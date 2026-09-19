/**
 * Builds AccessPolicy records: what a named plan publishes about a named
 * product, what it requires, and what the published policy says to do next.
 *
 * Two markets are built, from genuinely different kinds of source:
 *
 *   MEDICARE PART D           structured flags in the verified CMS release
 *   MEDICAID FEE-FOR-SERVICE  a state PDF, extracted with layout preserved
 *
 * They are never merged. A Part D restriction says nothing about Medicaid and
 * vice versa, and a policy carries the benefit programme it belongs to so a
 * consumer cannot show one as the other.
 *
 * WHAT IS DELIBERATELY ABSENT
 *
 * Plan-specific CLINICAL prior-authorization criteria. The CMS release carries
 * PA/ST/QL as booleans and quantity numbers; it does not carry criteria text.
 * That text lives in insurer documents whose applicability to a specific
 * contract-plan-segment has to be established document by document. Where that
 * has not been done, the policy says `policy-applicability-unresolved` rather
 * than borrowing a national PBM policy.
 */

import { createHash } from "node:crypto";
import {
  ACCESS_SCHEMA_VERSION,
  type AccessAction,
  type AccessPolicy,
  type Evidence,
  type PolicyRequirement,
} from "../schemas/access.js";
import {
  ACCESS_SOURCE_DOCUMENTS,
  PART_D_ACTIONS,
  VA_MEDICAID_FFS_ACTIONS,
  type AccessActionTemplate,
} from "../config/accessActions.js";
import type { CoverageLookupResult } from "../schemas/insurance.js";
import type { PdlMatch } from "../sources/vaMedicaid.js";
import type { LinkCheckResult } from "./linkCheck.js";

function id(parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

/** Turns a template plus retrieval facts into an AccessAction. */
function materialize(
  t: AccessActionTemplate,
  retrieval: { retrievedAt: string; contentHash: string; version: string | null; effective: string | null },
  links: Map<string, LinkCheckResult>
): AccessAction {
  const doc = ACCESS_SOURCE_DOCUMENTS[t.documentKey]!;
  const evidence: Evidence = {
    sourceId: t.documentKey,
    sourceOwner: doc.owner,
    documentTitle: doc.title,
    url: doc.url,
    documentVersion: retrieval.version,
    effectiveDate: retrieval.effective,
    retrievedAt: retrieval.retrievedAt,
    contentHash: retrieval.contentHash,
    locator: t.locator,
    quotation: t.quotation,
  };

  const contactUrl = t.submissionUrl ?? doc.url;
  const check = links.get(contactUrl);

  return {
    id: t.id,
    actor: t.actor,
    basis: t.basis,
    action: t.action,
    respondsToRequirementId: null,
    formType: t.formType ?? "not-a-form",
    routeApplicability: t.routeApplicability ?? "applicability-unresolved",
    formTitle: t.formTitle ?? null,
    formUrl: t.formUrl ?? null,
    submissionUrl: t.submissionUrl ?? null,
    submissionFax: t.submissionFax ?? null,
    submissionPhone: t.submissionPhone ?? null,
    documentsMentioned: t.documentsMentioned ?? [],
    statedTimeframes: t.statedTimeframes ?? [],
    expedited: t.expedited ?? null,
    contacts:
      t.submissionPhone || t.submissionFax || t.submissionUrl
        ? [
            {
              label: "Submission route",
              organization: doc.owner,
              phone: t.submissionPhone ?? null,
              fax: t.submissionFax ?? null,
              url: t.submissionUrl ?? null,
              notes: null,
              evidence,
              linkCheck: check
                ? {
                    checkedAt: check.checkedAt,
                    httpStatus: check.httpStatus,
                    ok: check.ok,
                    note: check.note,
                  }
                : null,
            },
          ]
        : [],
    evidence,
  };
}

/* ------------------------------------------------------- Medicare Part D */

export interface PartDPolicyInput {
  productKey: string;
  /** Reference date the effectivity judgement was made against. */
  asOfDate: string;
  coverage: CoverageLookupResult;
  /** Indication restrictions from the CMS indication-based coverage file. */
  indications: string[];
  retrieval: { retrievedAt: string; contentHash: string; version: string | null; effective: string | null };
  links: Map<string, LinkCheckResult>;
}

/**
 * Builds a Part D access policy from a coverage lookup.
 *
 * Requirements come only from what the release actually carries: the PA, step
 * therapy and quantity flags, plus any indication rows. Each is recorded with
 * the flag that produced it, and PA is explicitly described as a requirement
 * to ASK, never as an approval.
 */
export function buildPartDPolicy(input: PartDPolicyInput): AccessPolicy {
  const { coverage, productKey } = input;
  const plan = coverage.checked.plan;
  const evidenceBase: Evidence = {
    sourceId: "cms-part-d",
    sourceOwner: "Centers for Medicare & Medicaid Services",
    documentTitle:
      "Prescription Drug Plan Formulary, Pharmacy Network, and Pricing Information Files",
    url: "https://data.cms.gov/provider-summary-by-type-of-service/medicare-part-d-prescribers/monthly-prescription-drug-plan-formulary-and-pharmacy-network-information",
    documentVersion: coverage.freshness.sourceRelease,
    effectiveDate: coverage.freshness.sourcePublished,
    retrievedAt: coverage.freshness.retrievedAt,
    contentHash: input.retrieval.contentHash,
    locator: null,
    quotation: null,
  };

  const requirements: PolicyRequirement[] = [];
  const found = coverage.found[0];

  if (found) {
    const policy = found.policy;
    const loc = `basic drugs formulary file, formulary ${found.formularyId}, RXCUI ${found.matchedRxcui}`;

    if (policy.priorAuthorization === "yes") {
      requirements.push({
        id: id([productKey, "pa"]),
        kind: "administrative",
        phase: "phase-not-stated",
        statedText:
          "Prior authorization is required. The prescriber must submit a request and the plan must " +
          "approve it BEFORE the plan will pay. This is a requirement to ask, not an approval, and " +
          "the release does not carry the clinical criteria the plan will apply.",
        logic: "standalone",
        children: [],
        exceptions: [],
        quantityAsStated: null,
        effectiveStart: null,
        effectiveEnd: null,
        evidence: { ...evidenceBase, locator: loc, quotation: "PRIOR_AUTH_YN = Y" },
      });
    }
    if (policy.stepTherapy === "yes") {
      requirements.push({
        id: id([productKey, "st"]),
        kind: "clinical",
        phase: "initiation",
        statedText:
          "Step therapy applies: the plan requires trial of another drug first. The release records " +
          "only that step therapy applies, not which drug must be tried or what counts as a trial.",
        logic: "standalone",
        children: [],
        exceptions: [],
        quantityAsStated: null,
        effectiveStart: null,
        effectiveEnd: null,
        evidence: { ...evidenceBase, locator: loc, quotation: "STEP_THERAPY_YN = Y" },
      });
    }
    if (policy.quantityLimit.present === "yes") {
      requirements.push({
        id: id([productKey, "ql"]),
        kind: "quantity",
        phase: "both",
        statedText: `Quantity limit: ${policy.quantityLimit.asStated ?? "as published"}.`,
        logic: "standalone",
        children: [],
        exceptions: [],
        quantityAsStated: policy.quantityLimit.asStated,
        effectiveStart: null,
        effectiveEnd: null,
        evidence: {
          ...evidenceBase,
          locator: loc,
          quotation: `QUANTITY_LIMIT_AMOUNT ${policy.quantityLimit.amount} per QUANTITY_LIMIT_DAYS ${policy.quantityLimit.days} days`,
        },
      });
    }
  }

  for (const disease of input.indications) {
    requirements.push({
      id: id([productKey, "indication", disease]),
      kind: "indication",
      phase: "phase-not-stated",
      statedText:
        `The plan records indication-based coverage for this drug limited to: ${disease}. ` +
        "This is the plan's published coverage scope, not a clinical judgement about any patient.",
      logic: "any-of",
      children: [],
      exceptions: [],
      quantityAsStated: null,
      effectiveStart: null,
      effectiveEnd: null,
      evidence: {
        ...evidenceBase,
        locator: "indication based coverage formulary file",
        quotation: disease,
      },
    });
  }

  const listingStatus: AccessPolicy["listingStatus"] =
    coverage.state === "listed"
      ? "listed-without-preference-tiering"
      : coverage.state === "conditional"
        ? "listed-with-restrictions"
        : coverage.state === "explicitly-excluded"
          ? "explicitly-excluded"
          : coverage.state === "not-found-in-checked-source"
            ? "not-addressed-in-this-document"
            : "unresolved";

  return {
    schemaVersion: ACCESS_SCHEMA_VERSION,
    policyId: id(["partd", productKey, plan?.planKey ?? "unresolved"]),
    productKey,
    benefitProgram: "medicare-part-d",
    planKey: plan?.planKey ?? null,
    scopeLabel: plan ? `${plan.planName ?? plan.planKey} (${plan.planKey})` : "unresolved plan",
    geography: "United States (Medicare Part D)",
    planYear: coverage.checked.planYear,
    sourceEffectivity: {
      documentVersion: coverage.freshness.sourceRelease ?? "unknown",
      effectiveDate: coverage.freshness.sourcePublished,
      status: "currently-effective",
      asOfDate: input.asOfDate,
      note:
        "The CMS monthly release in use was confirmed to be the newest published at build time. " +
        "Unlike the state PDL, CMS does not publish a future-dated release alongside the current " +
        "one, so there is no upcoming version to hold separate.",
    },
    upcomingChanges: [],
    // Part D evidence is the plan's own structured filing, not a document
    // whose layout had to be interpreted, so there is no extraction dispute to
    // resolve and no second document needed to confirm a column reading.
    independentCorroboration: null,
    extractionDisputes: [],
    scopeWarning:
      "Medicare Part D only. This says nothing about Medicaid, Marketplace, or commercial " +
      "coverage, and nothing about what this person is enrolled in or would pay.",
    applicability: plan ? "verified-for-this-plan" : "policy-applicability-unresolved",
    applicabilityRationale: plan
      ? "Formulary rows were selected by this plan's own FORMULARY_ID, taken from the plan record " +
        "in the same CMS release. The restriction flags are the plan's own filing."
      : "No single plan was resolved, so nothing was checked.",
    listingStatus,
    listingStatusNote: coverage.headline,
    requirements,
    actions: PART_D_ACTIONS.map((t) => materialize(t, input.retrieval, input.links)),
    extractionStatus: plan ? "verified-public-evidence" : "unresolved-applicability",
    extractionLimitations: [
      "The CMS release carries prior-authorization and step-therapy as FLAGS only. It does not " +
        "contain the clinical criteria the plan applies, which are published separately by the " +
        "insurer and are not included here.",
      "The plan-defined meaning of the tier number is not in this dataset.",
    ],
    evidence: [evidenceBase],
    memberEligibilityDetermined: false,
    clinicallyReviewed: false,
    unknowns: coverage.unknown,
  };
}

/* ------------------------------------------ Virginia Medicaid fee-for-service */

export interface VaFfsPolicyInput {
  productKey: string;
  /** Reference date the effectivity judgement was made against. */
  asOfDate: string;
  /** Whether the document this policy describes is in force on `asOfDate`. */
  effectivityStatus: "currently-effective" | "upcoming" | "superseded";
  /** Differences in the next published version affecting THIS product. */
  upcomingChanges: AccessPolicy["upcomingChanges"];
  /** Result of checking a SEPARATE publisher document. */
  corroboration: AccessPolicy["independentCorroboration"];
  /** How each extraction disagreement touching this product was resolved. */
  extractionDisputes: AccessPolicy["extractionDisputes"];
  /** The brand/product name searched for. */
  searchTerm: string;
  match: PdlMatch;
  retrieval: { retrievedAt: string; contentHash: string; version: string | null; effective: string | null };
  documentUrl: string;
  links: Map<string, LinkCheckResult>;
}

/**
 * Builds a Virginia Medicaid fee-for-service access policy from a PDL match.
 *
 * The single requirement this document supports is the one it states on page
 * 1: non-preferred drugs require a service authorization. Criteria text is
 * carried as evidence but never asserted as this drug's requirement - see
 * `PdlMatch.criteriaExtraction` for why.
 */
export function buildVaFfsPolicy(input: VaFfsPolicyInput): AccessPolicy {
  const { match, productKey } = input;

  const evidenceFor = (locator: string, quotation: string | null): Evidence => ({
    sourceId: "vamedicaid",
    sourceOwner: "Virginia Department of Medical Assistance Services",
    documentTitle: "Virginia's Medicaid Preferred Drug List (PDL) / Common Core Formulary",
    url: input.documentUrl,
    documentVersion: input.retrieval.version,
    effectiveDate: input.retrieval.effective,
    retrievedAt: input.retrieval.retrievedAt,
    contentHash: input.retrieval.contentHash,
    locator,
    quotation,
  });

  const requirements: PolicyRequirement[] = [];
  const hit = match.hits.find((h) => h.column === "non-preferred");

  // Service-authorization CRITERIA text is deliberately NOT turned into a
  // requirement. The criteria column does not align to the drug-class headings,
  // so which criteria bind which drug is unestablished; promoting that text
  // here would assert a clinical condition the document never tied to this
  // product. It stays in `evidence` with its page citation, for a human.

  if (match.status === "non-preferred" || match.status === "appears-in-both-columns") {
    requirements.push({
      id: id([productKey, "va-sa"]),
      kind: "administrative",
      phase: "phase-not-stated",
      statedText:
        "Non-preferred drugs require a Service Authorization (SA). This product appears in the " +
        "Non-Preferred Agents column, so an SA is required before the fee-for-service programme " +
        "will pay. An SA requirement is not a denial and not an approval.",
      logic: "standalone",
      children: [],
      exceptions: [
        "Page 1 states preferred drugs do not require an SA unless subject to additional clinical " +
          "criteria, so a preferred alternative in the same class may avoid this requirement.",
      ],
      quantityAsStated: null,
      effectiveStart: input.retrieval.effective,
      effectiveEnd: null,
      evidence: evidenceFor(
        hit ? `page ${hit.page}, Non-Preferred Agents column` : "page 1, General Information",
        "Non-preferred drugs require a SA"
      ),
    });
  }

  const listingStatus: AccessPolicy["listingStatus"] =
    match.status === "preferred"
      ? "preferred"
      : match.status === "non-preferred"
        ? "non-preferred"
        : match.status === "appears-in-both-columns"
          ? "listed-with-restrictions"
          : "not-addressed-in-this-document";

  const listingStatusNote =
    match.status === "not-addressed-in-this-document"
      ? "This drug does not appear anywhere in the PDL. The document states it covers only " +
        "selected drug classes, and that drugs not on it are subject to Virginia's mandatory " +
        "generic substitution requirements. That is NOT a finding that the drug is not covered."
      : match.status === "appears-in-both-columns"
        ? "The name appears in both columns - typically the generic is preferred while the brand " +
          "or another formulation is not. Read the cited pages; which formulation you have matters."
        : match.status === "non-preferred"
          ? "Listed in the Non-Preferred Agents column, which the document says requires a Service " +
            "Authorization."
          : "Listed in the Preferred Agents column. Page 1 states preferred drugs do not require an " +
            "SA unless subject to additional clinical criteria.";

  const evidence: Evidence[] = match.hits.map((h) =>
    evidenceFor(
      `page ${h.page}, ${h.column === "preferred" ? "Preferred" : "Non-Preferred"} Agents column, class "${h.className}"`,
      h.text
    )
  );
  if (evidence.length === 0) evidence.push(evidenceFor("whole document", null));

  return {
    schemaVersion: ACCESS_SCHEMA_VERSION,
    policyId: id(["va-ffs", productKey]),
    productKey,
    benefitProgram: "medicaid-fee-for-service",
    planKey: null,
    scopeLabel: "Virginia Medicaid fee-for-service (statewide)",
    geography: "Virginia, United States",
    planYear: null,
    sourceEffectivity: {
      documentVersion: input.retrieval.version ?? "unknown",
      effectiveDate: input.retrieval.effective,
      status: input.effectivityStatus,
      asOfDate: input.asOfDate,
      note:
        input.effectivityStatus === "currently-effective"
          ? `This is the version in force on ${input.asOfDate}. Virginia publishes each quarterly ` +
            "PDL weeks ahead of its effective date and keeps superseded versions online, so the " +
            "newest published file is often NOT the one in force."
          : `This version is NOT in force on ${input.asOfDate}. Do not present it as current ` +
            "coverage.",
    },
    upcomingChanges: input.upcomingChanges,
    independentCorroboration: input.corroboration,
    extractionDisputes: input.extractionDisputes,
    scopeWarning:
      "VIRGINIA MEDICAID FEE-FOR-SERVICE ONLY. Virginia contracts with managed care organisations " +
      "(Aetna, Anthem, Humana, Sentara, UnitedHealthcare) that publish their OWN formularies and " +
      "their own authorization rules. Most Virginia Medicaid members are enrolled in one of those " +
      "plans, not in fee-for-service. Nothing here may be applied to a managed care member " +
      "without retrieving that plan's own documents.",
    applicability: "verified-for-this-market-segment",
    applicabilityRationale:
      "The PDL is published by the state Medicaid agency and applies to fee-for-service statewide. " +
      "It does NOT apply to Virginia Medicaid managed care plans, which publish their own " +
      "formularies; those were not retrieved.",
    listingStatus,
    listingStatusNote,
    requirements,
    actions: VA_MEDICAID_FFS_ACTIONS.map((t) => materialize(t, input.retrieval, input.links)),
    extractionStatus:
      match.status === "not-addressed-in-this-document"
        ? "verified-public-evidence"
        : "incomplete-extraction",
    extractionLimitations:
      match.status === "not-addressed-in-this-document"
        ? []
        : [
            match.criteriaExtraction.reason,
            match.criteriaExtraction.readInstead,
          ],
    evidence,
    memberEligibilityDetermined: false,
    clinicallyReviewed: false,
    unknowns: [
      "Whether this person is enrolled in Virginia Medicaid fee-for-service or in a managed care plan.",
      "Whether a service authorization would be approved for this person.",
      "Any amount this person would pay.",
      "Managed care plan coverage, which is published separately and was not retrieved.",
    ],
  };
}
