import { describe, it, expect, afterEach } from "vitest";

/**
 * The clinician workspace must not be served on the patient deployment.
 *
 * /doctor was reachable on the patient domain, so a patient following a shared
 * link could walk into a screen built for a prescriber - prescriber-directed
 * labeling, a share tool, an NFC tap point - with nothing marking it as not
 * for them.
 *
 * The gate has to fail CLOSED: an unset or misspelt APP_MODE must withhold the
 * workspace, never expose it.
 */
const ORIGINAL_MODE = process.env.APP_MODE;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function setEnv(mode: string | undefined, nodeEnv: string) {
  if (mode === undefined) delete process.env.APP_MODE;
  else process.env.APP_MODE = mode;
  // Readonly in the Node types, writable at runtime; the production branch
  // cannot be exercised otherwise.
  (process.env as Record<string, string>).NODE_ENV = nodeEnv;
}

afterEach(() => setEnv(ORIGINAL_MODE, ORIGINAL_NODE_ENV ?? "test"));

/** Imported fresh each call: the module reads process.env when called. */
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

  it.each(["Doctors", "clinician", "true", "", "patient", "DOCTOR_MODE"])(
    "fails closed in production on the misspelt value %s",
    async (bad) => {
      setEnv(bad, "production");
      expect(await servesClinician()).toBe(false);
    }
  );

  it("is served in production on the clinician deployment", async () => {
    // Case- and whitespace-insensitive: deployment consoles are not careful,
    // and a trailing space is not a different intent.
    for (const ok of ["doctor", "Doctor", "DOCTOR", " doctor ", "DOCTOR "]) {
      setEnv(ok, "production");
      expect(await servesClinician(), `APP_MODE="${ok}" should be accepted`).toBe(true);
    }
  });

  it("is served outside production, so one checkout can work on either side", async () => {
    setEnv("patient", "development");
    expect(await servesClinician()).toBe(true);
  });
});
