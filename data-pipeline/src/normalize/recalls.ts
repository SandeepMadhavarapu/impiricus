import type { EnforcementRecord } from "../sources/openfda.js";
import { toNdc11, ndcEquivalent } from "../identity/ndc.js";
import type { ProductIdentity } from "../schemas/index.js";

/**
 * Recall / enforcement matching.
 *
 * The defect this fixes: enforcement records were retrieved by GENERIC NAME and
 * exported under the product, with a single `matchedOnNdc` boolean that was
 * false on all 23 records across the three ingested products. A consumer
 * reading "6 recall records" next to Singulair would reasonably conclude this
 * product had been recalled six times. None of those six was verified to be
 * this product.
 *
 * Three tiers now, and only the strongest may be presented as a recall OF this
 * product:
 *
 *   discovery-candidate  matched on generic name only. A different
 *                        manufacturer, strength or dose form entirely.
 *   product-match        NDC or explicit product identity confirmed.
 *   package-match        a specific package NDC or lot is confirmed.
 *
 * Unresolved candidates are retained for review and deliberately excluded from
 * any product-specific export.
 */

export type RecallMatchTier = "discovery-candidate" | "product-match" | "package-match";

export interface RecallMatchEvidence {
  dimension: "generic-name" | "product-ndc" | "package-ndc" | "manufacturer" | "dose-form" | "strength";
  observed: string;
  agrees: boolean;
  note?: string;
}

export interface ClassifiedRecall {
  recallNumber: string;
  tier: RecallMatchTier;
  status: string;
  classification: string | null;
  reason: string;
  reportDate: string | null;
  recallInitiationDate: string | null;
  productDescription: string;
  recallingFirm: string | null;
  distributionPattern: string | null;
  /** NDCs the enforcement record itself declares, when present. */
  declaredProductNdcs: string[];
  /** Package NDCs or lot codes parsed out of the free-text description. */
  extractedPackageNdcs: string[];
  lotNumbers: string[];
  evidence: RecallMatchEvidence[];
  /** Why this tier and not a higher one. */
  rationale: string;
}

export interface RecallEvidence {
  /** Safe to present as recalls OF this product. */
  verified: ClassifiedRecall[];
  /** Retained for review. NOT this product unless promoted. */
  candidates: ClassifiedRecall[];
  searchStrategy: string;
  caveats: string[];
}

/** Finds NDC-shaped tokens in free text. */
function extractNdcs(text: string): string[] {
  const matches = text.match(/\b\d{4,5}-\d{3,4}-\d{1,2}\b/g) ?? [];
  return [...new Set(matches)];
}

/** Finds lot-number-shaped tokens. Conservative: needs an explicit label. */
function extractLots(text: string): string[] {
  const matches = text.match(/\b(?:lot|batch)\s*(?:#|no\.?|number)?\s*:?\s*([A-Z0-9][A-Z0-9-]{3,15})/gi) ?? [];
  return [...new Set(matches.map((m) => m.replace(/^.*?[:\s]([A-Z0-9][A-Z0-9-]{3,15})$/i, "$1")))];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function classifyRecall(
  record: EnforcementRecord & {
    recalling_firm?: string;
    distribution_pattern?: string;
    recall_initiation_date?: string;
  },
  identity: ProductIdentity
): ClassifiedRecall {
  const description = record.product_description ?? "";
  const declaredProductNdcs = record.openfda?.product_ndc ?? [];
  const extractedPackageNdcs = extractNdcs(description);
  const lotNumbers = extractLots(description);
  const evidence: RecallMatchEvidence[] = [];

  evidence.push({
    dimension: "generic-name",
    observed: (record.openfda?.generic_name ?? []).join(", ") || "(not declared)",
    agrees: true,
    note: "This is how the record was discovered. A name match alone identifies nothing.",
  });

  // Product NDC, declared by the enforcement record itself.
  const productNdcAgrees =
    identity.productNdc !== null && declaredProductNdcs.includes(identity.productNdc);
  if (declaredProductNdcs.length > 0) {
    evidence.push({
      dimension: "product-ndc",
      observed: declaredProductNdcs.join(", "),
      agrees: productNdcAgrees,
    });
  }

  // Package NDC, parsed from the description and compared in 11-digit space.
  let packageAgrees = false;
  for (const candidate of extractedPackageNdcs) {
    for (const ours of identity.ndc11List) {
      const cmp = ndcEquivalent(candidate, ours);
      if (cmp.comparable && cmp.equal) {
        packageAgrees = true;
        evidence.push({
          dimension: "package-ndc",
          observed: candidate,
          agrees: true,
          note: cmp.detail,
        });
      }
    }
  }
  if (extractedPackageNdcs.length > 0 && !packageAgrees) {
    evidence.push({
      dimension: "package-ndc",
      observed: extractedPackageNdcs.join(", "),
      agrees: false,
      note: "Package codes in the description do not match this product's packages.",
    });
  }

  // Manufacturer.
  const firm = record.recalling_firm ?? null;
  if (firm && identity.labelerName) {
    const agrees = norm(firm).includes(norm(identity.labelerName).split(" ")[0] ?? "");
    evidence.push({ dimension: "manufacturer", observed: firm, agrees });
  }

  // Strength and dose form, from the free-text description.
  const strength = identity.strength[0];
  if (strength) {
    const phrase = `${strength.numeratorValue} ${strength.numeratorUnit}`.toLowerCase();
    const agrees = norm(description).includes(norm(phrase));
    evidence.push({ dimension: "strength", observed: phrase, agrees });
  }
  const formWord = (identity.dosageForm ?? "").split(",")[0]?.toLowerCase() ?? "";
  if (formWord) {
    evidence.push({
      dimension: "dose-form",
      observed: formWord,
      agrees: norm(description).includes(norm(formWord)),
    });
  }

  let tier: RecallMatchTier;
  let rationale: string;
  if (packageAgrees) {
    tier = "package-match";
    rationale = "A package NDC in the recall description matches a package of this exact product.";
  } else if (productNdcAgrees) {
    tier = "product-match";
    rationale = "The enforcement record declares this product's NDC.";
  } else {
    tier = "discovery-candidate";
    rationale =
      "Discovered by generic name only. No declared product NDC and no package match, so this is " +
      "not established to be a recall of this product.";
  }

  return {
    recallNumber: record.recall_number,
    tier,
    status: record.status,
    classification: record.classification ?? null,
    reason: record.reason_for_recall,
    reportDate: record.report_date ?? null,
    recallInitiationDate: record.recall_initiation_date ?? null,
    productDescription: description,
    recallingFirm: firm,
    distributionPattern: record.distribution_pattern ?? null,
    declaredProductNdcs,
    extractedPackageNdcs,
    lotNumbers,
    evidence,
    rationale,
  };
}

export function buildRecallEvidence(
  records: Array<EnforcementRecord & Record<string, unknown>>,
  identity: ProductIdentity
): RecallEvidence {
  const classified = records.map((r) => classifyRecall(r, identity));
  return {
    verified: classified.filter((c) => c.tier !== "discovery-candidate"),
    candidates: classified.filter((c) => c.tier === "discovery-candidate"),
    searchStrategy:
      `openFDA drug/enforcement searched by openfda.generic_name:"${identity.genericName}". ` +
      "Name search is DISCOVERY ONLY; each hit is then checked against this product's NDCs, " +
      "manufacturer, strength and dose form.",
    caveats: [
      "Only entries under `verified` are established recalls of this exact product.",
      "`candidates` share a generic name and nothing more. They frequently belong to a different " +
        "manufacturer, strength or dose form.",
      "An empty `verified` list does not mean this product has never been recalled — enforcement " +
        "records often omit structured NDCs, which makes confirmation impossible from this source alone.",
      "Recall status changes over time. Check the report date and openFDA's own last_updated.",
    ],
  };
}
