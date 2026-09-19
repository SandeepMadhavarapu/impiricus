/**
 * NDC handling.
 *
 * The FDA NDC is three segments: labeler-product-package. In the NDC Directory
 * it is 10 digits in one of three layouts — 4-4-2, 5-3-2 or 5-4-1. In billing
 * and in RxNorm it is 11 digits, always 5-4-2, produced by zero-padding the
 * segment that is short.
 *
 * The trap: a 10-digit string WITHOUT hyphens does not tell you which layout it
 * is, so converting it to 11 digits is genuinely ambiguous. "7820617201" could
 * pad to three different 11-digit codes. This module refuses to pick one.
 *
 * Verified against live data during development:
 *   openFDA NDC directory package_ndc : "78206-172-01"  (5-3-2, hyphenated)
 *   RxNav /rxcui/153892/ndcs.json      : "78206017201"  (11-digit)
 * Those are the same package. The hyphens are what make that provable.
 */

export type NdcLayout = "4-4-2" | "5-3-2" | "5-4-1" | "5-4-2";

export type NdcConversion =
  | {
      ok: true;
      ndc11: string;
      layout: NdcLayout;
      /** How the 11-digit form was derived, for the provenance trail. */
      derivation: string;
    }
  | {
      ok: false;
      reason: "ambiguous-layout" | "invalid-format";
      detail: string;
      /** Every 11-digit code the input could legitimately mean. */
      possibilities: string[];
    };

const DIGITS = /^\d+$/;

/**
 * Converts a package NDC to its 11-digit (5-4-2) form.
 *
 * Accepts a hyphenated NDC, where the layout is unambiguous. An unhyphenated
 * 10-digit input is REJECTED with every possibility listed, because choosing
 * one would be inventing data.
 */
export function toNdc11(input: string): NdcConversion {
  const trimmed = input.trim();

  // Already 11 digits, unhyphenated.
  if (DIGITS.test(trimmed) && trimmed.length === 11) {
    return {
      ok: true,
      ndc11: trimmed,
      layout: "5-4-2",
      derivation: "input was already an 11-digit 5-4-2 code",
    };
  }

  const parts = trimmed.split("-");

  if (parts.length === 3 && parts.every((p) => DIGITS.test(p))) {
    const [labeler, product, pkg] = parts as [string, string, string];
    const layout = `${labeler.length}-${product.length}-${pkg.length}`;

    switch (layout) {
      case "4-4-2":
        return {
          ok: true,
          ndc11: `0${labeler}${product}${pkg}`,
          layout: "4-4-2",
          derivation: "4-4-2 -> pad labeler to 5 digits",
        };
      case "5-3-2":
        return {
          ok: true,
          ndc11: `${labeler}0${product}${pkg}`,
          layout: "5-3-2",
          derivation: "5-3-2 -> pad product to 4 digits",
        };
      case "5-4-1":
        return {
          ok: true,
          ndc11: `${labeler}${product}0${pkg}`,
          layout: "5-4-1",
          derivation: "5-4-1 -> pad package to 2 digits",
        };
      case "5-4-2":
        return {
          ok: true,
          ndc11: `${labeler}${product}${pkg}`,
          layout: "5-4-2",
          derivation: "already 5-4-2",
        };
      default:
        return {
          ok: false,
          reason: "invalid-format",
          detail: `segment lengths ${layout} are not a recognised NDC layout`,
          possibilities: [],
        };
    }
  }

  // Unhyphenated 10 digits: genuinely ambiguous.
  if (DIGITS.test(trimmed) && trimmed.length === 10) {
    const possibilities = [
      `0${trimmed}`, // read as 4-4-2
      `${trimmed.slice(0, 5)}0${trimmed.slice(5)}`, // read as 5-3-2
      `${trimmed.slice(0, 9)}0${trimmed.slice(9)}`, // read as 5-4-1
    ];
    return {
      ok: false,
      reason: "ambiguous-layout",
      detail:
        "a 10-digit NDC without hyphens does not encode its segment layout; " +
        "4-4-2, 5-3-2 and 5-4-1 all produce different 11-digit codes",
      possibilities: [...new Set(possibilities)],
    };
  }

  return {
    ok: false,
    reason: "invalid-format",
    detail: `"${trimmed}" is not a recognised NDC`,
    possibilities: [],
  };
}

/**
 * Extracts the product-level NDC (labeler-product) from a package NDC.
 * Returns null rather than guessing when the layout is unknown.
 */
export function productNdcFromPackage(packageNdc: string): string | null {
  const parts = packageNdc.trim().split("-");
  if (parts.length !== 3) return null;
  return `${parts[0]}-${parts[1]}`;
}

/**
 * Do two NDCs refer to the same package?
 *
 * Comparison happens in 11-digit space, and only when BOTH sides convert
 * unambiguously. An ambiguous input never "matches" — it reports why.
 */
export function ndcEquivalent(
  a: string,
  b: string
): { equal: boolean; comparable: boolean; detail: string } {
  const ca = toNdc11(a);
  const cb = toNdc11(b);

  if (!ca.ok || !cb.ok) {
    const which = !ca.ok
      ? `"${a}" (${ca.reason})`
      : `"${b}" (${(cb as Extract<NdcConversion, { ok: false }>).reason})`;
    return {
      equal: false,
      comparable: false,
      detail: `cannot compare: ${which} could not be resolved to a single 11-digit code`,
    };
  }

  return {
    equal: ca.ndc11 === cb.ndc11,
    comparable: true,
    detail:
      ca.ndc11 === cb.ndc11
        ? `both resolve to ${ca.ndc11} (${ca.derivation}; ${cb.derivation})`
        : `${a} -> ${ca.ndc11} but ${b} -> ${cb.ndc11}`,
  };
}

/** Formats an 11-digit NDC as 5-4-2 with hyphens, for display. */
export function formatNdc11(ndc11: string): string | null {
  if (!DIGITS.test(ndc11) || ndc11.length !== 11) return null;
  return `${ndc11.slice(0, 5)}-${ndc11.slice(5, 9)}-${ndc11.slice(9)}`;
}
