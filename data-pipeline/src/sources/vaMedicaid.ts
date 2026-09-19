/**
 * Virginia Medicaid Preferred Drug List / Common Core Formulary.
 *
 * This is the first insurance market in the pipeline beyond Medicare Part D.
 * It is Medicaid FEE-FOR-SERVICE only. Virginia also contracts with managed
 * care organisations that publish their own formularies; those are a different
 * benefit and are deliberately not conflated here.
 *
 * WHAT THE DOCUMENT IS
 *
 * A 73-page PDF published by the Virginia Department of Medical Assistance
 * Services through its pharmacy benefits administrator. Each page carries a
 * three-column table:
 *
 *   Preferred Agents | Non-Preferred Agents | SA Criteria
 *
 * grouped under drug-class headings.
 *
 * TWO TRAPS THIS MODULE IS BUILT AROUND
 *
 * 1. THE COLUMNS ARE INDEPENDENT LISTS, NOT ROWS OF PAIRS.
 *    On page 20 the line "metoprolol succinate   Inderal® XL" places two
 *    unrelated drugs on one visual baseline: metoprolol in the preferred
 *    column and propranolol (Inderal XL) in the non-preferred column. Reading
 *    that as a row would assert a therapeutic equivalence the document never
 *    states. Entries are therefore collected per column, never paired.
 *
 * 2. ABSENCE FROM THE PDL IS NOT NON-COVERAGE.
 *    Page 1 states the list "only includes select drug classes", and that
 *    drugs not on it "are subject to Virginia's mandatory generic substitution
 *    requirements" - a defined status, not exclusion. Semaglutide does not
 *    appear anywhere in the document; that is reported as
 *    `not-addressed-in-this-document`, never as "not covered".
 *
 * Column boundaries are derived from the document's own geometry and recorded,
 * because binding cells to the nearest header would be wrong here: the
 * "SA Criteria" header sits at x=628 while its content begins at x=375, which
 * is nearer the non-preferred header than its own.
 */

import { parsePdf, splitCells, type PdfDocument, type PdfLine } from "./pdf.js";
import { fetchBinary } from "./http.js";

export const VA_PDL_DOC_BASE =
  "https://www.virginiamedicaidpharmacyservices.com/provider/external/medicaid/vamps/doc/en-us";

/** The page the documents are published on, for a human to check. */
export const VA_PDL_LANDING =
  "https://www.virginiamedicaidpharmacyservices.com/provider/preferred-drug-list";

/**
 * Published PDL versions, as listed on the official landing page.
 *
 * The landing page is a client-rendered application, so the catalogue is
 * recorded here rather than scraped blindly. Nothing trusts these URLs on
 * faith: ingestion verifies each retrieved document's own stated effective
 * date and version string against the entry before using it, and refuses the
 * document on mismatch.
 */
export interface VaPdlVersionRef {
  /** Basename without extension, as published. */
  slug: string;
  /** Effective date the publisher assigns, ISO. */
  effectiveDate: string;
  /** Publisher's revision within that effective date. */
  version: string;
  /** What the document's own footer should read, for verification. */
  expectedFooterVersion: string;
}

export const VA_PDL_VERSIONS: VaPdlVersionRef[] = [
  {
    slug: "VAmed-PDL-List-Criteria-20261001-v2",
    effectiveDate: "2026-10-01",
    version: "v2",
    expectedFooterVersion: "10/01/2026 v2",
  },
  {
    slug: "VAmed-PDL-List-Criteria-20260701-v4",
    effectiveDate: "2026-07-01",
    version: "v4",
    expectedFooterVersion: "07/01/2026 v4",
  },
];

export function vaPdlUrl(slug: string): string {
  return `${VA_PDL_DOC_BASE}/${slug}.pdf`;
}

/* ------------------------------------------------------------- geometry */

export interface ColumnBoundaries {
  /** Left edge of the Preferred Agents column, from the header. */
  preferredX: number;
  /** Left edge of the Non-Preferred Agents column, from the header. */
  nonPreferredX: number;
  /**
   * Left edge of the SA Criteria column, DERIVED from the widest empty
   * horizontal band between the non-preferred header text and the SA header.
   * Not taken from the SA header's own x, which sits far right of its content.
   */
  saCriteriaX: number;
  /** How saCriteriaX was arrived at, so the number is auditable. */
  derivation: string;
  /** The header line the edges came from, verbatim. */
  headerEvidence: string;
  headerPage: number;
}

const HEADER_RE = /Preferred Agents/i;

function headerLine(doc: PdfDocument): { line: PdfLine; page: number } | null {
  for (const p of doc.pages) {
    const l = p.lines.find((x) => HEADER_RE.test(x.text) && /SA Criteria/i.test(x.text));
    if (l) return { line: l, page: p.pageNumber };
  }
  return null;
}

/**
 * Works out where each column starts.
 *
 * Returns null when the document does not have the expected three-column
 * header, so a changed layout surfaces as a refusal rather than as silently
 * mis-columned drugs.
 */
export function deriveColumnBoundaries(doc: PdfDocument): ColumnBoundaries | null {
  const found = headerLine(doc);
  if (!found) return null;

  const runs = found.line.runs.filter((r) => r.text.trim().length > 0);
  const preferred = runs.find((r) => /^Preferred Agents$/i.test(r.text.trim()));
  const nonIdx = runs.findIndex((r) => /^Non$/i.test(r.text.trim()));
  const sa = runs.find((r) => /SA Criteria/i.test(r.text));
  if (!preferred || nonIdx < 0 || !sa) return null;

  const nonPreferredX = runs[nonIdx]!.x;
  // Right edge of the words "Non-Preferred Agents".
  const nonPreferredEnd = Math.max(
    ...runs.slice(nonIdx, nonIdx + 3).map((r) => r.x + r.width)
  );

  // The SA column's left edge is the leftmost content that sits right of the
  // non-preferred HEADER text. A gap-width search was tried first and is
  // wrong here: the SA column has internal sub-columns (criteria at x=375,
  // durations at x=555), so the widest gap falls INSIDE the SA column and
  // splits it. The leftmost-content rule has no such failure mode, because
  // non-preferred entries all begin well left of the header's right edge.
  let leftmostRight = Infinity;
  for (const p of doc.pages) {
    for (const l of p.lines) {
      for (const r of l.runs) {
        if (r.text.trim().length === 0) continue;
        if (r.x > nonPreferredEnd && r.x < leftmostRight) leftmostRight = r.x;
      }
    }
  }
  if (!Number.isFinite(leftmostRight)) return null;

  // Sit the divider just left of that content so the column includes it.
  const saCriteriaX = Math.round(nonPreferredEnd + (leftmostRight - nonPreferredEnd) / 2);

  return {
    preferredX: preferred.x,
    nonPreferredX,
    saCriteriaX,
    derivation:
      `Non-Preferred header text ends at x=${nonPreferredEnd.toFixed(0)}; the leftmost content ` +
      `right of it begins at x=${leftmostRight.toFixed(0)}, so the divider is the midpoint, ` +
      `x=${saCriteriaX}. The "SA Criteria" header's own x (${sa.x.toFixed(0)}) is NOT usable as a ` +
      `left edge: its content begins ~250pt left of it, nearer the non-preferred header than its own.`,
    headerEvidence: found.line.text,
    headerPage: found.page,
  };
}

export type PdlColumn = "preferred" | "non-preferred" | "sa-criteria";

/**
 * Who a service-authorization criterion applies to.
 *
 * The document uses an asterisk convention: an entry marked "*Hemangeol(TM)"
 * is governed by a criteria block headed "*Clinical Criteria for Hemangeol(TM)".
 * Those criteria are NOT the class's criteria. Attaching them to every drug in
 * the Beta Blockers class would tell a reader that Toprol XL requires a
 * diagnosis of infantile hemangioma, which the document does not say about it.
 */
export type SaCriteriaScope = "class-level" | "drug-specific";

/** Criteria text with the scope it was published under. */
export interface ScopedCriteria {
  text: string;
  scope: SaCriteriaScope;
  /** Present only when scope is drug-specific: the drug the block names. */
  appliesToDrug: string | null;
  page: number;
  y: number;
}

/** "*Clinical Criteria for Hemangeol(TM)" and similar block headers. */
const DRUG_SPECIFIC_CRITERIA_HEADER =
  /^[*\u2666\u25c6\s]*Clinical Criteria for\s+(.+?)\s*$/i;

/**
 * Assigns each criteria cell to the class or to a named drug.
 *
 * Cells are read in document order. A "Clinical Criteria for X" header opens a
 * drug-specific run that continues until the next header; anything before the
 * first header belongs to the class.
 */
export function scopeCriteria(cells: PdlCell[]): ScopedCriteria[] {
  const out: ScopedCriteria[] = [];
  let currentDrug: string | null = null;

  // Document order: by page, then down the page (y descends).
  const ordered = [...cells].sort((a, b) => a.page - b.page || b.y - a.y);

  for (const c of ordered) {
    const header = DRUG_SPECIFIC_CRITERIA_HEADER.exec(c.text);
    if (header) {
      currentDrug = header[1]!.trim();
      out.push({
        text: c.text,
        scope: "drug-specific",
        appliesToDrug: currentDrug,
        page: c.page,
        y: c.y,
      });
      continue;
    }
    out.push({
      text: c.text,
      scope: currentDrug ? "drug-specific" : "class-level",
      appliesToDrug: currentDrug,
      page: c.page,
      y: c.y,
    });
  }
  return out;
}

/**
 * What the document's typography says a cell is.
 *
 * Virginia's PDL sets preferred agents in Times bold and non-preferred agents
 * in Times italic. That is independent of horizontal position, so it is used
 * to CHECK the geometric assignment rather than to replace it. Disagreements
 * are counted and reported instead of being silently resolved.
 */
export type PdlTypographyHint = "preferred-bold" | "non-preferred-italic" | "no-hint";

export function typographyHint(runs: Array<{ text: string; bold: boolean; italic: boolean }>): PdlTypographyHint {
  const solid = runs.filter((r) => r.text.trim().length > 0);
  if (solid.length === 0) return "no-hint";
  if (solid.every((r) => r.italic)) return "non-preferred-italic";
  if (solid.every((r) => r.bold)) return "preferred-bold";
  return "no-hint";
}

export function columnFor(x: number, b: ColumnBoundaries): PdlColumn {
  if (x >= b.saCriteriaX) return "sa-criteria";
  if (x >= b.nonPreferredX) return "non-preferred";
  return "preferred";
}

/* ------------------------------------------------------------ structure */

/** One line of text within one column, with the page it came from. */
export interface PdlCell {
  text: string;
  column: PdlColumn;
  page: number;
  /** Baseline, so a reader can find it on the rendered page. */
  y: number;
  x: number;
  /** Smaller type than the table body: usually a footnote or legend. */
  smallType: boolean;
  /** What typography independently suggests this cell is. */
  typography: PdlTypographyHint;
  /**
   * True when typography contradicts the geometric column assignment.
   * Surfaced rather than resolved: a disagreement means the layout model no
   * longer fits the document.
   */
  columnDisputed: boolean;
}

/**
 * A drug-class block.
 *
 * `preferred` and `nonPreferred` are INDEPENDENT lists. They are never zipped
 * into pairs, because the document does not mean them as pairs.
 */
export interface PdlClassBlock {
  className: string;
  startPage: number;
  endPage: number;
  preferred: PdlCell[];
  nonPreferred: PdlCell[];
  saCriteria: PdlCell[];
  /** True when the block runs across a page break. */
  spansPages: boolean;
  /**
   * How confident the class heading is.
   *
   * `stated` - larger bold type, clearly a heading.
   * `inferred-same-size-as-entries` - bold and alone in the preferred column,
   *   but rendered at the same size as drug rows, so it is indistinguishable
   *   from a lone preferred entry by type alone. Long headings in this
   *   document are shrunk to fit and land in this bucket.
   *
   * Class attribution is contextual metadata. The column a drug sits in does
   * not depend on it, and no assertion in the export requires it to be right.
   */
  headingConfidence: "stated" | "inferred-same-size-as-entries";
}

/** Heading type is larger than body type in this document. */
const CLASS_HEADING_MIN_HEIGHT = 11.5;

/** Horizontal extent of a cell: up to the next cell's x, or the line's end. */
function cellWidth(
  cells: Array<{ x: number }>,
  cell: { x: number }
): number {
  const next = cells.filter((c) => c.x > cell.x).sort((a, b) => a.x - b.x)[0];
  return next ? next.x - cell.x : 1000;
}

function isPageFurniture(text: string): boolean {
  return (
    /^\d+\s*\|\s*P\s*a\s*g\s*e/i.test(text) ||
    /^V\s*e\s*r\s*s\s*i\s*o\s*n\s*:/i.test(text) ||
    /^Virginia.s Medicaid Preferred Drug List/i.test(text) ||
    /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(text.trim()) ||
    HEADER_RE.test(text)
  );
}

/**
 * Splits the document into drug-class blocks.
 *
 * A class heading is a larger-type line that sits in the preferred column and
 * has no content in the other two columns. Blocks deliberately continue across
 * page boundaries: the page header repeats on every page but class headings do
 * not, so resetting at a page break would orphan the remainder of a class.
 */
export function parsePdlClasses(doc: PdfDocument, b: ColumnBoundaries): PdlClassBlock[] {
  const blocks: PdlClassBlock[] = [];
  let current: PdlClassBlock | null = null;

  for (const page of doc.pages) {
    for (const line of page.lines) {
      if (isPageFurniture(line.text)) continue;

      // Empty cells are dropped first. A heading line often carries a blank
      // run out in the SA column, and counting it made "Beta Blockers" look
      // like a two-column row rather than a heading - which silently filed
      // every beta blocker under the preceding class.
      const cells = splitCells(line)
        .map((c) => ({ text: c.text.trim(), x: c.x, column: columnFor(c.x, b) }))
        .filter((c) => c.text.length > 0);
      if (cells.length === 0) continue;

      const onlyPreferredColumn =
        cells.length === 1 && cells[0]!.column === "preferred" && cells[0]!.x < b.nonPreferredX;

      // A class heading is a MERGED cell: it is set bold, sits alone on its
      // baseline, and its text runs past the non-preferred column's left edge
      // because it spans the table rather than occupying one column.
      //
      // That span is the discriminator. Font weight alone is not: preferred
      // drugs are bold too, so "azelastine 0.1%" and "montelukast
      // tabs/chewable" would otherwise each open a new class. Drug entries
      // stay inside their column and never reach x=223; headings always do.
      const rightEdge = Math.max(...line.runs.map((r) => r.x + r.width));
      const spansIntoNextColumn = rightEdge >= b.nonPreferredX;

      if (onlyPreferredColumn && line.allBold && spansIntoNextColumn) {
        current = {
          className: cells[0]!.text,
          startPage: page.pageNumber,
          endPage: page.pageNumber,
          preferred: [],
          nonPreferred: [],
          saCriteria: [],
          spansPages: false,
          headingConfidence:
            line.fontHeight >= CLASS_HEADING_MIN_HEIGHT
              ? "stated"
              : "inferred-same-size-as-entries",
        };
        blocks.push(current);
        continue;
      }

      // Long headings wrap, and the tail ("Combinations") is short enough that
      // it no longer spans. A bold, alone, preferred-column line arriving
      // before the class has any entries is that tail, not a drug.
      if (
        current &&
        onlyPreferredColumn &&
        line.allBold &&
        current.preferred.length === 0 &&
        current.nonPreferred.length === 0
      ) {
        current.className = `${current.className} ${cells[0]!.text}`.replace(/\s+/g, " ").trim();
        current.endPage = page.pageNumber;
        continue;
      }

      if (!current) continue;
      current.endPage = page.pageNumber;
      current.spansPages = current.endPage !== current.startPage;

      // SA criteria wrap into sub-columns on one baseline ("LENGTH OF
      // AUTHORIZATION:" at x=375, "1 year" at x=555). Join them so the
      // criterion reads as written instead of arriving in fragments.
      const saOnLine = cells.filter((c) => c.column === "sa-criteria");
      const others = cells.filter((c) => c.column !== "sa-criteria");

      for (const c of others) {
        const runsInCell = line.runs.filter(
          (r) => r.x >= c.x - 0.5 && r.x < c.x + 0.5 + cellWidth(cells, c)
        );
        const hint = typographyHint(runsInCell.length > 0 ? runsInCell : line.runs);
        const expected: PdlTypographyHint =
          c.column === "preferred" ? "preferred-bold" : "non-preferred-italic";
        const cell: PdlCell = {
          text: c.text,
          column: c.column,
          page: page.pageNumber,
          y: line.y,
          x: c.x,
          smallType: line.fontHeight < 9.5,
          typography: hint,
          columnDisputed: hint !== "no-hint" && hint !== expected,
        };
        if (c.column === "preferred") current.preferred.push(cell);
        else current.nonPreferred.push(cell);
      }

      if (saOnLine.length > 0) {
        current.saCriteria.push({
          text: saOnLine.map((c) => c.text).join(" "),
          column: "sa-criteria",
          page: page.pageNumber,
          y: line.y,
          x: saOnLine[0]!.x,
          smallType: line.fontHeight < 9.5,
          typography: "no-hint",
          columnDisputed: false,
        });
      }
    }
  }
  return blocks;
}

/* -------------------------------------------------------------- lookup */

export type PdlStatus =
  /** The name appears in the Preferred Agents column. */
  | "preferred"
  /** The name appears in the Non-Preferred Agents column. */
  | "non-preferred"
  /**
   * The document does not mention the name at all. NOT "not covered" - the
   * PDL covers only selected drug classes.
   */
  | "not-addressed-in-this-document"
  /** Found in both columns, e.g. brand non-preferred and generic preferred. */
  | "appears-in-both-columns";

export interface PdlMatch {
  status: PdlStatus;
  /** Every place the search term was found, with page and column. */
  hits: Array<{
    column: PdlColumn;
    className: string;
    text: string;
    page: number;
    y: number;
  }>;
  /**
   * Service-authorization criteria text printed NEAR this drug's listing.
   *
   * Read `criteriaExtraction` before using any of it. These are candidates for
   * a human to read on the cited page, NOT a determination of what governs
   * this drug.
   */
  saCriteria: Array<{
    className: string;
    text: string;
    page: number;
    scope: SaCriteriaScope;
    appliesToDrug: string | null;
    /**
     * `same-page-within-class-span` - the criterion sits on the same page as
     *   the listing and within the vertical band of that class's rows, so the
     *   visual association is plausible.
     * `different-page-or-band` - it does not, and any association is an
     *   assumption this pipeline refuses to make.
     */
    alignment: "same-page-within-class-span" | "different-page-or-band";
  }>;
  /** Criteria in the same class block that explicitly name a different drug. */
  criteriaExcludedAsOtherDrug: Array<{ text: string; appliesToDrug: string; page: number }>;
  /**
   * Why criteria are not resolved to drugs.
   *
   * The SA Criteria column does not align to the left column's class
   * headings: a criteria block's header can sit above the heading of the class
   * its bullets belong to. Any rule that walks left-column classes and claims
   * the right column's text therefore mis-assigns criteria - which is how
   * "Clinical Criteria for Hemangeol" (propranolol, infantile hemangioma) came
   * to be offered as Toprol XL's requirement during development.
   *
   * Structured criteria extraction is REFUSED rather than guessed. Column
   * membership, drug class and page citation are extracted and verified; the
   * criteria text is carried verbatim for a human to read in place.
   */
  criteriaExtraction: {
    complete: false;
    status: "incomplete-extraction";
    reason: string;
    readInstead: string;
  };
  /** Classes the term appeared in. */
  classes: string[];
}

/**
 * Finds a drug name in the PDL.
 *
 * Matching is literal and case-insensitive against the document's own text.
 * It does not expand brands to ingredients or vice versa: "Singulair" and
 * "montelukast" are searched separately, because the document lists them in
 * DIFFERENT columns and collapsing them would erase that.
 */
export function findInPdl(blocks: PdlClassBlock[], term: string): PdlMatch {
  const needle = term.toLowerCase();
  const hits: PdlMatch["hits"] = [];
  const classes = new Set<string>();

  for (const block of blocks) {
    for (const [column, cells] of [
      ["preferred", block.preferred],
      ["non-preferred", block.nonPreferred],
    ] as const) {
      for (const c of cells) {
        if (!c.text.toLowerCase().includes(needle)) continue;
        hits.push({
          column,
          className: block.className,
          text: c.text,
          page: c.page,
          y: c.y,
        });
        classes.add(block.className);
      }
    }
  }

  const saCriteria: PdlMatch["saCriteria"] = [];
  const criteriaExcludedAsOtherDrug: PdlMatch["criteriaExcludedAsOtherDrug"] = [];

  for (const block of blocks) {
    if (!classes.has(block.className)) continue;

    // Vertical band this class occupies, per page, from its own rows.
    const bandByPage = new Map<number, { top: number; bottom: number }>();
    for (const cell of [...block.preferred, ...block.nonPreferred]) {
      const band = bandByPage.get(cell.page);
      if (!band) bandByPage.set(cell.page, { top: cell.y, bottom: cell.y });
      else {
        band.top = Math.max(band.top, cell.y);
        band.bottom = Math.min(band.bottom, cell.y);
      }
    }

    for (const c of scopeCriteria(block.saCriteria)) {
      if (c.scope === "drug-specific") {
        const namesThisDrug =
          c.appliesToDrug !== null && c.appliesToDrug.toLowerCase().includes(needle);
        if (!namesThisDrug) {
          criteriaExcludedAsOtherDrug.push({
            text: c.text,
            appliesToDrug: c.appliesToDrug ?? "unnamed",
            page: c.page,
          });
          continue;
        }
      }

      const band = bandByPage.get(c.page);
      const aligned = band !== undefined && c.y <= band.top && c.y >= band.bottom;

      saCriteria.push({
        className: block.className,
        text: c.text,
        page: c.page,
        scope: c.scope,
        appliesToDrug: c.appliesToDrug,
        alignment: aligned ? "same-page-within-class-span" : "different-page-or-band",
      });
    }
  }

  const inPreferred = hits.some((h) => h.column === "preferred");
  const inNonPreferred = hits.some((h) => h.column === "non-preferred");

  const status: PdlStatus =
    inPreferred && inNonPreferred
      ? "appears-in-both-columns"
      : inPreferred
        ? "preferred"
        : inNonPreferred
          ? "non-preferred"
          : "not-addressed-in-this-document";

  return {
    status,
    hits,
    saCriteria,
    criteriaExcludedAsOtherDrug,
    criteriaExtraction: {
      complete: false,
      status: "incomplete-extraction",
      reason:
        "The SA Criteria column is not aligned to the drug-class headings in the left column: a " +
        "criteria block's header can appear above the heading of the class whose rows its bullets " +
        "govern. No rule over the left column can therefore establish which criteria bind which " +
        "drug, so this pipeline does not assert one.",
      readInstead:
        "Open the cited page of the published PDF and read the SA Criteria column beside the " +
        "listing. Column membership, drug class and page number ARE verified and can be relied on.",
    },
    classes: [...classes],
  };
}

/* ------------------------------------------------------------ retrieval */

export interface VaPdlRetrieval {
  ref: VaPdlVersionRef;
  url: string;
  doc: PdfDocument;
  /** The version string the document states about itself. */
  statedFooterVersion: string | null;
  /** The effective date printed in the page header. */
  statedEffectiveDate: string | null;
  /** False when the document contradicts the catalogue entry. */
  verified: boolean;
  verificationNote: string;
}

/**
 * Retrieves one PDL version and checks the document against the catalogue.
 *
 * The footer of every page reads "V e r s i o n : 1 0 / 0 1 / 2 0 2 6 v 2",
 * letter-spaced. Spaces are stripped before comparison, so the check reads the
 * document's own claim rather than a URL we chose.
 */
export async function retrievePdl(ref: VaPdlVersionRef): Promise<VaPdlRetrieval> {
  const url = vaPdlUrl(ref.slug);
  const bytes = await fetchBinary(url);
  const doc = await parsePdf(bytes, { url });

  let statedFooterVersion: string | null = null;
  for (const p of doc.pages) {
    const f = p.lines.find((l) => /^V\s*e\s*r\s*s\s*i\s*o\s*n\s*:/i.test(l.text));
    if (f) {
      statedFooterVersion = f.text.replace(/\s+/g, "").replace(/^Version:/i, "");
      break;
    }
  }

  const firstPage = doc.pages[0];
  const dateLine = firstPage?.lines.find((l) => /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(l.text.trim()));
  const statedEffectiveDate = dateLine ? dateLine.text.trim() : null;

  const expected = ref.expectedFooterVersion.replace(/\s+/g, "");
  const verified = statedFooterVersion === expected;

  return {
    ref,
    url,
    doc,
    statedFooterVersion,
    statedEffectiveDate,
    verified,
    verificationNote: verified
      ? `Document footer states version ${statedFooterVersion}, matching the catalogue entry.`
      : `MISMATCH: catalogue expected ${expected}; the document states ` +
        `${statedFooterVersion ?? "no version"}. The document, not the catalogue, is authoritative.`,
  };
}
