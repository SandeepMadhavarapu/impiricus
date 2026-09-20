import "server-only";
import { getCoverageConfig } from "@/shared/lib/config";
import {
  lookupFormulary,
  describeQuantityLimit,
  describePlan,
  type FormularySnapshot,
  type ProductConcepts,
} from "./formulary";
import { loadFormularySnapshot } from "./snapshot";
import { productConcepts } from "./concepts";
import {
  unknownField,
  type CoverageRequest,
  type CoverageResult,
  type NextStep,
} from "./types";

/**
 * Coverage adapters.
 *
 * The contract every adapter must honour:
 *
 *   - A failure of any kind (no credential, timeout, unmatched plan, stale
 *     data, malformed response) resolves to "unable-to-verify". A failure may
 *     never become a positive coverage result.
 *   - A field the source did not return stays null. Adapters never default a
 *     copay to zero or a tier to 1.
 *   - Sample data is flagged isSample: true and is only reachable when the
 *     operator explicitly opts in. It is never a fallback for a failed lookup.
 */

export interface CoverageAdapter {
  id: string;
  displayName: string;
  check(req: CoverageRequest, productLabel: string): Promise<CoverageResult>;
}

/** Real next steps that work no matter what the lookup returned. */
function universalNextSteps(req: CoverageRequest): NextStep[] {
  return [
    {
      label: "Ask your pharmacy to run a test claim",
      detail:
        "A pharmacy can submit a trial claim to your plan and tell you the actual amount you would pay. This is the only step that produces a binding answer.",
      href: null,
    },
    {
      label: "Call the member services number on your insurance card",
      detail:
        `Ask specifically about ${req.strength} ${req.dosageForm.toLowerCase()}, quantity ${req.quantity} for ${req.daysSupply} days. Coverage can differ by strength, form and quantity.`,
      href: null,
    },
    {
      label: "Check your plan's own drug list",
      detail:
        "Insurers publish a formulary (drug list) for each plan and year. Your plan's member portal is the authoritative source for your specific plan.",
      href: null,
    },
    {
      label: "Medicare Plan Finder (if you have Part D)",
      detail: "Medicare's official tool for comparing drug coverage and costs across Part D plans.",
      href: "https://www.medicare.gov/plan-compare/",
    },
  ];
}

const baseScope = (req: CoverageRequest, productLabel: string) => ({
  product: productLabel,
  strength: req.strength,
  dosageForm: req.dosageForm,
  quantity: req.quantity,
  daysSupply: req.daysSupply,
  plan: `${req.insurer}: ${req.planName}`,
  planYear: req.planYear,
});

/* ------------------------------------------------------------ unconfigured */

/**
 * The default. No payer or formulary integration is available to this
 * prototype, so the honest answer is that nothing could be verified.
 *
 * The full input flow still runs, so the shape of a real integration — and the
 * exact inputs it needs — is demonstrated end to end.
 */
export const unconfiguredAdapter: CoverageAdapter = {
  id: "unconfigured",
  displayName: "No coverage source connected",
  async check(req, productLabel) {
    return {
      state: "unable-to-verify",
      headline: "Unable to verify with the available connection",
      caveats: [
        "This prototype is not connected to any insurer, pharmacy benefit manager, or formulary database, so no part of your coverage could be checked.",
        "This is not a statement that the medication is uncovered. It means nothing was checked.",
      ],
      scope: baseScope(req, productLabel),
      formularyListing: unknownField(),
      tier: unknownField(),
      priorAuthorization: unknownField(),
      stepTherapy: unknownField(),
      quantityLimits: unknownField(),
      pharmacyRestrictions: unknownField(),
      effectiveDates: unknownField(),
      costEstimate: null,
      sourceTimestamp: null,
      nextSteps: universalNextSteps(req),
      isSample: false,
      adapter: "unconfigured",
    };
  },
};

/* ------------------------------------------------------------------ sample */

/**
 * Sample mode. Opt-in via ENABLE_SAMPLE_COVERAGE=true.
 *
 * Exists so the distinct result states can be demonstrated and tested. Every
 * result is flagged isSample and the UI renders a persistent banner. The plan
 * names below are fictional and are never presented as real payer data.
 */
export const sampleAdapter: CoverageAdapter = {
  id: "sample",
  displayName: "Sample mode (fictional data)",
  async check(req, productLabel) {
    const scope = baseScope(req, productLabel);
    const steps = universalNextSteps(req);
    const stamp = "Sample dataset, not derived from any real plan document";

    // Deterministic scenario selection so demos and tests are reproducible.
    const scenario = pickScenario(req);

    switch (scenario) {
      case "restrictions":
        return {
          state: "restrictions-indicated",
          headline: "Listed on this sample formulary, with restrictions",
          caveats: [
            "Sample data. This does not reflect any real plan.",
            "A formulary listing is not confirmation of your personal coverage. Your eligibility, deductible and plan status were not checked.",
            "Restrictions mean your prescriber may need to submit additional information before the plan will pay.",
          ],
          scope,
          formularyListing: { value: "yes", source: stamp },
          tier: { value: "Tier 2 (preferred generic)", source: stamp },
          priorAuthorization: { value: "yes", source: stamp },
          stepTherapy: { value: "no", source: stamp },
          quantityLimits: { value: "30 tablets per 30 days", source: stamp },
          pharmacyRestrictions: { value: "Retail and mail order", source: stamp },
          effectiveDates: { value: `${req.planYear}-01-01 to ${req.planYear}-12-31`, source: stamp },
          // Deliberately null: a formulary document does not produce a price.
          costEstimate: null,
          sourceTimestamp: stamp,
          nextSteps: steps,
          isSample: true,
          adapter: "sample",
        };

      case "not-listed":
        return {
          state: "not-listed-on-checked-formulary",
          headline: "Not found on the sample formulary that was checked",
          caveats: [
            "Sample data. This does not reflect any real plan.",
            "Not being listed does not mean the medication is definitively not covered. The drug list checked may be the wrong plan or year, a different strength or form may be listed, or an exception process may apply.",
            "Your plan's member services line can confirm, and your prescriber can request a formulary exception.",
          ],
          scope,
          formularyListing: { value: "no", source: stamp },
          tier: unknownField(),
          priorAuthorization: unknownField(),
          stepTherapy: unknownField(),
          quantityLimits: unknownField(),
          pharmacyRestrictions: unknownField(),
          effectiveDates: { value: `${req.planYear}-01-01 to ${req.planYear}-12-31`, source: stamp },
          costEstimate: null,
          sourceTimestamp: stamp,
          nextSteps: steps,
          isSample: true,
          adapter: "sample",
        };

      case "listed":
      default:
        return {
          state: "formulary-listed",
          headline: "Listed on this sample formulary",
          caveats: [
            "Sample data. This does not reflect any real plan.",
            "A formulary listing is not confirmation of your personal coverage. Whether you actually pay less depends on your eligibility, deductible, and plan status, none of which were checked.",
            "The amount you pay is only final once a pharmacy submits a claim.",
          ],
          scope,
          formularyListing: { value: "yes", source: stamp },
          tier: { value: "Tier 1 (generic)", source: stamp },
          priorAuthorization: { value: "no", source: stamp },
          stepTherapy: { value: "no", source: stamp },
          quantityLimits: { value: "No limit recorded", source: stamp },
          pharmacyRestrictions: { value: "Retail and mail order", source: stamp },
          effectiveDates: { value: `${req.planYear}-01-01 to ${req.planYear}-12-31`, source: stamp },
          // Still null. A formulary listing does not tell us what YOU pay, and
          // inventing a copay here would be exactly the failure we guard against.
          costEstimate: null,
          sourceTimestamp: stamp,
          nextSteps: steps,
          isSample: true,
          adapter: "sample",
        };
    }
  },
};

type Scenario = "listed" | "restrictions" | "not-listed";

/**
 * Chooses a sample scenario from the request so each state is reachable in a
 * demo. Quantity/days-supply drive it, which also demonstrates that those
 * inputs genuinely change the answer.
 */
function pickScenario(req: CoverageRequest): Scenario {
  // A 90-day supply commonly trips quantity limits in real plans.
  if (req.daysSupply > 30 || req.quantity > 30) return "restrictions";
  if (/chewable|granule/i.test(req.dosageForm)) return "not-listed";
  return "listed";
}

/* ------------------------------------------------- CMS Part D formulary ---- */

/**
 * Real, plan-specific formulary evidence from the CMS public Part D dataset.
 *
 * This is genuine published data about a named plan. It is still NOT member
 * coverage, so a hit resolves to "formulary-listed" or
 * "restrictions-indicated" and NEVER to "member-benefit-response". No cost
 * estimate is ever produced: a formulary document does not know what you pay.
 *
 * `conceptsFor` resolves a slug to the RxNorm concepts that identify THAT
 * product. It is a parameter so tests can supply synthetic identities; the
 * app passes nothing and gets the committed ones.
 */
export function cmsFormularyAdapter(
  snapshot: FormularySnapshot,
  conceptsFor: (slug: string) => ProductConcepts | null = productConcepts
): CoverageAdapter {
  return {
    id: "cms-part-d-formulary",
    displayName: `CMS Part D formulary (${snapshot.cmsRelease})`,
    async check(req, productLabel) {
      const scope = baseScope(req, productLabel);
      const steps = universalNextSteps(req);
      const stamp = `CMS Part D public formulary file, release ${snapshot.cmsRelease}, retrieved ${snapshot.retrievedAt}`;

      const sharedCaveats = [
        "This is Medicare Part D formulary data published by CMS. It describes the plan's drug list, not your personal benefit.",
        "Your eligibility, enrolment status and deductible were not checked. Whether you actually pay less depends on all three.",
        "The amount you pay is only final once a pharmacy submits a claim.",
      ];

      const unverified = (headline: string, why: string[]): CoverageResult => ({
        state: "unable-to-verify",
        headline,
        caveats: [
          ...why,
          "This is not a statement that the medication is uncovered. It means nothing was checked.",
          "This dataset covers Medicare Part D plans only. Commercial and Medicaid plans are not in it.",
        ],
        scope,
        formularyListing: unknownField(),
        tier: unknownField(),
        priorAuthorization: unknownField(),
        stepTherapy: unknownField(),
        quantityLimits: unknownField(),
        pharmacyRestrictions: unknownField(),
        effectiveDates: unknownField(),
        costEstimate: null,
        sourceTimestamp: stamp,
        nextSteps: steps,
        isSample: false,
        adapter: "cms-part-d-formulary",
      });

      // The product's own concepts, not every product's. Without them there is
      // nothing to look for, and the honest answer is that nothing was checked.
      const concepts = conceptsFor(req.slug);
      if (!concepts) {
        return unverified("Could not identify this product in the formulary data", [
          "No RxNorm concept identity is on file for this medication, so its formulary rows could not be looked up.",
        ]);
      }

      const result = lookupFormulary(
        snapshot,
        { planKey: req.planKey, insurer: req.insurer, planName: req.planName, planYear: req.planYear },
        concepts
      );

      // "no-snapshot" is unreachable — this adapter is only constructed with a
      // snapshot — but it means the same thing: nothing was checked.
      if (result.kind === "no-snapshot") {
        return unverified("No formulary data has been ingested", [
          "No CMS formulary snapshot is present, so nothing was checked. Run: npm run content:sync",
        ]);
      }

      if (result.kind === "year-mismatch") {
        return unverified(`The available formulary data is for ${result.coveredYear}, not ${result.requestedYear}`, [
          `The CMS release on file describes plan year ${result.coveredYear}. A ${result.requestedYear} plan's drug list can differ, so it was not checked against this data.`,
        ]);
      }

      if (result.kind === "plan-not-matched") {
        return unverified(
          req.planKey
            ? "That plan is not in the CMS dataset on file"
            : "Could not match that plan in the CMS dataset",
          [
            req.planKey
              ? "The exact plan you selected was not found in the CMS Part D formulary file on record, so nothing was checked."
              : "The plan name you entered did not confidently match any plan in the CMS Part D formulary file, so nothing was checked. Choosing your plan from the list avoids this.",
          ]
        );
      }

      // From here on a specific plan was identified. Echo THAT plan, with its
      // identifiers, so the answer names what was checked rather than what was
      // typed. 39 plans share one name in this release.
      const checkedScope = { ...scope, plan: describePlan(result.plan) };

      if (result.kind === "drug-not-listed") {
        return {
          state: "not-listed-on-checked-formulary",
          headline: `Not listed on the CMS formulary for ${result.plan.planName}`,
          caveats: [
            `We checked the published CMS drug list for "${describePlan(result.plan)}". Neither this product nor its generic equivalent was on it.`,
            "Not being listed does not mean the medication is definitively not covered. A different strength or form may be listed, the plan may have updated its list, or an exception process may apply.",
            "Your prescriber can request a formulary exception, and member services can confirm.",
            ...sharedCaveats.slice(1),
          ],
          scope: checkedScope,
          formularyListing: { value: "no", source: stamp },
          tier: unknownField(),
          priorAuthorization: unknownField(),
          stepTherapy: unknownField(),
          quantityLimits: unknownField(),
          pharmacyRestrictions: unknownField(),
          effectiveDates: unknownField(),
          costEstimate: null,
          sourceTimestamp: stamp,
          nextSteps: steps,
          isSample: false,
          adapter: "cms-part-d-formulary",
          matchGranularity: null,
        };
      }

      // result.kind === "listed"
      const { row, plan, granularity, concept } = result;
      const restricted = row.priorAuthorization || row.stepTherapy || row.quantityLimit;
      const generic = granularity === "clinical-drug";

      // A generic listing is real evidence, but about the generic. Say so in
      // the headline, not in a caveat nobody reads.
      const what = generic ? `The generic (${concept.name ?? "same strength and form"}) is listed` : "Listed";
      const headline = restricted
        ? `${what} on ${plan.planName}, with restrictions`
        : `${what} on the CMS formulary for ${plan.planName}`;

      const genericCaveats = generic
        ? [
            `The brand-name product itself is not on this plan's published list. The row found is for the generic clinical drug${concept.name ? ` "${concept.name}"` : ""}, which the plan may substitute or may require. Ask the pharmacy or the plan how a brand prescription is handled.`,
          ]
        : [];

      return {
        state: restricted ? "restrictions-indicated" : "formulary-listed",
        headline,
        caveats: [
          ...genericCaveats,
          ...(restricted
            ? [
                "Restrictions mean your prescriber may need to submit additional information, or try another medicine first, before the plan will pay.",
              ]
            : []),
          ...sharedCaveats,
        ],
        scope: checkedScope,
        formularyListing: { value: "yes", source: stamp },
        tier: { value: row.tier !== null ? `Tier ${row.tier}` : null, source: row.tier !== null ? stamp : null },
        priorAuthorization: { value: row.priorAuthorization ? "yes" : "no", source: stamp },
        stepTherapy: { value: row.stepTherapy ? "yes" : "no", source: stamp },
        quantityLimits: {
          value: describeQuantityLimit(row),
          source: describeQuantityLimit(row) !== null ? stamp : null,
        },
        // CMS formulary files do not publish pharmacy network restrictions in
        // the basic drugs file, so this stays unknown rather than guessed.
        pharmacyRestrictions: unknownField(),
        effectiveDates: unknownField(),
        // A formulary listing never produces a price. Never populate this.
        costEstimate: null,
        sourceTimestamp: stamp,
        nextSteps: steps,
        isSample: false,
        adapter: "cms-part-d-formulary",
        matchGranularity: granularity,
      };
    },
  };
}

/* ---------------------------------------------------------------- selector */

/**
 * Adapter precedence:
 *   1. real CMS formulary data, when the committed snapshot parses
 *   2. sample mode, only if the operator explicitly opted in
 *   3. unconfigured — honest "unable to verify"
 *
 * Real data always wins over sample data, so an operator cannot accidentally
 * demo fiction while genuine evidence is available.
 */
export function getCoverageAdapter(): CoverageAdapter {
  const snapshot = loadFormularySnapshot();
  if (snapshot) return cmsFormularyAdapter(snapshot);

  const config = getCoverageConfig();
  return config.provider === "sample" ? sampleAdapter : unconfiguredAdapter;
}

/**
 * Wraps an adapter call so that any throw or timeout degrades to
 * "unable-to-verify" rather than propagating, or worse, being swallowed into a
 * positive-looking result.
 */
export async function checkCoverageSafely(
  adapter: CoverageAdapter,
  req: CoverageRequest,
  productLabel: string,
  timeoutMs = 10_000
): Promise<CoverageResult> {
  try {
    const result = await Promise.race([
      adapter.check(req, productLabel),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("coverage-timeout")), timeoutMs)
      ),
    ]);
    return result;
  } catch (err) {
    const reason = err instanceof Error && err.message === "coverage-timeout" ? "timed out" : "failed";
    const fallback = await unconfiguredAdapter.check(req, productLabel);
    return {
      ...fallback,
      headline: "Unable to verify: the coverage lookup " + reason,
      caveats: [
        `The coverage lookup ${reason}. No coverage information was retrieved.`,
        "This is not a statement that the medication is uncovered, and it is not a statement that it is covered.",
      ],
      adapter: adapter.id,
    };
  }
}
