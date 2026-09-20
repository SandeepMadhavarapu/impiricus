import { describe, it, expect, afterEach } from "vitest";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { withOpenFdaKey, sanitizeUrl } from "@pipeline/sources/http.js";
import { redactSecrets, SECRET_ENV_NAMES } from "@pipeline/config/env.js";

/**
 * Credential containment, proved with a canary rather than asserted.
 *
 * CANARY, NOT A REAL KEY. The value below is a made-up string that exists only
 * inside this file. A real key must never reach a command line, a test name, a
 * fixture or test output - which is also why nothing here reads the operator's
 * actual OPENFDA_API_KEY.
 *
 * The canary is deliberately distinctive so a scan for it cannot collide with
 * ordinary content.
 */
const CANARY = "CANARY-fake-openfda-key-0000000000000000";

const PIPELINE_ROOT = process.cwd();
const REPO_ROOT = path.join(PIPELINE_ROOT, "..");

const prior = process.env.OPENFDA_API_KEY;
afterEach(() => {
  if (prior === undefined) delete process.env.OPENFDA_API_KEY;
  else process.env.OPENFDA_API_KEY = prior;
});

describe("the key is attached to requests but never to anything recorded", () => {
  it("attaches the key to an outbound openFDA URL", () => {
    process.env.OPENFDA_API_KEY = CANARY;
    const url = withOpenFdaKey("https://api.fda.gov/drug/label.json?search=x");
    // It has to actually be used, or the authenticated rate limit is fiction.
    expect(url).toContain(`api_key=${CANARY}`);
  });

  it("removes it again before that URL is recorded or logged", () => {
    process.env.OPENFDA_API_KEY = CANARY;
    const sanitized = sanitizeUrl(withOpenFdaKey("https://api.fda.gov/drug/label.json?search=x"));
    expect(sanitized).not.toContain(CANARY);
    expect(sanitized).toContain("api_key=REDACTED");
    // The rest of the URL must survive, or provenance becomes useless.
    expect(sanitized).toContain("search=x");
  });

  it.each(["api_key", "apikey", "key", "token", "access_token"])(
    "redacts a credential carried as ?%s",
    (param) => {
      const sanitized = sanitizeUrl(`https://example.org/x?${param}=${CANARY}&page=2`);
      expect(sanitized).not.toContain(CANARY);
      expect(sanitized).toContain("page=2");
    }
  );

  it("strips the key out of an error message before it is surfaced", () => {
    process.env.OPENFDA_API_KEY = CANARY;
    const thrown = `fetch failed for https://api.fda.gov/drug/label.json?api_key=${CANARY}`;
    const safe = redactSecrets(thrown);
    expect(safe).not.toContain(CANARY);
    expect(safe).toContain("<OPENFDA_API_KEY:REDACTED>");
  });

  it("covers every environment variable declared secret", () => {
    // If a second credential is ever added, this fails until it is redacted
    // too, rather than leaking silently.
    for (const name of SECRET_ENV_NAMES) {
      const saved = process.env[name];
      process.env[name] = CANARY;
      try {
        expect(redactSecrets(`value=${CANARY}`)).not.toContain(CANARY);
      } finally {
        if (saved === undefined) delete process.env[name];
        else process.env[name] = saved;
      }
    }
  });
});

/* --------------------------------------------------- committed artifacts -- */

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "raw", // request captures are gitignored working files, not artifacts
]);

async function walk(dir: string, out: string[] = [], depth = 0): Promise<string[]> {
  if (depth > 8) return out;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out, depth + 1);
    else if (/\.(json|md|txt|ts|tsx|mjs|js|yml|yaml)$/.test(e.name)) out.push(full);
  }
  return out;
}

describe("no credential material sits in a generated artifact", () => {
  /**
   * The real risk is not the canary - it is a live key written into an export,
   * a provenance URL or a report at some point in the past. So this scans for
   * the SHAPE of a credential rather than for a known value: any `api_key=`
   * whose value is not the redaction placeholder.
   */
  it("has no unredacted api_key in any pipeline export, report or manifest", async () => {
    const roots = [
      path.join(PIPELINE_ROOT, "data", "exports"),
      path.join(PIPELINE_ROOT, "data", "reports"),
      path.join(PIPELINE_ROOT, "data", "manifests"),
      path.join(PIPELINE_ROOT, "data", "normalized"),
    ];
    const offenders: string[] = [];
    for (const root of roots) {
      try {
        await stat(root);
      } catch {
        continue;
      }
      for (const file of await walk(root)) {
        const text = await readFile(file, "utf8");
        for (const m of text.matchAll(/(api_key|apikey|access_token)=([^"&\s\\]+)/gi)) {
          if (m[2] !== "REDACTED") offenders.push(`${path.relative(REPO_ROOT, file)}: ${m[1]}=<value>`);
        }
      }
    }
    expect(offenders, `credential-shaped values found:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("has no unredacted api_key in anything the app ships to a browser", async () => {
    const offenders: string[] = [];
    for (const file of await walk(path.join(REPO_ROOT, "src"))) {
      const text = await readFile(file, "utf8");
      for (const m of text.matchAll(/(api_key|apikey|access_token)=([^"&\s\\]+)/gi)) {
        if (m[2] !== "REDACTED") offenders.push(`${path.relative(REPO_ROOT, file)}`);
      }
      // A public env var is how a server-side secret becomes a browser-side one.
      if (/NEXT_PUBLIC_[A-Z_]*(KEY|TOKEN|SECRET)/.test(text)) {
        offenders.push(`${path.relative(REPO_ROOT, file)}: public env var named like a credential`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("never names the openFDA key in application code", async () => {
    // The app has no business reading it: every authenticated call is made by
    // the pipeline. A reference here would mean the key reached the web tier.
    const offenders: string[] = [];
    for (const file of await walk(path.join(REPO_ROOT, "src"))) {
      const text = await readFile(file, "utf8");
      if (text.includes("OPENFDA_API_KEY")) offenders.push(path.relative(REPO_ROOT, file));
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("keeps .env.local untracked and out of the pipeline's own exports", async () => {
    const offenders: string[] = [];
    for (const file of await walk(path.join(PIPELINE_ROOT, "data"))) {
      const text = await readFile(file, "utf8");
      if (text.includes("OPENFDA_API_KEY=")) offenders.push(path.relative(REPO_ROOT, file));
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
