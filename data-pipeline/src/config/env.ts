/**
 * Local environment loading for the pipeline CLI.
 *
 * Node does NOT read `.env` files on its own. Node 20.6+ has an `--env-file`
 * flag, but it only applies when someone remembers to pass it, and it does not
 * give existing process variables precedence. So the loading is explicit here.
 *
 * TWO RULES
 *
 * 1. The process environment always wins. CI sets `OPENFDA_API_KEY` from a
 *    repository secret; a stale `.env.local` on a developer's machine must
 *    never override it, or a workflow would silently use the wrong credential.
 *
 * 2. Paths resolve from the PIPELINE DIRECTORY, not `process.cwd()`. The CLI is
 *    run from the repository root as often as from `data-pipeline/`, and a
 *    cwd-relative lookup finds the file in one case and not the other.
 *
 * Nothing here logs a value. `describeEnv()` reports only whether a variable is
 * set and how long it is, which is enough to diagnose a misconfiguration
 * without putting the secret anywhere it could be read.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The pipeline package root, derived from this module's own location.
 *
 * `src/config/env.ts` -> up two levels. Resolving from the module rather than
 * the working directory is what makes `npm run --prefix data-pipeline` and
 * `cd data-pipeline && npm run` behave identically.
 */
export const PIPELINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Files consulted, in order. The first to define a key wins among files. */
const ENV_FILES = [".env.local", ".env"] as const;

export interface EnvLoadResult {
  /** Absolute paths that existed and were read. */
  filesRead: string[];
  /** Absolute paths checked but absent. */
  filesMissing: string[];
  /** Names set from a file because the process did not already define them. */
  namesLoaded: string[];
  /** Names found in a file but ignored because the process already had them. */
  namesSkippedProcessWins: string[];
}

/**
 * Parses `KEY=value` lines.
 *
 * Deliberately small: comments, blank lines, `export ` prefixes, and matching
 * surrounding quotes. No variable interpolation, no multi-line values - a
 * pipeline secret does not need them, and each feature is another way for a
 * value to be transformed into something the author did not intend.
 */
export function parseEnvFile(contents: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;

    const name = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;

    let value = withoutExport.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out.set(name, value);
  }
  return out;
}

let loaded: EnvLoadResult | null = null;

/**
 * Loads `.env.local` then `.env` from the pipeline root into `process.env`.
 *
 * Idempotent: repeated calls return the first result rather than re-reading,
 * so importing this from several entry points cannot produce different states.
 */
export function loadPipelineEnv(opts: { force?: boolean } = {}): EnvLoadResult {
  if (loaded && !opts.force) return loaded;

  const result: EnvLoadResult = {
    filesRead: [],
    filesMissing: [],
    namesLoaded: [],
    namesSkippedProcessWins: [],
  };

  for (const file of ENV_FILES) {
    const abs = path.join(PIPELINE_ROOT, file);
    if (!existsSync(abs)) {
      result.filesMissing.push(abs);
      continue;
    }
    result.filesRead.push(abs);

    let parsed: Map<string, string>;
    try {
      parsed = parseEnvFile(readFileSync(abs, "utf8"));
    } catch {
      // An unreadable env file is not fatal: the process environment may
      // already carry everything needed. It is reported, not thrown.
      continue;
    }

    for (const [name, value] of parsed) {
      // Rule 1: anything already in the environment stays.
      if (process.env[name] !== undefined && process.env[name] !== "") {
        if (!result.namesSkippedProcessWins.includes(name)) {
          result.namesSkippedProcessWins.push(name);
        }
        continue;
      }
      if (result.namesLoaded.includes(name)) continue;
      process.env[name] = value;
      result.namesLoaded.push(name);
    }
  }

  loaded = result;
  return result;
}

/**
 * A safe description of a credential's presence.
 *
 * Returns whether it is set, where it came from, and its length. NEVER the
 * value, not even a prefix: a few characters of an API key are still key
 * material, and this string ends up in run summaries.
 */
export function describeSecret(name: string): {
  name: string;
  configured: boolean;
  length: number;
  source: "process-environment" | "local-env-file" | "absent";
} {
  const state = loaded;
  const value = process.env[name];
  const configured = typeof value === "string" && value.trim().length > 0;

  return {
    name,
    configured,
    length: configured ? value!.trim().length : 0,
    source: !configured
      ? "absent"
      : state?.namesLoaded.includes(name)
        ? "local-env-file"
        : "process-environment",
  };
}

/**
 * Redacts known secret values from arbitrary text.
 *
 * The last line of defence before anything is written to a log, an error, a
 * provenance record or a workflow summary. Values shorter than 8 characters
 * are not substituted, because replacing a short string would corrupt
 * unrelated text more often than it would protect anything.
 */
export function redactSecrets(text: string, names: string[] = SECRET_ENV_NAMES): string {
  let out = text;
  for (const name of names) {
    const value = process.env[name];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length < 8) continue;
    out = out.split(trimmed).join(`<${name}:REDACTED>`);
  }
  return out;
}

/** Environment variables treated as secret everywhere in the pipeline. */
export const SECRET_ENV_NAMES = ["OPENFDA_API_KEY"];
