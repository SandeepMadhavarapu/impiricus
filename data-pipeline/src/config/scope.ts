/**
 * Supported scope.
 *
 * One statement of what this pipeline covers, imported wherever that has to be
 * asserted, so the answer cannot drift between the exports and the docs.
 *
 * Everything outside this list is not supported, not partially supported and
 * not approximated. Where a question falls outside it, the pipeline reports
 * the absence rather than filling it in.
 */
export interface SupportedScope {
  products: "three-selected-products";
  formularyEvidence: "public-formulary-evidence-from-verified-cms-release";
  markets: "medicare-part-d-only";
  memberSpecificCoverage: false;
  copayVerification: false;
  comprehensiveInteractionChecker: false;
  clinicalReview: false;
  statements: string[];
}

export const SUPPORTED_SCOPE: SupportedScope = {
  products: "three-selected-products",
  formularyEvidence: "public-formulary-evidence-from-verified-cms-release",
  markets: "medicare-part-d-only",
  memberSpecificCoverage: false,
  copayVerification: false,
  comprehensiveInteractionChecker: false,
  clinicalReview: false,
  statements: [
    "Three selected medication products.",
    "Public formulary evidence from the verified CMS release.",
    "Medicare Part D only.",
    "No member-specific coverage or copay verification.",
    "No comprehensive interaction checker.",
    "No clinical review.",
  ],
};
