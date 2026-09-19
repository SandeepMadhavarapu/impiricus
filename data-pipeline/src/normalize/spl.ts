import { XMLParser } from "fast-xml-parser";
import type { LabelSection, LabelTable } from "../schemas/index.js";

/**
 * SPL (HL7 v3 Structured Product Labeling) normalizer.
 *
 * The point of parsing the XML rather than consuming openFDA's flattened text
 * is to keep two things that flattening destroys:
 *
 *   1. Hierarchy. "5.1 Neuropsychiatric Events" is a subsection of
 *      "5 WARNINGS AND PRECAUTIONS", not a sibling paragraph.
 *   2. Tables. A dosing table flattened to prose loses which dose belongs to
 *      which age group — exactly the error that turns a paediatric row into an
 *      adult instruction.
 *
 * Section identity comes from the LOINC code on <code>, not from title text,
 * because titles vary between labelers while LOINC codes do not.
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Keep text nodes addressable even when an element also has attributes.
  textNodeName: "#text",
  // Never coerce: NDC segments and version numbers must stay strings.
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => ["component", "section", "subject", "manufacturedProduct", "tr", "td", "th", "col", "thead", "tbody", "asEntityWithGeneric", "ingredient", "asContent", "containerPackagedProduct", "part"].includes(name),
});

type Node = Record<string, unknown>;

const asArray = <T,>(v: T | T[] | undefined): T[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

/**
 * LOINC codes for patient-directed labeling. These must stay distinguishable
 * from professional prescribing information.
 */
const PATIENT_AUDIENCE_LOINC = new Set([
  "42231-1", // SPL MEDGUIDE SECTION
  "34076-0", // INFORMATION FOR PATIENTS
  "42230-3", // SPL PATIENT PACKAGE INSERT
  "59845-8", // INSTRUCTIONS FOR USE
]);

/** Recursively collects text from mixed content, preserving reading order. */
function collectText(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join(" ");
  if (typeof node === "object") {
    const obj = node as Node;
    const parts: string[] = [];
    for (const [key, value] of Object.entries(obj)) {
      if (key.startsWith("@_")) continue;
      // Tables are extracted separately; excluding them here prevents cell
      // text leaking into the paragraph stream as unstructured prose.
      if (key === "table") continue;
      parts.push(collectText(value));
    }
    return parts.join(" ");
  }
  return "";
}

const clean = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Extracts one <table> as headers + rows, keeping cell positions. */
function parseTable(table: Node): LabelTable {
  const caption = table["caption"] ? clean(collectText(table["caption"])) : null;

  const readRows = (container: unknown): string[][] =>
    asArray(container as Node | Node[]).flatMap((group) =>
      asArray((group as Node)["tr"] as Node | Node[]).map((tr) => {
        const cells = [
          ...asArray((tr as Node)["th"] as Node | Node[]),
          ...asArray((tr as Node)["td"] as Node | Node[]),
        ];
        return cells.map((c) => clean(collectText(c)));
      })
    );

  const headers = readRows(table["thead"]);
  const bodyRows = readRows(table["tbody"]);
  // Some SPLs put <tr> directly on <table>.
  const looseRows = asArray(table["tr"] as Node | Node[]).map((tr) => {
    const cells = [
      ...asArray((tr as Node)["th"] as Node | Node[]),
      ...asArray((tr as Node)["td"] as Node | Node[]),
    ];
    return cells.map((c) => clean(collectText(c)));
  });

  return {
    caption,
    headers,
    rows: [...bodyRows, ...looseRows].filter((r) => r.some((c) => c.length > 0)),
  };
}

/** Pulls paragraph-level text, excluding tables and nested sections. */
function parseParagraphs(section: Node): string[] {
  const out: string[] = [];
  const text = section["text"];
  if (!text) return out;

  const textNode = text as Node;
  for (const [key, value] of Object.entries(textNode)) {
    if (key.startsWith("@_") || key === "table") continue;
    for (const item of asArray(value as unknown)) {
      const s = clean(collectText(item));
      if (s.length > 0) out.push(s);
    }
  }
  return out;
}

function parseTables(section: Node): LabelTable[] {
  const text = section["text"] as Node | undefined;
  if (!text) return [];
  return asArray(text["table"] as Node | Node[])
    .map(parseTable)
    .filter((t) => t.rows.length > 0 || t.headers.length > 0);
}

/**
 * Extracts the printed section number from a title, e.g. "5.1" from
 * "5.1 Neuropsychiatric Events". Returns null when the title carries none —
 * we do not invent numbering.
 */
function printedNumber(title: string | null): string | null {
  if (!title) return null;
  const m = title.match(/^\s*(\d+(?:\.\d+)*)\s/);
  return m ? m[1]! : null;
}

function parseSection(section: Node): LabelSection {
  const code = section["code"] as Node | undefined;
  const loincCode = (code?.["@_code"] as string | undefined) ?? null;
  const rawTitle = section["title"] ? clean(collectText(section["title"])) : null;

  const subsections = asArray(section["component"] as Node | Node[])
    .flatMap((c) => asArray((c as Node)["section"] as Node | Node[]))
    .map((s) => parseSection(s as Node));

  return {
    loincCode,
    printedNumber: printedNumber(rawTitle),
    title: rawTitle,
    paragraphs: parseParagraphs(section),
    tables: parseTables(section),
    subsections,
    // SPL <subject> scoping on a section is rare; when absent we record an
    // empty list, which means "the document did not scope this" — NOT
    // "applies to every product".
    appliesToProducts: [],
    audience:
      loincCode && PATIENT_AUDIENCE_LOINC.has(loincCode)
        ? "patient"
        : loincCode
          ? "professional"
          : "unknown",
  };
}

export interface SplProduct {
  name: string | null;
  formCode: string | null;
  formDisplay: string | null;
  route: string[];
  ndc: string | null;
  /** Ingredients marked as active, with strength numerator/denominator. */
  activeIngredients: Array<{
    name: string;
    /** The active moiety, when the SPL declares one distinct from the salt. */
    activeMoiety: string | null;
    numeratorValue: string | null;
    numeratorUnit: string | null;
    denominatorValue: string | null;
    denominatorUnit: string | null;
  }>;
  packageNdcs: string[];
}

export interface ParsedSpl {
  setId: string;
  splVersion: string;
  /** SPL effectiveTime, formatted YYYY-MM-DD. */
  effectiveDate: string;
  documentId: string | null;
  title: string;
  labeler: string | null;
  products: SplProduct[];
  sections: LabelSection[];
  patientLabeling: LabelSection[];
}

function formatSplDate(value: string | null): string {
  if (!value || value.length < 8) return "";
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

/** Collects every packaged NDC under a product, at any nesting depth. */
function collectPackageNdcs(node: unknown, out: string[] = []): string[] {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) collectPackageNdcs(item, out);
    return out;
  }
  const obj = node as Node;
  const cpp = obj["containerPackagedProduct"];
  if (cpp) {
    for (const p of asArray(cpp as Node | Node[])) {
      const code = (p as Node)["code"] as Node | undefined;
      const ndc = code?.["@_code"] as string | undefined;
      if (ndc) out.push(ndc);
      collectPackageNdcs(p, out);
    }
  }
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith("@_") || key === "containerPackagedProduct") continue;
    collectPackageNdcs(value, out);
  }
  return out;
}

/**
 * SPL active-ingredient class codes.
 *   ACTIB - active ingredient, basis of strength
 *   ACTIM - active moiety is the basis of strength
 *   ACTIR - active ingredient, reference substance
 * IACT (inactive) is excluded.
 */
const ACTIVE_CLASS_CODES = new Set(["ACTIB", "ACTIM", "ACTIR"]);

/**
 * Parses one product.
 *
 * `outer` carries route (consumedIn) and packaging context; `inner` carries
 * identity, form and ingredients. Verified against the live Singulair SPL,
 * which nests manufacturedProduct inside manufacturedProduct.
 */
function parseProduct(outer: Node, inner: Node): SplProduct {
  const formCodeNode = inner["formCode"] as Node | undefined;

  const ingredients = asArray(inner["ingredient"] as Node | Node[])
    .filter((ing) => ACTIVE_CLASS_CODES.has(((ing as Node)["@_classCode"] as string) ?? ""))
    .map((ing) => {
      const node = ing as Node;
      const substance = node["ingredientSubstance"] as Node | undefined;
      const quantity = node["quantity"] as Node | undefined;
      const numerator = quantity?.["numerator"] as Node | undefined;
      const denominator = quantity?.["denominator"] as Node | undefined;
      // The salt is ingredientSubstance.name; the active moiety is nested one
      // level deeper. Keeping both is what makes the salt vs moiety
      // distinction checkable rather than assumed.
      const moietyOuter = substance?.["activeMoiety"] as Node | undefined;
      const moietyInner = moietyOuter?.["activeMoiety"] as Node | undefined;

      return {
        name: clean(collectText(substance?.["name"])) || "",
        activeMoiety: moietyInner ? clean(collectText(moietyInner["name"])) || null : null,
        numeratorValue: (numerator?.["@_value"] as string | undefined) ?? null,
        numeratorUnit: (numerator?.["@_unit"] as string | undefined) ?? null,
        denominatorValue: (denominator?.["@_value"] as string | undefined) ?? null,
        denominatorUnit: (denominator?.["@_unit"] as string | undefined) ?? null,
      };
    });

  const consumedIn = asArray(outer["consumedIn"] as Node | Node[]);
  const routes = consumedIn
    .map((c) => {
      const act = (c as Node)["substanceAdministration"] as Node | undefined;
      const routeCode = act?.["routeCode"] as Node | undefined;
      return (routeCode?.["@_displayName"] as string | undefined) ?? null;
    })
    .filter((r): r is string => Boolean(r));

  return {
    name: clean(collectText(inner["name"])) || null,
    formCode: (formCodeNode?.["@_code"] as string | undefined) ?? null,
    formDisplay: (formCodeNode?.["@_displayName"] as string | undefined) ?? null,
    route: [...new Set(routes)],
    ndc: ((inner["code"] as Node | undefined)?.["@_code"] as string | undefined) ?? null,
    activeIngredients: ingredients.filter((i) => i.name.length > 0),
    packageNdcs: [...new Set(collectPackageNdcs(inner))],
  };
}

export function parseSpl(xml: string): ParsedSpl {
  const doc = parser.parse(xml) as Node;
  const root = doc["document"] as Node | undefined;
  if (!root) throw new Error("SPL XML has no <document> root");

  const setId = ((root["setId"] as Node | undefined)?.["@_root"] as string | undefined) ?? "";
  const splVersion =
    ((root["versionNumber"] as Node | undefined)?.["@_value"] as string | undefined) ?? "";
  const effectiveRaw =
    ((root["effectiveTime"] as Node | undefined)?.["@_value"] as string | undefined) ?? null;
  const documentId = ((root["id"] as Node | undefined)?.["@_root"] as string | undefined) ?? null;
  const title = clean(collectText(root["title"])).replace(/^[®™\s]+/, "");

  // root.component is an array (isArray config). The structured body lives in
  // whichever element carries it — indexing [0] blindly would be fragile.
  const rootComponents = asArray(root["component"] as Node | Node[]);
  const body = rootComponents
    .map((c) => (c as Node)["structuredBody"])
    .find((b): b is Node => Boolean(b));

  const author = root["author"] as Node | undefined;
  const labeler = author
    ? clean(
        collectText(
          ((author["assignedEntity"] as Node)?.["representedOrganization"] as Node)?.["name"]
        )
      ) || null
    : null;

  // structuredBody -> component[] -> section
  const topSections = asArray(body?.["component"] as Node | Node[])
    .flatMap((c) => asArray((c as Node)["section"] as Node | Node[]))
    .map((s) => parseSection(s as Node));

  // Products live under the SPL product data elements section's subjects.
  const products: SplProduct[] = [];
  const walkForProducts = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walkForProducts);
      return;
    }
    const obj = node as Node;
    for (const subj of asArray(obj["subject"] as Node | Node[])) {
      for (const outer of asArray((subj as Node)["manufacturedProduct"] as Node | Node[])) {
        const outerNode = outer as Node;
        // manufacturedProduct nests inside manufacturedProduct in real SPLs.
        const innerCandidates = asArray(outerNode["manufacturedProduct"] as Node | Node[]);
        const inner = (innerCandidates[0] as Node | undefined) ?? outerNode;
        products.push(parseProduct(outerNode, inner));
      }
    }
    for (const [key, value] of Object.entries(obj)) {
      if (key.startsWith("@_") || key === "subject") continue;
      walkForProducts(value);
    }
  };
  walkForProducts(body);

  const isPatient = (s: LabelSection): boolean => s.audience === "patient";

  return {
    setId,
    splVersion,
    effectiveDate: formatSplDate(effectiveRaw),
    documentId,
    title,
    labeler,
    products: products.filter((p) => p.activeIngredients.length > 0 || p.ndc !== null),
    sections: topSections.filter((s) => !isPatient(s)),
    patientLabeling: topSections.filter(isPatient),
  };
}

/** Flattens the hierarchy for lookup while KEEPING each node's own structure. */
export function walkSections(sections: LabelSection[]): LabelSection[] {
  const out: LabelSection[] = [];
  const visit = (s: LabelSection) => {
    out.push(s);
    s.subsections.forEach(visit);
  };
  sections.forEach(visit);
  return out;
}

/** Counts tables anywhere in the tree — used by the completeness report. */
export function countTables(sections: LabelSection[]): number {
  return walkSections(sections).reduce((n, s) => n + s.tables.length, 0);
}
