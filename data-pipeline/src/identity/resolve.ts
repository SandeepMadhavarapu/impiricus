import { ndcByProductNdc, drugsFdaByApplication, type NdcDirectoryEntry } from "../sources/openfda.js";
import { buildIdentity, getNdcStatus, type RxNormIdentity } from "../sources/rxnav.js";
import { getSplXml, getSplMetadata, dailyMedProvenance } from "../sources/dailymed.js";
import { parseSpl, type ParsedSpl, type SplProduct } from "../normalize/spl.js";
import { toNdc11, ndcEquivalent } from "./ndc.js";
import { SourceUnavailableError } from "../sources/http.js";
import {
  type MatchEvidence,
  type Resolution,
  type ProductIdentity,
  type Strength,
  type Provenance,
} from "../schemas/index.js";

/**
 * Exact product resolution.
 *
 * Candidate generation is separate from validation on purpose. Names generate
 * candidates; only concrete identifiers and attributes accept one. Matching on
 * a name string alone is how a 10 mg adult tablet acquires a 4 mg paediatric
 * granule's dosing instructions.
 *
 * Every dimension checked produces a MatchEvidence row — agreeing or not — so
 * the decision is auditable. There is deliberately no numeric confidence score:
 * "0.87" hides which dimension failed, and which dimension failed is the whole
 * question.
 */

/** What the operator asserts about the product they want. */
export interface ProductSpec {
  productKey: string;
  brandName: string | null;
  /** Ingredient as commonly named, e.g. "montelukast sodium". */
  genericName: string;
  strengthValue: number;
  strengthUnit: string;
  /** Denominator for ratio strengths, e.g. 1.5 mL in "2 mg/1.5 mL". */
  denominatorValue: number | null;
  denominatorUnit: string | null;
  /** Expected SPL/NDC dosage form verbatim, e.g. "TABLET, FILM COATED". */
  dosageForm: string;
  releaseCharacteristic: "immediate" | "extended" | "delayed" | "unstated";
  route: string;
  /** Anchors. At least one of productNdc or splSetId must be supplied. */
  productNdc: string | null;
  splSetId: string | null;
  applicationNumber: string | null;
  /** Expected RXCUI, checked rather than trusted. */
  expectedRxcui: string | null;
  /** Why this product is in the verification set. */
  selectionRationale: string;
}

function ev(
  dimension: MatchEvidence["dimension"],
  expected: string,
  observed: string,
  agrees: boolean,
  sourceId: string,
  note?: string
): MatchEvidence {
  return { dimension, expected, observed, agrees, sourceId, ...(note ? { note } : {}) };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Extracts release characteristic from a dose-form string. */
export function releaseFromForm(form: string): ProductSpec["releaseCharacteristic"] {
  const f = form.toLowerCase();
  if (/\bextended[- ]release\b|\ber\b|\bxl\b|\bxr\b/.test(f)) return "extended";
  if (/\bdelayed[- ]release\b|\bdr\b|enteric/.test(f)) return "delayed";
  if (/\bimmediate[- ]release\b/.test(f)) return "immediate";
  return "unstated";
}

/** Parses an openFDA strength string like "10 mg/1" or "2 mg/1.5 mL". */
export function parseStrength(asStated: string, basis: Strength["basis"]): Strength | null {
  const m = asStated.match(/([\d.]+)\s*([a-zA-Z%]+)\s*(?:\/\s*([\d.]+)?\s*([a-zA-Z]+)?)?/);
  if (!m) return null;
  const numeratorValue = Number(m[1]);
  if (!Number.isFinite(numeratorValue)) return null;
  const denomRaw = m[3];
  const denomUnit = m[4];
  return {
    numeratorValue,
    numeratorUnit: m[2] ?? "",
    denominatorValue: denomRaw !== undefined ? Number(denomRaw) : denomUnit ? 1 : null,
    // openFDA writes "10 mg/1" where the trailing 1 is a unitless count.
    denominatorUnit: denomUnit ?? null,
    asStated,
    basis,
  };
}

export interface ResolutionInputs {
  ndcEntry: NdcDirectoryEntry | null;
  spl: ParsedSpl | null;
  splProduct: SplProduct | null;
  rxnorm: RxNormIdentity | null;
  drugsFdaProductNumber: string | null;
  provenance: Provenance[];
  failures: Array<{ sourceId: string; detail: string }>;
}

/**
 * Gathers evidence from every source without deciding anything yet.
 * A source failure is recorded, never silently treated as "no disagreement".
 */
export async function gatherIdentityEvidence(
  spec: ProductSpec,
  force = false
): Promise<ResolutionInputs> {
  const provenance: Provenance[] = [];
  const failures: Array<{ sourceId: string; detail: string }> = [];

  let ndcEntry: NdcDirectoryEntry | null = null;
  if (spec.productNdc) {
    try {
      const res = await ndcByProductNdc(spec.productNdc, force);
      ndcEntry = res.entries[0] ?? null;
      provenance.push(...res.provenance);
    } catch (err) {
      failures.push({
        sourceId: "openfda",
        detail: err instanceof SourceUnavailableError ? err.message : String(err),
      });
    }
  }

  // The SPL set id may come from the spec or from the NDC directory entry.
  const setId = spec.splSetId ?? ndcEntry?.openfda?.spl_set_id?.[0] ?? null;
  let spl: ParsedSpl | null = null;
  let splProduct: SplProduct | null = null;
  if (setId) {
    try {
      const [{ xml, capture }, meta] = await Promise.all([
        getSplXml(setId, force),
        getSplMetadata(setId, force),
      ]);
      spl = parseSpl(xml);
      provenance.push(
        dailyMedProvenance(capture, "spl-xml", spl.setId, spl.splVersion, spl.effectiveDate)
      );
      if (meta) provenance.push(meta.provenance);

      // Select the ONE product in this SPL that matches. An SPL routinely
      // covers several products; picking the first would be a coin flip.
      splProduct =
        spl.products.find((p) =>
          spec.productNdc ? p.ndc === spec.productNdc : false
        ) ??
        spl.products.find(
          (p) =>
            norm(p.formDisplay ?? "") === norm(spec.dosageForm) &&
            p.activeIngredients.some(
              (i) => Number(i.numeratorValue) === spec.strengthValue
            )
        ) ??
        null;
    } catch (err) {
      failures.push({
        sourceId: "dailymed",
        detail: err instanceof SourceUnavailableError ? err.message : String(err),
      });
    }
  }

  // RxNorm: prefer the expected RXCUI, else the one the NDC directory reports.
  const rxcuiCandidate = spec.expectedRxcui ?? ndcEntry?.openfda?.rxcui?.[0] ?? null;
  let rxnorm: RxNormIdentity | null = null;
  if (rxcuiCandidate) {
    try {
      rxnorm = await buildIdentity(rxcuiCandidate, force);
      if (rxnorm) provenance.push(...rxnorm.provenance);
    } catch (err) {
      failures.push({ sourceId: "rxnav", detail: String(err) });
    }
  }

  // Drugs@FDA: find the product WITHIN the application, never the application.
  let drugsFdaProductNumber: string | null = null;
  const appNumber = spec.applicationNumber ?? ndcEntry?.application_number ?? null;
  if (appNumber) {
    try {
      const res = await drugsFdaByApplication(appNumber, force);
      provenance.push(...res.provenance);
      const app = res.applications[0];
      const match = app?.products?.find(
        (p) =>
          norm(p.dosage_form ?? "").includes(norm(spec.dosageForm).split(" ")[0] ?? "") &&
          (p.active_ingredients ?? []).some((ai) => {
            const parsed = parseStrength(ai.strength ?? "", "unstated");
            return parsed?.numeratorValue === spec.strengthValue;
          })
      );
      drugsFdaProductNumber = match?.product_number ?? null;
    } catch (err) {
      failures.push({ sourceId: "drugsfda", detail: String(err) });
    }
  }

  return { ndcEntry, spl, splProduct, rxnorm, drugsFdaProductNumber, provenance, failures };
}

/** Turns gathered evidence into a resolution state. */
export function decideResolution(spec: ProductSpec, inputs: ResolutionInputs): Resolution {
  const evidence: MatchEvidence[] = [];
  const competing: Resolution["competingCandidates"] = [];

  const { ndcEntry, spl, splProduct, rxnorm } = inputs;

  /* --- product NDC ----------------------------------------------------- */
  if (spec.productNdc && ndcEntry) {
    evidence.push(
      ev(
        "ndc",
        spec.productNdc,
        ndcEntry.product_ndc,
        ndcEntry.product_ndc === spec.productNdc,
        "openfda/drug/ndc"
      )
    );
  }

  /* --- dose form ------------------------------------------------------- */
  if (ndcEntry?.dosage_form) {
    evidence.push(
      ev(
        "dose-form",
        spec.dosageForm,
        ndcEntry.dosage_form,
        norm(ndcEntry.dosage_form) === norm(spec.dosageForm),
        "openfda/drug/ndc"
      )
    );
  }
  if (splProduct?.formDisplay) {
    evidence.push(
      ev(
        "dose-form",
        spec.dosageForm,
        splProduct.formDisplay,
        norm(splProduct.formDisplay) === norm(spec.dosageForm),
        "dailymed/spl"
      )
    );
  }

  /* --- release characteristic ----------------------------------------- */
  const observedRelease = releaseFromForm(
    splProduct?.formDisplay ?? ndcEntry?.dosage_form ?? spec.dosageForm
  );
  evidence.push(
    ev(
      "release-characteristic",
      spec.releaseCharacteristic,
      observedRelease,
      observedRelease === spec.releaseCharacteristic,
      "derived/dose-form",
      "Derived from the dose-form string; SPL does not encode release separately."
    )
  );

  /* --- strength, with numerator and denominator ------------------------ */
  if (splProduct?.activeIngredients?.[0]) {
    const ai = splProduct.activeIngredients[0];
    const num = Number(ai.numeratorValue);
    const numAgrees = num === spec.strengthValue && (ai.numeratorUnit ?? "") === spec.strengthUnit;
    evidence.push(
      ev(
        "strength",
        `${spec.strengthValue} ${spec.strengthUnit}`,
        `${ai.numeratorValue} ${ai.numeratorUnit}`,
        numAgrees,
        "dailymed/spl"
      )
    );

    // Salt vs active moiety. The SPL states both; conflating them silently
    // changes what the number means.
    evidence.push(
      ev(
        "salt",
        spec.genericName,
        ai.name,
        norm(ai.name) === norm(spec.genericName),
        "dailymed/spl",
        "Labeled ingredient (may be a salt)."
      )
    );
    if (ai.activeMoiety) {
      evidence.push(
        ev(
          "active-moiety",
          ai.activeMoiety,
          ai.activeMoiety,
          true,
          "dailymed/spl",
          `Active moiety declared as "${ai.activeMoiety}", distinct from labeled "${ai.name}".`
        )
      );
    }
  }

  /* --- route ----------------------------------------------------------- */
  const observedRoutes = splProduct?.route ?? ndcEntry?.route ?? [];
  if (observedRoutes.length > 0) {
    evidence.push(
      ev(
        "route",
        spec.route,
        observedRoutes.join(", "),
        observedRoutes.some((r) => norm(r) === norm(spec.route)),
        splProduct ? "dailymed/spl" : "openfda/drug/ndc"
      )
    );
  }

  /* --- brand and labeler ----------------------------------------------- */
  if (spec.brandName && ndcEntry?.brand_name) {
    evidence.push(
      ev(
        "brand",
        spec.brandName,
        ndcEntry.brand_name,
        norm(ndcEntry.brand_name) === norm(spec.brandName),
        "openfda/drug/ndc"
      )
    );
  }
  if (ndcEntry?.labeler_name) {
    evidence.push(ev("labeler", ndcEntry.labeler_name, ndcEntry.labeler_name, true, "openfda/drug/ndc"));
  }

  /* --- RxNorm concept type and currency -------------------------------- */
  if (rxnorm) {
    evidence.push(
      ev(
        "rxnorm-tty",
        spec.expectedRxcui ? `rxcui ${spec.expectedRxcui}` : "any current concept",
        `${rxnorm.concept.rxcui} (${rxnorm.concept.tty}) ${rxnorm.status}`,
        rxnorm.isCurrent &&
          (!spec.expectedRxcui || rxnorm.concept.rxcui === spec.expectedRxcui),
        "rxnav",
        rxnorm.isCurrent ? undefined : "RXCUI is not current — do not treat as active."
      )
    );

    // Cross-check: does RxNorm's NDC list contain our package NDCs?
    //
    // Only meaningful for PRODUCT-level concepts. Component-level concepts
    // (SBDC/SCDC) and ingredient concepts describe a strength or a substance,
    // not a package, and carry no NDCs — verified: SBDC 1991308 returns an
    // empty ndcList. Running this check against one manufactures a conflict.
    const PRODUCT_LEVEL_TTY = new Set(["SBD", "SCD", "BPCK", "GPCK"]);
    const ttyIsProductLevel = PRODUCT_LEVEL_TTY.has(rxnorm.concept.tty);

    if (!ttyIsProductLevel && (splProduct?.packageNdcs.length ?? 0) > 0) {
      evidence.push(
        ev(
          "rxnorm-tty",
          "a product-level concept (SBD/SCD/BPCK/GPCK) for NDC comparison",
          `${rxnorm.concept.tty} is component- or ingredient-level`,
          true,
          "rxnav",
          "NDC cross-check skipped: this TTY does not carry NDCs. Not a conflict."
        )
      );
    }

    for (const pkg of ttyIsProductLevel ? (splProduct?.packageNdcs ?? []) : []) {
      const conv = toNdc11(pkg);
      if (!conv.ok) {
        evidence.push(
          ev("ndc", pkg, `unconvertible (${conv.reason})`, false, "derived/ndc", conv.detail)
        );
        continue;
      }
      const inRxNorm = rxnorm.ndc11.includes(conv.ndc11);
      evidence.push(
        ev(
          "ndc",
          `${pkg} -> ${conv.ndc11}`,
          inRxNorm ? "present in RxNorm NDC list" : "absent from RxNorm NDC list",
          inRxNorm,
          "rxnav",
          conv.derivation
        )
      );
    }
  }

  /* --- application and product number ---------------------------------- */
  if (spec.applicationNumber && ndcEntry?.application_number) {
    evidence.push(
      ev(
        "application-number",
        spec.applicationNumber,
        ndcEntry.application_number,
        ndcEntry.application_number === spec.applicationNumber,
        "openfda/drug/ndc"
      )
    );
  }
  if (inputs.drugsFdaProductNumber) {
    evidence.push(
      ev(
        "product-number",
        "a single product within the application",
        inputs.drugsFdaProductNumber,
        true,
        "drugsfda",
        "Product-level record; other products in this application are recorded separately and never merged."
      )
    );
  }

  /* --- SPL set id ------------------------------------------------------ */
  if (spl) {
    evidence.push(
      ev(
        "spl-set-id",
        spec.splSetId ?? spl.setId,
        `${spl.setId} v${spl.splVersion}`,
        !spec.splSetId || spl.setId === spec.splSetId,
        "dailymed/spl"
      )
    );
    // Multi-product SPLs are explicitly surfaced, not hidden.
    for (const other of spl.products) {
      if (other.ndc && other.ndc !== splProduct?.ndc) {
        competing.push({
          label: `${other.name} ${other.activeIngredients[0]?.numeratorValue ?? "?"}${other.activeIngredients[0]?.numeratorUnit ?? ""} ${other.formDisplay ?? ""} (NDC ${other.ndc})`,
          rxcui: null,
          why: "Also described by this SPL. Its dosing and population do not transfer to the selected product.",
        });
      }
    }
  }

  /* --- decide ---------------------------------------------------------- */
  const CRITICAL: MatchEvidence["dimension"][] = [
    "ndc",
    "strength",
    "dose-form",
    "route",
    "release-characteristic",
  ];
  const criticalRows = evidence.filter((e) => CRITICAL.includes(e.dimension));
  const disagreements = criticalRows.filter((e) => !e.agrees);

  let state: Resolution["state"];
  let rationale: string;

  if (inputs.failures.length > 0 && !spl && !ndcEntry) {
    state = "source-unavailable";
    rationale = `No identity source could be reached: ${inputs.failures
      .map((f) => `${f.sourceId} (${f.detail})`)
      .join("; ")}. No match is asserted.`;
  } else if (!ndcEntry && !splProduct) {
    state = "unmatched";
    rationale =
      "Neither the NDC directory nor the SPL yielded a product matching the specification.";
  } else if (disagreements.length > 0) {
    state = "conflicting";
    rationale = `Critical dimensions disagree: ${disagreements
      .map((d) => `${d.dimension} (expected "${d.expected}", observed "${d.observed}")`)
      .join("; ")}.`;
  } else if (!splProduct) {
    state = "ambiguous";
    rationale =
      "An NDC directory entry matched but no single product within the SPL could be selected, so label content cannot be scoped to this product.";
  } else if (criticalRows.length < 3) {
    state = "ambiguous";
    rationale = `Only ${criticalRows.length} critical dimension(s) could be checked; that is not enough to assert an exact match.`;
  } else {
    state = "verified-match";
    rationale = `All ${criticalRows.length} checkable critical dimensions agree across ${new Set(evidence.map((e) => e.sourceId)).size} sources.`;
  }

  const identity = buildProductIdentity(spec, inputs);

  return {
    state,
    identity,
    evidence,
    competingCandidates: competing,
    rationale,
    resolvedAt: new Date().toISOString(),
  };
}

function buildProductIdentity(spec: ProductSpec, inputs: ResolutionInputs): ProductIdentity {
  const { ndcEntry, spl, splProduct, rxnorm } = inputs;
  const ai = splProduct?.activeIngredients?.[0];

  const strengths: Strength[] = [];
  if (ai) {
    strengths.push({
      numeratorValue: Number(ai.numeratorValue),
      numeratorUnit: ai.numeratorUnit ?? "",
      denominatorValue: ai.denominatorValue ? Number(ai.denominatorValue) : null,
      denominatorUnit: ai.denominatorUnit === "1" ? null : (ai.denominatorUnit ?? null),
      asStated: `${ai.numeratorValue} ${ai.numeratorUnit}`,
      basis: ai.activeMoiety && ai.activeMoiety !== ai.name ? "salt" : "unstated",
    });
  }

  const ndc11List = (splProduct?.packageNdcs ?? [])
    .map((p) => toNdc11(p))
    .filter((c): c is Extract<typeof c, { ok: true }> => c.ok)
    .map((c) => c.ndc11);

  return {
    productKey: spec.productKey,
    brandName: ndcEntry?.brand_name ?? splProduct?.name ?? spec.brandName,
    genericName: ndcEntry?.generic_name ?? spec.genericName,
    labeledIngredient: ai?.name ?? spec.genericName,
    activeMoiety: ai?.activeMoiety ?? null,
    strength: strengths,
    dosageForm: splProduct?.formDisplay ?? ndcEntry?.dosage_form ?? spec.dosageForm,
    releaseCharacteristic: releaseFromForm(
      splProduct?.formDisplay ?? ndcEntry?.dosage_form ?? spec.dosageForm
    ),
    route: splProduct?.route ?? ndcEntry?.route ?? [spec.route],
    labelerName: ndcEntry?.labeler_name ?? spl?.labeler ?? null,
    productNdc: ndcEntry?.product_ndc ?? splProduct?.ndc ?? spec.productNdc,
    ndc11List,
    applicationNumber: ndcEntry?.application_number ?? spec.applicationNumber,
    fdaProductNumber: inputs.drugsFdaProductNumber,
    marketingCategory: ndcEntry?.marketing_category ?? null,
    rxcui: rxnorm?.concept.rxcui ?? null,
    rxnormTty: rxnorm?.concept.tty ?? null,
    unii: ndcEntry?.openfda?.unii ?? [],
    splSetId: spl?.setId ?? null,
    splVersion: spl?.splVersion ?? null,
  };
}

export async function resolveProduct(spec: ProductSpec, force = false): Promise<{
  resolution: Resolution;
  inputs: ResolutionInputs;
}> {
  const inputs = await gatherIdentityEvidence(spec, force);
  return { resolution: decideResolution(spec, inputs), inputs };
}
