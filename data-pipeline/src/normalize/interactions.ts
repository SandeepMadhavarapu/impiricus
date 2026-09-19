import type { LabelSection } from "../schemas/index.js";
import { walkSections } from "./spl.js";
import { auditInteractions, type InteractionMention } from "./interactionAudit.js";
import type { ExtractionCompleteness } from "./interactionAudit.js";

/**
 * Drug interactions.
 *
 * The previous audit said "no interaction data is produced" because the RxNav
 * Interaction API is discontinued. That conflated two different things, and
 * verification showed the claim was wrong in a way that lost real evidence:
 *
 *   - A comprehensive INTERACTION-CHECKING SERVICE. We do not have one. RxNav's
 *     is discontinued (HTTP 404, re-probed at run time) and the commercial
 *     alternatives are licensed.
 *
 *   - LABEL-DESCRIBED INTERACTIONS. FDA labeling carries a Drug Interactions
 *     section (LOINC 34073-7). All three ingested products have one. Singulair
 *     carries 376 characters of it; Toprol XL carries three subsections plus a
 *     Highlights summary that the parser was silently dropping.
 *
 * Both facts are represented explicitly. An absent section is recorded as
 * absent with a reason — it is never rendered as "no interactions".
 */

/** LOINC code for the Drug Interactions section in SPL. */
export const DRUG_INTERACTIONS_LOINC = "34073-7";

export type InteractionAvailability =
  /** The label has a Drug Interactions section and we extracted it. */
  | "label-section-available"
  /** The label has the section but it yielded no usable text. */
  | "label-section-empty"
  /** This label has no Drug Interactions section at all. */
  | "no-label-section"
  /** We did not retrieve the label. */
  | "not-retrieved";

export interface InteractionEvidence {
  availability: InteractionAvailability;
  /**
   * Always false. No comprehensive interaction-checking service is connected.
   * This is a separate question from whether the label describes interactions.
   */
  checkingServiceAvailable: false;
  checkingServiceNote: string;
  /** The label's Drug Interactions section tree, hierarchy preserved. */
  sections: LabelSection[];
  /** Substances with direction, qualification and supporting sentence. */
  mentions: InteractionMention[];
  /**
   * The label states no DOSE ADJUSTMENT is needed for these. That is dosing
   * guidance; whether an interaction exists is UNKNOWN. Not a clearance.
   */
  noDoseAdjustmentStated: string[];
  /** The label states no interaction was OBSERVED for these. */
  noInteractionObservedStated: string[];
  describedInteraction: string[];
  /** How exhaustive the extraction is. Never "complete". */
  completeness: ExtractionCompleteness;
  /** What a consumer must not conclude from this. */
  caveats: string[];
}

const CHECKING_SERVICE_NOTE =
  "No comprehensive drug-interaction checking service is connected. The RxNav Interaction API was " +
  "discontinued and returns HTTP 404; commercial knowledge bases require a licence. The content here " +
  "is the interactions section of this product's own FDA label, which is not a substitute for a " +
  "checker run against a patient's full medication list.";

const BASE_CAVEATS = [
  "This is what THIS product's label describes. It is not a complete list of possible interactions.",
  "It has not been checked against any other medication a person may be taking.",
  "Absence of a substance here does not mean an interaction is impossible.",
  "A pharmacist can check a full medication list; this data cannot.",
];

/**
 * Extracts named interacting substances from label text.
 *
 * Deliberately narrow: it only harvests from explicit enumerations that follow
 * a coadministration phrase. It does not attempt to parse clinical meaning, and
 * over-extraction would be worse than under-extraction here.
 */
export function extractNamedSubstances(sections: LabelSection[]): string[] {
  const found = new Set<string>();
  const text = walkSections(sections)
    .flatMap((s) => [...s.paragraphs, ...s.highlights])
    .join(" ");

  // "co-administered with A, B, C, and D" / "when given with A, B and C"
  const listPattern =
    /(?:co-?administered with|given with|used with|combination with|concomitant use (?:of|with))\s+([^.;]{10,400})/gi;

  for (const match of text.matchAll(listPattern)) {
    const segment = match[1];
    if (!segment) continue;
    for (const rawItem of segment.split(/,|\band\b|\bor\b/)) {
      const item = rawItem
        .replace(/\([^)]*\)/g, " ")
        .replace(/\b(the|a|an|other|certain|such as|e\.g\.|including|agents?|drugs?|inhibitors?)\b/gi, " ")
        .replace(/[^A-Za-z0-9 -]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      // Single lowercase words that look like drug names or classes.
      if (item.length < 4 || item.length > 40) continue;
      if (/\d/.test(item)) continue;
      if (item.split(" ").length > 3) continue;
      found.add(item.toLowerCase());
    }
  }
  return [...found].sort();
}

/** Finds the Drug Interactions section tree in a label. */
export function findInteractionSections(sections: LabelSection[]): LabelSection[] {
  const all = walkSections(sections);
  // LOINC first — titles vary between labelers, codes do not.
  const byCode = sections.filter((s) => s.loincCode === DRUG_INTERACTIONS_LOINC);
  if (byCode.length > 0) return byCode;

  const byCodeNested = all.filter((s) => s.loincCode === DRUG_INTERACTIONS_LOINC);
  if (byCodeNested.length > 0) return byCodeNested;

  return all.filter((s) => /^\s*\d*\.?\d*\s*drug interactions?\b/i.test(s.title ?? ""));
}

export function buildInteractionEvidence(
  sections: LabelSection[] | null,
  /** Brand/generic names of this product, excluded from its own list. */
  selfNames: string[] = []
): InteractionEvidence {
  if (!sections) {
    return {
      availability: "not-retrieved",
      checkingServiceAvailable: false,
      checkingServiceNote: CHECKING_SERVICE_NOTE,
      sections: [],
      mentions: [],
      noDoseAdjustmentStated: [],
      noInteractionObservedStated: [],
      describedInteraction: [],
      completeness: {
        level: "index-only-not-exhaustive" as const,
        sentencesScanned: 0,
        sentencesWithCoadministrationPhrase: 0,
        sentencesYieldingSubstances: 0,
        sentencesUnparsed: 0,
        evidenceLocation: "No interaction section was available to scan.",
        note:
          "Nothing was extracted because there was nothing to extract from. This is not a " +
          "finding that the drug has no interactions.",
      },
      caveats: [
        "The label was not retrieved, so nothing is known about what it describes.",
        ...BASE_CAVEATS,
      ],
    };
  }

  const found = findInteractionSections(sections);

  if (found.length === 0) {
    return {
      availability: "no-label-section",
      checkingServiceAvailable: false,
      checkingServiceNote: CHECKING_SERVICE_NOTE,
      sections: [],
      mentions: [],
      noDoseAdjustmentStated: [],
      noInteractionObservedStated: [],
      describedInteraction: [],
      completeness: {
        level: "index-only-not-exhaustive" as const,
        sentencesScanned: 0,
        sentencesWithCoadministrationPhrase: 0,
        sentencesYieldingSubstances: 0,
        sentencesUnparsed: 0,
        evidenceLocation: "No interaction section was available to scan.",
        note:
          "Nothing was extracted because there was nothing to extract from. This is not a " +
          "finding that the drug has no interactions.",
      },
      caveats: [
        "This label does not contain a Drug Interactions section. That is a fact about the DOCUMENT, " +
          "not evidence that no interactions exist.",
        ...BASE_CAVEATS,
      ],
    };
  }

  const textLength = walkSections(found)
    .flatMap((s) => [...s.paragraphs, ...s.highlights])
    .join("").length;

  const audit = auditInteractions(found, selfNames);

  return {
    availability: textLength > 0 ? "label-section-available" : "label-section-empty",
    checkingServiceAvailable: false,
    checkingServiceNote: CHECKING_SERVICE_NOTE,
    sections: found,
    mentions: audit.mentions,
    noDoseAdjustmentStated: audit.noDoseAdjustmentStated,
    noInteractionObservedStated: audit.noInteractionObservedStated,
    describedInteraction: audit.describedInteraction,
    completeness: audit.completeness,
    caveats:
      textLength > 0
        ? [...audit.caveats, ...BASE_CAVEATS]
        : [
            "The Drug Interactions section exists but yielded no extractable text. Treat as unknown, " +
              "not as an absence of interactions.",
            ...BASE_CAVEATS,
          ],
  };
}
