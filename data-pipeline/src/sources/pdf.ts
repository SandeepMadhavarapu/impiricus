/**
 * PDF text extraction with layout preserved.
 *
 * Insurance policy documents are tables with footnotes. A naive text dump
 * destroys exactly the things that carry meaning:
 *
 *   - which column a cell belongs to (preferred vs non-preferred)
 *   - which row a footnote marker was attached to
 *   - whether a row continued onto the next page under a repeated header
 *   - the page a statement came from, needed to cite it
 *
 * So extraction keeps geometry. Every text run carries its x/y position and
 * font height; runs are grouped into lines by baseline, and lines keep their
 * runs so a caller can reconstruct columns by x. Nothing is flattened to a
 * single string until a caller asks for it.
 *
 * This module does not interpret a document. It only recovers structure that
 * the PDF already has, and records where each piece came from.
 */

import { createHash } from "node:crypto";

/** A single positioned text run, as the PDF stores it. */
export interface PdfRun {
  text: string;
  /** Distance from the left edge, in PDF points. */
  x: number;
  /** Distance from the BOTTOM edge, in PDF points (PDF origin is bottom-left). */
  y: number;
  width: number;
  /** Rendered glyph height; a proxy for font size. */
  fontHeight: number;
  /**
   * Resolved font name, e.g. "BCDEEE+TimesNewRomanPS-BoldMT".
   *
   * Worth the extra work: documents frequently encode meaning in typography
   * that is invisible in plain text. Virginia's PDL sets preferred drugs in
   * bold and non-preferred in italic, which gives a second, independent way to
   * check a column assignment derived from geometry.
   */
  fontName: string;
  bold: boolean;
  italic: boolean;
}

/** Runs sharing a baseline, left to right. */
export interface PdfLine {
  pageNumber: number;
  /** Baseline, from the bottom of the page. */
  y: number;
  runs: PdfRun[];
  /** Runs joined with single spaces. Column structure is lost here by design. */
  text: string;
  /** Median font height on the line. Small lines are usually footnotes. */
  fontHeight: number;
  /** True when every non-space run on the line is bold (resp. italic). */
  allBold: boolean;
  allItalic: boolean;
}

export interface PdfPage {
  pageNumber: number;
  width: number;
  height: number;
  lines: PdfLine[];
}

export interface PdfDocument {
  /** Where it came from, exactly as requested. */
  url: string | null;
  /** sha256 of the raw bytes. The evidence hash for anything extracted. */
  sha256: string;
  byteLength: number;
  retrievedAt: string;
  pageCount: number;
  pages: PdfPage[];
  /** Metadata the document states about itself, when present. */
  info: {
    title: string | null;
    creationDate: string | null;
    modificationDate: string | null;
    producer: string | null;
  };
}

/**
 * Two runs belong to the same line when their baselines are within this
 * fraction of the font height. Superscript footnote markers sit slightly
 * above the baseline, and this tolerance deliberately keeps them on the line
 * they annotate rather than orphaning them.
 */
const BASELINE_TOLERANCE = 0.5;

/** A horizontal gap wider than this many spaces implies a column break. */
export const COLUMN_GAP_SPACES = 1.6;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

/**
 * Joins runs into a line's text.
 *
 * PDFs often emit a word as several runs with no space run between them, and
 * emit column separation as a wide horizontal gap rather than whitespace. So
 * spacing is inferred from geometry, not from the absence of a space glyph.
 */
function joinRuns(runs: PdfRun[]): string {
  let out = "";
  let prev: PdfRun | null = null;
  for (const r of runs) {
    if (prev) {
      const gap = r.x - (prev.x + prev.width);
      // A space is roughly a third of the font height in most faces.
      const spaceWidth = Math.max(prev.fontHeight, r.fontHeight) * 0.33;
      if (gap > spaceWidth * 0.5) out += " ";
    }
    out += r.text;
    prev = r;
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Extracts positioned text from PDF bytes.
 *
 * Throws rather than returning empty text when the document cannot be parsed,
 * so a scanned or encrypted PDF becomes a visible retrieval failure instead of
 * a silently empty policy.
 */
export async function parsePdf(
  bytes: Buffer,
  opts: { url?: string | null } = {}
): Promise<PdfDocument> {
  // pdfjs ships an ESM legacy build intended for Node; the default build
  // expects browser globals.
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const task = pdfjs.getDocument({
    // pdfjs takes ownership of the buffer, so hand it a copy.
    data: new Uint8Array(bytes),
    // No network fetches for fonts or maps: everything stays local and
    // deterministic.
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
    // Run the parser on this thread. A worker would need a bundled worker
    // script and buys nothing for a batch pipeline.
    disableWorker: true,
  });
  const doc = await task.promise;

  let info: any = {};
  try {
    info = (await doc.getMetadata())?.info ?? {};
  } catch {
    info = {};
  }

  const pages: PdfPage[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    // Fonts are resolved lazily; rendering the operator list populates
    // commonObjs so font names become readable instead of "g_d0_f1".
    try {
      await page.getOperatorList();
    } catch {
      // Font resolution is a bonus. Extraction continues without it, and
      // callers see empty fontName rather than a failed page.
    }
    const content = await page.getTextContent();

    const fontNameOf = (id: string): string => {
      try {
        if (page.commonObjs.has(id)) {
          const f = page.commonObjs.get(id);
          return f?.name ?? id;
        }
      } catch {
        // fall through
      }
      return id;
    };

    const runs: PdfRun[] = [];
    for (const item of content.items as any[]) {
      const text: string = item.str ?? "";
      if (text.length === 0) continue;
      // transform = [a, b, c, d, e, f]; e/f are the translation.
      const tr = item.transform as number[];
      const fontName = fontNameOf(item.fontName ?? "");
      runs.push({
        text,
        x: tr[4]!,
        y: tr[5]!,
        width: item.width ?? 0,
        fontHeight: Math.abs(item.height ?? tr[3] ?? 0),
        fontName,
        bold: /bold/i.test(fontName),
        italic: /italic|oblique/i.test(fontName),
      });
    }

    // Group into lines by baseline, top of page first.
    const lines: PdfLine[] = [];
    const sorted = [...runs].sort((a, b) => b.y - a.y || a.x - b.x);
    for (const run of sorted) {
      const tol = Math.max(run.fontHeight, 1) * BASELINE_TOLERANCE;
      const line = lines.find((l) => Math.abs(l.y - run.y) <= tol);
      if (line) {
        line.runs.push(run);
      } else {
        lines.push({
          pageNumber: n,
          y: run.y,
          runs: [run],
          text: "",
          fontHeight: run.fontHeight,
          allBold: false,
          allItalic: false,
        });
      }
    }
    for (const line of lines) {
      line.runs.sort((a, b) => a.x - b.x);
      line.text = joinRuns(line.runs);
      line.fontHeight = median(line.runs.map((r) => r.fontHeight));
      const solid = line.runs.filter((r) => r.text.trim().length > 0);
      line.allBold = solid.length > 0 && solid.every((r) => r.bold);
      line.allItalic = solid.length > 0 && solid.every((r) => r.italic);
    }

    pages.push({
      pageNumber: n,
      width: viewport.width,
      height: viewport.height,
      lines: lines.filter((l) => l.text.length > 0),
    });
    page.cleanup();
  }

  await doc.destroy();

  return {
    url: opts.url ?? null,
    sha256,
    byteLength: bytes.length,
    retrievedAt: new Date().toISOString(),
    pageCount: doc.numPages,
    pages,
    info: {
      title: info.Title ?? null,
      creationDate: info.CreationDate ?? null,
      modificationDate: info.ModDate ?? null,
      producer: info.Producer ?? null,
    },
  };
}

/**
 * Splits a line into cells at wide horizontal gaps.
 *
 * Returns each cell with the x it starts at, so a caller can align cells to
 * column headers rather than trusting cell order. A row missing a middle cell
 * would otherwise shift every value one column left - the mechanism behind
 * "footnote attached to the wrong row" and its column-wise equivalent.
 */
export function splitCells(line: PdfLine): Array<{ text: string; x: number }> {
  const cells: Array<{ text: string; x: number; runs: PdfRun[] }> = [];
  let current: { text: string; x: number; runs: PdfRun[] } | null = null;
  let prev: PdfRun | null = null;

  for (const run of line.runs) {
    const spaceWidth = Math.max(run.fontHeight, 1) * 0.33;
    const gap = prev ? run.x - (prev.x + prev.width) : 0;
    if (!current || (prev && gap > spaceWidth * COLUMN_GAP_SPACES)) {
      current = { text: "", x: run.x, runs: [] };
      cells.push(current);
    }
    current.runs.push(run);
    prev = run;
  }
  return cells.map((c) => ({ text: joinRuns(c.runs), x: c.x }));
}

/** Every line on every page, in reading order, with page numbers attached. */
export function allLines(doc: PdfDocument): PdfLine[] {
  return doc.pages.flatMap((p) => p.lines);
}

/**
 * Lines matching a pattern, with surrounding context and page numbers.
 *
 * Used to cite a policy statement: the caller gets the page it appeared on and
 * the lines around it, not a floating sentence.
 */
export function findLines(
  doc: PdfDocument,
  pattern: RegExp,
  context = 0
): Array<{ page: number; index: number; line: PdfLine; before: PdfLine[]; after: PdfLine[] }> {
  const out: Array<{
    page: number;
    index: number;
    line: PdfLine;
    before: PdfLine[];
    after: PdfLine[];
  }> = [];
  for (const page of doc.pages) {
    page.lines.forEach((line, i) => {
      // Reset lastIndex so a /g pattern does not skip alternate matches.
      pattern.lastIndex = 0;
      if (!pattern.test(line.text)) return;
      out.push({
        page: page.pageNumber,
        index: i,
        line,
        before: page.lines.slice(Math.max(0, i - context), i),
        after: page.lines.slice(i + 1, i + 1 + context),
      });
    });
  }
  return out;
}
