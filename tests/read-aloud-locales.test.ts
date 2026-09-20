import { describe, it, expect } from "vitest";
import {
  SPOKEN_LOCALES,
  DEFAULT_CONTENT_LOCALE,
  SPOKEN_TRANSLATIONS,
  TranslatedSectionSchema,
  LOCALE_NAMES,
  SPEECH_TAGS,
  spokenTranslation,
  assertSpokenLocalesAreBacked,
  spokenLocaleIsBacked,
  SUPPORTED_CONTENT_LOCALES,
} from "@/sources/lib/content/locales";
import { listGuideSlugs, getGuide } from "@/sources/lib/content/catalogue";
import { patientGuide } from "@/sources/lib/content/patient-guide";

/**
 * Spoken translations of the patient summary.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS **NOT** VERIFIED HERE
 * ---------------------------------------------------------------------------
 * That the Spanish and French are GOOD. No test can establish that, and no
 * clinician has reviewed them. Every entry says so, and the checks below hold
 * them to saying so.
 *
 * What IS verified: that every offered language has real content behind it,
 * that a translation cannot outlive the English it was made from, and that
 * none of them can quietly acquire a clinical review nobody performed.
 */

/** The English read-aloud speaks, rebuilt exactly as the page builds it. */
function spokenEnglish(slug: string): string {
  const view = patientGuide(getGuide(slug)!);
  return [view.headline, ...view.keyPoints.map((p: { text: string }) => p.text)].join(" ");
}

const NON_DEFAULT = SPOKEN_LOCALES.filter((l) => l !== DEFAULT_CONTENT_LOCALE);

describe("the offered languages are backed by content", () => {
  it("offers more than English to listen in, so a picker is worth showing", () => {
    expect(NON_DEFAULT.length).toBeGreaterThan(0);
  });

  /**
   * The page stays English. Widening the page locales because a paragraph was
   * translated would put lang=es on a share link for an English page.
   */
  it("does not widen the PAGE locales on the strength of a spoken translation", () => {
    expect(SUPPORTED_CONTENT_LOCALES).toEqual(["en-US"]);
  });

  it("has sections behind every listed locale", () => {
    // The guard that stops a dead picker shipping.
    expect(() => assertSpokenLocalesAreBacked()).not.toThrow();
    for (const locale of SPOKEN_LOCALES) {
      expect(spokenLocaleIsBacked(locale), locale).toBe(true);
    }
  });

  it("covers every catalogued product in every offered language", () => {
    // A picker that works on one medicine and silently does nothing on the
    // next is worse than no picker.
    for (const slug of listGuideSlugs()) {
      for (const locale of NON_DEFAULT) {
        expect(spokenTranslation(slug, locale), `${slug} / ${locale}`).not.toBeNull();
      }
    }
  });

  it("can name and speak each offered locale", () => {
    for (const locale of SPOKEN_LOCALES) {
      expect(LOCALE_NAMES[locale], locale).toBeTruthy();
      expect(SPEECH_TAGS[locale], locale).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
    }
  });

  it("treats English as the original rather than as a translation", () => {
    for (const slug of listGuideSlugs()) {
      expect(spokenTranslation(slug, DEFAULT_CONTENT_LOCALE)).toBeNull();
    }
  });
});

/* ------------------------------------------------------------ the drift -- */

describe("a translation cannot outlive the English it came from", () => {
  /**
   * The check this file exists for.
   *
   * `originalText` is the exact English that was translated. If a label is
   * re-synced and the summary changes, this fails - which is the point. A
   * translation still presented as current while describing a previous
   * version of the guidance is the failure mode that matters, and it is
   * invisible without an assertion like this one.
   */
  it.each(
    listGuideSlugs().flatMap((slug) => NON_DEFAULT.map((locale) => ({ slug, locale })))
  )("$locale for $slug still matches the English being spoken", ({ slug, locale }) => {
    const section = spokenTranslation(slug, locale)!;
    expect(section.originalText.trim()).toBe(spokenEnglish(slug).trim());
  });

  it("pins the source version on every section", () => {
    for (const section of SPOKEN_TRANSLATIONS) {
      expect(section.sourceVersion.trim().length, section.productKey).toBeGreaterThan(0);
      expect(section.sourceDocumentId.trim().length).toBeGreaterThan(0);
    }
  });
});

/* ------------------------------------------------------- honest provenance */

describe("nothing claims a review that did not happen", () => {
  it("reports every shipped translation as machine output and unreviewed", () => {
    // If a human ever reviews one, this changes deliberately, with a name and
    // a date. It must never change by accident.
    for (const section of SPOKEN_TRANSLATIONS) {
      expect(section.translationOrigin, section.productKey).toBe("machine-translated");
      expect(section.reviewStatus).toBe("unreviewed");
      expect(section.reviewedBy).toBeNull();
      expect(section.reviewedAt).toBeNull();
    }
  });

  it("refuses a clinically-reviewed claim with no named reviewer", () => {
    const base = SPOKEN_TRANSLATIONS[0]!;
    const forged = { ...base, reviewStatus: "clinically-reviewed" as const };
    expect(() => TranslatedSectionSchema.parse(forged)).toThrow(/named reviewer/i);
  });

  it("accepts a review that names a person and a date", () => {
    const base = SPOKEN_TRANSLATIONS[0]!;
    const real = {
      ...base,
      reviewStatus: "clinically-reviewed" as const,
      reviewedBy: "A. Reviewer, PharmD",
      reviewedAt: "2026-09-20",
    };
    expect(() => TranslatedSectionSchema.parse(real)).not.toThrow();
  });

  it("rejects an unknown field rather than ignoring it", () => {
    // .strict() - so a future "confidence: 0.9" cannot ride along unnoticed.
    const base = SPOKEN_TRANSLATIONS[0]!;
    expect(() => TranslatedSectionSchema.parse({ ...base, confidence: 0.9 })).toThrow();
  });
});

/* -------------------------------------------------------- the words kept -- */

describe("what the translations must carry across", () => {
  /**
   * The boxed warning is the single most important sentence in a summary that
   * has one, and it is the one a translation could most damagingly drop.
   */
  it("keeps the FDA boxed warning wherever the English has one", () => {
    const marker: Record<string, RegExp> = {
      es: /recuadro de la FDA/i,
      fr: /encadr[ée]e de la FDA/i,
    };
    for (const slug of listGuideSlugs()) {
      if (!/boxed warning/i.test(spokenEnglish(slug))) continue;
      for (const locale of NON_DEFAULT) {
        const section = spokenTranslation(slug, locale)!;
        expect(section.translatedText, `${slug} / ${locale}`).toMatch(marker[locale]!);
      }
    }
  });

  it("is not a copy of the English", () => {
    for (const section of SPOKEN_TRANSLATIONS) {
      expect(section.translatedText).not.toBe(section.originalText);
      expect(section.translatedText.trim().length).toBeGreaterThan(20);
    }
  });

  /**
   * "FDA" is the name of a US agency, not a word to localise. A reader looking
   * for it on the label needs the same three letters.
   */
  it("leaves the agency name untranslated", () => {
    for (const section of SPOKEN_TRANSLATIONS) {
      if (!/FDA/.test(section.originalText)) continue;
      expect(section.translatedText, section.productKey).toContain("FDA");
    }
  });
});
