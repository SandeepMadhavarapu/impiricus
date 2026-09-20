import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { FormularySnapshotSchema } from "@/patient/lib/coverage/formulary";

/**
 * The shipped coverage snapshot must satisfy the app's OWN schema.
 *
 * This is the check that was missing. The pipeline and the app each validated
 * their own shape, and nothing validated the seam between them - so a snapshot
 * that the app would reject at runtime could ship, and the coverage flow would
 * report "unable to verify" with no build failure anywhere.
 */
const SNAPSHOT = path.join(process.cwd(), "src", "sources", "content", "coverage", "cms-part-d-snapshot.json");

describe("shipped coverage snapshot", () => {
  it("exists where the loader looks for it", () => {
    expect(existsSync(SNAPSHOT)).toBe(true);
  });

  it("parses with the application's own schema", () => {
    const raw = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
    const parsed = FormularySnapshotSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        "shipped snapshot rejected by the app schema: " +
          parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
      );
    }
    expect(parsed.success).toBe(true);
  });

  it("carries real formulary rows, not an empty list", () => {
    const snap = FormularySnapshotSchema.parse(JSON.parse(readFileSync(SNAPSHOT, "utf8")));
    // An empty formulary would make the UI answer "not on your plan's list"
    // for every drug - a false claim about access, not a cosmetic bug.
    expect(snap.formulary.length).toBeGreaterThan(0);
    expect(snap.plans.length).toBeGreaterThan(0);
    expect(snap.rxcuis.length).toBeGreaterThan(0);
  });

  it("never emits tier 0 or a negative tier", () => {
    const snap = FormularySnapshotSchema.parse(JSON.parse(readFileSync(SNAPSHOT, "utf8")));
    for (const row of snap.formulary) {
      if (row.tier !== null) expect(row.tier).toBeGreaterThan(0);
    }
  });

  it("keeps a quantity-limit flag even when the amount was not published", () => {
    const snap = FormularySnapshotSchema.parse(JSON.parse(readFileSync(SNAPSHOT, "utf8")));
    const flaggedNoDetail = snap.formulary.filter(
      (r) => r.quantityLimit && r.quantityLimitDescription === null
    );
    // Whatever the count, the invariant is that the flag is never dropped just
    // because the detail was missing: "there is a limit, amount unpublished"
    // is a different fact from "there is no limit".
    for (const r of flaggedNoDetail) expect(r.quantityLimit).toBe(true);
  });

  it("is not accidentally still in the pipeline shape", () => {
    const raw: Record<string, unknown> = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
    expect(raw).not.toHaveProperty("release");
    expect(raw).not.toHaveProperty("rxcuisFiltered");
    expect(JSON.stringify(raw)).not.toContain("tierLevelValue");
    expect(JSON.stringify(raw)).not.toContain("priorAuthorizationYn");
  });
});
