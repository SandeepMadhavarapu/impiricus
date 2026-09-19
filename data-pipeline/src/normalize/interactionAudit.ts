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
  /** The label states no dose adjustment / no significant effect. */
  | "no-significant-interaction-stated"
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
   * False when the label states no significant interaction. Consumers must
   * not render these as warnings.
   */
  isAdverseInteraction: boolean;
}

export interface InteractionAuditResult {
  mentions: InteractionMention[];
  /** Counts by direction, for the report. */
  counts: Record<InteractionDirection, number>;
  /** Substances the label explicitly clears. */
  statedNoInteraction: string[];
  /** Substances with a described interaction. */
  describedInteraction: string[];
  caveats: string[];
}

/** Sentences asserting absence of a clinically significant interaction. */
const NO_INTERACTION_PATTERNS = [
  /\bno (?:dose|dosage) adjustment is (?:needed|required|necessary)\b/i,
  /\bno clinically (?:significant|relevant|meaningful) (?:effect|interaction|change)\b/i,
  /\bdid not (?:significantly )?(?:alter|change|affect|influence)\b/i,
  /\bwere not (?:significantly )?(?:altered|changed|affected)\b/i,
  /\bhad no (?:significant )?effect\b/i,
  /\bno interaction\b/i,
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

function classify(sentence: string): InteractionDirection {
  if (NO_INTERACTION_PATTERNS.some((p) => p.test(sentence))) {
    return "no-significant-interaction-stated";
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

  for (const section of walkSections(sections)) {
    const text = [...section.paragraphs, ...section.highlights].join(" ");
    if (text.trim().length === 0) continue;

    for (const sentence of sentences(text)) {
      const substances = candidateSubstances(sentence, self);
      if (substances.length === 0) continue;

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
          isAdverseInteraction: direction !== "no-significant-interaction-stated",
        });
      }
    }
  }

  const counts: Record<InteractionDirection, number> = {
    "no-significant-interaction-stated": 0,
    "other-affects-this": 0,
    "this-affects-other": 0,
    "interaction-described-direction-unclear": 0,
    "mentioned-unclassified": 0,
  };
  for (const m of mentions) counts[m.direction]++;

  const statedNo = [
    ...new Set(
      mentions.filter((m) => m.direction === "no-significant-interaction-stated").map((m) => m.substance)
    ),
  ].sort();
  const described = [
    ...new Set(mentions.filter((m) => m.isAdverseInteraction).map((m) => m.substance)),
  ].sort();

  return {
    mentions,
    counts,
    statedNoInteraction: statedNo,
    describedInteraction: described,
    caveats: [
      "A substance appearing here is NOT automatically an adverse interaction. Check " +
        "`isAdverseInteraction` and `direction` - labels frequently state that NO dose adjustment " +
        "is needed, and that is the opposite of a warning.",
      "`supportingText` is the sentence the substance came from. Render it; do not render the name alone.",
      "Extraction is conservative and under-reports. The full interactions section is exported " +
        "separately and is the evidence; this list is a convenience index.",
      "This is the label's own content. It has not been checked against any other medicine a person " +
        "takes, and no interaction-checking service is connected.",
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
      "The previous flat list inverted meaning: Singulair's substances come from a sentence stating " +
      "**no dose adjustment is needed**, which a name-only list would render as a warning."
  );
  lines.push("");
  lines.push("| Product | Mentions | No significant interaction stated | Other affects this | This affects other | Direction unclear |");
  lines.push("|---|---:|---:|---:|---:|---:|");
  for (const { productKey, result } of perProduct) {
    const c = result.counts;
    lines.push(
      `| ${productKey} | ${result.mentions.length} | ${c["no-significant-interaction-stated"]} | ${c["other-affects-this"]} | ${c["this-affects-other"]} | ${c["interaction-described-direction-unclear"]} |`
    );
  }
  lines.push("");
  for (const { productKey, result } of perProduct) {
    lines.push(`### ${productKey}`);
    lines.push("");
    if (result.statedNoInteraction.length > 0) {
      lines.push(
        `**Label states NO significant interaction** (${result.statedNoInteraction.length}): ` +
          result.statedNoInteraction.join(", ")
      );
      const sample = result.mentions.find((m) => m.direction === "no-significant-interaction-stated");
      if (sample) lines.push(`  - source: "${sample.supportingText.slice(0, 220)}"`);
      lines.push("");
    }
    if (result.describedInteraction.length > 0) {
      lines.push(
        `**Interaction described** (${result.describedInteraction.length}): ` +
          result.describedInteraction.join(", ")
      );
      for (const m of result.mentions.filter((x) => x.isAdverseInteraction).slice(0, 3)) {
        lines.push(`  - ${m.substance} [${m.direction}]: "${m.supportingText.slice(0, 200)}"`);
      }
      lines.push("");
    }
    if (result.mentions.length === 0) {
      lines.push("No substances extracted. The full interactions section is still exported.");
      lines.push("");
    }
  }
  return lines.join("\n");
}
