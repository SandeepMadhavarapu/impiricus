/**
 * Structured comparison of medication strengths.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT STRING COMPARISON
 * ---------------------------------------------------------------------------
 * The same strength is written several ways across the sources this project
 * reads. The authored record for Singulair says "MONTELUKAST SODIUM 10 mg/1";
 * the label export says "10 mg"; a person types "10mg". Those are one strength.
 * Comparing the strings says they are three.
 *
 * ---------------------------------------------------------------------------
 * THE DENOMINATOR IS NOT PART OF THE STRENGTH, UNTIL IT IS
 * ---------------------------------------------------------------------------
 * openFDA writes strength as `<amount>/<per>`. A denominator with NO unit is
 * bookkeeping - "10 mg/1" means one tablet holds 10 mg, and the "1" says
 * nothing. A denominator WITH a unit is a concentration: "1.34 mg/1 mL" is not
 * a dose at all, it is how much drug sits in each millilitre.
 *
 * Collapsing those two is the failure this module exists to prevent. A dose of
 * 10 mg and a concentration of 10 mg/mL are different quantities of medicine,
 * and a comparison that calls them equal will happily confirm coverage for a
 * product nobody asked about.
 */

/** A strength that could be parsed. Units are normalised for comparison only. */
export interface ParsedStrength {
  amount: number;
  /** Lower-cased unit as written, e.g. "mg". */
  unit: string;
  /**
   * Present only when the denominator carries a unit, which makes this a
   * concentration rather than a dose. A unitless "/1" is dropped.
   */
  per?: { amount: number; unit: string };
}

/**
 * Finds the strength inside a string that may also carry an ingredient name.
 *
 * Anchored on the NUMBER, because the ingredient name is the part that varies
 * most between sources and the part that matters least here.
 */
const STRENGTH_PATTERN =
  /(\d+(?:\.\d+)?)\s*([a-zµ%]+)\s*(?:\/\s*(\d+(?:\.\d+)?)?\s*([a-zµ]+)?)?/i;

/**
 * Parses one written strength, or returns null when there is not one.
 *
 * Returns null rather than a best guess. A bare "1", a bare "mg" and an empty
 * box are all "no strength was stated", and a caller that receives null is
 * expected to decline to answer rather than to carry on with a default.
 */
export function parseStrength(raw: string): ParsedStrength | null {
  const cleaned = (raw ?? "").trim();
  if (cleaned.length === 0) return null;

  /*
   * A signed value is rejected outright.
   *
   * There is no such thing as a negative dose, so "-10 mg" is corrupt input,
   * not a small one. Without this the pattern below reads the digits and
   * silently drops the sign, turning corrupt input into a confident answer
   * about a real product.
   */
  if (/[-+]\s*\d/.test(cleaned)) return null;

  const match = STRENGTH_PATTERN.exec(cleaned);
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = (match[2] ?? "").toLowerCase();
  if (!Number.isFinite(amount) || unit.length === 0) return null;

  const perAmountRaw = match[3];
  const perUnit = (match[4] ?? "").toLowerCase();

  // A denominator without a unit ("/1") is noise; a denominator with one
  // ("/1 mL") makes this a concentration.
  if (perUnit.length === 0) return { amount, unit };

  const perAmount = perAmountRaw === undefined ? 1 : Number(perAmountRaw);
  if (!Number.isFinite(perAmount) || perAmount === 0) return null;

  return { amount, unit, per: { amount: perAmount, unit: perUnit } };
}

/** Floating-point tolerance. Strengths are written to at most a few decimals. */
const EPSILON = 1e-9;

/**
 * Whether two written strengths describe the same quantity of medicine.
 *
 * Conservative in both directions: anything that cannot be parsed is not equal
 * to anything, INCLUDING an identical unparseable string. Two boxes both
 * containing "mg" is not agreement that the strength matches; it is two
 * absences of a strength.
 *
 * A dose is never equal to a concentration, whatever the numbers say.
 */
export function strengthsEqual(a: string, b: string): boolean {
  const left = parseStrength(a);
  const right = parseStrength(b);
  if (!left || !right) return false;

  if (Math.abs(left.amount - right.amount) > EPSILON) return false;
  if (left.unit !== right.unit) return false;

  // One is a dose and the other a concentration: different quantities.
  if ((left.per === undefined) !== (right.per === undefined)) return false;
  if (left.per && right.per) {
    if (left.per.unit !== right.per.unit) return false;
    if (Math.abs(left.per.amount - right.per.amount) > EPSILON) return false;
  }
  return true;
}

/**
 * A written strength rendered for a reader, or null when there is not one.
 *
 * Sources carry the ingredient name and the bookkeeping denominator alongside
 * the strength - "MONTELUKAST SODIUM 10 mg/1" - which is correct in a data
 * file and unreadable in a sentence. This renders what the strength IS, and
 * keeps a real concentration whole because dropping its denominator would
 * change what it means.
 */
export function formatStrength(raw: string): string | null {
  const parsed = parseStrength(raw);
  if (!parsed) return null;
  const base = `${parsed.amount} ${parsed.unit}`;
  if (!parsed.per) return base;
  const per = parsed.per.amount === 1 ? parsed.per.unit : `${parsed.per.amount} ${parsed.per.unit}`;
  return `${base}/${per}`;
}

/**
 * Whether two written dose forms are the same form.
 *
 * Case and punctuation vary between sources - "TABLET, FILM COATED" against
 * "tablet, film coated" - but the WORDS must match. "Tablet" and "tablet,
 * extended release" are different products that are dispensed differently, so
 * this is not a prefix match.
 */
export function dosageFormsEqual(a: string, b: string): boolean {
  const key = (s: string) =>
    (s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(" ")
      .filter(Boolean)
      .sort()
      .join(" ");
  const left = key(a);
  const right = key(b);
  return left.length > 0 && left === right;
}
