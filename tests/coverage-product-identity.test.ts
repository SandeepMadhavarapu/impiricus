import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FormularySnapshotSchema, lookupFormulary } from "@/patient/lib/coverage/formulary";
import { cmsFormularyAdapter } from "@/patient/lib/coverage/adapters";
import {
  listGuides,
  guideProductName,
  productRxcuis,
  productConcepts,
} from "@/sources/lib/content/catalogue";
import type { CoverageRequest } from "@/patient/lib/coverage/types";

/**
 * A coverage answer must describe the medication that was asked about.
 *
 * The adapter used to pass `snapshot.rxcuis` - the union of every RXCUI in the
 * snapshot - into the formulary lookup, which returns the FIRST row matching
 * the plan's formulary and any wanted RXCUI. On a plan carrying more than one
 * of the tracked drugs, whichever row came first in the file won. Singulair's
 * page reported Ozempic's tier, prior authorisation and "3 per 28 days".
 *
 * This is the coverage-flow twin of the applicability bug fixed in
 * tests/label-applicability.test.ts: one product's facts presented on another
 * product's page. It was invisible for as long as the snapshot failed to load,
 * because every answer was "unable to verify"; shipping real data turned a
 * silent failure into a confident wrong answer, which is worse.
 *
 * These tests assert the property, not the specific rows, so they keep working
 * when CMS publishes a new release.
 */

const SNAPSHOT = path.join(
  process.cwd(),
  "src",
  "sources",
  "content",
  "coverage",
  "cms-part-d-snapshot.json"
);

const snapshot = FormularySnapshotSchema.parse(JSON.parse(readFileSync(SNAPSHOT, "utf8")));

/** A plan that carries rows for more than one tracked drug, so a union lookup goes wrong. */
function planWithMultipleTrackedDrugs() {
  const byFormulary = new Map<string, Set<string>>();
  for (const row of snapshot.formulary) {
    const set = byFormulary.get(row.formularyId) ?? new Set<string>();
    set.add(row.rxcui);
    byFormulary.set(row.formularyId, set);
  }
  // Group tracked RXCUIs by the medication that owns them.
  const owners = new Map<string, string>();
  for (const guide of listGuides()) {
    for (const rxcui of productRxcuis(guide.slug)) {
      owners.set(rxcui, guide.slug);
    }
  }
  for (const [formularyId, rxcuis] of byFormulary) {
    const slugs = new Set([...rxcuis].map((r) => owners.get(r)).filter(Boolean));
    if (slugs.size < 2) continue;
    const plan = snapshot.plans.find((p) => p.formularyId === formularyId && p.planName.length > 0);
    if (plan) return { plan, rxcuis };
  }
  return null;
}

function request(slug: string, insurer: string, planName: string): CoverageRequest {
  return {
    slug,
    insurer,
    planName,
    planYear: 2026,
    strength: "10 mg",
    dosageForm: "tablet",
    quantity: 30,
    daysSupply: 30,
    pharmacyType: "unspecified",
  };
}

describe("coverage answers belong to the medication that was asked about", () => {
  it("has a plan carrying two tracked drugs, or this test proves nothing", () => {
    // If the snapshot ever stops containing such a plan, the assertions below
    // would pass vacuously. Fail loudly instead of quietly losing the check.
    expect(planWithMultipleTrackedDrugs()).not.toBeNull();
  });

  it("never returns another product's formulary row", async () => {
    const found = planWithMultipleTrackedDrugs()!;
    const adapter = cmsFormularyAdapter(snapshot);

    for (const guide of listGuides()) {
      // The EXACT concept only. The generic equivalent is a different
      // product and its row must never satisfy a claim about this one.
      const concepts = productConcepts(guide.slug);
      const own = new Set(concepts?.exact ? [concepts.exact.rxcui] : []);
      if (own.size === 0) continue;

      const result = await adapter.check(
        request(guide.slug, found.plan.organizationName ?? "Unknown", found.plan.planName),
        guideProductName(guide)
      );

      if (result.state === "unable-to-verify") continue;

      const candidateRows = snapshot.formulary.filter(
        (r) => r.formularyId === found.plan.formularyId && own.has(r.rxcui)
      );

      // "not listed" is a legitimate answer when this product genuinely has no
      // row on this formulary - a brand whose generic is listed is the common
      // case, and the copy says so. It is only a defect the other way round.
      if (result.state === "not-listed-on-checked-formulary") {
        expect(
          candidateRows.length,
          `${guide.slug} was reported as not listed on formulary ${found.plan.formularyId}, ` +
            `but that formulary does carry a row for its own RXCUIs ${JSON.stringify([...own])}`
        ).toBe(0);
        continue;
      }

      // Anything that CLAIMS a listing must be backed by a row belonging to
      // this product. Claiming one from another drug's row is the bug.
      expect(
        candidateRows.length,
        `${guide.slug} produced state "${result.state}" on formulary ${found.plan.formularyId}, ` +
          `which carries no row for any of its own RXCUIs ${JSON.stringify([...own])}`
      ).toBeGreaterThan(0);

      // The reported tier, if any, must be one this product's own rows publish.
      const tier = result.tier?.value;
      if (typeof tier === "string" && /\d/.test(tier)) {
        const reported = Number(tier.replace(/\D+/g, ""));
        const ownTiers = candidateRows.map((r) => r.tier).filter((t): t is number => t !== null);
        expect(
          ownTiers,
          `${guide.slug} reported "${tier}" but its own rows publish ${JSON.stringify(ownTiers)}`
        ).toContain(reported);
      }

      // Same for the quantity limit sentence, which is the most concrete and
      // most dangerous thing to get from the wrong drug.
      const ql = result.quantityLimits?.value;
      if (typeof ql === "string" && ql.trim().length > 0) {
        const ownDescriptions = candidateRows
          .map((r) => r.quantityLimitDescription)
          .filter((d): d is string => typeof d === "string" && d.length > 0);
        if (ownDescriptions.length > 0) {
          expect(
            ownDescriptions.some((d) => ql.includes(d)),
            `${guide.slug} reported quantity limit "${ql}" but its own rows publish ${JSON.stringify(ownDescriptions)}`
          ).toBe(true);
        }
      }
    }
  });

  it("does not search the formulary at all when a product has no RXCUI", async () => {
    const found = planWithMultipleTrackedDrugs()!;
    const adapter = cmsFormularyAdapter(snapshot);
    // A slug the registry cannot resolve has no identifiers by definition.
    const result = await adapter.check(
      request("not-a-real-medication-slug", found.plan.organizationName ?? "Unknown", found.plan.planName),
      "Unknown product"
    );
    expect(result.state).toBe("unable-to-verify");
    // And it must not claim absence of coverage.
    expect(result.caveats.join(" ").toLowerCase()).toContain("not a statement that the medication is uncovered");
  });
});

/**
 * A plan NAME is not a plan identity, and the lookup must act like it.
 *
 * `matchScore` divides by the query's token count, so a short query wholly
 * contained in a long plan name scores a perfect 1.0. In the 2026-08 release,
 * insurer "Humana" with plan "Humana Gold Plus HMO" scored 1.000 against 308
 * plans spanning FOUR different formularies - and the lookup returned whichever
 * came first in the file. The tier, prior authorisation and quantity limit a
 * reader saw were decided by row order.
 */
describe("an ambiguous plan name is never answered", () => {
  /**
   * The rule is agreement, not a shared identifier.
   *
   * An earlier version refused whenever the tied plans pointed at different
   * formulary ids. That is both too strict and too weak: two different drug
   * lists publishing the same thing about a product give the same answer, and
   * pointing at the same id is not the same as that id HAVING an entry. The
   * test is now on the published evidence itself.
   */
  it("refuses when the tied plans publish different evidence", () => {
    // Built from the real snapshot so the shape is genuine: two plans with the
    // same name on formularies that disagree about this product.
    const a = snapshot.formulary.find((f) => f.rxcui === "200224" && f.tier === 1)!;
    const conflicting = {
      ...snapshot,
      plans: [
        { ...snapshot.plans[0]!, organizationName: "Twinned", planName: "Twinned Rx Plan", formularyId: "F-AAA", contractId: "S0001" },
        { ...snapshot.plans[0]!, organizationName: "Twinned", planName: "Twinned Rx Plan", formularyId: "F-BBB", contractId: "S0002" },
      ],
      formulary: [
        { ...a, formularyId: "F-AAA", tier: 1, priorAuthorization: false },
        { ...a, formularyId: "F-BBB", tier: 4, priorAuthorization: true },
      ],
    };
    const result = lookupFormulary(conflicting, "Twinned", "Twinned Rx Plan", ["200224"]);
    expect(result.kind).toBe("plan-not-matched");
    if (result.kind === "plan-not-matched") expect(result.reason).toBe("ambiguous-evidence");
  });

  /**
   * ...and refuses when a candidate has no drug list at all, rather than
   * borrowing a sibling's.
   */
  it("refuses when a tied plan has no formulary mapping", () => {
    const a = snapshot.formulary.find((f) => f.rxcui === "200224")!;
    const missing = {
      ...snapshot,
      plans: [
        { ...snapshot.plans[0]!, organizationName: "Halfmapped", planName: "Halfmapped Rx Plan", formularyId: "F-AAA", contractId: "S0001" },
        { ...snapshot.plans[0]!, organizationName: "Halfmapped", planName: "Halfmapped Rx Plan", formularyId: "F-NONE", contractId: "S0002" },
      ],
      formulary: [{ ...a, formularyId: "F-AAA" }],
    };
    const result = lookupFormulary(missing, "Halfmapped", "Halfmapped Rx Plan", ["200224"]);
    expect(result.kind).toBe("plan-not-matched");
    if (result.kind === "plan-not-matched") expect(result.reason).toBe("missing-formulary-mapping");
  });

  /**
   * The Humana case. 105 plans tie across three different formularies, every
   * one has a mapping, and all three publish the same thing about brand
   * Singulair - absent. The drug answer is identical for all of them, so it is
   * given, labelled as shared evidence.
   */
  it("answers across different formularies when they all agree", () => {
    const result = lookupFormulary(snapshot, "Humana", "Humana Gold Plus HMO", ["153892"]);
    expect(result.kind === "listed" || result.kind === "drug-not-listed").toBe(true);
    if (result.kind !== "listed" && result.kind !== "drug-not-listed") return;
    expect(result.identity.evidenceBasis).toBe("shared-evidence");
    expect(result.identity.resolved).toBe(false);
    expect(result.identity.formularyIds.length).toBeGreaterThan(1);
  });

  it("still answers when every equally-good match shares one drug list", () => {
    // 39 plans share this name, all on formulary 00026000, so the answer is
    // the same whichever is meant. Refusing here would be over-caution.
    const own = productRxcuis("singulair-montelukast-10mg-tablet");
    const result = lookupFormulary(
      snapshot,
      "UNITEDHEALTHCARE INS. CO. & UHC INS. CO. OF NY",
      "AARP Medicare Rx Preferred from UHC (PDP)",
      own
    );
    expect(result.kind).toBe("listed");
  });

  it("reports no-match, not ambiguity, for a name nothing resembles", () => {
    const result = lookupFormulary(snapshot, "Nonexistent Insurance Co", "Totally Made Up Plan", ["200224"]);
    expect(result.kind).toBe("plan-not-matched");
    if (result.kind === "plan-not-matched") expect(result.reason).toBe("no-match");
  });

  /**
   * The property, not the example: whenever the lookup DOES answer, every plan
   * that matched as well as the winner must point at the same drug list.
   */
  /**
   * The property, across real queries: whenever the lookup DOES answer, every
   * plan that matched as well as the winner must have a drug list AND publish
   * the same thing about the product. The oracle recomputes that from the
   * snapshot rather than asking the lookup.
   */
  it("only answers when every tied candidate agrees", () => {
    const queries: Array<[string, string]> = [
      ["Humana", "Humana Gold Plus HMO"],
      ["Aetna", "Aetna Better Health Commercial PPO"],
      ["Cigna", "Cigna Open Access Plus"],
      ["Blue Cross Blue Shield", "BCBS PPO Gold"],
      ["UNITEDHEALTHCARE INS. CO. & UHC INS. CO. OF NY", "AARP Medicare Rx Preferred from UHC (PDP)"],
      ["WELLCARE PRESCRIPTION INSURANCE, INC.", "Wellcare Value Script (PDP)"],
    ];
    const RX = "153892";

    const key = (t: string) =>
      t.toLowerCase().replace(/(inc|llc|the|plan|plans|health|insurance|company|co)/g, " ")
        .replace(/[^a-z0-9]+/g, " ").trim();
    const toks = (t: string) => new Set(key(t).split(" ").filter((x) => x.length > 2));
    // Independent restatement of the symmetric score.
    const score = (q: Set<string>, c: Set<string>) => {
      if (q.size === 0 || c.size === 0) return 0;
      let o = 0;
      for (const t of q) if (c.has(t)) o++;
      if (o === 0) return 0;
      const p = o / q.size;
      const r = o / c.size;
      return (2 * p * r) / (p + r);
    };

    for (const [insurer, planName] of queries) {
      const result = lookupFormulary(snapshot, insurer, planName, [RX]);
      if (result.kind !== "listed" && result.kind !== "drug-not-listed") continue;

      const q = toks(`${insurer} ${planName}`);
      let top = 0;
      for (const p of snapshot.plans) {
        top = Math.max(top, score(q, toks(`${p.organizationName ?? ""} ${p.planName}`)));
      }
      const tied = snapshot.plans.filter(
        (p) => score(q, toks(`${p.organizationName ?? ""} ${p.planName}`)) === top
      );

      const signatures = new Set(
        tied.map((p) => {
          const rows = snapshot.formulary.filter((f) => f.formularyId === p.formularyId);
          if (rows.length === 0) return "NO-MAPPING";
          const row = rows.find((f) => f.rxcui === RX);
          return row === undefined
            ? "absent"
            : JSON.stringify([
                row.tier,
                row.priorAuthorization,
                row.stepTherapy,
                row.quantityLimit,
                row.quantityLimitDescription,
              ]);
        })
      );

      expect(
        signatures.has("NO-MAPPING"),
        `"${insurer} / ${planName}" was answered although a tied plan has no drug list`
      ).toBe(false);
      expect(
        signatures.size,
        `"${insurer} / ${planName}" was answered although the ${tied.length} tied plans publish ` +
          `${signatures.size} different things about it`
      ).toBe(1);

      // ...and the result must say which basis it used.
      expect(result.identity.evidenceBasis).toBe(tied.length === 1 ? "exact-plan" : "shared-evidence");
    }
  });
});

/**
 * A shared drug list is not a resolved enrolment.
 *
 * The lookup will answer when several plans tie, provided they share one
 * formulary: the answer about the DRUG is then the same whichever is meant.
 * But 39 plans carry the name "AARP Medicare Rx Preferred from UHC (PDP)" in
 * the 2026-08 release under different contract and segment ids, and nothing in
 * a name says which one somebody holds. The result must say so rather than let
 * the headline read as an identified plan.
 */
describe("unresolved plan identity is stated, not implied", () => {
  it("reports how many plans tied, and that enrolment was not determined", () => {
    const own = productRxcuis("singulair-montelukast-10mg-tablet");
    const result = lookupFormulary(
      snapshot,
      "UNITEDHEALTHCARE INS. CO. & UHC INS. CO. OF NY",
      "AARP Medicare Rx Preferred from UHC (PDP)",
      own
    );
    expect(result.kind === "listed" || result.kind === "drug-not-listed").toBe(true);
    if (result.kind !== "listed" && result.kind !== "drug-not-listed") return;

    // Independent oracle: count the plans with that exact name directly.
    const sameName = snapshot.plans.filter(
      (p) => p.planName === "AARP Medicare Rx Preferred from UHC (PDP)"
    );
    expect(sameName.length).toBeGreaterThan(1);

    expect(result.identity.resolved).toBe(false);
    expect(result.identity.matchedPlanCount).toBeGreaterThan(1);
    expect(result.identity.contractIds.length).toBeGreaterThan(0);
  });

  it("carries that into what the reader is told", async () => {
    const adapter = cmsFormularyAdapter(snapshot);
    const r = await adapter.check(
      request(
        "singulair-montelukast-10mg-tablet",
        "UNITEDHEALTHCARE INS. CO. & UHC INS. CO. OF NY",
        "AARP Medicare Rx Preferred from UHC (PDP)"
      ),
      "Singulair"
    );
    const text = r.caveats.join(" ");
    expect(text).toMatch(/plans in this release carry that name/i);
    expect(text).toMatch(/NOT individually identified/i);
    expect(text).toMatch(/not a check of your enrolment/i);
  });

  it("every answered result agrees with its own identity claim", async () => {
    const adapter = cmsFormularyAdapter(snapshot);
    const cases: Array<[string, string]> = [
      ["UNITEDHEALTHCARE INS. CO. & UHC INS. CO. OF NY", "AARP Medicare Rx Preferred from UHC (PDP)"],
      ["Hamaspik", "Hamaspik Medicare Select (HMO D-SNP)"],
    ];
    for (const [insurer, planName] of cases) {
      const low = lookupFormulary(snapshot, insurer, planName, ["200224", "153892"]);
      if (low.kind !== "listed" && low.kind !== "drug-not-listed") continue;
      const r = await adapter.check(
        request("singulair-montelukast-10mg-tablet", insurer, planName),
        "Singulair"
      );
      const said = /plans in this release carry that name/i.test(r.caveats.join(" "));
      expect(
        said,
        `"${planName}" identity.resolved=${low.identity.resolved} but the caveat ${said ? "was" : "was not"} shown`
      ).toBe(!low.identity.resolved);
    }
  });
});

/**
 * A commercial plan name must not resolve to a Medicare plan.
 *
 * `matchScore` used to be `overlap / query.size`, which counts the query words
 * that matched and charges nothing for the ones that did not. "UnitedHealthcare
 * / UHC Choice Plus Commercial" therefore scored 0.600 - exactly the threshold -
 * against three Medicare D-SNP plans, a different market and a different
 * population, and the shared-formulary rule let it through.
 *
 * Expected outcomes below come from what the plan actually is, not from the
 * scorer: this dataset contains Medicare Part D only, so a commercial plan name
 * has no correct answer in it.
 */
describe("wrong-market queries are refused", () => {
  const commercial: Array<[string, string]> = [
    ["UnitedHealthcare", "UHC Choice Plus Commercial"],
    ["Blue Cross Blue Shield", "BCBS PPO Gold"],
    ["Aetna", "Aetna Better Health Commercial PPO"],
    ["Cigna", "Cigna Open Access Plus"],
  ];

  it.each(commercial)("does not answer for %s / %s", (insurer, planName) => {
    const result = lookupFormulary(snapshot, insurer, planName, ["200224", "153892"]);
    expect(
      result.kind,
      `"${planName}" resolved to a Medicare plan`
    ).toBe("plan-not-matched");
  });

  /** The counterexample: tightening must not break real plan names. */
  it.each([
    ["UNITEDHEALTHCARE INS. CO. & UHC INS. CO. OF NY", "AARP Medicare Rx Preferred from UHC (PDP)"],
    ["WELLCARE PRESCRIPTION INSURANCE, INC.", "Wellcare Value Script (PDP)"],
    ["Hamaspik", "Hamaspik Medicare Select (HMO D-SNP)"],
  ])("still resolves the real plan %s / %s", (insurer, planName) => {
    const result = lookupFormulary(snapshot, insurer, planName, ["200224", "153892"]);
    expect(
      result.kind === "listed" || result.kind === "drug-not-listed",
      `"${planName}" no longer resolves; got ${result.kind}`
    ).toBe(true);
  });

  /**
   * The asymmetry itself. A two-word fragment contained in a long plan name
   * scored a perfect 1.0 under the old formula, because nothing charged for
   * everything the plan said that the query did not. "UHC Choice" resolved to
   * one specific plan; it now scores 0.400 and resolves to nothing.
   */
  it.each([
    ["UHC", "Choice"],
    ["Wellcare", "Value"],
    ["Humana", "Gold"],
  ])("refuses a bare fragment like %s / %s", (insurer, planName) => {
    const result = lookupFormulary(snapshot, insurer, planName, ["200224", "153892"]);
    expect(
      result.kind,
      `"${insurer} ${planName}" is a fragment, not a plan name, and must not resolve`
    ).toBe("plan-not-matched");
  });

  /**
   * ...while a genuine plan name stays resolvable even carrying extra words.
   * Tightening in a way that rejected real input would be the worse failure,
   * so this is the counterexample that bounds the change.
   */
  it("still resolves an exact plan name carrying extra rider words", () => {
    const padded = lookupFormulary(
      snapshot,
      "UNITEDHEALTHCARE INS. CO. & UHC INS. CO. OF NY",
      "AARP Medicare Rx Preferred from UHC (PDP) dental vision rider",
      ["200224"]
    );
    expect(padded.kind).not.toBe("plan-not-matched");
  });
});
