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

/** Words in a dose-form string, long enough to carry meaning. */
function formWords(form: string): string[] {
  return form
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 4);
}

/**
 * Form words that can tell THESE TWO products apart.
 *
 * Distinctiveness is relative, not a property of the word. "tablet" says
 * nothing when the other product is also a tablet, and everything when the
 * other product is a granule. Filtering by word length alone got this wrong:
 * "tablet" is six characters, so it survived, and every section mentioning
 * the word matched both a 10 mg film-coated tablet and a 4 mg chewable one.
 *
 * That pushed sibling-only content into `explicitly-shared`, which is one of
 * the two states treated as safe for product-specific guidance. On the real
 * labels it placed the 4 mg CHEWABLE "For Pediatric Patients 2-5 Years of
 * Age" panel into the 10 mg adult tablet's guidance set: precisely the merge
 * this module exists to prevent.
 *
 * When two products share a dose form entirely, as Toprol XL's four strengths
 * do, this correctly returns nothing and strength becomes the only
 * discriminator. Fewer sections then qualify as product-specific, which is the
 * honest result; `excludedUnresolvedCount` reports how many were held back.
 */
function discriminatingFormWords(form: string, comparedWith: string): string[] {
  const other = new Set(formWords(comparedWith));
  return formWords(form).filter((w) => !other.has(w));
}

/** Escapes a literal for use inside a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches a strength phrase on number boundaries.
 *
 * Plain substring matching lets "5 mg" match inside "15 mg", which would
 * attribute a sibling's section to the wrong product. The leading lookbehind
 * rejects a preceding digit or decimal point; the trailing boundary stops
 * "1 mg" matching "1 mg/mL" as though it were the same strength.
 */
function strengthPattern(value: string, unit: string): RegExp {
  return new RegExp(
    `(?<![\\d.])${escapeRegex(value.trim())}\\s*-?\\s*${escapeRegex(unit.trim().toLowerCase())}\\b`,
    "i"
  );
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

  /**
   * Does this section name `p`, in a way that distinguishes it from `versus`?
   *
   * Every comparison is against the OTHER side of the decision, because a
   * signal shared by both products cannot resolve between them. For the
   * selected product that means checking it against its siblings; for a
   * sibling, against the selected product.
   */
  const mentions = (p: SplProduct, versus: SplProduct[]): boolean => {
    const formHit = versus.length > 0 &&
      versus.every((v) =>
        discriminatingFormWords(p.formDisplay ?? "", v.formDisplay ?? "").some((w) =>
          haystack.includes(w)
        )
      );

    const strength = p.activeIngredients[0];
    const strengthHit =
      strength?.numeratorValue && strength.numeratorUnit
        ? strengthPattern(strength.numeratorValue, strength.numeratorUnit).test(haystack)
        : false;

    return formHit || strengthHit;
  };

  const siblings = allProducts.filter((p) => p.ndc !== selected.ndc);
  const selectedMentioned = mentions(selected, siblings);
  const siblingsMentioned = siblings.filter((s) => mentions(s, [selected]));

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

/** The only two states that may become product-specific guidance. */
const SAFE_FOR_GUIDANCE: ReadonlySet<Applicability> = new Set<Applicability>([
  "exact-product",
  "explicitly-shared",
]);

/**
 * Sections safe to present as product-specific guidance.
 *
 * `document-level-unresolved` and `not-applicable` content is excluded: it
 * stays available as source material but must never silently become dosing or
 * patient instruction for this product.
 *
 * The exclusion is applied at EVERY depth. An earlier version selected
 * matching nodes and returned them whole, which let an unresolved subsection
 * ride along inside a safe parent -- on the real labels that leaked 33, 37 and
 * 68 unresolved sections respectively into what callers were told was
 * product-specific. It also emitted safe subsections twice, once nested and
 * once hoisted.
 *
 * A safe section under an unresolved parent is kept, hoisted to the top level,
 * so genuinely scoped content is not lost to its parent's ambiguity. Every
 * node in the returned tree is itself safe.
 */
export function productSpecificSections(sections: LabelSection[]): LabelSection[] {
  const collect = (s: LabelSection): LabelSection[] =>
    SAFE_FOR_GUIDANCE.has(s.applicability)
      ? [{ ...s, subsections: s.subsections.flatMap(collect) }]
      : s.subsections.flatMap(collect);
  return sections.flatMap(collect);
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


