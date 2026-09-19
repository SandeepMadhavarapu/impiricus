import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { toExport, NOT_PROVIDED } from "@pipeline/export/appExport.js";
import { MedicationRecordSchema, type MedicationRecord } from "@pipeline/schemas/index.js";

/**
 * Export invariants, checked against the REAL records committed under
 * data/normalized. These are the guarantees teammates rely on.
 */

const NORMALIZED = path.join(process.cwd(), "data", "normalized");

async function loadRealRecords(): Promise<MedicationRecord[]> {
  let files: string[];
  try {
    files = (await readdir(NORMALIZED)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: MedicationRecord[] = [];
  for (const f of files) {
    out.push(MedicationRecordSchema.parse(JSON.parse(await readFile(path.join(NORMALIZED, f), "utf8"))));
  }
  return out;
}

const records = await loadRealRecords();

describe("committed records", () => {
  it("exist, so teammates never need to run ingestion", () => {
    expect(records.length).toBeGreaterThan(0);
  });

  it("validate against the schema", () => {
    // parse() above would have thrown; this asserts the count survived.
    expect(records.every((r) => r.schemaVersion === "1.0.0")).toBe(true);
  });
});

describe("clinical review is never claimed", () => {
  it("is false on every record", () => {
    for (const r of records) {
      expect(r.clinicalReview.reviewed).toBe(false);
      expect(r.clinicalReview.reviewedAt).toBeNull();
      expect(r.clinicalReview.reviewedBy).toBeNull();
    }
  });

  it("is false on every export", () => {
    for (const r of records) {
      expect(toExport(r).clinicalReview.reviewed).toBe(false);
    }
  });

  it("states that app-ready is not clinical approval", () => {
    for (const r of records) {
      expect(toExport(r).clinicalReview.note.toLowerCase()).toContain("not clinically approved");
    }
  });
});

describe("provenance is retained", () => {
  it("every label carries at least one provenance entry with a raw pointer and hash", () => {
    for (const r of records) {
      expect(r.label.provenance.length).toBeGreaterThan(0);
      for (const p of r.label.provenance) {
        expect(p.rawPath).toBeTruthy();
        expect(p.contentHash).toMatch(/^[0-9a-f]{64}$/);
        expect(p.retrievedAt).toBeTruthy();
      }
    }
  });

  /** Retrieval time must never stand in for the document's own date. */
  it("keeps the source effective date distinct from retrieval time", () => {
    for (const r of records) {
      const e = toExport(r);
      expect(e.freshness.sourceEffectiveDate).toBe(r.label.splEffectiveDate);
      expect(e.freshness.sourceEffectiveDate).not.toBe(e.freshness.ingestedAt);
    }
  });

  it("never persists a credential in a provenance URL", () => {
    for (const r of records) {
      for (const p of r.label.provenance) {
        expect(p.url).not.toMatch(/api_key=(?!REDACTED)/);
      }
    }
  });
});

describe("what the export refuses to provide", () => {
  it("lists the boundaries on every record", () => {
    for (const r of records) {
      const e = toExport(r);
      expect(e.notProvided).toEqual([...NOT_PROVIDED]);
    }
  });

  it("explicitly disclaims coverage, prescriptions and interactions", () => {
    const joined = NOT_PROVIDED.join(" ").toLowerCase();
    expect(joined).toContain("insurance coverage");
    expect(joined).toContain("prescription");
    expect(joined).toContain("interaction");
    expect(joined).toContain("incidence");
  });
});

describe("blocked records ship no label content", () => {
  it("omits sections and explains why when readiness is blocked", () => {
    const real = records[0];
    if (!real) return;
    const blocked = toExport({
      ...real,
      readiness: "blocked",
      resolution: { ...real.resolution, state: "conflicting", rationale: "synthetic block for test" },
    });
    expect(blocked.professionalLabeling).toEqual([]);
    expect(blocked.patientLabeling).toEqual([]);
    expect(blocked.blockedReason).toMatch(/conflicting/);
  });

  it("includes content when app-ready", () => {
    for (const r of records.filter((r) => r.readiness === "app-ready")) {
      expect(toExport(r).professionalLabeling.length).toBeGreaterThan(0);
    }
  });
});

describe("identity fidelity in the export", () => {
  it("keeps the denominator for ratio strengths", () => {
    const ozempic = records.find((r) => r.productKey.includes("ozempic"));
    if (!ozempic) return;
    const e = toExport(ozempic);
    expect(e.display.strengthDisplay).toMatch(/\/.*mL/);
  });

  it("keeps salt and active moiety separate", () => {
    for (const r of records) {
      const e = toExport(r);
      expect(e.display.labeledIngredient).toBeTruthy();
      // activeMoiety may be null, but when present it is its own field.
      expect(e.display).toHaveProperty("activeMoiety");
    }
  });

  it("lists every product the source document describes", () => {
    for (const r of records) {
      expect(toExport(r).document.productsInDocument.length).toBeGreaterThan(0);
    }
  });

  it("carries the resolution evidence so a reader can audit the match", () => {
    for (const r of records) {
      const e = toExport(r);
      expect(e.verification.evidence.length).toBeGreaterThan(0);
      expect(e.verification.resolutionState).toBe(r.resolution.state);
    }
  });
});

describe("approval facts stay product-scoped", () => {
  it("never merges another product's details into the matched product", () => {
    for (const r of records) {
      const e = toExport(r);
      if (!e.approval.available) continue;
      const others = e.approval.otherProductsInApplication.map((p) => p.productNumber);
      expect(others).not.toContain(e.approval.productNumber);
    }
  });
});
