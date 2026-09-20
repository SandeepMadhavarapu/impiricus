import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import DoctorPage from "@/app/doctor/page";
import { getMedication, DEFAULT_MEDICATION_SLUG } from "@/sources/lib/content/registry";

const slug = DEFAULT_MEDICATION_SLUG;
afterEach(() => vi.unstubAllEnvs());
async function render(medication?: string | string[]) {
  return renderToStaticMarkup(await DoctorPage({ searchParams: Promise.resolve({ medication }) }));
}

describe("doctor workflow", () => {
  it("starts with the supported product and no active share action", async () => {
    const html = await render();
    expect(html).toContain("Patient Medication Guide");
    expect(html).toContain("Send prescription data safely and securely");
    expect(html).toContain("Singulair (montelukast sodium) 10 mg tablet, film coated");
    expect(html).toContain("Start with a medication");
    expect(html).toMatch(/disabled="">Share with Patient/);
  });

  it("walks the three steps in order", async () => {
    const html = await render(slug);
    expect(html.indexOf("Step 1")).toBeLessThan(html.indexOf("Step 2"));
    expect(html.indexOf("Step 2")).toBeLessThan(html.indexOf("Step 3"));
  });

  /**
   * The clinician screen collapses the guide to headings so it can be scanned
   * mid-consult. The content must still be THERE and still be verbatim: a
   * preview that paraphrases is not a preview of what the patient gets.
   */
  it("previews every section the patient will see, verbatim", async () => {
    const html = await render(slug);
    const { record } = getMedication(slug)!;
    for (const section of record.sections) {
      expect(html).toContain(renderToStaticMarkup(section.title));
      for (const paragraph of section.plain) {
        expect(html).toContain(renderToStaticMarkup(paragraph));
      }
    }
  });

  it("shows the boxed warning first and flags it", async () => {
    const html = await render(slug);
    const { record } = getMedication(slug)!;
    const boxed = record.sections.find((s) => s.id === "boxed-warning")!;
    const other = record.sections.find((s) => s.id === "what-it-is")!;
    expect(html.indexOf(boxed.title)).toBeLessThan(html.indexOf(other.title));
    expect(html).toContain("Boxed warning");
  });

  it("offers both a patient preview and a send action once a drug is chosen", async () => {
    const html = await render(slug);
    expect(html).toContain(`href="/medications/${slug}"`);
    expect(html).toContain("Send to patient");
    expect(html).toContain('aria-current="true"');
  });

  it("keeps provenance and refuses to claim a clinical review", async () => {
    const html = await render(slug);
    expect(html).toContain("No clinical review has been performed.");
    expect(html).toContain("Retrieved on");
  });

  it.each(["unknown-drug", "singulair-montelukast-5mg-chewable", [slug, "other"]])(
    "never substitutes a drug for invalid selection %j",
    async (selection) => {
      const html = await render(selection);
      expect(html).toContain("Medication unavailable");
      expect(html).not.toContain("Send to patient");
      expect(html).not.toContain(">Send Nearby</button>");
      expect(html).toMatch(/disabled="">Share with Patient/);
    }
  );

  it("uses only the configured public medication URL", async () => {
    vi.stubEnv("PUBLIC_ORIGIN", "https://mediz.example/doctor?session=private#patient");
    const html = await render(slug);
    expect(html).toContain(`https://mediz.example/medications/${slug}`);
    expect(html).not.toContain("session=private");
    expect(html).not.toContain("#patient");
    expect(html).not.toMatch(/disabled="">Share with Patient/);
  });

  it.each(["", "http://localhost:3000", "https://localhost", "http://unsafe.example"])(
    "blocks off-device sharing for unavailable public origin %j",
    async (origin) => {
      vi.stubEnv("PUBLIC_ORIGIN", origin);
      vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "");
      const html = await render(slug);
      expect(html).toContain("Sharing needs a public HTTPS deployment");
      expect(html).toMatch(/disabled="">Share with Patient/);
    }
  );
});

it.each(["", "http://localhost:3000", "http://unsafe.example", "https://preview.example"])("enables nearby sharing for a selected medication in production regardless of public origin %j", async (origin) => {
  vi.stubEnv("NODE_ENV", "production");
  // The clinician workspace is only served on the clinician deployment. This
  // test is about nearby sharing, so it states that premise rather than
  // relying on /doctor being reachable everywhere, which it no longer is.
  vi.stubEnv("APP_MODE", "doctor");
  vi.stubEnv("PUBLIC_ORIGIN", origin);
  vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "");
  const html = await render(slug);
  const button = html.match(/<button[^>]*>Send Nearby<\/button>/)?.[0];
  expect(button).toBeDefined();
  expect(button).not.toContain("disabled");
});
