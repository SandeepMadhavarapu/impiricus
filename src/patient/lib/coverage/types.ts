import { z } from "zod";
import { SLUG_PATTERN, SLUG_MAX_LENGTH } from "@/shared/lib/slug";

/**
 * Insurance coverage.
 *
 * The real question is: "does THIS plan cover THIS product at THIS strength,
 * form, quantity and days' supply, and what can actually be verified?"
 *
 * Four different things get confused constantly, so they are modelled as
 * distinct evidence levels and never collapsed:
 *
 *   1. general formulary information  - a plan document says the drug is listed
 *   2. member eligibility + benefits  - this member's plan is active and covers it
 *   3. patient-specific cost estimate - what this member would pay
 *   4. pharmacy claim adjudication    - the final, binding answer
 *
 * A formulary listing is NOT member coverage. A member benefit response is NOT
 * a final price. Only a pharmacy claim is the real answer.
 */

export const DOSAGE_FORMS = [
  "TABLET, FILM COATED",
  "TABLET, CHEWABLE",
  "GRANULE",
] as const;

export const CoverageRequestSchema = z.object({
  slug: z.string().min(1).max(SLUG_MAX_LENGTH).regex(SLUG_PATTERN),
  insurer: z.string().min(2, "Enter your insurer").max(120),
  planName: z.string().min(2, "Enter your exact plan name").max(160),
  /**
   * Exact plan identity, present ONLY when the plan was chosen from the CMS
   * directory rather than typed.
   *
   * A plan name is not an identity: 39 plans in the 2026-08 release share the
   * name "AARP Medicare Rx Preferred from UHC (PDP)". This field is what
   * distinguishes "the person picked this exact contract, plan and segment"
   * from "the person typed some words", and an adapter may only treat the
   * former as resolved.
   *
   * It was previously sent by the form and silently dropped here, because zod
   * strips unknown keys by default, so the identity the picker worked to
   * collect never reached the server.
   */
  planKey: z
    .string()
    .max(64)
    .regex(/^[A-Za-z0-9-]+$/, "Invalid plan key")
    .optional(),
  planYear: z
    .number()
    .int()
    .min(2020, "Enter a plan year")
    .max(2100, "Enter a plan year"),
  /** Two-letter US state. Plan formularies vary by state for many insurers. */
  state: z
    .string()
    .regex(/^[A-Za-z]{2}$/, "Use a two-letter state code")
    .transform((s) => s.toUpperCase())
    .optional(),
  strength: z.string().min(1).max(60),
  dosageForm: z.string().min(1).max(60),
  quantity: z.number().int().positive("Quantity must be at least 1").max(1000),
  daysSupply: z.number().int().positive("Days' supply must be at least 1").max(365),
  pharmacyType: z.enum(["retail", "mail-order", "specialty", "unspecified"]).default("unspecified"),
});
export type CoverageRequest = z.infer<typeof CoverageRequestSchema>;

/**
 * Evidence state. This is the single most important type in the coverage flow.
 *
 * Note what is absent: there is no "covered" state. The strongest thing a
 * non-adjudicating source can say is that a member benefit response was
 * returned, and even that is not a filled prescription.
 */
export type CoverageEvidenceState =
  /** A member-specific benefit response was returned by an authorised source. */
  | "member-benefit-response"
  /** The drug appears on the checked plan formulary. Personal coverage unverified. */
  | "formulary-listed"
  /** Listed, but with restrictions such as prior authorisation or step therapy. */
  | "restrictions-indicated"
  /** Not found on the formulary that was checked. NOT the same as "not covered". */
  | "not-listed-on-checked-formulary"
  /** No usable source, a timeout, a plan that could not be matched, or stale data. */
  | "unable-to-verify";

export type TriState = "yes" | "no" | "unknown";

/**
 * A single verified field. `value` is null whenever the source did not supply
 * it. Rendering code must show "Not available" for null — never a zero, never
 * a blank that reads as "none".
 */
export interface CoverageField<T> {
  value: T | null;
  /** Where this specific field came from. */
  source: string | null;
}

export interface CostEstimate {
  /** Integer cents. A cost estimate with no amount is not a cost estimate. */
  amountCents: number;
  currency: "USD";
  /** e.g. "30-day retail fill, after deductible". */
  basis: string;
  source: string;
}

export interface CoverageResult {
  state: CoverageEvidenceState;
  /** One-line plain summary, matched to the evidence state. */
  headline: string;
  /** What this result does and does not establish. Always populated. */
  caveats: string[];
  /** The exact product + fill the answer applies to, echoed back. */
  scope: {
    product: string;
    strength: string;
    dosageForm: string;
    quantity: number;
    daysSupply: number;
    plan: string;
    planYear: number;
  };
  formularyListing: CoverageField<TriState>;
  tier: CoverageField<string>;
  priorAuthorization: CoverageField<TriState>;
  stepTherapy: CoverageField<TriState>;
  quantityLimits: CoverageField<string>;
  pharmacyRestrictions: CoverageField<string>;
  effectiveDates: CoverageField<string>;
  /** Null unless a real estimate was genuinely returned. */
  costEstimate: CostEstimate | null;
  /** When the underlying source data was published/retrieved. */
  sourceTimestamp: string | null;
  /** Real, actionable steps the user can take regardless of the result. */
  nextSteps: NextStep[];
  /** True only in explicitly-labelled Sample mode. */
  isSample: boolean;
  /** Which adapter produced this. */
  adapter: string;
}

export interface NextStep {
  label: string;
  detail: string;
  href: string | null;
}

/** An empty field — the default for everything a source did not tell us. */
export function unknownField<T>(): CoverageField<T> {
  return { value: null, source: null };
}

/**
 * Formats a cost for display.
 *
 * A null estimate must never render as "$0.00". Showing a fabricated zero copay
 * is one of the most damaging failures this flow could have.
 */
export function formatCost(estimate: CostEstimate | null): string {
  if (!estimate) return "Not available";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: estimate.currency,
  }).format(estimate.amountCents / 100);
}

/** Human-readable label per evidence state. */
export const EVIDENCE_LABELS: Record<CoverageEvidenceState, string> = {
  "member-benefit-response": "Member benefit response received",
  "formulary-listed": "Listed on this plan's formulary",
  "restrictions-indicated": "Listed with restrictions",
  "not-listed-on-checked-formulary": "Not found on the formulary we checked",
  "unable-to-verify": "Unable to verify",
};

/** Whether a state represents any positive coverage evidence. */
export function isPositiveEvidence(state: CoverageEvidenceState): boolean {
  return state === "member-benefit-response" || state === "formulary-listed";
}
