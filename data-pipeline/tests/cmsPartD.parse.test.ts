import { describe, it, expect } from "vitest";
import { parseFormularyFile } from "@pipeline/sources/cmsPartD.js";

/**
 * The CMS formulary parser must fail rather than understate a restriction.
 *
 * SYNTHETIC FIXTURES. These are hand-written pipe-delimited rows in the shape
 * of the CMS "basic drugs formulary file", not extracts of a real release.
 * They exist to exercise failure modes the 2026-08 release does not contain:
 * every row in that release carries a clean Y or N and every column is present,
 * which is exactly why both defects below were invisible.
 *
 * Header field names and the pipe delimiter are taken from the real file.
 */

const HEADER =
  "FORMULARY_ID|FORMULARY_VERSION|CONTRACT_YEAR|RXCUI|NDC|TIER_LEVEL_VALUE|" +
  "QUANTITY_LIMIT_YN|QUANTITY_LIMIT_AMOUNT|QUANTITY_LIMIT_DAYS|PRIOR_AUTHORIZATION_YN|STEP_THERAPY_YN";

const row = (over: Partial<Record<string, string>> = {}) => {
  const f = {
    FORMULARY_ID: "00026000",
    FORMULARY_VERSION: "22",
    CONTRACT_YEAR: "2026",
    RXCUI: "200224",
    NDC: "",
    TIER_LEVEL_VALUE: "1",
    QUANTITY_LIMIT_YN: "N",
    QUANTITY_LIMIT_AMOUNT: "",
    QUANTITY_LIMIT_DAYS: "",
    PRIOR_AUTHORIZATION_YN: "N",
    STEP_THERAPY_YN: "N",
    ...over,
  };
  return HEADER.split("|")
    .map((k) => f[k as keyof typeof f] ?? "")
    .join("|");
};

const file = (rows: string[], header = HEADER) => [header, ...rows].join("\n");
const WANTED = new Set(["200224"]);

describe("restriction flags", () => {
  it("reads Y and N, case- and whitespace-insensitively", () => {
    const out = parseFormularyFile(
      file([row({ PRIOR_AUTHORIZATION_YN: "y", STEP_THERAPY_YN: " N ", QUANTITY_LIMIT_YN: "Y" })]),
      WANTED
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.priorAuthorizationYn).toBe(true);
    expect(out[0]!.stepTherapyYn).toBe(false);
    expect(out[0]!.quantityLimitYn).toBe(true);
  });

  /**
   * The defect: `=== "Y"` mapped every unrecognised value to false, which is
   * an assertion that the plan imposes NO prior authorisation. Unknown is not
   * "no", and a favourable guess about someone's coverage is the wrong way to
   * be wrong.
   */
  it.each([
    ["an empty value", ""],
    ["an unknown code", "U"],
    ["a word", "YES"],
    ["a numeric flag", "1"],
  ])("refuses %s in PRIOR_AUTHORIZATION_YN rather than reading it as no", (_label, value) => {
    expect(() => parseFormularyFile(file([row({ PRIOR_AUTHORIZATION_YN: value })]), WANTED)).toThrow(
      /neither Y nor N/i
    );
  });

  it("refuses an unknown STEP_THERAPY_YN and QUANTITY_LIMIT_YN too", () => {
    expect(() => parseFormularyFile(file([row({ STEP_THERAPY_YN: "?" })]), WANTED)).toThrow(/neither Y nor N/i);
    expect(() => parseFormularyFile(file([row({ QUANTITY_LIMIT_YN: "" })]), WANTED)).toThrow(/neither Y nor N/i);
  });

  it("names the column and the row, so a real failure is actionable", () => {
    let message = "";
    try {
      parseFormularyFile(file([row(), row({ STEP_THERAPY_YN: "X" })]), WANTED);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("STEP_THERAPY_YN");
    expect(message).toContain("row 2");
  });

  /**
   * Rows for other drugs are skipped before the flags are read, so an unknown
   * value in a row we do not want must not fail the whole release.
   */
  it("does not fail on an unwanted row's unknown flag", () => {
    const out = parseFormularyFile(
      file([row(), row({ RXCUI: "999999", PRIOR_AUTHORIZATION_YN: "?" })]),
      WANTED
    );
    expect(out).toHaveLength(1);
  });
});

describe("header schema drift", () => {
  /**
   * The worse defect: `header.indexOf` returns -1 for a renamed column and
   * `r[-1]` is undefined, which the old parser read as false. One upstream
   * rename would have published "no prior authorisation" for an entire
   * release with nothing failing anywhere.
   */
  it.each([
    "PRIOR_AUTHORIZATION_YN",
    "STEP_THERAPY_YN",
    "QUANTITY_LIMIT_YN",
    "TIER_LEVEL_VALUE",
  ])("refuses to parse when %s is missing", (column) => {
    const renamed = HEADER.replace(column, `${column}_V2`);
    expect(() => parseFormularyFile(file([row()], renamed), WANTED)).toThrow(
      /missing required column/i
    );
  });

  it("still refuses when FORMULARY_ID or RXCUI is missing", () => {
    expect(() => parseFormularyFile(file([row()], HEADER.replace("RXCUI", "RX_CUI")), WANTED)).toThrow(
      /FORMULARY_ID or RXCUI/i
    );
  });
});

describe("tier values", () => {
  it("keeps a published tier as published", () => {
    const out = parseFormularyFile(file([row({ TIER_LEVEL_VALUE: "5" })]), WANTED);
    expect(out[0]!.tierLevelValue).toBe(5);
  });

  it.each([
    ["blank", ""],
    ["zero", "0"],
    ["non-numeric", "N/A"],
  ])("maps a %s tier to null rather than inventing one", (_label, value) => {
    const out = parseFormularyFile(file([row({ TIER_LEVEL_VALUE: value })]), WANTED);
    expect(out[0]!.tierLevelValue).toBeNull();
  });
});
