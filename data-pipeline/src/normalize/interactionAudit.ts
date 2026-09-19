import type { LabelSection } from "../schemas/index.js";
import { walkSections } from "./spl.js";

/**
 * Interaction substance auditing.
 *
 * The defect this fixes: `extractNamedSubstances` returned a flat list of
 * names, and Singulair's list read
 *
 *   benzodiazepines, decongestants, digoxin, fexofenadine, gemfibrozil,
 *   itraconazole, oral contraceptives, prednisone, theophylline, warfarin...
 *
 * A consumer would reasonably render that as "interacts with warfarin". The
 * source sentence says the opposite:
 *
 *   "No dose adjustment is needed when SINGULAIR is co-administered with
 *    theophylline, prednisone, ... warfarin ..."
 *
 * That is an explicit statement of NO clinically significant interaction. A
 * bare name list inverts its meaning.
 *
 * Every substance now carries the sentence it came from and a classified
 * relationship, so direction and qualification survive extraction.
 */

export type InteractionDirection =
  /**
   * The label gives DOSING guidance: no dose adjustment is needed.
   *
   * This is NOT a statement that no interaction exists. A drug can interact
   * measurably and still need no dose change. Inferring absence of an
   * interaction from dosing guidance is exactly the inference this pipeline
   * must not make.
   */
  | "no-dose-adjustment-stated"
  /**
   * The label states that no interaction or no significant effect was
   * OBSERVED, e.g. "did not alter the pharmacokinetics of". This is an
   * assertion about the interaction itself.
   */
  | "no-interaction-observed-stated"
  /** The other drug affects this drug. */
  | "other-affects-this"
  /** This drug affects the other drug. */
  | "this-affects-other"
  /** An interaction is described without a clear direction. */
  | "interaction-described-direction-unclear"
  /** Mentioned in an interactions context with no assertion we can classify. */
  | "mentioned-unclassified";

export interface InteractionMention {
  substance: string;
  direction: InteractionDirection;
  /** The sentence the substance was extracted from, verbatim. */
  supportingText: string;
  /** Qualifiers preserved from the sentence, e.g. "use with caution". */
  qualifiers: string[];
  /** Section the sentence came from. */
  sectionTitle: string | null;
  loincCode: string | null;
  /**
   * True only when the label describes an interaction. False for dosing
   * guidance and for observed-no-interaction statements. Consumers must not
   * render a false value as a warning.
   */
  isAdverseInteraction: boolean;
  /**
   * True ONLY when the label states an interaction was not observed.
   * Deliberately false for "no dose adjustment is needed" — that sentence
   * says nothing about whether an interaction exists.
   */
  assertsNoInteraction: boolean;
  /**
   * True when the sentence is dosing guidance only. The interaction status
   * is UNKNOWN from this sentence.
   */
  isDosingGuidanceOnly: boolean;
}

export interface InteractionAuditResult {
  mentions: InteractionMention[];
  /** Counts by direction, for the report. */
  counts: Record<InteractionDirection, number>;
  /**
   * Substances for which the label states NO DOSE ADJUSTMENT is needed.
   * Interaction status is unknown for these — dosing guidance is not a
   * statement about interaction.
   */
  noDoseAdjustmentStated: string[];
  /** Substances for which the label states no interaction was OBSERVED. */
  noInteractionObservedStated: string[];
  /** Substances with a described interaction. */
  describedInteraction: string[];
  /** How exhaustive this extraction is. Never "complete". */
  completeness: ExtractionCompleteness;
  caveats: string[];
}

/**
 * Extraction completeness.
 *
 * A count of zero adverse mentions means the EXTRACTOR found none in the
 * sentences it could parse. It does not mean the label describes no adverse
 * interactions, and it certainly does not mean none exist. The full
 * interactions section is exported alongside and is the evidence.
 */
export interface ExtractionCompleteness {
  /** Always "index-only-not-exhaustive". There is no "complete" value. */
  level: "index-only-not-exhaustive";
  sentencesScanned: number;
  /** Sentences containing a coadministration phrase the extractor recognises. */
  sentencesWithCoadministrationPhrase: number;
  /** Sentences that yielded at least one substance. */
  sentencesYieldingSubstances: number;
  /** Sentences with a coadministration phrase that yielded nothing. */
  sentencesUnparsed: number;
  /** Where the actual evidence lives. */
  evidenceLocation: string;
  note: string;
}

/**
 * DOSING GUIDANCE. These sentences say a dose need not change.
 *
 * They do NOT say an interaction is absent, and must never be read that way.
 * A drug can interact measurably -- a real change in exposure -- and still
 * require no dose adjustment because the change is not large enough to matter
 * for dosing. Inferring "no interaction" from "no dose adjustment" is the
 * specific inference this module exists to prevent.
 */
const NO_DOSE_ADJUSTMENT_PATTERNS = [
  /\bno (?:dose|dosage) (?:adjustment|modification)s? (?:is |are |was |were )?(?:needed|required|necessary|recommended|warranted)\b/i,
  /\b(?:dose|dosage) (?:adjustment|modification)s? (?:is |are )?not (?:needed|required|necessary|recommended|warranted)\b/i,
  /\bno adjustment (?:of|in) (?:the )?(?:dose|dosage)\b/i,
];

/**
 * OBSERVED ABSENCE. These sentences assert something about the interaction
 * itself: it was looked for and not found, or was found not to be clinically
 * significant. This is the only family that supports "no interaction stated".
 */
const NO_INTERACTION_OBSERVED_PATTERNS = [
  /\bno clinically (?:significant|relevant|meaningful|important) (?:effect|interaction|change|difference)\b/i,
  /\bdid not (?:significantly )?(?:alter|change|affect|influence)\b/i,
  /\b(?:was|were) not (?:significantly )?(?:altered|changed|affected|influenced)\b/i,
  /\bhad no (?:significant |clinically significant )?effect\b/i,
  /\bno (?:significant )?interactions? (?:was|were|has been|have been|are|is) (?:observed|detected|reported|identified|found|seen|expected)\b/i,
  /\bno (?:pharmacokinetic )?interaction was (?:observed|detected|seen|found)\b/i,
];

/** The other drug acts on this one. */
const OTHER_AFFECTS_THIS = [
  /\b(?:are|is) likely to increase\b.*\bconcentration/i,
  /\binhibitors? (?:of )?\w+ (?:may|can|will) increase\b/i,
  /\b(?:increase|decrease|reduce)[sd]? (?:the )?(?:plasma )?(?:concentration|exposure|levels?) of (?:this|the) ?\w*\b/i,
  /\binducers? .*(?:reduce|decrease)\b/i,
];

/** This drug acts on the other. */
const THIS_AFFECTS_OTHER = [
  /\bdelays? gastric emptying\b/i,
  /\bmay impact (?:the )?absorption\b/i,
  /\b(?:increase|decrease|reduce)[sd]? (?:the )?(?:plasma )?(?:concentration|exposure|levels?) of\b/i,
];

const QUALIFIER_PATTERNS: Array<[RegExp, string]> = [
  [/\buse with caution\b/i, "use with caution"],
  // Labels phrase caution several ways. "Caution should be exercised" carries
  // the same clinical weight as "use with caution" and must not be dropped.
  [/\bcaution should be (?:exercised|used)\b/i, "caution advised"],
  [/\bexercise caution\b/i, "caution advised"],
  [/\bcaution\b/i, "caution mentioned"],
  [/\bmonitor(?:ing)?\b/i, "monitoring advised"],
  [/\bconsider\b/i, "consideration advised"],
  [/\bmay\b/i, "possibility, not certainty"],
  [/\bno dose adjustment is needed\b/i, "no dose adjustment needed"],
  [/\bin (?:drug )?interaction studies\b/i, "from interaction studies"],
  [/\bobserve\b/i, "observation advised"],
];

/** Splits prose into sentences without breaking on label cross-references. */
function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<![A-Z])(?<!e\.g)(?<!i\.e)\.\s+(?=[A-Z0-9•])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);
}

/**
 * Candidate substance names within a sentence.
 *
 * Conservative on purpose: it harvests from explicit enumerations following a
 * coadministration phrase, and drops generic nouns that are not substances.
 */
const NON_SUBSTANCE = new Set([
  "agents", "agent", "drugs", "drug", "inhibitors", "inhibitor", "inducers", "inducer",
  "medications", "medication", "products", "product", "therapy", "treatment", "enzyme",
  "enzymes", "receptor", "agonists", "antagonists", "other", "certain", "such", "including",
  "cytochrome", "hormones", "hypnotics", "contraceptives",
]);

function candidateSubstances(sentence: string, selfNames: string[] = []): string[] {
  const listPattern =
    /(?:co-?administered with|given with|used with|combination with|concomitant use (?:of|with)|coadministration with|administered with)\s+([^.;]{6,400})/gi;

  const found = new Set<string>();
  for (const m of sentence.matchAll(listPattern)) {
    const segment = m[1];
    if (!segment) continue;
    for (const raw of segment.split(/,|\band\b|\bor\b/)) {
      const item = raw
        .replace(/\([^)]*\)/g, " ")
        .replace(/\b(the|a|an|other|certain|such as|e\.g\.|including)\b/gi, " ")
        .replace(/[^A-Za-z0-9 -]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      // Strip residue left by removing a parenthetical, e.g.
      // "insulin secretagogue (e.g., sulfonylurea)" -> "insulin secretagogue e".
      const cleaned = item.replace(/\s+[a-z]$/, "").trim();
      if (cleaned.length < 4 || cleaned.length > 40) continue;
      if (/\d/.test(cleaned)) continue;
      if (cleaned.split(" ").length > 3) continue;
      // Drop bare generic nouns, keep multiword names like "oral contraceptives".
      if (cleaned.split(" ").length === 1 && NON_SUBSTANCE.has(cleaned)) continue;
      // The product itself is not an interacting substance.
      if (selfNames.some((n) => n.length > 2 && cleaned.includes(n))) continue;
      found.add(cleaned);
    }
  }
  return [...found];
}

/** Directions that describe an actual interaction. */
const ADVERSE_DIRECTIONS = new Set<InteractionDirection>([
  "other-affects-this",
  "this-affects-other",
  "interaction-described-direction-unclear",
  "mentioned-unclassified",
]);

/**
 * Detects that a sentence TALKS about coadministration, independently of
 * whether any substance could be pulled out of it. The gap between the two is
 * the extractor's blind spot, and is reported rather than hidden.
 */
const COADMINISTRATION_PHRASE =
  /co-?administered with|given with|used with|combination with|concomitant use (?:of|with)|coadministration with|administered with/i;

function classify(sentence: string): InteractionDirection {
  // Dosing guidance is checked FIRST and kept separate. "No dose adjustment is
  // needed" is advice about dosing, not evidence about interaction.
  if (NO_DOSE_ADJUSTMENT_PATTERNS.some((p) => p.test(sentence))) {
    return "no-dose-adjustment-stated";
  }
  if (NO_INTERACTION_OBSERVED_PATTERNS.some((p) => p.test(sentence))) {
    return "no-interaction-observed-stated";
  }
  if (OTHER_AFFECTS_THIS.some((p) => p.test(sentence))) return "other-affects-this";
  if (THIS_AFFECTS_OTHER.some((p) => p.test(sentence))) return "this-affects-other";
  if (/\binteract|\baffect|\bincrease|\bdecrease|\breduce|\bexacerbate/i.test(sentence)) {
    return "interaction-described-direction-unclear";
  }
  return "mentioned-unclassified";
}

function qualifiersIn(sentence: string): string[] {
  return QUALIFIER_PATTERNS.filter(([p]) => p.test(sentence)).map(([, label]) => label);
}

export function auditInteractions(
  sections: LabelSection[],
  /** Brand and generic names of THIS product, excluded from its own list. */
  selfNames: string[] = []
): InteractionAuditResult {
  const self = selfNames.map((n) => n.toLowerCase().trim()).filter(Boolean);
  const mentions: InteractionMention[] = [];

  let sentencesScanned = 0;
  let sentencesWithPhrase = 0;
  let sentencesYielding = 0;

  for (const section of walkSections(sections)) {
    const text = [...section.paragraphs, ...section.highlights].join(" ");
    if (text.trim().length === 0) continue;

    for (const sentence of sentences(text)) {
      sentencesScanned++;
      if (COADMINISTRATION_PHRASE.test(sentence)) sentencesWithPhrase++;

      const substances = candidateSubstances(sentence, self);
      if (substances.length === 0) continue;
      sentencesYielding++;

      const direction = classify(sentence);
      const qualifiers = qualifiersIn(sentence);

      for (const substance of substances) {
        mentions.push({
          substance,
          direction,
          supportingText: sentence,
          qualifiers,
          sectionTitle: section.title,
          loincCode: section.loincCode,
          isAdverseInteraction: ADVERSE_DIRECTIONS.has(direction),
          // Only an OBSERVED absence asserts there is no interaction. Dosing
          // guidance deliberately does not set this flag.
          assertsNoInteraction: direction === "no-interaction-observed-stated",
          isDosingGuidanceOnly: direction === "no-dose-adjustment-stated",
        });
      }
    }
  }

  const counts: Record<InteractionDirection, number> = {
    "no-dose-adjustment-stated": 0,
    "no-interaction-observed-stated": 0,
    "other-affects-this": 0,
    "this-affects-other": 0,
    "interaction-described-direction-unclear": 0,
    "mentioned-unclassified": 0,
  };
  for (const m of mentions) counts[m.direction]++;

  const uniq = (pred: (m: InteractionMention) => boolean) =>
    [...new Set(mentions.filter(pred).map((m) => m.substance))].sort();

  const completeness: ExtractionCompleteness = {
    level: "index-only-not-exhaustive",
    sentencesScanned,
    sentencesWithCoadministrationPhrase: sentencesWithPhrase,
    sentencesYieldingSubstances: sentencesYielding,
    sentencesUnparsed: Math.max(0, sentencesWithPhrase - sentencesYielding),
    evidenceLocation:
      "interactions.sections[] - the full label interaction sections, verbatim.",
    note:
      "This extractor only harvests names from explicit enumerations that follow a " +
      "coadministration phrase. Interactions written as prose, as a drug class, in a table, or " +
      "in any other section are NOT counted. A count of zero adverse mentions therefore means " +
      "ZERO WERE EXTRACTED. It does not mean the label describes no adverse interactions, and " +
      "it is not evidence that none exist. Read the full sections.",
  };

  return {
    mentions,
    counts,
    noDoseAdjustmentStated: uniq((m) => m.direction === "no-dose-adjustment-stated"),
    noInteractionObservedStated: uniq((m) => m.direction === "no-interaction-observed-stated"),
    describedInteraction: uniq((m) => m.isAdverseInteraction),
    completeness,
    caveats: [
      "A substance appearing here is NOT automatically an adverse interaction. Check " +
        "`direction` and `isAdverseInteraction` before rendering anything as a warning.",
      "`no-dose-adjustment-stated` is DOSING GUIDANCE, not a statement that no interaction " +
        "exists. The label says the dose need not change; it does not say the drugs do not " +
        "interact. Do not render it as 'no interaction'.",
      "`no-interaction-observed-stated` is the only direction where the label itself asserts an " +
        "interaction was not observed, and even then only for what was studied.",
      "`supportingText` is the sentence the substance came from. Render it; never render the " +
        "name alone.",
      "An empty list means nothing was EXTRACTED, not that there are no interactions. See " +
        "`completeness`: this list is an incomplete index and the full sections are the evidence.",
      "This is the label's own content. It has not been checked against any other medicine a " +
        "person takes, and no interaction-checking service is connected.",
    ],
  };
}

/** Markdown rendering for the verification report. */
export function renderInteractionAudit(
  perProduct: Array<{ productKey: string; result: InteractionAuditResult }>
): string {
  const lines: string[] = [];
  lines.push("## Interaction substance audit");
  lines.push("");
  lines.push(
    "Every extracted substance is tied to the sentence it came from and classified by direction. " +
      "Two kinds of negative statement are kept apart, because they are not the same claim:"
  );
  lines.push("");
  lines.push(
    "- **`no-dose-adjustment-stated`** - the label says the dose need not change. It says " +
      "**nothing** about whether an interaction exists. Interaction status is UNKNOWN."
  );
  lines.push(
    "- **`no-interaction-observed-stated`** - the label says an interaction was looked for and " +
      "not observed, or was found not to be clinically significant."
  );
  lines.push("");
  lines.push(
    "Collapsing the first into the second would make this pipeline assert an absence the source " +
      "never claimed. Singulair is exactly that case: all of its substances come from a dosing " +
      "sentence."
  );
  lines.push("");
  lines.push(
    "| Product | Mentions | No dose adjustment (status unknown) | No interaction observed | Other affects this | This affects other | Direction unclear |"
  );
  lines.push("|---|---:|---:|---:|---:|---:|---:|");
  for (const { productKey, result } of perProduct) {
    const c = result.counts;
    lines.push(
      "| " +
        productKey +
        " | " +
        result.mentions.length +
        " | " +
        c["no-dose-adjustment-stated"] +
        " | " +
        c["no-interaction-observed-stated"] +
        " | " +
        c["other-affects-this"] +
        " | " +
        c["this-affects-other"] +
        " | " +
        c["interaction-described-direction-unclear"] +
        " |"
    );
  }
  lines.push("");
  lines.push("### Extraction completeness");
  lines.push("");
  lines.push(
    "Zero extracted adverse mentions is a statement about the EXTRACTOR, not about the drug. " +
      "`unparsed` counts sentences that discuss coadministration but yielded no name."
  );
  lines.push("");
  lines.push(
    "| Product | Sentences scanned | With coadministration phrase | Yielded substances | Unparsed | Level |"
  );
  lines.push("|---|---:|---:|---:|---:|---|");
  for (const { productKey, result } of perProduct) {
    const k = result.completeness;
    lines.push(
      "| " +
        productKey +
        " | " +
        k.sentencesScanned +
        " | " +
        k.sentencesWithCoadministrationPhrase +
        " | " +
        k.sentencesYieldingSubstances +
        " | " +
        k.sentencesUnparsed +
        " | " +
        k.level +
        " |"
    );
  }
  lines.push("");
  for (const { productKey, result } of perProduct) {
    lines.push("### " + productKey);
    lines.push("");
    if (result.noDoseAdjustmentStated.length > 0) {
      lines.push(
        "**Label states no DOSE ADJUSTMENT needed** (" +
          result.noDoseAdjustmentStated.length +
          ") - interaction status unknown, NOT cleared: " +
          result.noDoseAdjustmentStated.join(", ")
      );
      const sample = result.mentions.find((m) => m.direction === "no-dose-adjustment-stated");
      if (sample) lines.push('  - source: "' + sample.supportingText.slice(0, 260) + '"');
      lines.push("");
    }
    if (result.noInteractionObservedStated.length > 0) {
      lines.push(
        "**Label states no interaction OBSERVED** (" +
          result.noInteractionObservedStated.length +
          "): " +
          result.noInteractionObservedStated.join(", ")
      );
      const sample = result.mentions.find((m) => m.direction === "no-interaction-observed-stated");
      if (sample) lines.push('  - source: "' + sample.supportingText.slice(0, 260) + '"');
      lines.push("");
    }
    if (result.describedInteraction.length > 0) {
      lines.push(
        "**Interaction described** (" +
          result.describedInteraction.length +
          "): " +
          result.describedInteraction.join(", ")
      );
      for (const m of result.mentions.filter((x) => x.isAdverseInteraction).slice(0, 3)) {
        lines.push(
          "  - " + m.substance + " [" + m.direction + ']: "' + m.supportingText.slice(0, 200) + '"'
        );
      }
      lines.push("");
    }
    if (result.mentions.length === 0) {
      lines.push(
        "No substances extracted. This is not a finding of no interactions - the full " +
          "interaction sections are exported and remain the evidence."
      );
      lines.push("");
    }
  }
  return lines.join("\n");
}
