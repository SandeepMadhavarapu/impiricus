import { createHash } from "node:crypto";
import { listRemoteZip, fetchZipMemberFlattened, type ZipEntry } from "./zipRange.js";
import { USER_AGENT } from "../config/sources.js";

/**
 * CMS Medicare Part D formulary adapter.
 *
 * Source: "Monthly Prescription Drug Plan Formulary and Pharmacy Network
 * Information", CMS, public domain. Located at run time from the CMS open data
 * catalogue so it does not rot against a hardcoded URL.
 *
 * Only four small members are fetched, by HTTP range:
 *
 *   basic drugs formulary file   formulary_id -> rxcui with tier and UM flags
 *   plan information             contract/plan -> formulary_id
 *   beneficiary cost file        tier cost-sharing RULES (not a member's cost)
 *   excluded drugs formulary     explicit plan exclusions
 *
 * The archive is 2.29 GB; these total roughly 8.8 MB.
 *
 * WHAT THIS ESTABLISHES: that a NAMED Part D plan's published formulary lists
 * (or excludes) a drug, with its tier and utilisation-management flags.
 *
 * WHAT IT DOES NOT: that a given member is enrolled, eligible, past their
 * deductible, or what they would actually pay. Cost-sharing here is the plan's
 * published RULE, not an adjudicated amount.
 */

const CATALOG = "https://data.cms.gov/data.json";
const DATASET_TITLE =
  "Monthly Prescription Drug Plan Formulary and Pharmacy Network Information";

export interface PartDRelease {
  title: string;
  url: string;
  /** Release label from the URL path, e.g. "2026-08". */
  release: string;
  modified: string | null;
  totalBytes: number;
  entries: ZipEntry[];
}

export async function findPartDRelease(): Promise<PartDRelease> {
  const res = await fetch(CATALOG, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`CMS catalogue -> HTTP ${res.status}`);
  const catalog = (await res.json()) as {
    dataset?: Array<{
      title?: string;
      modified?: string;
      distribution?: Array<{ downloadURL?: string; accessURL?: string }>;
    }>;
  };

  const dataset = (catalog.dataset ?? []).find((d) => (d.title ?? "").trim() === DATASET_TITLE);
  if (!dataset) throw new Error(`Dataset not found in CMS catalogue: ${DATASET_TITLE}`);

  const dist = (dataset.distribution ?? []).find((d) =>
    (d.downloadURL ?? d.accessURL ?? "").endsWith(".zip")
  );
  const url = dist?.downloadURL ?? dist?.accessURL;
  if (!url) throw new Error("No zip distribution found for the Part D dataset");

  const { entries, totalBytes } = await listRemoteZip(url);
  const releaseMatch = url.match(/\/(\d{4}-\d{2})\//);

  return {
    title: DATASET_TITLE,
    url,
    release: releaseMatch?.[1] ?? "unknown",
    modified: dataset.modified ?? null,
    totalBytes,
    entries,
  };
}

/** Finds a member by a case-insensitive name fragment. */
export function findEntry(entries: ZipEntry[], fragment: RegExp): ZipEntry | null {
  return entries.find((e) => fragment.test(e.name)) ?? null;
}

/* ----------------------------------------------------------------- parse -- */

/** CMS publishes these as pipe-delimited text with a header row. */
export function parsePipeDelimited(text: string): { header: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { header: [], rows: [] };
  const header = (lines[0] ?? "").split("|").map((h) => h.trim().toUpperCase());
  const rows = lines.slice(1).map((l) => l.split("|").map((c) => c.trim()));
  return { header, rows };
}

export interface PartDFormularyRow {
  formularyId: string;
  formularyVersion: string | null;
  contractYear: string | null;
  rxcui: string;
  /** Tier as published. Its MEANING is plan-defined; see beneficiary cost file. */
  tierLevelValue: number | null;
  quantityLimitYn: boolean;
  quantityLimitAmount: string | null;
  quantityLimitDays: string | null;
  priorAuthorizationYn: boolean;
  stepTherapyYn: boolean;
}

export function parseFormularyFile(
  text: string,
  wantedRxcuis: Set<string>
): PartDFormularyRow[] {
  const { header, rows } = parsePipeDelimited(text);
  const idx = (name: string) => header.indexOf(name);
  const iFormulary = idx("FORMULARY_ID");
  const iRxcui = idx("RXCUI");
  if (iFormulary < 0 || iRxcui < 0) {
    throw new Error(
      `Formulary file header missing FORMULARY_ID or RXCUI. Got: ${header.slice(0, 12).join(", ")}`
    );
  }
  const iVersion = idx("FORMULARY_VERSION");
  const iYear = idx("CONTRACT_YEAR");
  const iTier = idx("TIER_LEVEL_VALUE");
  const iQlYn = idx("QUANTITY_LIMIT_YN");
  const iQlAmt = idx("QUANTITY_LIMIT_AMOUNT");
  const iQlDays = idx("QUANTITY_LIMIT_DAYS");
  const iPa = idx("PRIOR_AUTHORIZATION_YN");
  const iSt = idx("STEP_THERAPY_YN");

  const yn = (v: string | undefined) => String(v ?? "").toUpperCase() === "Y";
  const out: PartDFormularyRow[] = [];

  for (const r of rows) {
    const rxcui = r[iRxcui] ?? "";
    if (!wantedRxcuis.has(rxcui)) continue;
    const tierRaw = iTier >= 0 ? Number(r[iTier]) : NaN;
    out.push({
      formularyId: r[iFormulary] ?? "",
      formularyVersion: iVersion >= 0 ? (r[iVersion] ?? null) : null,
      contractYear: iYear >= 0 ? (r[iYear] ?? null) : null,
      rxcui,
      tierLevelValue: Number.isFinite(tierRaw) && tierRaw > 0 ? tierRaw : null,
      quantityLimitYn: yn(r[iQlYn]),
      quantityLimitAmount: iQlAmt >= 0 ? (r[iQlAmt] || null) : null,
      quantityLimitDays: iQlDays >= 0 ? (r[iQlDays] || null) : null,
      priorAuthorizationYn: yn(r[iPa]),
      stepTherapyYn: yn(r[iSt]),
    });
  }
  return out;
}

export interface PartDPlanRow {
  contractId: string;
  planId: string;
  segmentId: string | null;
  contractName: string | null;
  planName: string | null;
  formularyId: string;
  contractYear: string | null;
  premium: string | null;
  deductible: string | null;
}

export function parsePlanFile(text: string): PartDPlanRow[] {
  const { header, rows } = parsePipeDelimited(text);
  const idx = (n: string) => header.indexOf(n);
  const iContract = idx("CONTRACT_ID");
  const iPlan = idx("PLAN_ID");
  const iFormulary = idx("FORMULARY_ID");
  if (iContract < 0 || iPlan < 0 || iFormulary < 0) {
    throw new Error(
      `Plan file header missing required columns. Got: ${header.slice(0, 12).join(", ")}`
    );
  }
  const iSegment = idx("SEGMENT_ID");
  const iContractName = idx("CONTRACT_NAME");
  const iPlanName = idx("PLAN_NAME");
  const iYear = idx("CONTRACT_YEAR");
  const iPremium = idx("PREMIUM");
  const iDeductible = idx("DEDUCTIBLE");

  const seen = new Set<string>();
  const out: PartDPlanRow[] = [];
  for (const r of rows) {
    const contractId = r[iContract] ?? "";
    const planId = r[iPlan] ?? "";
    const formularyId = r[iFormulary] ?? "";
    if (!contractId || !planId || !formularyId) continue;
    const segmentId = iSegment >= 0 ? (r[iSegment] || null) : null;
    const key = `${contractId}|${planId}|${segmentId ?? ""}|${formularyId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      contractId,
      planId,
      segmentId,
      contractName: iContractName >= 0 ? (r[iContractName] || null) : null,
      planName: iPlanName >= 0 ? (r[iPlanName] || null) : null,
      formularyId,
      contractYear: iYear >= 0 ? (r[iYear] || null) : null,
      premium: iPremium >= 0 ? (r[iPremium] || null) : null,
      deductible: iDeductible >= 0 ? (r[iDeductible] || null) : null,
    });
  }
  return out;
}

export interface PartDCostRow {
  contractId: string;
  planId: string;
  segmentId: string | null;
  coverageLevel: string | null;
  tier: number | null;
  daysSupply: string | null;
  costTypePref: string | null;
  costAmtPref: string | null;
  costTypeNonpref: string | null;
  costAmtNonpref: string | null;
}

/**
 * Beneficiary cost file: the plan's published cost-sharing RULES by tier.
 *
 * This is a rule, not a price. It does not know a member's deductible status,
 * accumulator position, or the pharmacy's negotiated rate, so it must never be
 * rendered as "you will pay X".
 */
export function parseCostFile(text: string): PartDCostRow[] {
  const { header, rows } = parsePipeDelimited(text);
  const idx = (n: string) => header.indexOf(n);
  const iContract = idx("CONTRACT_ID");
  const iPlan = idx("PLAN_ID");
  if (iContract < 0 || iPlan < 0) return [];
  const iSegment = idx("SEGMENT_ID");
  const iLevel = idx("COVERAGE_LEVEL");
  const iTier = idx("TIER");
  const iDays = idx("DAYS_SUPPLY");
  const iTypePref = idx("COST_TYPE_PREF");
  const iAmtPref = idx("COST_AMT_PREF");
  const iTypeNon = idx("COST_TYPE_NONPREF");
  const iAmtNon = idx("COST_AMT_NONPREF");

  const out: PartDCostRow[] = [];
  for (const r of rows) {
    const tierRaw = iTier >= 0 ? Number(r[iTier]) : NaN;
    out.push({
      contractId: r[iContract] ?? "",
      planId: r[iPlan] ?? "",
      segmentId: iSegment >= 0 ? (r[iSegment] || null) : null,
      coverageLevel: iLevel >= 0 ? (r[iLevel] || null) : null,
      tier: Number.isFinite(tierRaw) ? tierRaw : null,
      daysSupply: iDays >= 0 ? (r[iDays] || null) : null,
      costTypePref: iTypePref >= 0 ? (r[iTypePref] || null) : null,
      costAmtPref: iAmtPref >= 0 ? (r[iAmtPref] || null) : null,
      costTypeNonpref: iTypeNon >= 0 ? (r[iTypeNon] || null) : null,
      costAmtNonpref: iAmtNon >= 0 ? (r[iAmtNon] || null) : null,
    });
  }
  return out;
}

/** Excluded drugs: an EXPLICIT exclusion, which is not the same as "not found". */
export function parseExcludedFile(
  text: string,
  wantedRxcuis: Set<string>
): Array<{ formularyId: string; rxcui: string }> {
  const { header, rows } = parsePipeDelimited(text);
  const iFormulary = header.indexOf("FORMULARY_ID");
  const iRxcui = header.indexOf("RXCUI");
  if (iFormulary < 0 || iRxcui < 0) return [];
  const out: Array<{ formularyId: string; rxcui: string }> = [];
  for (const r of rows) {
    const rxcui = r[iRxcui] ?? "";
    if (!wantedRxcuis.has(rxcui)) continue;
    out.push({ formularyId: r[iFormulary] ?? "", rxcui });
  }
  return out;
}

/* --------------------------------------------------------------- fetchers -- */

export interface PartDExtract {
  release: PartDRelease;
  formularyRows: PartDFormularyRow[];
  planRows: PartDPlanRow[];
  costRows: PartDCostRow[];
  excludedRows: Array<{ formularyId: string; rxcui: string }>;
  bytesFetched: number;
  memberHashes: Record<string, string>;
  retrievedAt: string;
}

/**
 * Fetches only the members needed, by range, and parses them.
 *
 * `wantedRxcuis` filters the formulary file at parse time so the retained data
 * stays small and relevant.
 */
export async function extractPartD(wantedRxcuis: Set<string>): Promise<PartDExtract> {
  const release = await findPartDRelease();

  const wanted: Array<{ key: keyof PartDExtract | string; pattern: RegExp; required: boolean }> = [
    { key: "formulary", pattern: /basic\s*drugs\s*formulary/i, required: true },
    { key: "plan", pattern: /plan\s*information/i, required: true },
    { key: "cost", pattern: /^(?!.*insulin).*beneficiary\s*cost/i, required: false },
    { key: "excluded", pattern: /excluded\s*drugs\s*formulary/i, required: false },
  ];

  const texts: Record<string, string> = {};
  const memberHashes: Record<string, string> = {};
  let bytesFetched = 0;

  for (const w of wanted) {
    const entry = findEntry(release.entries, w.pattern);
    if (!entry) {
      if (w.required) throw new Error(`Required member not found in archive: ${w.pattern}`);
      continue;
    }
    const files = await fetchZipMemberFlattened(release.url, entry);
    bytesFetched += entry.compressedSize;
    // The member is itself a zip containing one .txt.
    const txt = files.find((f) => /\.txt$/i.test(f.name)) ?? files[0];
    if (!txt) continue;
    texts[w.key] = txt.data.toString("utf8");
    memberHashes[entry.name] = createHash("sha256").update(txt.data).digest("hex");
  }

  return {
    release,
    formularyRows: parseFormularyFile(texts.formulary ?? "", wantedRxcuis),
    planRows: parsePlanFile(texts.plan ?? ""),
    costRows: texts.cost ? parseCostFile(texts.cost) : [],
    excludedRows: texts.excluded ? parseExcludedFile(texts.excluded, wantedRxcuis) : [],
    bytesFetched,
    memberHashes,
    retrievedAt: new Date().toISOString(),
  };
}
