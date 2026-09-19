import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  deriveColumnBoundaries,
  parsePdlClasses,
  findInPdl,
  typographyHint,
  columnFor,
  scopeCriteria,
  type ColumnBoundaries,
  type PdlCell,
} from "@pipeline/sources/vaMedicaid.js";
import {
  matchCard,
  redactForLog,
  mayDisplayFormularyEvidence,
  type FormularyDisplayContext,
} from "@pipeline/access/cardMatch.js";
import {
  classifyVersions,
  currentlyEffectiveVersion,
  upcomingVersion,
  type VaPdlVersionRef,
} from "@pipeline/sources/vaMedicaid.js";
import {
  compareSnapshots,
  entryKey,
  normalizeForComparison,
  summarizeChanges,
  type VersionSnapshot,
} from "@pipeline/access/changes.js";
import type { PlanIdentity } from "@pipeline/schemas/insurance.js";

/**
 * Adversarial cases for the access pipeline. Fixture-driven, no network.
 *
 * Each test here names a specific way this data could mislead someone, and
 * pins the behaviour that prevents it.
 */

const BOUNDS: ColumnBoundaries = {
  preferredX: 87,
  nonPreferredX: 223,
  saCriteriaX: 333,
  derivation: "fixture",
  headerEvidence: "Preferred Agents Non-Preferred Agents SA Criteria",
  headerPage: 1,
};

describe("PDL column semantics", () => {
  it("assigns cells to columns by x, not by order", () => {
    expect(columnFor(87, BOUNDS)).toBe("preferred");
    expect(columnFor(223, BOUNDS)).toBe("non-preferred");
    expect(columnFor(375, BOUNDS)).toBe("sa-criteria");
    // The SA header sits at x=628 but its content starts at 375. Binding to
    // the nearest header would file criteria as non-preferred drugs.
    expect(columnFor(375, BOUNDS)).not.toBe("non-preferred");
  });

  /**
   * Typography is a SECOND ENCODING inside the same file, not a second source.
   * It checks the parser; it cannot corroborate the fact.
   */
  it("reads typography as a parser cross-check, not as corroboration", () => {
    expect(typographyHint([{ text: "montelukast", bold: true, italic: false }])).toBe(
      "preferred-bold"
    );
    expect(typographyHint([{ text: "Singulair", bold: false, italic: true }])).toBe(
      "non-preferred-italic"
    );
    expect(typographyHint([{ text: "x", bold: false, italic: false }])).toBe("no-hint");
  });

  /**
   * The failure this prevents: "metoprolol succinate   Inderal XL" sits on one
   * baseline, but Inderal XL is propranolol. Reading the line as a row would
   * assert a therapeutic equivalence the document never makes.
   */
  it("keeps the two columns as independent lists, never as pairs", () => {
    const criteria: PdlCell[] = [];
    const blocks = parsePdlClasses(
      {
        url: null,
        sha256: "x",
        byteLength: 0,
        retrievedAt: "now",
        pageCount: 1,
        info: { title: null, creationDate: null, modificationDate: null, producer: null },
        pages: [
          {
            pageNumber: 1,
            width: 792,
            height: 612,
            lines: [
              line(1, 500, [run("Beta Blockers", 87, 140, true, false)], true, false),
              line(
                1,
                480,
                [
                  run("metoprolol succinate", 87, 110, true, false),
                  run("Inderal XL", 223, 60, false, true),
                ],
                false,
                false
              ),
            ],
          },
        ],
      } as never,
      BOUNDS
    );

    expect(blocks).toHaveLength(1);
    const b = blocks[0]!;
    expect(b.preferred.map((c) => c.text)).toEqual(["metoprolol succinate"]);
    expect(b.nonPreferred.map((c) => c.text)).toEqual(["Inderal XL"]);
    // Nothing in the structure pairs them.
    expect(Object.keys(b)).not.toContain("rows");
    expect(criteria).toHaveLength(0);
  });

  it("separates drug-specific criteria from class-level criteria", () => {
    const cells: PdlCell[] = [
      cell("Routine PDL edits", 1, 500),
      cell("*Clinical Criteria for Hemangeol", 1, 480),
      cell("Diagnosis of proliferating infantile hemangioma", 1, 460),
    ];
    const scoped = scopeCriteria(cells);
    expect(scoped[0]!.scope).toBe("class-level");
    expect(scoped[1]!.scope).toBe("drug-specific");
    expect(scoped[1]!.appliesToDrug).toMatch(/Hemangeol/);
    // The bullet inherits the drug-specific scope, so it cannot be offered as
    // every beta blocker's requirement.
    expect(scoped[2]!.scope).toBe("drug-specific");
    expect(scoped[2]!.appliesToDrug).toMatch(/Hemangeol/);
  });
});

describe("the committed Virginia Medicaid evidence", () => {
  it("does not read absence from the PDL as non-coverage", async () => {
    const f = path.join(process.cwd(), "data", "exports", "access", "access-policies.json");
    const a = JSON.parse(await readFile(f, "utf8"));
    const ozempic = a.policies.find(
      (p: any) =>
        p.benefitProgram === "medicaid-fee-for-service" && p.productKey.startsWith("ozempic")
    );
    expect(ozempic).toBeDefined();
    expect(ozempic.listingStatus).toBe("not-addressed-in-this-document");
    expect(ozempic.listingStatus).not.toBe("explicitly-excluded");
    expect(ozempic.listingStatusNote).toMatch(/NOT a finding that the drug is not covered/i);
    expect(ozempic.requirements).toHaveLength(0);
  });

  it("states a service authorization requirement without calling it a denial", async () => {
    const f = path.join(process.cwd(), "data", "exports", "access", "access-policies.json");
    const a = JSON.parse(await readFile(f, "utf8"));
    const singulair = a.policies.find(
      (p: any) =>
        p.benefitProgram === "medicaid-fee-for-service" && p.productKey.startsWith("singulair")
    );
    expect(singulair.listingStatus).toBe("non-preferred");
    const sa = singulair.requirements[0];
    expect(sa.statedText).toMatch(/not a denial and not an approval/i);
    expect(sa.evidence.locator).toMatch(/page \d+/);
  });

  it("never claims prior authorization is an approval", async () => {
    const f = path.join(process.cwd(), "data", "exports", "access", "access-policies.json");
    const a = JSON.parse(await readFile(f, "utf8"));
    for (const p of a.policies) {
      for (const r of p.requirements) {
        if (!/prior authorization/i.test(r.statedText)) continue;
        expect(r.statedText).toMatch(/not an approval|requirement to ask/i);
      }
    }
  });

  it("carries no member determination or clinical review anywhere", async () => {
    const f = path.join(process.cwd(), "data", "exports", "access", "access-policies.json");
    const a = JSON.parse(await readFile(f, "utf8"));
    expect(a.policies.length).toBeGreaterThan(0);
    for (const p of a.policies) {
      expect(p.memberEligibilityDetermined).toBe(false);
      expect(p.clinicallyReviewed).toBe(false);
    }
  });

  it("publishes only links that were verified to resolve", async () => {
    const f = path.join(process.cwd(), "data", "exports", "access", "access-policies.json");
    const a = JSON.parse(await readFile(f, "utf8"));
    expect(a.linkCheck.checked).toBeGreaterThan(0);
    for (const r of a.linkCheck.results) {
      if (r.ok) continue;
      // A failing link must explain itself rather than appear as official.
      expect(r.note.length).toBeGreaterThan(10);
    }
  });

  it("labels our own navigation suggestions as ours", async () => {
    const f = path.join(process.cwd(), "data", "exports", "access", "access-policies.json");
    const a = JSON.parse(await readFile(f, "utf8"));
    const suggested = a.policies
      .flatMap((p: any) => p.actions)
      .filter((x: any) => x.basis === "pipeline-suggested-navigation");
    expect(suggested.length).toBeGreaterThan(0);
    for (const s of suggested) expect(s.action).toMatch(/our (navigation )?suggestion/i);
  });
});

describe("insurance card matching", () => {
  const plans: PlanIdentity[] = [
    plan("medicare-partd-2026-S5820-034-000", "S5820", "034", "000", "AARP Medicare Rx Preferred"),
    plan("medicare-partd-2026-S5820-034-001", "S5820", "034", "001", "AARP Medicare Rx Preferred"),
  ];

  it("never resolves an exact plan from RxBIN/RxPCN alone", () => {
    const r = matchCard({ rxBin: "610097", rxPcn: "9999", rxGroup: "ACME" }, plans);
    expect(r.level).toBe("routing-identified");
    expect(r.mayLookUpCoverage).toBe(false);
    expect(r.candidates).toHaveLength(0);
    expect(r.explanation).toMatch(/not which plan/i);
  });

  it("never resolves an exact plan from a plan name", () => {
    const r = matchCard({ planName: "AARP Medicare Rx Preferred" }, plans);
    expect(r.level).toBe("plan-family-identified");
    expect(r.mayLookUpCoverage).toBe(false);
    expect(r.requiresUserSelection).toBe(true);
    expect(r.candidates.length).toBeGreaterThan(1);
  });

  /** Missing segment must not collapse two real plans into one answer. */
  it("refuses an exact plan when the segment is missing and segments differ", () => {
    const r = matchCard({ contractId: "S5820", planId: "034", planYear: 2026 }, plans);
    expect(r.level).toBe("plan-family-identified");
    expect(r.mayLookUpCoverage).toBe(false);
    expect(r.missingFields).toContain("segmentId");
  });

  it("resolves an exact plan only with contract, plan and segment", () => {
    const r = matchCard(
      { contractId: "S5820", planId: "034", segmentId: "000", planYear: 2026 },
      plans
    );
    expect(r.level).toBe("exact-plan-identified");
    expect(r.mayLookUpCoverage).toBe(true);
    expect(r.candidates).toHaveLength(1);
  });

  it("discards member id and group number rather than matching on them", () => {
    const r = matchCard({ memberId: "ZZ123456789", groupNumber: "GRP-42" }, plans);
    expect(r.level).toBe("nothing-identified");
    expect(r.ignoredPersonalFields).toEqual(["memberId", "groupNumber"]);
    // The value must not appear anywhere in the result.
    expect(JSON.stringify(r)).not.toContain("ZZ123456789");
    expect(JSON.stringify(r)).not.toContain("GRP-42");
  });

  it("redacts personal fields for logging", () => {
    const red = redactForLog({ memberId: "ZZ123456789", rxBin: "610097" });
    expect(red.memberId).toBe("<redacted>");
    expect(red.rxBin).toBe("610097");
    expect(JSON.stringify(red)).not.toContain("ZZ123456789");
  });
});

describe("source change detection", () => {
  const base = (items: VersionSnapshot["items"], parser = "p1"): VersionSnapshot => ({
    documentVersion: "v1",
    effectiveDate: "2026-07-01",
    contentHash: "aaa",
    parserVersion: parser,
    items,
  });

  it("treats a trademark symbol difference as formatting, not a change", () => {
    const a = base([item("fintepla", "non-preferred", "* Fintepla®")]);
    const b = {
      ...base([item("fintepla", "non-preferred", "* Fintepla")]),
      documentVersion: "v2",
      contentHash: "bbb",
    };
    const changes = compareSnapshots(a, b, { category: "preference-status", effectiveStatus: "in-effect", takesEffectOn: null });
    expect(changes).toHaveLength(0);
  });

  it("reports a genuine preference change as source content", () => {
    const a = base([item("cinryze", "preferred", "Cinryze")]);
    const b = {
      ...base([item("cinryze", "non-preferred", "Cinryze")]),
      documentVersion: "v2",
      contentHash: "bbb",
    };
    const changes = compareSnapshots(a, b, { category: "preference-status", effectiveStatus: "in-effect", takesEffectOn: null });
    expect(changes).toHaveLength(1);
    expect(changes[0]!.nature).toBe("source-content");
    expect(changes[0]!.note).toMatch(/preferred.*non-preferred/i);
  });

  /** A parser upgrade must never masquerade as the publisher acting. */
  it("refuses to attribute a difference to the publisher across parser builds", () => {
    const a = base([item("cinryze", "preferred", "Cinryze")], "p1");
    const b = {
      ...base([item("cinryze", "non-preferred", "Cinryze")], "p2"),
      documentVersion: "v2",
      contentHash: "bbb",
    };
    const changes = compareSnapshots(a, b, { category: "preference-status", effectiveStatus: "in-effect", takesEffectOn: null });
    expect(changes[0]!.nature).toBe("ambiguous-needs-review");
    expect(changes[0]!.verification).toBe("needs-human-review");
  });

  it("never marks a change as a patient notification", () => {
    const a = base([item("x", "preferred", "X")]);
    const b = { ...base([item("x", "non-preferred", "X")]), contentHash: "bbb" };
    for (const c of compareSnapshots(a, b, { category: "preference-status", effectiveStatus: "in-effect", takesEffectOn: null })) {
      expect(c.isPatientNotification).toBe(false);
    }
  });

  it("says removal is not exclusion", () => {
    const a = base([item("x", "preferred", "X")]);
    const b = { ...base([]), contentHash: "bbb" };
    const changes = compareSnapshots(a, b, { category: "formulary-listing", effectiveStatus: "in-effect", takesEffectOn: null });
    expect(changes[0]!.note).toMatch(/NOT the same as exclusion/i);
  });

  it("normalises footnote markers out of an entry key", () => {
    expect(entryKey("***Zoryve cream®")).toBe(entryKey("Zoryve cream"));
    expect(normalizeForComparison("A–B")).toBe("a-b");
  });

  it("summarises by nature", () => {
    const a = base([item("x", "preferred", "X")]);
    const b = { ...base([item("x", "non-preferred", "X")]), contentHash: "bbb" };
    const s = summarizeChanges(compareSnapshots(a, b, { category: "preference-status", effectiveStatus: "in-effect", takesEffectOn: null }));
    expect(s["source-content"]).toBe(1);
    expect(s["formatting-only"]).toBe(0);
  });
});

describe("published-version effectivity", () => {
  const refs: VaPdlVersionRef[] = [
    {
      slug: "later",
      effectiveDate: "2026-10-01",
      version: "v2",
      expectedFooterVersion: "10/01/2026 v2",
    },
    {
      slug: "earlier",
      effectiveDate: "2026-07-01",
      version: "v4",
      expectedFooterVersion: "07/01/2026 v4",
    },
  ];

  /**
   * The defect this pins: Virginia publishes each quarterly PDL weeks before
   * it takes effect. Taking the newest published file as current coverage
   * states next quarter's rules as today's.
   */
  it("does not treat the newest published version as current", () => {
    const cur = currentlyEffectiveVersion(refs, "2026-09-19");
    expect(cur?.ref.effectiveDate).toBe("2026-07-01");
    expect(cur?.ref.effectiveDate).not.toBe("2026-10-01");
  });

  it("marks a future-dated version upcoming, with days remaining", () => {
    const next = upcomingVersion(refs, "2026-09-19");
    expect(next?.ref.effectiveDate).toBe("2026-10-01");
    expect(next?.daysUntilEffective).toBe(12);
    expect(next?.effectivity).toBe("upcoming");
  });

  it("switches over once the effective date arrives", () => {
    expect(currentlyEffectiveVersion(refs, "2026-10-01")?.ref.effectiveDate).toBe("2026-10-01");
    expect(upcomingVersion(refs, "2026-10-01")).toBeNull();
  });

  it("classifies an older version as superseded", () => {
    const all = classifyVersions(refs, "2026-10-02");
    expect(all.find((v) => v.ref.effectiveDate === "2026-07-01")?.effectivity).toBe("superseded");
  });

  it("returns null rather than falling back when everything is future-dated", () => {
    expect(currentlyEffectiveVersion(refs, "2026-01-01")).toBeNull();
  });
});

describe("the committed exports separate current coverage from upcoming", () => {
  const read = async () =>
    JSON.parse(
      await readFile(
        path.join(process.cwd(), "data", "exports", "access", "access-policies.json"),
        "utf8"
      )
    );

  it("builds every Virginia policy from the version in force", async () => {
    const a = await read();
    const va = a.policies.filter((p: any) => p.benefitProgram === "medicaid-fee-for-service");
    expect(va.length).toBeGreaterThan(0);
    for (const p of va) {
      expect(p.sourceEffectivity.status).toBe("currently-effective");
    }
  });

  it("marks every detected change as upcoming, with its effective date", async () => {
    const c = JSON.parse(
      await readFile(
        path.join(process.cwd(), "data", "exports", "access", "source-changes.json"),
        "utf8"
      )
    );
    expect(c.changes.length).toBeGreaterThan(0);
    for (const ch of c.changes) {
      expect(ch.effectiveStatus).toBe("upcoming");
      expect(ch.takesEffectOn).toBeTruthy();
      expect(ch.isPatientNotification).toBe(false);
    }
  });

  /** Cinryze has NOT moved yet; it moves on the upcoming effective date. */
  it("words a future preference change in the future tense", async () => {
    const c = JSON.parse(
      await readFile(
        path.join(process.cwd(), "data", "exports", "access", "source-changes.json"),
        "utf8"
      )
    );
    const cinryze = c.changes.find((x: any) => /cinryze/i.test(x.subjectLabel));
    expect(cinryze).toBeDefined();
    expect(cinryze.note).toMatch(/currently in force/i);
    expect(cinryze.note).toMatch(/becomes/i);
    expect(cinryze.note).not.toMatch(/\bmoved from\b/i);
  });

  it("corroborates a column reading against a SEPARATE document", async () => {
    const a = await read();
    const singulair = a.policies.find(
      (p: any) =>
        p.benefitProgram === "medicaid-fee-for-service" && p.productKey.startsWith("singulair")
    );
    const c = singulair.independentCorroboration;
    expect(c).not.toBeNull();
    expect(c.result).toBe("consistent-with-non-preferred");
    // A different document, not the same file read twice.
    expect(c.documentUrl).toMatch(/PDLquick/i);
    expect(c.documentUrl).not.toMatch(/List-Criteria/i);
  });

  /** Absence from a preferred-only list proves nothing about an absent drug. */
  it("does not manufacture corroboration for a drug the PDL never mentions", async () => {
    const a = await read();
    const ozempic = a.policies.find(
      (p: any) =>
        p.benefitProgram === "medicaid-fee-for-service" && p.productKey.startsWith("ozempic")
    );
    expect(ozempic.independentCorroboration.result).toBe("not-applicable-drug-absent-from-pdl");
    expect(ozempic.independentCorroboration.note).toMatch(/adds no evidence/i);
  });

  it("keeps Virginia fee-for-service scope prominent on every policy", async () => {
    const a = await read();
    for (const p of a.policies.filter(
      (x: any) => x.benefitProgram === "medicaid-fee-for-service"
    )) {
      expect(p.scopeWarning).toMatch(/FEE-FOR-SERVICE ONLY/i);
      expect(p.scopeWarning).toMatch(/managed care/i);
    }
  });

  /** Unbound criteria must never become a drug-specific requirement. */
  it("keeps unbound SA criteria out of requirements", async () => {
    const a = await read();
    for (const p of a.policies.filter(
      (x: any) => x.benefitProgram === "medicaid-fee-for-service"
    )) {
      for (const r of p.requirements) {
        expect(r.statedText).not.toMatch(/hemangioma|hemangeol/i);
        expect(r.kind).not.toBe("clinical");
      }
    }
  });

  it("describes CMS model forms as templates, not the plan's own form", async () => {
    const a = await read();
    const partD = a.policies.filter((p: any) => p.benefitProgram === "medicare-part-d");
    const templates = partD
      .flatMap((p: any) => p.actions)
      .filter((x: any) => x.formType === "generic-model-template");
    expect(templates.length).toBeGreaterThan(0);
    const coverage = templates.find((x: any) => x.id === "partd-coverage-determination");
    expect(coverage.action).toMatch(/MODEL form|generic template/i);
    expect(coverage.action).toMatch(/not this plan's form/i);
    expect(coverage.routeApplicability).toBe("market-segment-standard-plan-form-may-differ");
  });

  it("separates what we implemented from what the source did", async () => {
    const m = JSON.parse(
      await readFile(
        path.join(process.cwd(), "data", "exports", "access", "capability-manifest.json"),
        "utf8"
      )
    );
    const assistance = m.notReadyToDisplay.find((x: any) => /assistance/i.test(x.capability));
    expect(assistance.implementationStatus).toBe("not-attempted");
    expect(assistance.sourceAvailability).toBe("not-assessed");
    // It must NOT claim the source was unavailable, because we never looked.
    expect(assistance.status).not.toBe("source-unavailable");
    expect(assistance.blocker).toMatch(/NO RETRIEVAL WAS ATTEMPTED/i);
  });
});

describe("displaying plan-specific formulary evidence", () => {
  const ok: FormularyDisplayContext = {
    planResolvedExactly: true,
    formularyIdOnPlanRecord: "00026000",
    formularyIdOnEvidence: "00026000",
    medicationMatchGranularity: "exact-product",
    requestedPlanYear: 2026,
    evidencePlanYear: 2026,
    sourceEffectivity: "currently-effective",
    coverageState: "conditional",
  };

  it("allows display when every condition holds", () => {
    const d = mayDisplayFormularyEvidence(ok);
    expect(d.mayDisplay).toBe(true);
    expect(d.blockedBy).toHaveLength(0);
    expect(d.personalBenefitsVerified).toBe(false);
  });

  /** The headline correction: resolving the plan is not enough on its own. */
  it("blocks display when the plan resolves but the formulary link does not", () => {
    const d = mayDisplayFormularyEvidence({ ...ok, formularyIdOnEvidence: "00099999" });
    expect(d.mayDisplay).toBe(false);
    expect(d.blockedBy.join(" ")).toMatch(/another plan's drug list/i);
  });

  it("blocks display when the plan record has no formulary at all", () => {
    const d = mayDisplayFormularyEvidence({ ...ok, formularyIdOnPlanRecord: null });
    expect(d.mayDisplay).toBe(false);
  });

  it("blocks a drug-class match and cautions an ingredient match", () => {
    expect(
      mayDisplayFormularyEvidence({ ...ok, medicationMatchGranularity: "drug-class" }).mayDisplay
    ).toBe(false);
    const ing = mayDisplayFormularyEvidence({ ...ok, medicationMatchGranularity: "ingredient" });
    expect(ing.mayDisplay).toBe(true);
    expect(ing.cautions.join(" ")).toMatch(/INGREDIENT level/i);
  });

  it("blocks a year mismatch", () => {
    const d = mayDisplayFormularyEvidence({ ...ok, evidencePlanYear: 2025 });
    expect(d.mayDisplay).toBe(false);
    expect(d.blockedBy.join(" ")).toMatch(/plan year/i);
  });

  it("blocks a source document that is not in force yet", () => {
    const d = mayDisplayFormularyEvidence({ ...ok, sourceEffectivity: "upcoming" });
    expect(d.mayDisplay).toBe(false);
    expect(d.blockedBy.join(" ")).toMatch(/not in force yet/i);
  });

  it("blocks an unusable lookup result", () => {
    expect(
      mayDisplayFormularyEvidence({ ...ok, coverageState: "source-unavailable" }).mayDisplay
    ).toBe(false);
  });

  it("never verifies personal benefits, whatever else holds", () => {
    for (const ctx of [ok, { ...ok, planResolvedExactly: false }]) {
      expect(mayDisplayFormularyEvidence(ctx).personalBenefitsVerified).toBe(false);
    }
    expect(mayDisplayFormularyEvidence(ok).explanation).toMatch(/not this person's benefit/i);
  });
});

/* ------------------------------------------------------------- helpers */

function run(text: string, x: number, width: number, bold: boolean, italic: boolean) {
  return {
    text,
    x,
    y: 0,
    width,
    fontHeight: 10,
    fontName: bold ? "T-BoldMT" : italic ? "T-ItalicMT" : "T",
    bold,
    italic,
  };
}

function line(
  pageNumber: number,
  y: number,
  runs: ReturnType<typeof run>[],
  allBold: boolean,
  allItalic: boolean
) {
  return {
    pageNumber,
    y,
    runs: runs.map((r) => ({ ...r, y })),
    text: runs.map((r) => r.text).join(" "),
    fontHeight: 10,
    allBold,
    allItalic,
  };
}

function cell(text: string, page: number, y: number): PdlCell {
  return {
    text,
    column: "sa-criteria",
    page,
    y,
    x: 375,
    smallType: false,
    typography: "no-hint",
    columnDisputed: false,
  };
}

function item(key: string, value: string, statedText: string) {
  return { key, subjectLabel: statedText, value, statedText, locator: "page 1" };
}

function plan(
  planKey: string,
  contractId: string,
  planId: string,
  segmentId: string,
  planName: string
): PlanIdentity {
  return {
    planKey,
    market: "medicare-part-d",
    planYear: 2026,
    contractId,
    planId,
    segmentId,
    formularyId: "00026000",
    hiosIssuerId: null,
    hiosPlanId: null,
    planVariant: null,
    stateCode: null,
    medicaidProgram: null,
    managedCarePlanId: null,
    organizationName: "UnitedHealthcare",
    planName,
    serviceArea: null,
  };
}
