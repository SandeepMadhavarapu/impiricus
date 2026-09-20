import { describe, it, expect } from "vitest";
import {
  SUPPORTED_CONTENT_LOCALES,
  DEFAULT_CONTENT_LOCALE,
  TRANSLATED_SECTIONS,
  TranslatedSectionSchema,
  isSupportedContentLocale,
  resolveContentLocale,
  localeIsBacked,
  assertLocalesAreBacked,
  shouldOfferLanguageChoice,
} from "@/sources/lib/content/locales";
import { buildShareUrl, buildShareTarget } from "@/doctor/lib/share";

const ORIGIN = "https://example.org";
const SLUG = "singulair-montelukast-10mg-tablet";

/**
 * A language is offered only where reviewed content exists.
 *
 * Inventoried on 2026-09-20: no label export declares a language, no
 * translated section exists, and there is no localisation framework. So the
 * honest state is English only, and no language control is rendered. Someone
 * who picks "Español" and receives English has been told their language is
 * supported when it is not.
 */

describe("the language inventory is honest about itself", () => {
  it("lists exactly the locales that have content behind them", () => {
    expect(SUPPORTED_CONTENT_LOCALES).toEqual(["en-US"]);
    expect(TRANSLATED_SECTIONS).toHaveLength(0);
  });

  it("does not offer a choice while there is only one", () => {
    // A picker with one entry is not a choice; it is an invitation to look for
    // languages that are not there.
    expect(shouldOfferLanguageChoice()).toBe(false);
  });

  it("refuses to let the supported list outrun the content", () => {
    // The guard that stops a dead picker shipping.
    expect(() => assertLocalesAreBacked()).not.toThrow();
    expect(localeIsBacked(DEFAULT_CONTENT_LOCALE)).toBe(true);
    expect(localeIsBacked("es")).toBe(false);
  });

  it.each(["es", "es-MX", "fr", "zh-CN", "en-GB"])("does not claim %s is supported", (locale) => {
    expect(isSupportedContentLocale(locale)).toBe(false);
  });

  it.each([undefined, null, 42, {}, "", "xx", "en_US", "../en", "en-US; DROP"])(
    "falls back to English for %s rather than failing",
    (value) => {
      // A bad locale in a shared link is a link that must still open.
      expect(resolveContentLocale(value)).toBe("en-US");
    }
  );
});

describe("a translation record cannot claim a review that did not happen", () => {
  const base = {
    productKey: SLUG,
    locale: "es",
    sourceDocumentId: "spl-abc",
    sourceSectionId: "warnings",
    sourceVersion: "20",
    originalText: "Tell your doctor if you feel agitated.",
    translatedText: "Informe a su médico si se siente agitado.",
    translationOrigin: "human-translated" as const,
  };

  it("accepts an honestly unreviewed translation", () => {
    const r = TranslatedSectionSchema.safeParse({
      ...base,
      reviewStatus: "unreviewed",
      reviewedBy: null,
      reviewedAt: null,
    });
    expect(r.success).toBe(true);
  });

  it("rejects 'clinically reviewed' with no named reviewer or date", () => {
    for (const missing of [
      { reviewedBy: null, reviewedAt: "2026-09-20" },
      { reviewedBy: "Dr Someone", reviewedAt: null },
      { reviewedBy: null, reviewedAt: null },
    ]) {
      const r = TranslatedSectionSchema.safeParse({
        ...base,
        reviewStatus: "clinically-reviewed",
        ...missing,
      });
      expect(r.success, `accepted a review claim missing ${JSON.stringify(missing)}`).toBe(false);
    }
  });

  it("requires the source version, so a translation cannot outlive its source", () => {
    const { sourceVersion: _omitted, ...withoutVersion } = base;
    const r = TranslatedSectionSchema.safeParse({
      ...withoutVersion,
      reviewStatus: "unreviewed",
      reviewedBy: null,
      reviewedAt: null,
    });
    expect(r.success).toBe(false);
  });

  it("keeps the original text alongside the translation", () => {
    const r = TranslatedSectionSchema.safeParse({
      ...base,
      originalText: "",
      reviewStatus: "unreviewed",
      reviewedBy: null,
      reviewedAt: null,
    });
    expect(r.success).toBe(false);
  });

  it("records machine translation as machine translation", () => {
    const r = TranslatedSectionSchema.safeParse({
      ...base,
      translationOrigin: "machine-translated",
      reviewStatus: "unreviewed",
      reviewedBy: null,
      reviewedAt: null,
    });
    expect(r.success).toBe(true);
    // And it can never be clinically-reviewed without a real reviewer, above.
  });
});

/* ------------------------------------------------------------- share links */

describe("a public share link carries the product and nothing else", () => {
  it("is just the medication path", () => {
    expect(buildShareUrl(ORIGIN, SLUG)).toBe(`${ORIGIN}/medications/${SLUG}`);
  });

  it.each([
    ["an unsupported locale", "es"],
    ["a tampered value", "en-US' OR 1=1"],
    ["a path fragment", "../../admin"],
    ["an object", { locale: "es" }],
    ["nothing at all", undefined],
  ])("discards %s rather than putting it in the URL", (_label, locale) => {
    const url = buildShareUrl(ORIGIN, SLUG, locale);
    expect(url).toBe(`${ORIGIN}/medications/${SLUG}`);
    expect(url).not.toContain("lang=");
  });

  it("does not append the default locale, which would change nothing", () => {
    expect(buildShareUrl(ORIGIN, SLUG, "en-US")).not.toContain("lang=");
  });

  it("strips any query string or fragment that rode along on the origin", () => {
    const url = buildShareUrl(`${ORIGIN}/?utm=x&patient=Jane#notes`, SLUG);
    expect(url).toBe(`${ORIGIN}/medications/${SLUG}`);
    expect(url).not.toMatch(/utm|patient|Jane|notes|#/);
  });

  /**
   * The reference design compressed patient names and visit notes into URL
   * parameters. Compression is neither encryption nor access control, and this
   * link is public.
   */
  it("has no channel for a name, a note or an identifier", () => {
    const url = buildShareUrl(ORIGIN, SLUG, "es");
    for (const leak of ["Jane", "note", "mrn", "member", "dob", "rx", "token"]) {
      expect(url.toLowerCase()).not.toContain(leak);
    }
    expect(new URL(url).search).toBe("");
  });

  it("rejects a non-https origin outside local development", () => {
    expect(() => buildShareUrl("http://example.org", SLUG)).toThrow();
    // ...while localhost still works, or nothing could be tested locally.
    expect(buildShareUrl("http://localhost:3100", SLUG)).toContain("/medications/");
  });

  it("shares text about the medication, never about the person sharing", () => {
    const target = buildShareTarget(ORIGIN, SLUG, "Singulair");
    const all = `${target.title} ${target.text} ${target.url}`;
    expect(all).toContain("Singulair");
    expect(all).not.toMatch(/your doctor prescribed|your prescription|for you\b/i);
  });

  /** What the provider previews must be what the patient opens. */
  it("the provider preview URL and the shared URL are the same string", () => {
    const shared = buildShareUrl(ORIGIN, SLUG);
    const target = buildShareTarget(ORIGIN, SLUG, "Singulair");
    expect(target.url).toBe(shared);
  });
});
