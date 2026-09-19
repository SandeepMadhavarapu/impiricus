import { describe, it, expect } from "vitest";
import { getProperties, getHistoryStatus, interactionApiStatus } from "@pipeline/sources/rxnav.js";
import { getSplMetadata } from "@pipeline/sources/dailymed.js";
import { ndcByProductNdc } from "@pipeline/sources/openfda.js";
import { lookupProviders } from "@pipeline/sources/nppes.js";

/**
 * LIVE smoke checks. Excluded from the default test run (see vitest.config.ts)
 * and only executed with:
 *
 *   npm run test:live
 *
 * These hit real APIs, so they are reported separately from the fixture-driven
 * suite. A failure here means a source changed or is down — not that the
 * pipeline logic regressed.
 */

const live = process.env.LIVE === "1";
const maybe = live ? describe : describe.skip;

maybe("live: RxNav", () => {
  it("resolves the Singulair 10 mg concept", async () => {
    const props = await getProperties("153892", true);
    expect(props?.concept.tty).toBe("SBD");
    expect(props?.concept.name).toMatch(/montelukast/i);
  }, 60_000);

  it("reports the concept as current", async () => {
    const h = await getHistoryStatus("153892", true);
    expect(h.isCurrent).toBe(true);
  }, 60_000);

  /**
   * Documents reality rather than asserting a behaviour we want. NLM
   * discontinued this service; if it ever returns, the note changes and the
   * audit should be updated deliberately.
   */
  it("records the interaction API status", async () => {
    const status = await interactionApiStatus();
    expect(typeof status.available).toBe("boolean");
    console.log(`  interaction API: available=${status.available} http=${status.httpStatus}`);
  }, 60_000);
});

maybe("live: DailyMed", () => {
  it("returns SPL metadata for the Singulair set id", async () => {
    const meta = await getSplMetadata("482dcc92-b47f-4ea6-854a-f5ac2aea7842", true);
    expect(meta?.setId).toBe("482dcc92-b47f-4ea6-854a-f5ac2aea7842");
    expect(Number(meta?.splVersion)).toBeGreaterThanOrEqual(5);
  }, 60_000);
});

maybe("live: openFDA", () => {
  it("returns the NDC directory entry for 78206-172", async () => {
    const res = await ndcByProductNdc("78206-172", true);
    expect(res.entries[0]?.product_ndc).toBe("78206-172");
    expect(res.entries[0]?.application_number).toBe("NDA020829");
  }, 60_000);
});

maybe("live: NPPES", () => {
  it("rejects a non-selective query instead of bulk harvesting", async () => {
    await expect(lookupProviders({ state: "CA" }, true)).rejects.toThrow(/selective criterion/i);
  }, 60_000);

  it("returns a normalized result for a targeted query", async () => {
    const res = await lookupProviders({ lastName: "Smith", state: "CA", limit: 2 }, true);
    expect(res.limitations.length).toBeGreaterThan(0);
    expect(res.limitations.join(" ")).toMatch(/not proof of current licensure/i);
    for (const p of res.providers) expect(p.npi).toMatch(/^\d{10}$/);
  }, 60_000);
});
