/**
 * Structured medication strength, and whether two of them are the same.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS REPLACED NUMBER MATCHING
 * ---------------------------------------------------------------------------
 * The coverage endpoint used to compare the requested strength against a
 * concatenation of everything known about the product, first with
 * `String.includes` and then by whole numbers. openFDA writes a solid oral
 * dose as `<INGREDIENT> <amount>/<per>` - Singulair's is
 * "MONTELUKAST SODIUM 10 mg/1" - so "1", the DENOMINATOR, counted as a match
 * for a 10 mg tablet. A denominator is not a strength. `formatStrength` in
 * registry.ts has always called that "/1" noise; the guard did not.
 *
 * Numbers alone cannot answer the question anyway. "1.34 mg/1 mL" is a
 * CONCENTRATION and "3 mL" is the container it comes in; both are true of
 * Ozempic and only one is its strength.
 *
 * ---------------------------------------------------------------------------
 * THE MODEL
 * ---------------------------------------------------------------------------
 * A strength is a numerator, and optionally a denominator:
 *
 *   "10 mg"          -> 10 mg                          (a dose)
 *   "10 mg/1"        -> 10 mg per 1 (unitless)         (the same dose; the
 *                                                       denominator counts
 *                                                       dosage units, so it
 *                                                       carries no meaning)
 *   "1.34 mg/1 mL"   -> 1.34 mg per 1 mL               (a concentration)
 *
 * A UNITLESS denominator is noise and is dropped. A denominator WITH a unit is
 * a concentration and is significant: 1.34 mg/mL is not 1.34 mg, and neither is
 * 3 mL.
 *
 * Units convert only inside a dimension - mass to mass, volume to volume -
 * because that is the only place conversion is both mathematically and
 * semantically valid. Milligrams never become millilitres. A missing unit is
 * never invented; a bare number is not a strength.
 */

export type Dimension = "mass" | "volume" | "count" | "percent";

interface UnitDef {
  dimension: Dimension;
  /** Multiplier into the dimension's base unit (mg for mass, mL for volume). */
  factor: number;
}

/**
 * Deliberately small. Every entry is an exact conversion; nothing here is an
 * approximation, and "unit"/"IU" are intentionally absent as convertible
 * because their meaning is product-specific.
 */
const UNITS: Record<string, UnitDef> = {
  // mass, base mg
  g: { dimension: "mass", factor: 1000 },
  gram: { dimension: "mass", factor: 1000 },
  grams: { dimension: "mass", factor: 1000 },
  mg: { dimension: "mass", factor: 1 },
  milligram: { dimension: "mass", factor: 1 },
  milligrams: { dimension: "mass", factor: 1 },
  mcg: { dimension: "mass", factor: 0.001 },
  ug: { dimension: "mass", factor: 0.001 },
  "µg": { dimension: "mass", factor: 0.001 },
  microgram: { dimension: "mass", factor: 0.001 },
  micrograms: { dimension: "mass", factor: 0.001 },
  // volume, base mL
  l: { dimension: "volume", factor: 1000 },
  liter: { dimension: "volume", factor: 1000 },
  litre: { dimension: "volume", factor: 1000 },
  ml: { dimension: "volume", factor: 1 },
  milliliter: { dimension: "volume", factor: 1 },
  millilitre: { dimension: "volume", factor: 1 },
  // not convertible to anything, but recognised so they are not "missing"
  "%": { dimension: "percent", factor: 1 },
  unit: { dimension: "count", factor: 1 },
  units: { dimension: "count", factor: 1 },
  iu: { dimension: "count", factor: 1 },
};

export interface Quantity {
  /** In the dimension's base unit: mg for mass, mL for volume. */
  base: number;
  dimension: Dimension;
  /** The unit as written, kept for messages. */
  unit: string;
}

export interface ParsedStrength {
  numerator: Quantity;
  /** Present only when the source wrote a denominator WITH a unit. */
  denominator: Quantity | null;
  /** True when a denominator was written but carried no unit ("/1"). */
  hadUnitlessDenominator: boolean;
}

function quantity(amountRaw: string, unitRaw: string): Quantity | null {
  const amount = Number(amountRaw.replace(/,/g, ""));
  // Rejects NaN, Infinity and negatives. A negative strength is not a typo to
  // interpret, it is a malformed request.
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const def = UNITS[unitRaw.trim().toLowerCase()];
  if (!def) return null;
  return { base: amount * def.factor, dimension: def.dimension, unit: unitRaw.trim() };
}

/**
 * Parses a strength as written by openFDA, DailyMed or a client.
 *
 * Returns null for anything that is not a strength, including a bare number.
 * A unit is never inferred: "10" could be 10 mg or 10 mcg, and guessing which
 * is how a thousandfold error enters a medication record.
 */
export function parseStrength(text: string | null | undefined): ParsedStrength | null {
  if (typeof text !== "string") return null;
  const cleaned = text.trim();
  if (cleaned.length === 0) return null;

  /*
   * A sign is rejected outright rather than skipped.
   *
   * The amount pattern below does not capture "-", so searching a string
   * containing "-10 mg" would have matched the "10 mg" inside it and returned
   * a positive 10 mg. Silently turning a negative request into a positive one
   * changes what the caller asked for, which is worse than refusing it.
   */
  if (/[-+]\s*\d/.test(cleaned)) return null;

  // "<amount> <unit>" optionally followed by "/<amount> [unit]".
  // The ingredient name that openFDA prefixes is skipped by searching rather
  // than anchoring, but the amount must carry a unit to be found at all.
  const m = cleaned.match(
    /(\d+(?:[.,]\d+)?)\s*([a-zµ%]+)\s*(?:\/\s*(\d+(?:[.,]\d+)?)?\s*([a-zµ%]+)?)?/i
  );
  if (!m) return null;

  const numerator = quantity(m[1]!, m[2]!);
  if (numerator === null) return null;

  const denomAmount = m[3];
  const denomUnit = m[4];

  // "/1" with no unit: a count of dosage units. Noise, and dropped.
  if (denomAmount !== undefined && denomUnit === undefined) {
    return { numerator, denominator: null, hadUnitlessDenominator: true };
  }
  if (denomUnit !== undefined) {
    const denominator = quantity(denomAmount ?? "1", denomUnit);
    // A denominator we cannot parse must not be silently discarded: dropping
    // it would turn a concentration into a dose.
    if (denominator === null) return null;
    return { numerator, denominator, hadUnitlessDenominator: false };
  }
  return { numerator, denominator: null, hadUnitlessDenominator: false };
}

/** Equal within floating-point tolerance, on the same dimension. */
function sameQuantity(a: Quantity, b: Quantity): boolean {
  if (a.dimension !== b.dimension) return false;
  const scale = Math.max(Math.abs(a.base), Math.abs(b.base), 1);
  return Math.abs(a.base - b.base) <= scale * 1e-9;
}

/**
 * Whether two strengths describe the same thing.
 *
 * A dose equals a dose. A concentration equals a concentration with the same
 * ratio. A dose NEVER equals a concentration: "1.34 mg" and "1.34 mg/mL" are
 * different claims, and so is the 3 mL of liquid they arrive in.
 */
export function strengthsEqual(a: ParsedStrength, b: ParsedStrength): boolean {
  const aConc = a.denominator !== null;
  const bConc = b.denominator !== null;
  if (aConc !== bConc) return false;

  if (!aConc) return sameQuantity(a.numerator, b.numerator);

  // Compare as ratios, so "1.34 mg/1 mL" equals "1340 mcg/1 mL".
  if (a.numerator.dimension !== b.numerator.dimension) return false;
  if (a.denominator!.dimension !== b.denominator!.dimension) return false;
  const ratioA = a.numerator.base / a.denominator!.base;
  const ratioB = b.numerator.base / b.denominator!.base;
  const scale = Math.max(Math.abs(ratioA), Math.abs(ratioB), 1);
  return Math.abs(ratioA - ratioB) <= scale * 1e-9;
}

/* ------------------------------------------------------------ dosage form */

/**
 * Release and delivery characteristics that change what a product IS.
 *
 * An extended-release tablet and an immediate-release tablet of the same
 * ingredient and strength are different products with different formulary
 * rows, so a request naming one must not be answered for the other.
 */
const RELEASE_TOKENS = new Set([
  "extended",
  "delayed",
  "sustained",
  "controlled",
  "immediate",
  "release",
  "er",
  "xl",
  "xr",
  "sr",
  "dr",
  "cr",
]);

function formTokens(form: string): string[] {
  return form
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length > 0);
}

/**
 * Whether a requested dosage form contradicts the product's.
 *
 * Under-specification is allowed: a request of "tablet" against
 * "TABLET, EXTENDED RELEASE" is vaguer than the product, not wrong about it,
 * and the lookup is done on the product's own concept either way.
 *
 * Contradiction is not: "capsule" against a tablet, or a request naming a
 * release characteristic the product does not have.
 */
export function dosageFormCompatible(requested: string, canonical: string): boolean {
  const req = formTokens(requested);
  if (req.length === 0) return false;
  const canon = new Set(formTokens(canonical));
  // Every word the request uses must be one the product's own form uses.
  // "extended"/"release" fail this against a film-coated tablet, which is the
  // immediate- versus extended-release case.
  return req.every((t) => canon.has(t));
}

/** True when a form string names a release characteristic. */
export function namesRelease(form: string): boolean {
  return formTokens(form).some((t) => RELEASE_TOKENS.has(t));
}
