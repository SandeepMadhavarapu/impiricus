import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import DoctorPage from "@/app/doctor/page";
import { getMedication, DEFAULT_MEDICATION_SLUG } from "@/lib/content/registry";

const slug = DEFAULT_MEDICATION_SLUG;
afterEach(() => vi.unstubAllEnvs());
async function render(medication?: string | string[]) {
  return renderToStaticMarkup(await DoctorPage({ searchParams: Promise.resolve({ medication }) }));
}

describe("doctor workflow", () => {
  it("starts with the supported product and no active share action", async () => {
    const html = await render();
    expect(html).toContain("DocUpdate Integration Preview");
    expect(html).toContain("Create a patient medication guide");
    expect(html).toContain("Singulair (montelukast sodium) 10 mg tablet, film coated");
    expect(html).toContain("Start with a medication");
    expect(html).toMatch(/disabled="">Share with Patient/);
    expect(html).not.toContain('id="sec-boxed-warning"');
  });

  it("previews the existing content verbatim, with safety first and provenance", async () => {
    const html = await render(slug);
    const { record } = getMedication(slug)!;
    for (const section of record.sections) {
      expect(html).toContain(`id="sec-${section.id}"`);
      // Render the text through React to account for HTML escaping.
      for (const paragraph of section.plain) {
        expect(html).toContain(renderToStaticMarkup(paragraph));
      }
    }
    expect(html.indexOf('id="sec-boxed-warning"')).toBeLessThan(html.indexOf('id="sec-what-it-is"'));
    expect(html).toContain("No clinical review has been performed.");
    expect(html).toContain("Retrieved on");
    expect(html).toContain(`href="/medications/${slug}"`);
    expect(html).toContain('aria-current="true"');
  });

  it.each(["unknown-drug", "singulair-montelukast-5mg-chewable", [slug, "other"]])("never substitutes a drug for invalid selection %j", async (selection) => {
    const html = await render(selection);
    expect(html).toContain("Medication unavailable");
    expect(html).not.toContain('id="sec-boxed-warning"');
    expect(html).toMatch(/disabled="">Share with Patient/);
  });

  it("uses only the configured public medication URL", async () => {
    vi.stubEnv("PUBLIC_ORIGIN", "https://medbridge.example/doctor?session=private#patient");
    const html = await render(slug);
    expect(html).toContain(`https://medbridge.example/medications/${slug}`);
    expect(html).not.toContain("session=private");
    expect(html).not.toContain("#patient");
    expect(html).not.toMatch(/disabled="">Share with Patient/);
  });

  it.each(["", "http://localhost:3000", "https://localhost", "http://unsafe.example"])("blocks off-device sharing for unavailable public origin %j", async (origin) => {
    vi.stubEnv("PUBLIC_ORIGIN", origin);
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "");
    const html = await render(slug);
    expect(html).toContain("Sharing needs a public HTTPS deployment");
    expect(html).toMatch(/disabled="">Share with Patient/);
  });
});
