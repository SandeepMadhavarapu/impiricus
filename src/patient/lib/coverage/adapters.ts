import "server-only";
import { getCoverageConfig } from "@/shared/lib/config";
import { productConcepts } from "@/sources/lib/content/catalogue";
import {
  lookupFormulary,
  describeQuantityLimit,
  type FormularySnapshot,
  type PlanIdentity,
} from "./formulary";
import { loadFormularySnapshot } from "./snapshot";
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
 * The fallback when no usable coverage source is available.
 *
 * This used to be the normal state and the copy said so ("not connected to any
 * ... formulary database"). It is not the normal state any more: the CMS Part D
 * snapshot is committed and loaded, so this adapter is now reached only when
 * that snapshot fails schema validation at startup. The wording below therefore
 * describes what is actually true - a source exists and could not be read -
 * rather than claiming there is no source at all.
 *
 * What has NOT changed: no payer or pharmacy benefit manager is connected, and
 * no adapter here adjudicates a member benefit. The full input flow still runs,
 * so the shape of a real integration and the exact inputs it needs are
 * demonstrated end to end.
 */
export const unconfiguredAdapter: CoverageAdapter = {
  id: "unconfigured",
  displayName: "No coverage source connected",
  async check(req, productLabel) {
    return {
      state: "unable-to-verify",
      headline: "Unable to verify with the available connection",
      caveats: [
        "No usable drug-list data was available, so no part of your coverage could be checked.",
        "This prototype is not connected to any insurer or pharmacy benefit manager. It cannot see your personal benefit under any circumstances.",
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
 */
export function cmsFormularyAdapter(snapshot: FormularySnapshot): CoverageAdapter {
  return {
    id: "cms-part-d-formulary",
    displayName: `CMS Part D formulary (${snapshot.cmsRelease})`,
    async check(req, productLabel) {
      const scope = baseScope(req, productLabel);
      const steps = universalNextSteps(req);
      const stamp = `CMS Part D public formulary file, release ${snapshot.cmsRelease}, retrieved ${snapshot.retrievedAt}`;
      /*
       * The RXCUIs of THIS medication - never every RXCUI in the snapshot.
       *
       * This previously passed `snapshot.rxcuis`, the union across every drug
       * the snapshot was built for. `lookupFormulary` takes the first row
       * matching the plan's formulary and ANY wanted RXCUI, so Singulair's
       * page reported Ozempic's tier, prior authorisation and quantity limit
       * ("Tier 3", "3 per 28 days") because that row happened to come first.
       *
       * It stayed invisible while the snapshot failed to load and every answer
       * was "unable to verify". Shipping the data turned a silent failure into
       * a confident wrong answer about a different medicine, which is worse.
       */
      /*
       * The concepts for THIS product, kept apart.
       *
       * Two earlier versions of this line were wrong in the same way, at
       * different scales. It first passed `snapshot.rxcuis` - every RXCUI in
       * the snapshot - so the Singulair page reported OZEMPIC's tier and
       * "3 per 28 days". Narrowing that to the product's own identifiers fixed
       * the cross-DRUG error but left a cross-PRESENTATION one: the authored
       * record's `product.rxcui` array holds eight concepts spanning 10 mg
       * tablets, 5 mg and 4 mg chewables and 4 mg granules, and it mixes the
       * branded concept with the generic one. The "Tier 1, no prior
       * authorisation, 30 per 30 days" a reader saw was rxcui 200224, the
       * GENERIC montelukast tablet. Brand Singulair is not on that plan's list
       * at all.
       *
       * So the brand is searched for FIRST and on its own. The generic is a
       * separate, clearly-labelled secondary answer, never merged into the
       * brand's fields.
       */
      const concepts = productConcepts(req.slug);
      const exact = concepts?.exact ?? null;
      const generic = concepts?.genericEquivalent ?? null;

      if (!exact) {
        // No identifiers for this product means the formulary cannot be
        // searched for it. Saying so is correct; searching for every drug and
        // returning whatever matched first is not.
        return {
          state: "unable-to-verify",
          headline: "This medication has no identifier to look up",
          caveats: [
            "This medication has no RxNorm identifier recorded, so its formulary status could not be searched for.",
            "This is not a statement that the medication is uncovered. Nothing was checked.",
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
        };
      }

      // Stage 1: the product the page is actually about.
      const result = lookupFormulary(
        snapshot,
        req.insurer,
        req.planName,
        [exact.rxcui],
        // The plan year is now checked against the release, rather than being
        // accepted, echoed back and ignored.
        req.planYear
      );

      /**
       * Says out loud when the plan was not uniquely identified.
       *
       * The lookup answers from a set of plans that share one drug list,
       * because the answer about the DRUG is then the same whichever is meant.
       * That is not the same as knowing which plan somebody is enrolled in: 39
       * plans carry the name "AARP Medicare Rx Preferred from UHC (PDP)" under
       * different contract and segment ids. Without this the headline reads as
       * a resolved enrolment, which the data does not support.
       */
      const identityCaveats = (identity: PlanIdentity): string[] =>
        identity.evidenceBasis === "exact-plan"
          ? []
          : [
              `Your plan was NOT individually identified. ${identity.matchedPlanCount} Medicare Part D ` +
                `plans in this release carry that name, across ${identity.contractIds.length} ` +
                `contract${identity.contractIds.length === 1 ? "" : "s"} ` +
                `(${identity.contractIds.slice(0, 4).join(", ")}${identity.contractIds.length > 4 ? ", and others" : ""}). ` +
                `Every one of them publishes the same thing about this product, so the drug-list ` +
                `answer below holds for all of them - but it is evidence about a group of plans, ` +
                `not a check of your enrolment, your benefit or your cost.`,
            ];

      /*
       * Wording that does not overclaim identity.
       *
       * "Not listed on the CMS formulary for X" and "This plan's list" both
       * read as a statement about ONE plan. When the answer rests on several
       * plans that agree, it is a statement about all of them, and the phrasing
       * has to say so - otherwise the caveat explaining that enrolment was not
       * determined contradicts the headline above it.
       */
      const planPhrase = (identity: PlanIdentity, name: string) =>
        identity.evidenceBasis === "exact-plan"
          ? `the CMS formulary for ${name}`
          : `the CMS formularies of the ${identity.matchedPlanCount} plans named "${name}"`;
      const theirList = (identity: PlanIdentity) =>
        identity.evidenceBasis === "exact-plan" ? "This plan's list" : "Those plans' lists";
      const theirListVerb = (identity: PlanIdentity) =>
        identity.evidenceBasis === "exact-plan" ? "DOES include" : "DO all include";

      const sharedCaveats = [
        "This is Medicare Part D formulary data published by CMS. It describes the plan's drug list, not your personal benefit.",
        "Your eligibility, enrolment status and deductible were not checked. Whether you actually pay less depends on all three.",
        "The amount you pay is only final once a pharmacy submits a claim.",
      ];

      // "no-snapshot" is unreachable — this adapter is only constructed with a
      // snapshot — but both cases mean the same thing: nothing was checked.
      if (result.kind === "year-not-covered") {
        return {
          state: "unable-to-verify",
          headline: `This drug list is for ${result.coveredYear}, not ${result.requestedYear}`,
          caveats: [
            `You asked about a ${result.requestedYear} plan. The CMS release loaded here describes ` +
              `contract year ${result.coveredYear}, so nothing was checked. A drug list from a ` +
              `different year does not describe your plan.`,
            "This is not a statement that the medication is uncovered.",
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
        };
      }

      if (result.kind === "plan-not-matched" || result.kind === "no-snapshot") {
        return {
          state: "unable-to-verify",
          headline:
            result.kind === "no-snapshot"
              ? "No formulary data has been ingested"
              : result.reason === "ambiguous-evidence"
                ? "That name matches several plans that say different things"
                : result.reason === "missing-formulary-mapping"
                  ? "That name matches a plan whose drug list is not in this release"
                  : "Could not match that plan in the CMS dataset",
          caveats: [
            result.kind === "no-snapshot"
              ? "No CMS formulary snapshot could be read, so nothing was checked."
              : result.reason === "ambiguous-evidence"
                ? /*
                   * Answering here would mean picking one of several equally
                   * good matches and presenting it as theirs. They publish
                   * different tiers or restrictions for this product, so that
                   * is a coin toss dressed up as an answer.
                   */
                  "Several Medicare Part D plans match that name equally well and they publish different information about this product, so nothing was checked. Use the exact plan name on your card, including the contract number if it has one."
                : result.reason === "missing-formulary-mapping"
                  ? "At least one plan matching that name has no drug list in this CMS release, so there is nothing to check it against. Borrowing another plan's list would invent an answer."
                  : "The plan name you entered did not confidently match any plan in the CMS Part D formulary file, so nothing was checked.",
            "This is not a statement that the medication is uncovered. It means we could not identify your plan.",
            "This dataset covers Medicare Part D plans only. Commercial and Medicaid plans are not in it.",
            ...(result.kind !== "no-snapshot" && result.candidates.length > 0
              ? [`Plans with similar names: ${result.candidates.join("; ")}.`]
              : []),
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
        };
      }

      if (result.kind === "drug-not-listed") {
        /*
         * Stage 2: the same-strength, same-form GENERIC, as a separate product.
         *
         * A branded product missing from a Part D drug list while its generic
         * sits on tier 1 is the ordinary case, not an edge case. Saying only
         * "not listed" is a false negative that could stop someone filling a
         * prescription they can afford.
         *
         * But the generic's tier, prior authorisation and quantity limit are
         * the GENERIC's. They are reported in words, attributed to the named
         * RxNorm concept, and deliberately NOT written into this result's
         * tier/priorAuthorization/quantityLimits fields - those describe the
         * product the reader asked about, and for that product they are
         * genuinely unknown. Filling them in is exactly the brand/generic
         * collapse this whole path was rewritten to remove.
         *
         * INTEGRATION GAP: the existing coverage UI renders one product's
         * fields. It has no place to show a second product's structured
         * status, so this is carried as prose. See docs/LIMITATIONS.md.
         */
        const genericHit = generic
          ? lookupFormulary(snapshot, req.insurer, req.planName, [generic.rxcui])
          : null;
        const genericRow = genericHit?.kind === "listed" ? genericHit.row : null;

        const genericCaveats: string[] = [];
        if (generic && genericRow) {
          const bits: string[] = [];
          if (genericRow.tier !== null) bits.push(`tier ${genericRow.tier}`);
          bits.push(
            genericRow.priorAuthorization
              ? "prior authorisation required"
              : "no prior authorisation"
          );
          if (genericRow.stepTherapy) bits.push("step therapy required");
          const ql = describeQuantityLimit(genericRow);
          if (ql) bits.push(`quantity limit ${ql}`);
          genericCaveats.push(
            `${theirList(result.identity)} ${theirListVerb(result.identity)} the generic equivalent, "${generic.name}" ` +
              `(RxNorm ${generic.rxcui}): ${bits.join(", ")}. That is a different product ` +
              `from the one on this page, and those details describe the generic, not the brand.`,
            "Whether the generic can be substituted for your prescription is a decision for your prescriber and pharmacist."
          );
        } else if (generic) {
          genericCaveats.push(
            `The generic equivalent, "${generic.name}" (RxNorm ${generic.rxcui}), is not on this plan's list either.`
          );
        }

        return {
          state: "not-listed-on-checked-formulary",
          headline: `Not listed on ${planPhrase(result.identity, result.plan.planName)}`,
          caveats: [
            `We matched the name you gave to "${result.plan.planName}" and checked the published CMS drug list${result.identity.evidenceBasis === "exact-plan" ? "" : "s"}. ` +
              `"${exact.name}" (RxNorm ${exact.rxcui}), the product this page is about, was not on it.`,
            ...identityCaveats(result.identity),
            ...genericCaveats,
            "Not being listed does not mean the medication is definitively not covered. A different strength or form may be listed, the plan may have updated its list, or an exception process may apply.",
            "Your prescriber can request a formulary exception, and member services can confirm.",
            ...sharedCaveats.slice(1),
          ],
          scope,
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
        };
      }

      /*
       * result.kind === "listed" - and it is the EXACT product, because stage 1
       * searched only `exact.rxcui`. Nothing here can be the generic's row.
       */
      const { row, plan } = result;
      const restricted = row.priorAuthorization || row.stepTherapy || row.quantityLimit;

      return {
        state: restricted ? "restrictions-indicated" : "formulary-listed",
        headline: restricted
          ? result.identity.evidenceBasis === "exact-plan"
            ? `Listed on ${plan.planName}, with restrictions`
            : `Listed with restrictions on all ${result.identity.matchedPlanCount} plans named "${plan.planName}"`
          : `Listed on ${planPhrase(result.identity, plan.planName)}`,
        caveats: [
          // Name the concept that matched, so "listed" is checkable rather
          // than something the reader has to take on trust.
          `Matched on "${exact.name}" (RxNorm ${exact.rxcui}), the exact product this page describes.`,
          ...identityCaveats(result.identity),
          ...(restricted
            ? [
                "Restrictions mean your prescriber may need to submit additional information, or try another medicine first, before the plan will pay.",
              ]
            : []),
          ...sharedCaveats,
        ],
        scope,
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
      };
    },
  };
}

/* ---------------------------------------------------------------- selector */

/**
 * Adapter precedence:
 *   1. real CMS formulary data, when an ingested snapshot is present
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
