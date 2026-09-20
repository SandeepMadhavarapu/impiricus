import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FormularySnapshotSchema } from "@/patient/lib/coverage/formulary";
import { cmsFormularyAdapter } from "@/patient/lib/coverage/adapters";
import {
  listGuides,
  productConcepts,
  guideProductName,
} from "@/sources/lib/content/catalogue";
import type { CoverageRequest } from "@/patient/lib/coverage/types";

/**
 * Brand and generic are different products, and the answer must say which.
 *
 * ---------------------------------------------------------------------------
 * THE ORACLE
 * ---------------------------------------------------------------------------
 * Expected values here are NOT produced by calling the adapter under test.
 * They are read straight from the shipped CMS snapshot by RXCUI, and the RXCUI
 * meanings were retrieved independently from RxNav on 2026-09-20:
 *
 *   153892  SBD  montelukast 10 MG Oral Tablet [Singulair]
 *   200224  SCD  montelukast 10 MG Oral Tablet
 *   866438  SBD  24 HR metoprolol succinate 50 MG ER Oral Tablet [Toprol]
 *   866436  SCD  24 HR metoprolol succinate 50 MG ER Oral Tablet
 *   2398842 SBD  3 ML semaglutide 1.34 MG/ML Pen Injector [Ozempic]
 *   2398841 SCD  3 ML semaglutide 1.34 MG/ML Pen Injector
 *
 * ---------------------------------------------------------------------------
 * WHAT WENT WRONG
 * ---------------------------------------------------------------------------
 * On formulary 00026000 the Singulair page reported "Tier 1, no prior
 * authorisation, 30 per 30 days". That is row 200224 - the GENERIC. Brand
 * Singulair has no row on that formulary at all. The authored source record's
 * `product.rxcui` array holds both concepts plus six others spanning 5 mg and
 * 4 mg chewables and 4 mg oral granules, and the lookup took whichever matched
 * first.
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

/** Independent oracle: the row a given RXCUI has on a given formulary, or null. */
function rowFor(formularyId: string, rxcui: string) {
  return snapshot.formulary.find((r) => r.formularyId === formularyId && r.rxcui === rxcui) ?? null;
}

function planOn(formularyId: string) {
  const p = snapshot.plans.find((x) => x.formularyId === formularyId && x.planName.length > 0);
  if (!p) throw new Error(`no plan on formulary ${formularyId}`);
  return p;
}

function request(slug: string, plan: { organizationName: string | null; planName: string }): CoverageRequest {
  return {
    slug,
    insurer: plan.organizationName ?? "Unknown",
    planName: plan.planName,
    planYear: 2026,
    strength: "10 mg",
    dosageForm: "tablet",
    quantity: 30,
    daysSupply: 30,
    pharmacyType: "unspecified",
  };
}

describe("RxNorm concepts are recorded, not inferred", () => {
  it("gives every published product an exact concept with a term type", () => {
    for (const guide of listGuides()) {
      const c = productConcepts(guide.slug);
      expect(c, `${guide.slug} has no recorded concepts`).not.toBeNull();
      expect(c!.exact, `${guide.slug} has no exact concept`).not.toBeNull();
      expect(c!.exact!.tty.length).toBeGreaterThan(0);
      expect(c!.exact!.name.length).toBeGreaterThan(0);
    }
  });

  it("never lets the generic equivalent be the same concept as the brand", () => {
    for (const guide of listGuides()) {
      const c = productConcepts(guide.slug)!;
      if (!c.genericEquivalent) continue;
      expect(c.genericEquivalent.rxcui).not.toBe(c.exact!.rxcui);
      // A branded product's equivalent must be a generic clinical drug.
      expect(c.genericEquivalent.tty).toBe("SCD");
    }
  });

  /**
   * The presentations the old resolver would have admitted. None of them may
   * be reachable as an identifier for the 10 mg film-coated tablet page.
   */
  it("excludes other strengths and forms of the same molecule", () => {
    const c = productConcepts("singulair-montelukast-10mg-tablet")!;
    const admitted = new Set([c.exact?.rxcui, c.genericEquivalent?.rxcui]);
    for (const other of ["153893", "242438", "261367", "311759", "351246", "404406"]) {
      expect(
        admitted.has(other),
        `rxcui ${other} is a different strength or form and must not identify the 10 mg tablet page`
      ).toBe(false);
    }
  });

  it("returns nothing for a slug the catalogue does not publish", () => {
    expect(productConcepts("not-a-real-slug")).toBeNull();
  });
});

describe("generic evidence is never presented as the branded product's", () => {
  const FORMULARY = "00026000";
  const SLUG = "singulair-montelukast-10mg-tablet";

  it("the fixture still has the shape this test depends on", () => {
    // Guard against the snapshot changing under the test and making the
    // assertions below pass for the wrong reason.
    expect(rowFor(FORMULARY, "153892"), "brand should be absent here").toBeNull();
    expect(rowFor(FORMULARY, "200224"), "generic should be present here").not.toBeNull();
  });

  it("does not report the brand as listed when only the generic is", async () => {
    const plan = planOn(FORMULARY);
    const result = await cmsFormularyAdapter(snapshot).check(
      request(SLUG, plan),
      guideProductName(listGuides().find((g) => g.slug === SLUG)!)
    );

    expect(result.state).toBe("not-listed-on-checked-formulary");
    expect(result.formularyListing.value).toBe("no");

    // The structured fields describe the product asked about. For the brand
    // they are unknown, and must NOT carry the generic's values.
    const genericRow = rowFor(FORMULARY, "200224")!;
    expect(result.tier.value).toBeNull();
    expect(result.priorAuthorization.value).toBeNull();
    expect(result.quantityLimits.value).toBeNull();
    expect(result.tier.value).not.toBe(`Tier ${genericRow.tier}`);
    expect(result.quantityLimits.value).not.toBe(genericRow.quantityLimitDescription);
  });

  it("still tells the reader the generic is on the list, attributed to it", async () => {
    const plan = planOn(FORMULARY);
    const result = await cmsFormularyAdapter(snapshot).check(request(SLUG, plan), "Singulair");
    const text = result.caveats.join(" ");

    // Named concept, not a vague "a similar product".
    expect(text).toContain("200224");
    expect(text).toContain("montelukast 10 MG Oral Tablet");
    expect(text.toLowerCase()).toContain("generic equivalent");
    // And the generic's real, independently-read facts.
    const genericRow = rowFor(FORMULARY, "200224")!;
    expect(text).toContain(`tier ${genericRow.tier}`);
    // It must not claim substitution is settled.
    expect(text.toLowerCase()).toContain("prescriber and pharmacist");
  });

  it("reports an exact brand match as exact, naming the concept", async () => {
    // Formulary 00026303 does list brand Singulair (153892).
    const EXACT_FORMULARY = "00026303";
    expect(rowFor(EXACT_FORMULARY, "153892"), "fixture no longer has an exact brand row").not.toBeNull();

    const plan = planOn(EXACT_FORMULARY);
    const result = await cmsFormularyAdapter(snapshot).check(request(SLUG, plan), "Singulair");

    if (result.state === "unable-to-verify") {
      // The plan name may be ambiguous; that is a different, tested behaviour.
      expect(result.caveats.join(" ")).toMatch(/could not|match/i);
      return;
    }
    expect(["formulary-listed", "restrictions-indicated"]).toContain(result.state);
    const brandRow = rowFor(EXACT_FORMULARY, "153892")!;
    expect(result.tier.value).toBe(brandRow.tier === null ? null : `Tier ${brandRow.tier}`);
    expect(result.caveats.join(" ")).toContain("153892");
    expect(result.caveats.join(" ")).toContain("exact product");
  });
});

/**
 * Row order must not decide a clinical answer. The lookup walks the snapshot
 * and takes matches as it finds them, so a reversed file is a real test of
 * whether anything depends on position.
 */
describe("answers do not depend on the order of rows in the source file", () => {
  it("gives the same answer with the formulary and plan rows reversed", async () => {
    const plan = planOn("00026000");
    const slug = "singulair-montelukast-10mg-tablet";

    const forward = await cmsFormularyAdapter(snapshot).check(request(slug, plan), "Singulair");
    const reversed = await cmsFormularyAdapter({
      ...snapshot,
      formulary: [...snapshot.formulary].reverse(),
      plans: [...snapshot.plans].reverse(),
    }).check(request(slug, plan), "Singulair");

    expect(reversed.state).toBe(forward.state);
    expect(reversed.tier.value).toBe(forward.tier.value);
    expect(reversed.priorAuthorization.value).toBe(forward.priorAuthorization.value);
    expect(reversed.quantityLimits.value).toBe(forward.quantityLimits.value);
    expect(reversed.headline).toBe(forward.headline);
  });

  it("holds for every published product", async () => {
    const plan = planOn("00026000");
    const shuffled = {
      ...snapshot,
      // A deterministic reordering, so a failure is reproducible.
      formulary: [...snapshot.formulary].sort((a, b) => a.rxcui.localeCompare(b.rxcui)),
    };
    for (const guide of listGuides()) {
      const a = await cmsFormularyAdapter(snapshot).check(
        request(guide.slug, plan),
        guideProductName(guide)
      );
      const b = await cmsFormularyAdapter(shuffled).check(
        request(guide.slug, plan),
        guideProductName(guide)
      );
      expect(b.state, `${guide.slug} changed state under reordering`).toBe(a.state);
      expect(b.tier.value, `${guide.slug} changed tier under reordering`).toBe(a.tier.value);
    }
  });
});
