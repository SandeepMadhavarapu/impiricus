import { describe, it, expect, afterEach } from "vitest";
import { CoverageRequestSchema } from "@/patient/lib/coverage/types";
import {
  listGuides,
  productRxcuis,
  productPresentation,
} from "@/sources/lib/content/catalogue";

/**
 * F-06: the clinician workspace must not be served on the patient deployment.
 *
 * The audit recorded that /doctor was reachable on impiricus.vercel.app, so a
 * patient following a shared link could walk into a screen built for a
 * prescriber. The gate has to fail CLOSED - an unset or misspelt APP_MODE must
 * withhold the clinician workspace, never expose it.
 */
const ORIGINAL_MODE = process.env.APP_MODE;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function setEnv(mode: string | undefined, nodeEnv: string) {
  if (mode === undefined) delete process.env.APP_MODE;
  else process.env.APP_MODE = mode;
  // NODE_ENV is readonly in the Node types but writable at runtime; tests need
  // to exercise the production branch.
  (process.env as Record<string, string>).NODE_ENV = nodeEnv;
}

afterEach(async () => {
  setEnv(ORIGINAL_MODE, ORIGINAL_NODE_ENV ?? "test");
});

/** Imported fresh each time: the module reads process.env when called, not at import. */
async function servesClinician(): Promise<boolean> {
  const mod = await import("@/shared/lib/config");
  return mod.servesClinicianWorkspace();
}

describe("clinician workspace is gated by deployment", () => {
  it("is withheld in production when APP_MODE is patient", async () => {
    setEnv("patient", "production");
    expect(await servesClinician()).toBe(false);
  });

  it("fails closed in production when APP_MODE is unset", async () => {
    setEnv(undefined, "production");
    expect(await servesClinician()).toBe(false);
  });

  it("fails closed in production on a misspelt value", async () => {
    for (const bad of ["Doctors", "clinician", "true", "", "patient"]) {
      setEnv(bad, "production");
      expect(await servesClinician(), `APP_MODE="${bad}" must not open the workspace`).toBe(false);
    }
  });

  it("is served in production on the clinician deployment", async () => {
    setEnv("doctor", "production");
    expect(await servesClinician()).toBe(true);
    // Case- and whitespace-insensitive, because deployment consoles are not
    // careful and a trailing space is not a different intent.
    for (const ok of ["Doctor", "DOCTOR", " doctor ", "DOCTOR "]) {
      setEnv(ok, "production");
      expect(await servesClinician(), `APP_MODE="${ok}" should be accepted`).toBe(true);
    }
  });

  it("is served outside production, so one checkout can work on either side", async () => {
    setEnv("patient", "development");
    expect(await servesClinician()).toBe(true);
  });
});

/**
 * The coverage form is rendered on every medication page. Before this, two of
 * the three pages had a "Check coverage" button that could not succeed: the
 * Ozempic slug was rejected by the request schema for containing the
 * underscore the pipeline uses to encode a decimal point, and Toprol XL was
 * rejected as an unknown medication because the endpoint resolved through the
 * authored registry rather than the catalogue.
 */
describe("every published medication can reach the coverage endpoint", () => {
  const base = {
    insurer: "UnitedHealthcare",
    planName: "AARP Medicare Rx Preferred from UHC (PDP)",
    planYear: 2026,
    dosageForm: "tablet",
    quantity: 30,
    daysSupply: 30,
    pharmacyType: "unspecified" as const,
  };

  it("accepts every published slug, including ones containing an underscore", () => {
    const slugs = listGuides().map((g) => g.slug);
    expect(slugs.some((s) => s.includes("_")), "no underscore slug left to test").toBe(true);

    for (const slug of slugs) {
      const parsed = CoverageRequestSchema.safeParse({ ...base, slug, strength: "10 mg" });
      expect(parsed.success, `request schema rejected published slug "${slug}"`).toBe(true);
    }
  });

  it("still rejects a slug that could reach outside the catalogue", () => {
    for (const bad of ["../etc/passwd", "a/b", "a.b", "A-B", "a b", ""]) {
      const parsed = CoverageRequestSchema.safeParse({ ...base, slug: bad, strength: "10 mg" });
      expect(parsed.success, `request schema accepted "${bad}"`).toBe(false);
    }
  });

  it("knows a strength for every published medication, so the guard can run", () => {
    for (const guide of listGuides()) {
      // A parsed strength, not a text blob: the blob is what let a denominator
      // count as a strength.
      const p = productPresentation(guide.slug);
      expect(p, `no presentation for ${guide.slug}`).not.toBeNull();
      expect(p!.strength, `no parseable strength for ${guide.slug}`).not.toBeNull();
      expect(p!.dosageForm.length).toBeGreaterThan(0);
    }
  });

  it("knows at least one RXCUI for every published medication", () => {
    for (const guide of listGuides()) {
      expect(
        productRxcuis(guide.slug).length,
        `${guide.slug} has no RXCUI, so its coverage can never be looked up`
      ).toBeGreaterThan(0);
    }
  });

  it("returns nothing for a slug the catalogue does not publish", () => {
    expect(productRxcuis("not-a-real-slug")).toEqual([]);
    expect(productPresentation("not-a-real-slug")).toBeNull();
  });
});
