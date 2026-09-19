import type { ProductSpec } from "../identity/resolve.js";

/**
 * The verification set.
 *
 * Three products, chosen to exercise distinct identity failure modes rather
 * than to inflate a record count. Every identifier below was confirmed against
 * a live source before being written here; none is a guess.
 */
export const PRODUCTS: ProductSpec[] = [
  {
    productKey: "singulair-montelukast-10mg-tablet",
    brandName: "SINGULAIR",
    genericName: "MONTELUKAST SODIUM",
    strengthValue: 10,
    strengthUnit: "mg",
    denominatorValue: 1,
    denominatorUnit: null,
    dosageForm: "TABLET, FILM COATED",
    releaseCharacteristic: "unstated",
    route: "ORAL",
    productNdc: "78206-172",
    splSetId: "482dcc92-b47f-4ea6-854a-f5ac2aea7842",
    applicationNumber: "NDA020829",
    expectedRxcui: "153892",
    selectionRationale:
      "Baseline product, already supported by the application. Exercises the MULTI-PRODUCT SPL case: " +
      "one SPL set id covers four products (4 mg granule, 4 mg and 5 mg chewable tablets, 10 mg film-coated " +
      "tablet) under three NDAs. Selecting the wrong one would attach paediatric dosing to an adult tablet. " +
      "Also exercises SALT vs ACTIVE MOIETY: the SPL labels the ingredient MONTELUKAST SODIUM with active " +
      "moiety MONTELUKAST.",
  },

  {
    productKey: "toprol-xl-metoprolol-succinate-50mg-er-tablet",
    brandName: "TOPROL XL",
    genericName: "METOPROLOL SUCCINATE",
    strengthValue: 50,
    strengthUnit: "mg",
    denominatorValue: 1,
    denominatorUnit: null,
    dosageForm: "TABLET, EXTENDED RELEASE",
    releaseCharacteristic: "extended",
    route: "ORAL",
    // Verified live against openFDA drug/ndc on 2026-09-19.
    productNdc: "70842-111",
    splSetId: "496ddfaa-7c9c-4888-b747-a210249b367a",
    applicationNumber: "NDA019962",
    // Verified: RxNav resolves "24 HR metoprolol succinate 50 MG Extended
    // Release Oral Tablet [Toprol]" to 866438.
    expectedRxcui: "866438",
    selectionRationale:
      "Chosen for three traps, all of which this product exercises for real. " +
      "(1) SALT: metoprolol succinate and metoprolol tartrate are different products with different " +
      "dosing; matching on the moiety 'metoprolol' alone merges them. " +
      "(2) RELEASE: Toprol XL is extended release while metoprolol tartrate is immediate release. " +
      "(3) MISMATCHED HARMONIZED IDENTIFIERS - this is the important one. openFDA's NDC entry for " +
      "70842-111, a 50 mg product, carries openfda.rxcui = [866412, 866414, 866419, 866421], and every " +
      "one of those concepts is 100 mg or 200 mg. Taking openfda.rxcui[0] would attach a 100 mg concept " +
      "to a 50 mg product. The resolver must reject that, which is why strength is a critical dimension " +
      "checked against the SPL rather than inherited from the harmonized block.",
  },

  {
    productKey: "ozempic-semaglutide-1_34mg-per-ml-injection",
    brandName: "Ozempic",
    genericName: "SEMAGLUTIDE",
    // openFDA expresses this as a CONCENTRATION (1.34 mg/mL). The carton states
    // total content (2 mg per 1.5 mL pen). 2 / 1.5 = 1.333..., the same product.
    // Storing strength as a single scalar would lose the denominator entirely.
    strengthValue: 1.34,
    strengthUnit: "mg",
    denominatorValue: 1,
    denominatorUnit: "mL",
    dosageForm: "INJECTION, SOLUTION",
    releaseCharacteristic: "unstated",
    route: "SUBCUTANEOUS",
    // Verified live against openFDA drug/ndc on 2026-09-19.
    productNdc: "0169-4130",
    // NOT discoverable from openFDA: this product's openfda harmonized block is
    // EMPTY (no spl_set_id, no rxcui), and openFDA drug/label does not index the
    // Novo Nordisk SPL at all. The set id below came from DailyMed's own name
    // search, which does index it.
    splSetId: "adec4fd2-6858-4c99-91d4-531f5f2a2d79",
    applicationNumber: "NDA209637",
    // Verified via RxNav ndcstatus for 0169-4130-13, which returns rxcui
    // 2398842 "3 ML semaglutide 1.34 MG/ML Pen Injector [Ozempic]" (TTY SBD,
    // ACTIVE). The concentration concept 1991308 is an SBDC and carries an
    // EMPTY NDC list, because NDCs attach to product-level concepts, not
    // components. Pointing at 1991308 produced a false NDC conflict.
    expectedRxcui: "2398842",
    selectionRationale:
      "Chosen for RATIO STRENGTH, missing identifiers and source-coverage limits. " +
      "(1) Strength is a concentration with units on both numerator and denominator, so a scalar strength " +
      "field loses the concentration. " +
      "(2) MISSING HARMONIZED IDENTIFIERS: openFDA's NDC entry for 0169-4130 has an empty openfda block - " +
      "no spl_set_id and no rxcui - so the usual join path simply does not exist. " +
      "(3) SOURCE COVERAGE: openFDA drug/label returns four Ozempic SPLs and none is the manufacturer's; " +
      "three are A-S Medication Solutions repackager copies of the same original, which must never be " +
      "counted as independent corroboration. The real Novo Nordisk label was only reachable via DailyMed. " +
      "(4) CONCEPT LEVEL: the concentration concept 1991308 is an SBDC and carries no NDCs at all; the " +
      "packaged product concept is SBD 2398842. Matching an NDC against a component-level concept " +
      "produces a false conflict, which is why the resolver is TTY-aware.",
  },
];

export function findProduct(productKey: string): ProductSpec | undefined {
  return PRODUCTS.find((p) => p.productKey === productKey);
}
