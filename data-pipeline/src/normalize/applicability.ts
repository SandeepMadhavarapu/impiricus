import type { LabelSection, Applicability } from "../schemas/index.js";
import type { SplProduct } from "./spl.js";

/**
 * Section applicability.
 *
 * The defect this fixes: every section carried `appliesToProducts: []`, and an
 * empty list is trivially misread as "applies to everything". It does not. The
 * Singulair label covers four products — a 10 mg tablet, two chewable
 * strengths and a granule — and its dosing table assigns a different dose to
 * each. Treating a document-level section as product-specific is how a
 * paediatric granule dose becomes an adult tablet instruction.
 *
 * What this can and cannot do:
 *
 *   It CAN detect when a section's own text names a specific dose form or
 *   strength, which is how real SPLs scope content in practice.
 *
 *   It CANNOT invent structural scoping the document does not contain. When
 *   the text gives no signal, the state stays `document-level-unresolved`,
 *   which is honest and is NOT an upgrade path to `exact-product`.
 */

/** Normalises a dose-form string to comparable tokens. */
function formTokens(form: string): string[] {
  return form
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length > 3 && t !== "tablet" ? true : t.length > 3);
}

/** Distinctive words for a dose form, e.g. "chewable", "granule", "extended". */
function distinctiveFormWords(form: string): string[] {
  const words = form.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  // "tablet" alone is not distinctive when several products are tablets.
  return words.filter((w) => w.length > 4);
}

export interface ApplicabilityInput {
  /** The product this record is about. */
  selected: SplProduct;
  /** Every product the document describes, including the selected one. */
  allProducts: SplProduct[];
}

/**
 * Classifies one section against the selected product.
 *
 * Deliberately conservative. A section is only `exact-product` when its text
 * mentions something distinctive to the selected product AND mentions nothing
 * distinctive to a sibling product. Anything mixed is `explicitly-shared`;
 * anything silent is `document-level-unresolved`.
 */
export function classifySection(
  section: LabelSection,
  input: ApplicabilityInput
): { applicability: Applicability; appliesToProducts: string[] } {
  const { selected, allProducts } = input;

  // A single-product document scopes everything to that product structurally.
  if (allProducts.length <= 1) {
    return {
      applicability: "exact-product",
      appliesToProducts: [productLabel(selected)],
    };
  }

  const haystack = [
    section.title ?? "",
    ...section.paragraphs,
    ...section.highlights,
    ...section.tables.flatMap((t) => [t.caption ?? "", ...t.headers.flat(), ...t.rows.flat()]),
  ]
    .join(" ")
    .toLowerCase();

  if (haystack.trim().length === 0) {
    return { applicability: "document-level-unresolved", appliesToProducts: [] };
  }

  const mentions = (p: SplProduct): boolean => {
    const strength = p.activeIngredients[0];
    const strengthPhrase =
      strength?.numeratorValue && strength.numeratorUnit
        ? `${strength.numeratorValue} ${strength.numeratorUnit}`.toLowerCase()
        : null;

    // A strength phrase plus a distinctive form word is a strong signal.
    const formWords = distinctiveFormWords(p.formDisplay ?? "");
    const formHit = formWords.some((w) => haystack.includes(w));
    const strengthHit = strengthPhrase
      ? haystack.includes(strengthPhrase) ||
        haystack.includes(strengthPhrase.replace(" ", "-")) ||
        haystack.includes(strengthPhrase.replace(" ", ""))
      : false;

    return formHit || strengthHit;
  };

  const selectedMentioned = mentions(selected);
  const siblings = allProducts.filter((p) => p.ndc !== selected.ndc);
  const siblingsMentioned = siblings.filter(mentions);

  if (selectedMentioned && siblingsMentioned.length === 0) {
    return { applicability: "exact-product", appliesToProducts: [productLabel(selected)] };
  }
  if (selectedMentioned && siblingsMentioned.length > 0) {
    return {
      applicability: "explicitly-shared",
      appliesToProducts: [selected, ...siblingsMentioned].map(productLabel),
    };
  }
  if (!selectedMentioned && siblingsMentioned.length > 0) {
    return {
      applicability: "not-applicable",
      appliesToProducts: siblingsMentioned.map(productLabel),
    };
  }
  return { applicability: "document-level-unresolved", appliesToProducts: [] };
}

export function productLabel(p: SplProduct): string {
  const ai = p.activeIngredients[0];
  const strength = ai ? `${ai.numeratorValue}${ai.numeratorUnit}` : "?";
  return `${p.name ?? "?"} ${strength} ${p.formDisplay ?? ""} (NDC ${p.ndc ?? "?"})`.trim();
}

/** Applies classification across a section tree, in place-free fashion. */
export function scopeSections(
  sections: LabelSection[],
  input: ApplicabilityInput
): LabelSection[] {
  return sections.map((s) => {
    const { applicability, appliesToProducts } = classifySection(s, input);
    return {
      ...s,
      applicability,
      appliesToProducts,
      subsections: scopeSections(s.subsections, input),
    };
  });
}

/**
 * Sections safe to present as product-specific guidance.
 *
 * `document-level-unresolved` content is deliberately excluded: it remains
 * available as source material but must not silently become dosing or patient
 * instruction for this product.
 */
export function productSpecificSections(sections: LabelSection[]): LabelSection[] {
  const out: LabelSection[] = [];
  const visit = (s: LabelSection) => {
    if (s.applicability === "exact-product" || s.applicability === "explicitly-shared") {
      out.push(s);
    }
    s.subsections.forEach(visit);
  };
  sections.forEach(visit);
  return out;
}

/** Counts sections by applicability, for the completeness report. */
export function applicabilityCounts(sections: LabelSection[]): Record<Applicability, number> {
  const counts: Record<Applicability, number> = {
    "exact-product": 0,
    "explicitly-shared": 0,
    "document-level-unresolved": 0,
    "not-applicable": 0,
  };
  const visit = (s: LabelSection) => {
    counts[s.applicability]++;
    s.subsections.forEach(visit);
  };
  sections.forEach(visit);
  return counts;
}

export { formTokens };
