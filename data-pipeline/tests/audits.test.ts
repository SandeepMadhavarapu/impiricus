import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { auditHighlights } from "@pipeline/normalize/highlightsAudit.js";
import { auditInteractions } from "@pipeline/normalize/interactionAudit.js";
import { parseSpl } from "@pipeline/normalize/spl.js";
import { SYNTHETIC_SPL_XML } from "./fixtures/synthetic-spl.js";
import type { LabelSection } from "@pipeline/schemas/index.js";

/**
 * Tests for the reconciliation work: highlights accounting and interaction
 * direction. Fixture-driven; no network.
 */

function section(overrides: Partial<LabelSection>): LabelSection {
  return {
    loincCode: "34073-7",
    printedNumber: "7",
    title: "7 DRUG INTERACTIONS",
    paragraphs: [],
    highlights: [],
    tables: [],
    subsections: [],
    appliesToProducts: [],
    applicability: "document-level-unresolved",
    audience: "professional",
    ...overrides,
  };
}

describe("highlights accounting", () => {
  const spl = parseSpl(SYNTHETIC_SPL_XML);

  it("reconciles a document with no excerpt blocks", () => {
    const r = auditHighlights(SYNTHETIC_SPL_XML, spl.sections);
    expect(r.totals.blocks).toBe(0);
    expect(r.reconciled).toBe(true);
  });

  it("classifies a retained block", () => {
    const xml = `<document><setId root="x"/><section><code code="34068-7" codeSystem="2.16.840.1.113883.6.1"/><title>2 DOSAGE</title><excerpt><highlight><text><paragraph>Administer once daily with food.</paragraph></text></highlight></excerpt></section></document>`;
    const r = auditHighlights(xml, [
      section({
        loincCode: "34068-7",
        title: "2 DOSAGE",
        highlights: ["Administer once daily with food."],
      }),
    ]);
    expect(r.totals.blocks).toBe(1);
    expect(r.blocks[0]!.disposition).toBe("retained");
    expect(r.reconciled).toBe(true);
  });

  /** A genuinely dropped block must be reported, not smoothed over. */
  it("reports a block whose text reached nothing as missing", () => {
    const xml = `<document><setId root="x"/><section><code code="34068-7" codeSystem="2.16.840.1.113883.6.1"/><title>2 DOSAGE</title><excerpt><highlight><text><paragraph>Completely unrelated wording nobody extracted anywhere.</paragraph></text></highlight></excerpt></section></document>`;
    const r = auditHighlights(xml, [section({ loincCode: "34068-7", highlights: [] })]);
    expect(r.blocks[0]!.disposition).toBe("missing");
    expect(r.reconciled).toBe(false);
    expect(r.totals.missingChars).toBeGreaterThan(0);
  });

  /**
   * Reordering must not read as loss. `collectText` hoists inline
   * cross-reference numbers, so token coverage is the correct measure.
   */
  it("treats reordered cross-references as retained, not missing", () => {
    const xml = `<document><setId root="x"/><section><code code="34068-7" codeSystem="2.16.840.1.113883.6.1"/><title>2 DOSAGE</title><excerpt><highlight><text><paragraph>Administer once weekly at any time of day. ( 2.1 )</paragraph></text></highlight></excerpt></section></document>`;
    const r = auditHighlights(xml, [
      section({
        loincCode: "34068-7",
        highlights: ["2.1 Administer once weekly at any time of day. ()"],
      }),
    ]);
    expect(r.blocks[0]!.disposition).toBe("retained");
  });

  it("routes table content away from highlights rather than calling it missing", () => {
    const xml = `<document><setId root="x"/><section><code code="34068-7" codeSystem="2.16.840.1.113883.6.1"/><title>T</title><excerpt><highlight><text><table><tbody><tr><td>Age</td><td>Dose</td></tr></tbody></table></text></highlight></excerpt></section></document>`;
    const r = auditHighlights(xml, [section({ loincCode: "34068-7" })]);
    expect(r.blocks[0]!.disposition).toBe("excluded-table");
    expect(r.blocks[0]!.tableChars).toBeGreaterThan(0);
    expect(r.reconciled).toBe(true);
  });

  it("distinguishes the raw indentation measure from the collapsed one", () => {
    const xml = `<document><setId root="x"/><section><code code="1" codeSystem="2.16.840.1.113883.6.1"/><excerpt><highlight><text>
      <paragraph>
         Spaced   out    text.
      </paragraph>
    </text></highlight></excerpt></section></document>`;
    const r = auditHighlights(xml, [section({ loincCode: "1", highlights: ["Spaced out text."] })]);
    // The crude measure counts whitespace; the collapsed one does not.
    expect(r.totals.rawWithIndentation).toBeGreaterThan(r.totals.sourceCollapsed);
  });
});

describe("interaction direction", () => {
  /**
   * The headline case: a "no dose adjustment" sentence is not a warning AND
   * not a clearance. It is dosing guidance, and the interaction status stays
   * unknown.
   */
  it("classifies a no-dose-adjustment sentence as dosing guidance, not absence", () => {
    const r = auditInteractions([
      section({
        paragraphs: [
          "No dose adjustment is needed when TESTDRUG is co-administered with theophylline, digoxin, and warfarin.",
        ],
      }),
    ]);
    expect(r.mentions.length).toBeGreaterThan(0);
    expect(r.mentions.every((m) => m.direction === "no-dose-adjustment-stated")).toBe(true);
    expect(r.mentions.every((m) => m.isAdverseInteraction === false)).toBe(true);
    // The critical assertion: dosing guidance never asserts absence.
    expect(r.mentions.every((m) => m.assertsNoInteraction === false)).toBe(true);
    expect(r.mentions.every((m) => m.isDosingGuidanceOnly === true)).toBe(true);
    expect(r.noDoseAdjustmentStated).toContain("warfarin");
    expect(r.noInteractionObservedStated).toHaveLength(0);
    expect(r.describedInteraction).toHaveLength(0);
  });

  /** An observed absence is a different claim and gets its own direction. */
  it("classifies an observed absence separately from dosing guidance", () => {
    const r = auditInteractions([
      section({
        paragraphs: [
          "TESTDRUG did not alter the pharmacokinetics of medicines given with it, including digoxin and warfarin.",
        ],
      }),
    ]);
    expect(r.mentions.length).toBeGreaterThan(0);
    expect(r.mentions.every((m) => m.direction === "no-interaction-observed-stated")).toBe(true);
    expect(r.mentions.every((m) => m.assertsNoInteraction === true)).toBe(true);
    expect(r.mentions.every((m) => m.isDosingGuidanceOnly === false)).toBe(true);
    expect(r.noInteractionObservedStated).toContain("warfarin");
    expect(r.noDoseAdjustmentStated).toHaveLength(0);
  });

  /**
   * Regression guard. The two negative directions must never collapse into
   * one another, in either direction.
   */
  it("keeps the two negative directions disjoint", () => {
    const dosing = auditInteractions([
      section({
        paragraphs: [
          "No dosage adjustment is required when TESTDRUG is used with atorvastatin and metformin.",
        ],
      }),
    ]);
    const observed = auditInteractions([
      section({
        paragraphs: [
          "No clinically significant effect was seen when TESTDRUG was used with atorvastatin and metformin.",
        ],
      }),
    ]);
    expect(dosing.counts["no-dose-adjustment-stated"]).toBeGreaterThan(0);
    expect(dosing.counts["no-interaction-observed-stated"]).toBe(0);
    expect(observed.counts["no-interaction-observed-stated"]).toBeGreaterThan(0);
    expect(observed.counts["no-dose-adjustment-stated"]).toBe(0);
  });

  it("warns in its caveats against reading dosing guidance as absence", () => {
    const r = auditInteractions([
      section({ paragraphs: ["No dose adjustment is needed when X is given with warfarin."] }),
    ]);
    expect(r.caveats.join(" ")).toMatch(/DOSING GUIDANCE, not a statement that no interaction/i);
  });

  it("classifies the other drug acting on this one", () => {
    const r = auditInteractions([
      section({
        paragraphs: [
          "CYP2D6 Inhibitors are likely to increase metoprolol concentration when given with beta-blocking agents.",
        ],
      }),
    ]);
    expect(r.mentions.some((m) => m.direction === "other-affects-this")).toBe(true);
  });

  it("classifies this drug acting on the other", () => {
    const r = auditInteractions([
      section({
        paragraphs: [
          "TESTDRUG delays gastric emptying and may impact the absorption of medicines used with it, including levothyroxine.",
        ],
      }),
    ]);
    expect(r.mentions.some((m) => m.direction === "this-affects-other")).toBe(true);
  });

  it("carries the sentence and qualifiers with every substance", () => {
    const r = auditInteractions([
      section({
        paragraphs: [
          "Caution should be exercised when oral medications are concomitantly administered with amiodarone.",
        ],
      }),
    ]);
    const m = r.mentions[0];
    expect(m).toBeDefined();
    expect(m!.supportingText).toMatch(/Caution should be exercised/);
    expect(m!.qualifiers.length).toBeGreaterThan(0);
  });

  it("excludes the product's own name from its interaction list", () => {
    const r = auditInteractions(
      [
        section({
          paragraphs: [
            "Caution should be exercised when oral medications are concomitantly administered with OZEMPIC.",
          ],
        }),
      ],
      ["OZEMPIC", "semaglutide"]
    );
    expect(r.mentions.map((m) => m.substance)).not.toContain("ozempic");
  });

  it("strips parenthetical residue such as a trailing 'e' from e.g.", () => {
    const r = auditInteractions([
      section({
        paragraphs: [
          "Patients receiving TESTDRUG in combination with an insulin secretagogue (e.g., sulfonylurea) may have increased risk.",
        ],
      }),
    ]);
    expect(r.mentions.map((m) => m.substance)).not.toContain("insulin secretagogue e");
  });

  it("returns nothing when no coadministration phrase is present", () => {
    const r = auditInteractions([section({ paragraphs: ["This section has no interaction list."] })]);
    expect(r.mentions).toHaveLength(0);
  });
});

describe("extraction completeness", () => {
  /** Zero extracted must never be readable as zero existing. */
  it("reports an empty extraction as index-only, never as complete", () => {
    const r = auditInteractions([
      section({ paragraphs: ["This section describes interactions only in prose."] }),
    ]);
    expect(r.mentions).toHaveLength(0);
    expect(r.describedInteraction).toHaveLength(0);
    expect(r.completeness.level).toBe("index-only-not-exhaustive");
    expect(r.completeness.note).toMatch(/ZERO WERE EXTRACTED/);
    expect(r.completeness.note).toMatch(/not evidence that none exist/i);
    expect(r.completeness.evidenceLocation).toMatch(/sections/);
  });

  it("counts the sentences it could not parse rather than hiding them", () => {
    const r = auditInteractions([
      section({
        paragraphs: [
          // Has a coadministration phrase but no enumeration to harvest.
          "Caution is advised when TESTDRUG is co-administered with agents that prolong the QT interval.",
        ],
      }),
    ]);
    expect(r.completeness.sentencesWithCoadministrationPhrase).toBeGreaterThan(0);
    expect(r.completeness.sentencesYieldingSubstances).toBe(0);
    expect(r.completeness.sentencesUnparsed).toBeGreaterThan(0);
  });

  it("accounts for every scanned sentence", () => {
    const r = auditInteractions([
      section({
        paragraphs: [
          "No dose adjustment is needed when TESTDRUG is co-administered with warfarin and digoxin.",
          "This sentence is unrelated to any interaction whatsoever.",
        ],
      }),
    ]);
    const c = r.completeness;
    expect(c.sentencesScanned).toBeGreaterThanOrEqual(c.sentencesWithCoadministrationPhrase);
    expect(c.sentencesWithCoadministrationPhrase).toBeGreaterThanOrEqual(
      c.sentencesYieldingSubstances
    );
    expect(c.sentencesUnparsed).toBe(
      c.sentencesWithCoadministrationPhrase - c.sentencesYieldingSubstances
    );
  });

  it("carries caveats warning against rendering names alone", () => {
    const r = auditInteractions([
      section({ paragraphs: ["No dose adjustment is needed when X is given with warfarin."] }),
    ]);
    expect(r.caveats.join(" ")).toMatch(/NOT automatically an adverse interaction/i);
    expect(r.caveats.join(" ")).toMatch(/incomplete index/i);
  });
});

describe("the committed records carry corrected interaction semantics", () => {
  it("Singulair's substances are dosing guidance, not warnings and not clearances", async () => {
    const file = path.join(process.cwd(), "data", "normalized", "singulair-montelukast-10mg-tablet.json");
    const r = JSON.parse(await readFile(file, "utf8"));
    expect(r.interactions.noDoseAdjustmentStated.length).toBeGreaterThan(0);
    expect(r.interactions.describedInteraction).toHaveLength(0);
    const mentions = r.interactions.mentions as Array<{
      isAdverseInteraction: boolean;
      assertsNoInteraction: boolean;
      supportingText: string;
    }>;
    expect(mentions.every((m) => !m.isAdverseInteraction)).toBe(true);
    // The label never asserts these do not interact; it says the dose stands.
    expect(mentions.every((m) => !m.assertsNoInteraction)).toBe(true);
    expect(mentions[0]!.supportingText).toMatch(/No dose adjustment is needed/i);
  });

  it("every record exports extraction completeness", async () => {
    const dir = path.join(process.cwd(), "data", "normalized");
    for (const f of (await readdir(dir)).filter((x) => x.endsWith(".json"))) {
      const r = JSON.parse(await readFile(path.join(dir, f), "utf8"));
      expect(r.interactions.completeness.level).toBe("index-only-not-exhaustive");
      expect(r.interactions.completeness.note).toMatch(/not evidence that none exist/i);
    }
  });

  it("no record exposes a bare namedSubstances list any more", async () => {
    const dir = path.join(process.cwd(), "data", "normalized");
    for (const f of (await readdir(dir)).filter((x) => x.endsWith(".json"))) {
      const r = JSON.parse(await readFile(path.join(dir, f), "utf8"));
      expect(r.interactions).not.toHaveProperty("namedSubstances");
      // The conflated field must not come back.
      expect(r.interactions).not.toHaveProperty("statedNoInteraction");
      expect(Array.isArray(r.interactions.mentions)).toBe(true);
    }
  });
});

describe("Part D scope accounting", () => {
  it("row arithmetic balances and identifiers are reconciled", async () => {
    const file = path.join(
      process.cwd(),
      "data",
      "normalized",
      "insurance",
      "cms-part-d-snapshot.json"
    );
    const snap = JSON.parse(await readFile(file, "utf8"));
    const s = snap.scope;
    expect(s.formularyRowsRetained + s.formularyRowsRejectedRxcuiFilter).toBe(s.formularyRowsRead);
    expect(s.formularyIdsWithoutPlan).toHaveLength(0);
    expect(s.membersFetched.length).toBeGreaterThan(0);
    expect(s.membersSkipped.length).toBeGreaterThan(0);
  });

  it("records the dates separately", async () => {
    const file = path.join(process.cwd(), "data", "normalized", "insurance", "cms-part-d-snapshot.json");
    const snap = JSON.parse(await readFile(file, "utf8"));
    expect(snap.release).toBeTruthy();
    expect(snap.modified).toBeTruthy();
    expect(snap.contractYear).toBeTruthy();
    expect(snap.retrievedAt).toBeTruthy();
    // Retrieval time must never equal the publication date by construction.
    expect(snap.retrievedAt).not.toBe(snap.modified);
  });
});
