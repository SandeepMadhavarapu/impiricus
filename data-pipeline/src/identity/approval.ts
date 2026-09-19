import type { DrugsFdaApplication, DrugsFdaProduct } from "../sources/openfda.js";

/**
 * Exact product matching within an FDA application.
 *
 * An application is not a product. NDA209637 covers seven Ozempic
 * presentations, and two of them share the same concentration:
 *
 *   product 001   2MG/1.5ML (1.34MG/ML)   Discontinued
 *   product 002   4MG/3ML   (1.34MG/ML)   Prescription
 *
 * Matching on concentration alone picks between them by luck, and picking 001
 * would attach a DISCONTINUED product's approval record to a marketed one. The
 * disambiguator is total content and volume: RxNorm identifies the package as a
 * "3 ML ... Pen Injector", and 3 mL at 1.34 mg/mL is 4 mg, which is product 002.
 *
 * When no single product wins, this returns `ambiguous` with the candidates
 * listed. It never picks one.
 */

export interface ParsedFdaStrength {
  /** Total drug content, e.g. 4 for "4MG/3ML". */
  totalValue: number | null;
  totalUnit: string | null;
  /** Package volume, e.g. 3 for "4MG/3ML". */
  volumeValue: number | null;
  volumeUnit: string | null;
  /** Concentration from the parenthetical, e.g. 1.34 for "(1.34MG/ML)". */
  concentrationValue: number | null;
  concentrationUnit: string | null;
  raw: string;
}

/**
 * Parses Drugs@FDA strength strings.
 *
 * Real formats observed live:
 *   "10MG"                    discrete solid dose
 *   "50MG"                    discrete solid dose
 *   "4MG/3ML (1.34MG/ML)"     total content with parenthetical concentration
 *   "0.5MG/0.5ML (0.5MG/0.5ML)"
 */
export function parseFdaStrength(raw: string): ParsedFdaStrength {
  const out: ParsedFdaStrength = {
    totalValue: null,
    totalUnit: null,
    volumeValue: null,
    volumeUnit: null,
    concentrationValue: null,
    concentrationUnit: null,
    raw,
  };
  if (!raw) return out;

  const parenthetical = raw.match(/\(([^)]+)\)/);
  const primary = raw.replace(/\([^)]*\)/g, "").trim();

  const primaryMatch = primary.match(/([\d.]+)\s*([A-Za-z]+)\s*(?:\/\s*([\d.]+)?\s*([A-Za-z]+))?/);
  if (primaryMatch) {
    out.totalValue = Number(primaryMatch[1]);
    out.totalUnit = (primaryMatch[2] ?? "").toUpperCase();
    if (primaryMatch[4]) {
      out.volumeValue = primaryMatch[3] !== undefined ? Number(primaryMatch[3]) : 1;
      out.volumeUnit = primaryMatch[4].toUpperCase();
    }
  }

  if (parenthetical?.[1]) {
    const c = parenthetical[1].match(/([\d.]+)\s*([A-Za-z]+)\s*\/\s*([\d.]+)?\s*([A-Za-z]+)/);
    if (c) {
      const num = Number(c[1]);
      const den = c[3] !== undefined ? Number(c[3]) : 1;
      out.concentrationValue = den !== 0 ? num / den : num;
      out.concentrationUnit = `${(c[2] ?? "").toUpperCase()}/${(c[4] ?? "").toUpperCase()}`;
    }
  } else if (out.volumeValue && out.totalValue) {
    // No parenthetical: derive concentration from total/volume.
    out.concentrationValue = out.totalValue / out.volumeValue;
    out.concentrationUnit = `${out.totalUnit}/${out.volumeUnit}`;
  }

  return out;
}

/**
 * Extracts a package volume from an RxNorm concept name.
 * e.g. "3 ML semaglutide 1.34 MG/ML Pen Injector [Ozempic]" -> 3 mL.
 */
export function volumeFromRxNormName(name: string | null): { value: number; unit: string } | null {
  if (!name) return null;
  const m = name.match(/^\s*([\d.]+)\s*(ML|L)\b/i);
  if (!m) return null;
  return { value: Number(m[1]), unit: (m[2] ?? "").toUpperCase() };
}

/** Dose forms are compared on their leading token: "SOLUTION" vs "INJECTION, SOLUTION". */
function formCompatible(fdaForm: string, ourForm: string): boolean {
  const tok = (s: string) =>
    s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2);
  const a = new Set(tok(fdaForm));
  const b = tok(ourForm);
  // Drugs@FDA writes "SOLUTION"; SPL/NDC write "INJECTION, SOLUTION".
  return b.some((w) => a.has(w));
}

export interface ApprovalMatchCriteria {
  strengthValue: number;
  strengthUnit: string;
  /** Denominator unit when the strength is a concentration, e.g. "mL". */
  denominatorUnit: string | null;
  dosageForm: string;
  route: string | null;
  /** Package volume, when known from RxNorm. The key disambiguator. */
  packageVolume: { value: number; unit: string } | null;
}

export interface ApprovalMatchCandidate {
  productNumber: string;
  strength: string;
  dosageForm: string;
  marketingStatus: string | null;
  parsed: ParsedFdaStrength;
  why: string;
}

export type ApprovalMatch =
  | { kind: "exact"; product: DrugsFdaProduct; evidence: string[]; others: ApprovalMatchCandidate[] }
  | { kind: "ambiguous"; candidates: ApprovalMatchCandidate[]; reason: string }
  | { kind: "none"; reason: string; candidates: ApprovalMatchCandidate[] };

const near = (a: number, b: number, tol = 0.02) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

/**
 * Finds the one product in an application that matches our criteria.
 *
 * Order of discrimination: dose form compatibility, then concentration OR
 * discrete strength, then package volume. Volume is what separates two
 * presentations of the same concentration.
 */
export function matchApprovalProduct(
  app: DrugsFdaApplication,
  criteria: ApprovalMatchCriteria
): ApprovalMatch {
  const products = app.products ?? [];
  if (products.length === 0) {
    return { kind: "none", reason: "The application record lists no products.", candidates: [] };
  }

  const described = (p: DrugsFdaProduct): ApprovalMatchCandidate => ({
    productNumber: p.product_number,
    strength: p.active_ingredients?.[0]?.strength ?? "",
    dosageForm: p.dosage_form ?? "",
    marketingStatus: p.marketing_status ?? null,
    parsed: parseFdaStrength(p.active_ingredients?.[0]?.strength ?? ""),
    why: "",
  });

  const formOk = products.filter((p) => formCompatible(p.dosage_form ?? "", criteria.dosageForm));
  if (formOk.length === 0) {
    return {
      kind: "none",
      reason: `No product in ${app.application_number} has a dose form compatible with "${criteria.dosageForm}".`,
      candidates: products.map(described),
    };
  }

  // Strength: concentration when our strength is a ratio, otherwise total.
  const isConcentration = criteria.denominatorUnit !== null;
  const strengthOk = formOk.filter((p) => {
    const parsed = parseFdaStrength(p.active_ingredients?.[0]?.strength ?? "");
    if (isConcentration) {
      return parsed.concentrationValue !== null && near(parsed.concentrationValue, criteria.strengthValue);
    }
    return parsed.totalValue !== null && near(parsed.totalValue, criteria.strengthValue, 0.001);
  });

  if (strengthOk.length === 0) {
    return {
      kind: "none",
      reason: `No product matches ${criteria.strengthValue} ${criteria.strengthUnit}${
        criteria.denominatorUnit ? "/" + criteria.denominatorUnit : ""
      }.`,
      candidates: formOk.map(described),
    };
  }

  if (strengthOk.length === 1) {
    const p = strengthOk[0]!;
    return {
      kind: "exact",
      product: p,
      evidence: [
        `Dose form "${p.dosage_form}" is compatible with "${criteria.dosageForm}".`,
        `Strength "${p.active_ingredients?.[0]?.strength}" matches ${criteria.strengthValue} ${criteria.strengthUnit}${criteria.denominatorUnit ? "/" + criteria.denominatorUnit : ""}.`,
        `Unique within application ${app.application_number}.`,
      ],
      others: products.filter((o) => o.product_number !== p.product_number).map(described),
    };
  }

  // Several share the concentration. Disambiguate by package volume.
  if (criteria.packageVolume) {
    const volumeOk = strengthOk.filter((p) => {
      const parsed = parseFdaStrength(p.active_ingredients?.[0]?.strength ?? "");
      return (
        parsed.volumeValue !== null &&
        parsed.volumeUnit === criteria.packageVolume!.unit &&
        near(parsed.volumeValue, criteria.packageVolume!.value, 0.001)
      );
    });

    if (volumeOk.length === 1) {
      const p = volumeOk[0]!;
      return {
        kind: "exact",
        product: p,
        evidence: [
          `Dose form "${p.dosage_form}" is compatible with "${criteria.dosageForm}".`,
          `Concentration matches ${criteria.strengthValue} ${criteria.strengthUnit}/${criteria.denominatorUnit}.`,
          `Package volume ${criteria.packageVolume.value} ${criteria.packageVolume.unit} (from the RxNorm concept) ` +
            `selects "${p.active_ingredients?.[0]?.strength}" over ${strengthOk.length - 1} other product(s) ` +
            `sharing the same concentration.`,
          `Marketing status: ${p.marketing_status ?? "unknown"}.`,
        ],
        others: products.filter((o) => o.product_number !== p.product_number).map(described),
      };
    }
  }

  return {
    kind: "ambiguous",
    candidates: strengthOk.map((p) => ({
      ...described(p),
      why: "Shares the matched concentration; package volume did not separate it.",
    })),
    reason:
      `${strengthOk.length} products in ${app.application_number} share this concentration and could not be ` +
      `separated by package volume. Application-level facts are not attached to the product.`,
  };
}
