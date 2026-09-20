import { z } from "zod";
import translationsFile from "@/sources/content/translations/read-aloud.json";

/**
 * Which languages this product can present MEDICAL content in.
 *
 * ---------------------------------------------------------------------------
 * THE PAGE IS ENGLISH. THE SPOKEN SUMMARY IS NOT ONLY ENGLISH.
 * ---------------------------------------------------------------------------
 * Two separate claims live in this module, and collapsing them would overstate
 * one of them:
 *
 *   SUPPORTED_CONTENT_LOCALES  what the PAGE is available in. English only.
 *                              No label export declares a language and no
 *                              reviewed translation of any section exists.
 *   SPOKEN_LOCALES             what the read-aloud SUMMARY can be heard in.
 *                              English, Spanish and French, from
 *                              src/sources/content/translations/read-aloud.json.
 *
 * That asymmetry is deliberate and must stay visible. Someone who selects
 * "Español" hears the summary in Spanish and still sees an English page, so
 * the control says what it covers rather than implying the product speaks
 * Spanish. Widening SUPPORTED_CONTENT_LOCALES on the strength of a translated
 * paragraph would put lang=es on a share link for an English page.
 *
 * Both translations are MACHINE-TRANSLATED and UNREVIEWED. No clinician has
 * checked them. They are offered because a listener who reads no English gets
 * nothing at all from an English-only control, and they are labelled as
 * machine output at the point of use with the English original on the same
 * screen - which is the only condition under which `machine-translated` is
 * permitted below.
 *
 * This module exists so that adding a language is a data change with a
 * validated shape, rather than a UI change that quietly outruns the content.
 *
 * ---------------------------------------------------------------------------
 * TO ACTIVATE A LANGUAGE
 * ---------------------------------------------------------------------------
 * Add a `TranslatedSection` per section, each carrying real provenance, and
 * add the locale to `SUPPORTED_CONTENT_LOCALES`. `assertLocalesAreBacked` will
 * refuse a locale that has no sections, so the two cannot drift apart.
 *
 * Required per section, and none of it may be invented:
 *
 *   - the source document and section it translates, WITH the version, so a
 *     translation cannot silently outlive the English text it came from
 *   - who produced it, and by what means
 *   - review status, and a named reviewer and date ONLY if a person really
 *     reviewed it
 *
 * ---------------------------------------------------------------------------
 * WHAT A TRANSLATION IS NOT
 * ---------------------------------------------------------------------------
 * A translated INTERFACE is not a translated medical guide. Translating the
 * word "Warnings" while the warning itself stays in English is an interface
 * translation, and must never be counted here.
 *
 * A translation is also not FDA-approved because its English source was. The
 * approval attaches to the English label. `translationOrigin` and
 * `reviewStatus` carry what is actually true about the translated words.
 */

/** BCP-47, restricted to tags we can actually name a voice and a reviewer for. */
export const ContentLocaleSchema = z
  .string()
  .regex(/^[a-z]{2}(-[A-Z]{2})?$/, "Expected a BCP-47 tag such as en-US or es");

export type ContentLocale = z.infer<typeof ContentLocaleSchema>;

export const TranslationOriginSchema = z.enum([
  /** Published by the source authority itself, e.g. an FDA Spanish label. */
  "source-authority-published",
  /** A person translated it. */
  "human-translated",
  /**
   * Machine output. Never the patient-facing default: it may be shown only
   * where it is labelled as machine output and an original is one tap away.
   */
  "machine-translated",
]);

export const ReviewStatusSchema = z.enum([
  /** Nobody has reviewed it. The honest default. */
  "unreviewed",
  /** A qualified person reviewed it against the source. */
  "clinically-reviewed",
]);

export const TranslatedSectionSchema = z
  .object({
    productKey: z.string().min(1),
    locale: ContentLocaleSchema,
    /** The source document and section this translates. */
    sourceDocumentId: z.string().min(1),
    sourceSectionId: z.string().min(1),
    /**
     * The source version. Without it a translation outlives the English text
     * it came from and nothing notices.
     */
    sourceVersion: z.string().min(1),
    /** The original text, so the reader can always reach what was translated. */
    originalText: z.string().min(1),
    translatedText: z.string().min(1),
    translationOrigin: TranslationOriginSchema,
    reviewStatus: ReviewStatusSchema,
    /** ONLY when a named person really reviewed it. Never a placeholder. */
    reviewedBy: z.string().min(1).nullable(),
    reviewedAt: z.string().min(1).nullable(),
  })
  .strict()
  .refine(
    (t) => t.reviewStatus !== "clinically-reviewed" || (t.reviewedBy !== null && t.reviewedAt !== null),
    {
      message:
        "A translation cannot be marked clinically-reviewed without a named reviewer and a date. " +
        "Fabricating either is how an unreviewed translation acquires an authority it does not have.",
    }
  );

export type TranslatedSection = z.infer<typeof TranslatedSectionSchema>;

/**
 * Locales the app may present PAGE content in.
 *
 * English only. The labels are English, every section on the page is English,
 * and no reviewed translation of any of it exists. This drives the share link
 * and the (absent) page language control, and it must not be widened because
 * some smaller piece of the page gained a translation - see SPOKEN_LOCALES.
 */
export const SUPPORTED_CONTENT_LOCALES: readonly ContentLocale[] = ["en-US"] as const;

export const DEFAULT_CONTENT_LOCALE: ContentLocale = "en-US";

/** Every translated PAGE section the app holds. Empty, and honestly so. */
export const TRANSLATED_SECTIONS: readonly TranslatedSection[] = [];

/* ------------------------------------------------- the spoken summary only */

/**
 * Locales the SPOKEN SUMMARY can be heard in.
 *
 * Deliberately separate from SUPPORTED_CONTENT_LOCALES, because they are
 * different claims and collapsing them would overstate one of them. The page
 * is English. One paragraph of it - the summary read-aloud speaks - also
 * exists in Spanish and French.
 *
 * Keeping them apart is what stops a share link advertising `lang=es` for a
 * page that is entirely in English, and stops a page-level language picker
 * appearing on the strength of a translated paragraph.
 *
 * Both non-English entries are MACHINE-TRANSLATED and UNREVIEWED. They are
 * offered because a listener who reads no English gets nothing at all from an
 * English-only control, and they are labelled as machine output at the point
 * of use with the English original on the same screen - the only condition
 * under which `machine-translated` is permitted above.
 */
export const SPOKEN_LOCALES: readonly ContentLocale[] = ["en-US", "es", "fr"] as const;

/**
 * How each spoken locale should be voiced.
 *
 * A bare "es" leaves the engine to pick any Spanish voice; naming a region
 * gets one that exists on most platforms. This is a speech hint only and makes
 * no claim that the text is regionalised - it is not.
 */
export const SPEECH_TAGS: Readonly<Record<string, string>> = {
  "en-US": "en-US",
  es: "es-ES",
  fr: "fr-FR",
};

/** Endonyms, so the choice is legible to the person who needs it. */
export const LOCALE_NAMES: Readonly<Record<string, string>> = {
  "en-US": "English",
  es: "Español",
  fr: "Français",
};

/**
 * Every spoken translation the app holds, validated on load.
 *
 * Parsed rather than cast: the schema is what stops an entry claiming clinical
 * review it never had, and a cast would skip exactly that check.
 */
export const SPOKEN_TRANSLATIONS: readonly TranslatedSection[] = (
  translationsFile as { sections: unknown[] }
).sections.map((s) => TranslatedSectionSchema.parse(s));

/** Whether the spoken summary really exists in this locale. */
export function spokenLocaleIsBacked(locale: ContentLocale): boolean {
  if (locale === DEFAULT_CONTENT_LOCALE) return true;
  return SPOKEN_TRANSLATIONS.some((t) => t.locale === locale);
}

/**
 * Guard against the spoken locale list and its content drifting apart.
 *
 * Same reasoning as assertLocalesAreBacked: offering a language the app cannot
 * deliver tells someone their language is supported when it is not.
 */
export function assertSpokenLocalesAreBacked(): void {
  const unbacked = SPOKEN_LOCALES.filter((l) => !spokenLocaleIsBacked(l));
  if (unbacked.length > 0) {
    throw new Error(
      `Spoken locale(s) ${unbacked.join(", ")} are listed but have no translation. ` +
        `Either add one or remove them.`
    );
  }
}

/**
 * The translated spoken summary for a product, or null.
 *
 * Null for English, which is not a translation, and null for any product or
 * locale with nothing behind it. A caller that gets null must fall back to the
 * English rather than to silence.
 */
export function spokenTranslation(
  productKey: string,
  locale: ContentLocale
): TranslatedSection | null {
  if (locale === DEFAULT_CONTENT_LOCALE) return null;
  return (
    SPOKEN_TRANSLATIONS.find(
      (t) =>
        t.productKey === productKey &&
        t.locale === locale &&
        t.sourceSectionId === "patient-summary-spoken"
    ) ?? null
  );
}

/** Whether medical content actually exists in this locale. */
export function isSupportedContentLocale(value: unknown): value is ContentLocale {
  return typeof value === "string" && SUPPORTED_CONTENT_LOCALES.includes(value as ContentLocale);
}

/**
 * Narrows an untrusted locale - from a URL, a header, anywhere - to one the
 * app has content for, falling back to English.
 *
 * Never throws, because an unsupported locale in a shared link is a link that
 * must still open. It silently degrades to English rather than to nothing.
 */
export function resolveContentLocale(value: unknown): ContentLocale {
  return isSupportedContentLocale(value) ? value : DEFAULT_CONTENT_LOCALE;
}

/**
 * Whether a locale is backed by real sections, ignoring the list above.
 *
 * English is backed by the label exports themselves rather than by
 * `TRANSLATED_SECTIONS`, so it is true by construction. Any other locale must
 * earn it.
 */
export function localeIsBacked(locale: ContentLocale): boolean {
  if (locale === DEFAULT_CONTENT_LOCALE) return true;
  return TRANSLATED_SECTIONS.some((t) => t.locale === locale);
}

/**
 * Guard against the list and the content drifting apart.
 *
 * Adding a locale to `SUPPORTED_CONTENT_LOCALES` without adding sections is
 * exactly how a dead language picker ships, so it is a hard failure rather
 * than a warning.
 */
export function assertLocalesAreBacked(): void {
  const unbacked = SUPPORTED_CONTENT_LOCALES.filter((l) => !localeIsBacked(l));
  if (unbacked.length > 0) {
    throw new Error(
      `Locale(s) ${unbacked.join(", ")} are listed as supported but have no translated sections. ` +
        `Either add reviewed content or remove them: offering a language the app cannot deliver ` +
        `tells someone their language is supported when it is not.`
    );
  }
}

/**
 * Whether a language control should be shown at all.
 *
 * False while English is the only option. A picker with one entry is not a
 * choice; it is an invitation to look for languages that are not there.
 */
export function shouldOfferLanguageChoice(): boolean {
  return SUPPORTED_CONTENT_LOCALES.length > 1;
}
