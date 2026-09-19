/**
 * Change detection between two retrieved versions of the same source.
 *
 * The hard part is not spotting differences. It is refusing to call a
 * difference a change when it is an artefact of how the document was rendered
 * or how this parser happened to read it. A pipeline that cannot tell those
 * apart manufactures medical alerts out of a reflowed PDF.
 *
 * Four natures are distinguished:
 *
 *   source-content        the publisher changed something
 *   formatting-only       the same statement, typeset differently
 *   parser-induced        the same document, read differently by us
 *   ambiguous-needs-review  we cannot tell, so a human must
 *
 * Only `source-content` differences describe the publisher acting, and even
 * those are exported for review. `isPatientNotification` is the literal false
 * on every record: deciding to tell a patient something changed is a clinical
 * and product judgement this pipeline does not make.
 */

import { createHash } from "node:crypto";
import type { SourceChange } from "../schemas/access.js";

/**
 * Parser build identifier.
 *
 * Bumped whenever extraction behaviour changes. A diff whose two sides were
 * produced by different parser versions is not evidence about the publisher,
 * and `compareSnapshots` refuses to classify one as `source-content`.
 */
export const PARSER_VERSION = "pdl-extract-2026.09.1";

/** One comparable assertion pulled out of a document version. */
export interface ComparableItem {
  /** Stable identity of the thing being compared, e.g. a drug name. */
  key: string;
  /** Human label for the subject. */
  subjectLabel: string;
  /** The value being tracked, e.g. "non-preferred". */
  value: string;
  /** The source's own words behind that value. */
  statedText: string;
  /** e.g. "page 73". */
  locator: string | null;
}

export interface VersionSnapshot {
  documentVersion: string;
  effectiveDate: string | null;
  contentHash: string;
  parserVersion: string;
  items: ComparableItem[];
}

/**
 * Normalises text for a formatting-insensitive comparison.
 *
 * Collapses whitespace, unifies the several dash and quote characters PDF
 * producers emit, drops the registered/trademark marks that come and go
 * between revisions, and lowercases. If two statements agree after this and
 * differed before, the difference was typography.
 */
export function normalizeForComparison(text: string): string {
  return text
    .replace(/[‐-―−]/g, "-")
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[®™℠]/g, "")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Identity of a listed drug entry, for matching across versions.
 *
 * Strips what varies between printings without changing what is listed:
 *
 *   - leading footnote markers (*, **, ******, diamonds), which are renumbered
 *     whenever a footnote is added earlier in the document
 *   - trademark and registered marks, which come and go between revisions
 *   - typographic dashes and quotes
 *
 * Keying on raw text instead produced phantom changes: "* Fintepla(R)" and
 * "* Fintepla" were reported as one drug removed and another added, when the
 * publisher had done nothing but drop a symbol.
 */
export function entryKey(text: string): string {
  return normalizeForComparison(text)
    .replace(/^[*\u2666\u25c6\u2020\u2021\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function idFor(parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

export interface CompareOptions {
  category: SourceChange["category"];
  productKeyFor?: (item: ComparableItem) => string | null;
  /**
   * Whether the newer side is already in force.
   *
   * Publishers issue a formulary weeks before it takes effect, so the newest
   * two published documents usually straddle the present: the older one is the
   * coverage in force and the newer one is next quarter's. Passing "upcoming"
   * keeps that distinction on every record produced.
   */
  effectiveStatus: SourceChange["effectiveStatus"];
  /** The date the newer side takes (or took) effect. */
  takesEffectOn: string | null;
}

/**
 * Compares two snapshots of the same source.
 *
 * Items are matched by `key`. A key present on one side only is a listing
 * change; a key on both sides with a different value is a value change.
 */
export function compareSnapshots(
  previous: VersionSnapshot,
  current: VersionSnapshot,
  opts: CompareOptions
): SourceChange[] {
  const changes: SourceChange[] = [];

  // A diff across parser builds says nothing about the publisher.
  const parserDiffers = previous.parserVersion !== current.parserVersion;

  const prevByKey = new Map(previous.items.map((i) => [i.key, i]));
  const currByKey = new Map(current.items.map((i) => [i.key, i]));
  const keys = new Set([...prevByKey.keys(), ...currByKey.keys()]);

  for (const key of [...keys].sort()) {
    const a = prevByKey.get(key);
    const b = currByKey.get(key);

    if (a && b && a.value === b.value) {
      // Same value. A differing quotation is typography, not a change.
      if (normalizeForComparison(a.statedText) !== normalizeForComparison(b.statedText)) {
        changes.push(
          build({
            category: opts.category,
            effectiveStatus: opts.effectiveStatus,
            takesEffectOn: opts.takesEffectOn,
            nature: parserDiffers ? "parser-induced" : "formatting-only",
            subjectLabel: b.subjectLabel,
            productKey: opts.productKeyFor?.(b) ?? null,
            previous,
            current,
            a,
            b,
            note: parserDiffers
              ? "The wording differs but the extracted value does not, and the two sides were " +
                "produced by different parser builds. Attributed to the parser, not the publisher."
              : "The extracted value is unchanged; only typography differs (dashes, trademark " +
                "marks or spacing). Not a change in what the source says.",
            verification: "verified-against-both-documents",
          })
        );
      }
      continue;
    }

    if (a && b) {
      changes.push(
        build({
          category: opts.category,
          effectiveStatus: opts.effectiveStatus,
          takesEffectOn: opts.takesEffectOn,
          nature: parserDiffers ? "ambiguous-needs-review" : "source-content",
          subjectLabel: b.subjectLabel,
          productKey: opts.productKeyFor?.(b) ?? null,
          previous,
          current,
          a,
          b,
          note: parserDiffers
            ? `Value moved from "${a.value}" to "${b.value}", but the sides were produced by ` +
              `different parser builds (${previous.parserVersion} vs ${current.parserVersion}). ` +
              "Cannot be attributed to the publisher without re-running both with one build."
            : opts.effectiveStatus === "upcoming"
              ? `Value is "${a.value}" in the version currently in force and becomes "${b.value}" ` +
                `in the version effective ${opts.takesEffectOn ?? "later"}. It has NOT changed yet.`
              : `Value moved from "${a.value}" to "${b.value}" between published versions.`,
          verification: parserDiffers ? "needs-human-review" : "verified-against-both-documents",
        })
      );
      continue;
    }

    // Present on one side only.
    const present = (a ?? b)!;
    const added = !a;
    changes.push(
      build({
        category: opts.category,
        effectiveStatus: opts.effectiveStatus,
        takesEffectOn: opts.takesEffectOn,
        nature: parserDiffers ? "ambiguous-needs-review" : "source-content",
        subjectLabel: present.subjectLabel,
        productKey: opts.productKeyFor?.(present) ?? null,
        previous,
        current,
        a,
        b,
        note: parserDiffers
          ? `Present in only one version, but parser builds differ, so the absence may be ours ` +
            `rather than the publisher's. Needs review.`
          : added
            ? `Appears in the newer version and was absent from the older one. Absence from the ` +
              `older document is not evidence it was excluded then.`
            : `Present in the older version and absent from the newer one. Absence is NOT the ` +
              `same as exclusion: it may have moved, been renamed, or left the list's scope.`,
        verification: parserDiffers ? "needs-human-review" : "verified-against-both-documents",
      })
    );
  }

  return changes;
}

function build(args: {
  category: SourceChange["category"];
  nature: SourceChange["nature"];
  effectiveStatus: SourceChange["effectiveStatus"];
  takesEffectOn: string | null;
  subjectLabel: string;
  productKey: string | null;
  previous: VersionSnapshot;
  current: VersionSnapshot;
  a: ComparableItem | undefined;
  b: ComparableItem | undefined;
  note: string;
  verification: SourceChange["verification"];
}): SourceChange {
  return {
    id: idFor([args.category, args.subjectLabel, args.previous.contentHash, args.current.contentHash]),
    category: args.category,
    nature: args.nature,
    subjectLabel: args.subjectLabel,
    productKey: args.productKey,
    effectiveStatus: args.effectiveStatus,
    takesEffectOn: args.takesEffectOn,
    previous: {
      documentVersion: args.previous.documentVersion,
      effectiveDate: args.previous.effectiveDate,
      contentHash: args.previous.contentHash,
      statedText: args.a?.statedText ?? null,
      locator: args.a?.locator ?? null,
    },
    current: {
      documentVersion: args.current.documentVersion,
      effectiveDate: args.current.effectiveDate,
      contentHash: args.current.contentHash,
      statedText: args.b?.statedText ?? null,
      locator: args.b?.locator ?? null,
    },
    parserVersion:
      args.previous.parserVersion === args.current.parserVersion
        ? args.current.parserVersion
        : `${args.previous.parserVersion} -> ${args.current.parserVersion}`,
    verification: args.verification,
    isPatientNotification: false,
    note: args.note,
  };
}

/** Counts by nature, for the report. */
export function summarizeChanges(changes: SourceChange[]): Record<SourceChange["nature"], number> {
  const out: Record<SourceChange["nature"], number> = {
    "source-content": 0,
    "formatting-only": 0,
    "parser-induced": 0,
    "ambiguous-needs-review": 0,
  };
  for (const c of changes) out[c.nature]++;
  return out;
}
