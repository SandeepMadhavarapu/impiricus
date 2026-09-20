/**
 * Source registry.
 *
 * Every endpoint listed here was probed live before being written down (see
 * docs/SOURCES.md for the probe results and dates). Nothing in this file is an
 * endpoint someone assumed exists.
 *
 * Rate limits are the DOCUMENTED limits from each publisher. Where a publisher
 * documents no limit we set a conservative self-imposed one rather than
 * pretending to know theirs.
 */

export interface SourceSpec {
  id: SourceId;
  name: string;
  publisher: string;
  /** Official documentation the endpoints were read from. */
  docs: string;
  baseUrl: string;
  /** Whether a key is required, and what it changes. */
  auth: string;
  /** Requests per second this client will not exceed. */
  maxRequestsPerSecond: number;
  /** Maximum concurrent in-flight requests to this host. */
  maxConcurrency: number;
  /** Documented publisher limit, verbatim-ish, or an honest "not documented". */
  documentedLimit: string;
  /** How often the publisher says the data changes. */
  updateCadence: string;
  /** Redistribution / licensing position. */
  licensing: string;
  /** What this source can legitimately establish. */
  establishes: string[];
  /** What it must never be used to establish. */
  cannotEstablish: string[];
}

export type SourceId =
  | "rxnav"
  | "dailymed"
  | "openfda"
  | "drugsfda"
  | "nppes"
  | "vamedicaid"
  | "novocare";

export const SOURCES: Record<SourceId, SourceSpec> = {
  rxnav: {
    id: "rxnav",
    name: "RxNav / RxNorm REST API",
    publisher: "U.S. National Library of Medicine",
    docs: "https://lhncbc.nlm.nih.gov/RxNav/APIs/RxNormAPIs.html",
    baseUrl: "https://rxnav.nlm.nih.gov/REST",
    auth: "None. No API key.",
    maxRequestsPerSecond: 15,
    maxConcurrency: 4,
    documentedLimit:
      "NLM asks callers not to exceed 20 requests per second per IP address. This client caps at 15/s.",
    updateCadence:
      "RxNorm full release monthly (first Monday); weekly updates between full releases.",
    licensing:
      "RxNorm is produced by NLM and is in the public domain, but RxNorm contains source vocabularies with their own restrictions. Only RxNorm-normalized identifiers and relationships are retained here.",
    establishes: [
      "Normalized drug identity (RXCUI) and concept type (TTY)",
      "Ingredient / precise ingredient / brand / clinical-drug relationships",
      "Strength and dose form as normalized by RxNorm",
      "RXCUI active/obsolete status and remapping history",
      "NDC associations known to RxNorm, in 11-digit form",
    ],
    cannotEstablish: [
      "FDA approval status",
      "A complete drug monograph",
      "Drug-drug interactions - the RxNav Interaction API was DISCONTINUED and now returns HTTP 404 (verified)",
      "Clinical guidance of any kind",
    ],
  },

  dailymed: {
    id: "dailymed",
    name: "DailyMed SPL Web Services v2",
    publisher: "U.S. National Library of Medicine",
    docs: "https://dailymed.nlm.nih.gov/dailymed/app-support-mapping-files.cfm",
    baseUrl: "https://dailymed.nlm.nih.gov/dailymed/services/v2",
    auth: "None. No API key.",
    maxRequestsPerSecond: 4,
    maxConcurrency: 2,
    documentedLimit:
      "No published numeric rate limit. This client self-imposes 4 requests/second with concurrency 2.",
    updateCadence: "Continuous; labelers submit SPL revisions and DailyMed publishes daily.",
    licensing:
      "SPL content is public domain as published by NLM/FDA. Label text is reproduced verbatim with source attribution.",
    establishes: [
      "The authoritative submitted labeling document (SPL) and its set id, document id, version and effective date",
      "Full section structure including nested subsections and tables",
      "Labeler, product and package identifiers as submitted",
      "Medication Guides and other patient-directed documents",
      "Version history for a set id",
    ],
    cannotEstablish: [
      "That a label has been FDA-approved - DailyMed hosts submitted labeling",
      "Current marketing status of a product",
      "Anything about an individual patient",
    ],
  },

  openfda: {
    id: "openfda",
    name: "openFDA Drug APIs",
    publisher: "U.S. Food & Drug Administration",
    docs: "https://open.fda.gov/apis/",
    baseUrl: "https://api.fda.gov",
    auth:
      "Optional API key via api_key query parameter. Set OPENFDA_API_KEY to raise limits; the pipeline works without one.",
    maxRequestsPerSecond: 3,
    maxConcurrency: 2,
    documentedLimit:
      "Without a key: 240 requests per minute per IP and 1,000 per day. With a key: 240 per minute and 120,000 per day. This client caps at 3/s.",
    updateCadence:
      "Varies by endpoint; each response carries meta.last_updated, which this pipeline records rather than assuming.",
    licensing: "openFDA data is public domain. Attribution to FDA is retained.",
    establishes: [
      "A submitted label as harmonized by openFDA (drug/label)",
      "An NDC directory entry: product identity, dosage form, route, labeler, marketing category (drug/ndc)",
      "Application-level approval records and submission history (drug/drugsfda)",
      "Recall / enforcement records (drug/enforcement) - supplemental only",
    ],
    cannotEstablish: [
      "That presence in an FDA-hosted dataset proves FDA approval of a specific product",
      "Completeness of the openfda harmonized block - fields are frequently absent",
      "Incidence, causation or comparative safety from drug/event (FAERS) - spontaneous reports have no denominator",
    ],
  },

  drugsfda: {
    id: "drugsfda",
    name: "Drugs@FDA (via openFDA drug/drugsfda)",
    publisher: "U.S. Food & Drug Administration",
    docs: "https://open.fda.gov/apis/drug/drugsfda/",
    baseUrl: "https://api.fda.gov/drug/drugsfda.json",
    auth: "Same as openFDA.",
    maxRequestsPerSecond: 3,
    maxConcurrency: 2,
    documentedLimit: "Same as openFDA.",
    updateCadence: "Weekly, per FDA. Response meta.last_updated is recorded.",
    licensing: "Public domain.",
    establishes: [
      "Application number and type (NDA/ANDA/BLA)",
      "Product numbers within an application, each with its own strength, dosage form and route",
      "Marketing status per product",
      "Submission history including approval dates and submission types",
    ],
    cannotEstablish: [
      "That every product in an application shares one product's strength, route or approval date",
      "The content of the approved labeling document (only references to it)",
    ],
  },

  nppes: {
    id: "nppes",
    name: "NPPES NPI Registry API",
    publisher: "Centers for Medicare & Medicaid Services",
    docs: "https://npiregistry.cms.hhs.gov/api-page",
    baseUrl: "https://npiregistry.cms.hhs.gov/api",
    auth: "None. version=2.1 is required.",
    maxRequestsPerSecond: 2,
    maxConcurrency: 1,
    documentedLimit:
      "No published numeric limit. Results are capped at 200 per request with skip up to 1000. This client self-imposes 2 requests/second and never bulk-harvests.",
    updateCadence: "NPPES data is updated weekly.",
    licensing: "Public data published by CMS.",
    establishes: [
      "That an NPI number is enumerated and what type it is (individual vs organization)",
      "Self-reported name, taxonomy and public practice location",
      "Enumeration and last-update dates",
    ],
    cannotEstablish: [
      "Current licensure",
      "Credentialing or privileges",
      "Identity authentication of the person",
      "Whether the provider accepts new patients or any insurance",
      "Any relationship between a provider and a patient",
    ],
  },
  /**
   * Virginia Medicaid pharmacy benefits, published as PDFs.
   *
   * Fee-for-service only. Virginia also contracts with managed care
   * organisations that publish separate formularies; this source says nothing
   * about those plans.
   */
  vamedicaid: {
    id: "vamedicaid",
    name: "Virginia Medicaid Preferred Drug List / Common Core Formulary",
    publisher:
      "Virginia Department of Medical Assistance Services (DMAS), via its pharmacy benefits administrator",
    docs: "https://www.dmas.virginia.gov/for-providers/benefits-services-for-providers/pharmacy-and-drug-formularies/",
    baseUrl: "https://www.virginiamedicaidpharmacyservices.com",
    auth: "None. Public provider documents, no sign-in.",
    maxRequestsPerSecond: 1,
    maxConcurrency: 1,
    documentedLimit:
      "No published rate limit. Capped at 1 request/second because these are multi-megabyte PDFs served by a state contractor's portal.",
    updateCadence:
      "Quarterly effective dates (Jan/Apr/Jul/Oct) with interim revisions, each published as a separate versioned PDF. Superseded versions stay online in an archive section.",
    licensing:
      "Public documents published by a state agency for provider use. Retrieved as published; no redistribution of the PDFs themselves, only extracted assertions with citations.",
    establishes: [
      "Whether a drug name appears in the Preferred or Non-Preferred column of the Virginia Medicaid FFS PDL",
      "The drug class heading a listing sits under",
      "Service authorization criteria text printed alongside a class",
      "The document's own effective date and version string",
      "Page-level citations for every extracted assertion",
    ],
    cannotEstablish: [
      "Coverage under a Virginia Medicaid MANAGED CARE plan - those publish their own formularies",
      "Whether a specific person is enrolled, eligible, or would be approved",
      "That a drug absent from the PDL is not covered - the list covers only selected drug classes",
      "Any amount a member would pay",
      "Coverage in any other state",
    ],
  },

  /**
   * Novo Nordisk patient-facing program pages for its own products.
   *
   * A manufacturer is authoritative about its OWN program terms and nothing
   * else. It is not a source about coverage, and its eligibility statements
   * apply only to the program described on the page retrieved.
   */
  novocare: {
    id: "novocare",
    name: "NovoCare / Novo Nordisk patient assistance and savings programs",
    publisher: "Novo Nordisk Inc.",
    docs: "https://www.novocare.com/",
    baseUrl: "https://www.novocare.com",
    auth: "None for the public program pages. Enrollment and eligibility checking require an account and are NOT used.",
    maxRequestsPerSecond: 1,
    maxConcurrency: 1,
    documentedLimit: "No published rate limit. Capped at 1 request/second as a courtesy.",
    updateCadence:
      "Program terms change without notice and carry their own expiry dates. Treated as valid only as of the retrieval date.",
    licensing:
      "Manufacturer marketing and program pages. Terms are quoted with attribution, never paraphrased into a promise.",
    establishes: [
      "The program's own published eligibility terms, exclusions and expiry, as worded",
      "Which products a program names",
      "Official application and contact routes",
      "Whether the program is a savings offer or a payment-spreading arrangement",
    ],
    cannotEstablish: [
      "That any individual qualifies - only the operator can determine eligibility",
      "Any amount a specific person would pay",
      "That a program is still open or funded at any moment after retrieval",
      "Anything about a competitor's product or program",
    ],
  },
};

/** Default request timeout, per request, in milliseconds. */
export const REQUEST_TIMEOUT_MS = 45_000;

/** Bounded retry policy. */
export const RETRY = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  /** Status codes worth retrying. Everything else fails immediately. */
  retryableStatuses: [408, 425, 429, 500, 502, 503, 504] as const,
};


/** Pagination safety: never follow more pages than this for one query. */
export const MAX_PAGES = 20;

export const USER_AGENT =
  "mediz-data-pipeline/0.1 (hackathon prototype; contact: repository maintainer)";
