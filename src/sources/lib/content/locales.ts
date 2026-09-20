import { z } from "zod";

/**
 * Which languages this product can present MEDICAL content in.
 *
 * ---------------------------------------------------------------------------
 * TODAY THE ANSWER IS: ENGLISH ONLY
 * ---------------------------------------------------------------------------
 * The catalogue was inventoried on 2026-09-20. No label export declares a
 * language, no translated section exists, and there is no localisation
 * framework. `SUPPORTED_CONTENT_LOCALES` is therefore `["en-US"]`, and the
 * language control is NOT rendered - a picker listing languages that resolve
 * to English, or to machine output, is worse than no picker. Someone who
 * selects "Español" and receives English has been told their language is
 * supported when it is not.
 *
 * This module exists so that adding a language is a data change with a
 * validated shape, rather than a UI change that quietly outruns the content.
 *
 * ---------------------------------------------------------------------------
 * TO ACTIVATE A LANGUAGE
 * ---------------------------------------------------------------------------
 * Add a `TranslatedSection` per section, each carrying real provenance, and
 * add the locale to `SUPPORTED_CONTENT_LOCALES`. `assertLocaleIsBacked` will
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
 * Locales the app may present medical content in.
 *
 * English is here because the labels are English. Nothing else is, because
 * nothing else has content behind it.
 */
export const SUPPORTED_CONTENT_LOCALES: readonly ContentLocale[] = ["en-US"] as const;

export const DEFAULT_CONTENT_LOCALE: ContentLocale = "en-US";

/** Every translated section the app holds. Empty, and honestly so. */
export const TRANSLATED_SECTIONS: readonly TranslatedSection[] = [];

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
