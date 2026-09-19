import { describe, it, expect } from "vitest";
import {
  buildShareUrl,
  buildShareTarget,
  medicationPath,
  urlCarriesExtraData,
  InvalidShareTargetError,
} from "@/doctor/lib/share";

const ORIGIN = "https://example.org";
const SLUG = "singulair-montelukast-10mg-tablet";

describe("share URL construction", () => {
  it("builds the bare public path", () => {
    expect(buildShareUrl(ORIGIN, SLUG)).toBe(`${ORIGIN}/medications/${SLUG}`);
  });

  it("normalises an origin that carries a path or query", () => {
    expect(buildShareUrl("https://example.org/some/path?x=1#frag", SLUG)).toBe(
      `${ORIGIN}/medications/${SLUG}`
    );
  });

  it("allows localhost over http for development only", () => {
    expect(buildShareUrl("http://localhost:3000", SLUG)).toBe(
      `http://localhost:3000/medications/${SLUG}`
    );
    expect(() => buildShareUrl("http://evil.example.com", SLUG)).toThrow(InvalidShareTargetError);
  });

  it("rejects a slug that is not a plain public identifier", () => {
    for (const bad of [
      "../../etc/passwd",
      "slug?token=abc",
      "slug#fragment",
      "slug with spaces",
      "SLUG",
      "slug/../other",
      "javascript:alert(1)",
      "slug%2e%2e",
      "slug\\other",
    ]) {
      expect(() => medicationPath(bad), bad).toThrow(InvalidShareTargetError);
    }
  });

  /**
   * The pipeline escapes a decimal point with an underscore, so Ozempic's
   * 1.34 mg/mL product keys as "...-1_34mg-per-ml-injection". The app and the
   * pipeline share ONE identity string rather than translating between two
   * spellings, so the slug rule has to accept it.
   */
  it("accepts an underscore, which a real product key contains", () => {
    const slug = "ozempic-semaglutide-1_34mg-per-ml-injection";
    expect(medicationPath(slug)).toBe(`/medications/${slug}`);
    expect(buildShareUrl("https://example.org", slug)).toBe(
      `https://example.org/medications/${slug}`
    );
  });
});

describe("no private data ever reaches a share URL", () => {
  it("produces a URL with no query string and no fragment", () => {
    const url = buildShareUrl(ORIGIN, SLUG);
    expect(urlCarriesExtraData(url)).toBe(false);
    expect(url).not.toContain("?");
    expect(url).not.toContain("#");
  });

  it("share text contains nothing about the person sharing", () => {
    const target = buildShareTarget(ORIGIN, SLUG, "Singulair (montelukast) 10 mg tablet");
    const blob = `${target.title} ${target.text} ${target.url}`.toLowerCase();
    for (const leak of [
      "session",
      "token",
      "member",
      "insur",
      "copay",
      "plan",
      "chat",
      "conversation",
      "user",
      "@",
    ]) {
      expect(blob, `share payload leaked "${leak}"`).not.toContain(leak);
    }
  });

  it("share text does not urge anyone to take the drug", () => {
    const target = buildShareTarget(ORIGIN, SLUG, "Singulair (montelukast) 10 mg tablet");
    const blob = `${target.title} ${target.text}`.toLowerCase();
    for (const pushy of ["ask your doctor for", "get a prescription", "you should take", "try "]) {
      expect(blob).not.toContain(pushy);
    }
    // It should describe the content instead.
    expect(blob).toMatch(/benefits and risks|plain-language/);
  });

  it("detects a URL that gained extra data", () => {
    expect(urlCarriesExtraData(`${ORIGIN}/medications/${SLUG}?ref=abc`)).toBe(true);
    expect(urlCarriesExtraData(`${ORIGIN}/medications/${SLUG}#chat`)).toBe(true);
    expect(urlCarriesExtraData("not a url")).toBe(true);
  });
});
