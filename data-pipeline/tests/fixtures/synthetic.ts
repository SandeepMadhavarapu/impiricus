import type { NdcDirectoryEntry } from "@pipeline/sources/openfda.js";
import type { RxNormIdentity } from "@pipeline/sources/rxnav.js";
import type { ParsedSpl, SplProduct } from "@pipeline/normalize/spl.js";
import type { ProductSpec } from "@pipeline/identity/resolve.js";

/**
 * SYNTHETIC fixtures.
 *
 * Everything in this file is invented, deliberately, to exercise failure modes
 * that real sources will not reliably produce on demand (timeouts, partial
 * payloads, deliberate disagreements).
 *
 * These are kept in tests/fixtures and are NEVER written to data/. Real
 * retrieved records live in data/normalized and data/raw. Nothing here is a
 * real drug record and none of these identifiers should be trusted.
 */

export const SYNTHETIC_MARKER = "SYNTHETIC-FIXTURE-DO-NOT-USE-AS-DATA";

export function syntheticSpec(overrides: Partial<ProductSpec> = {}): ProductSpec {
  return {
    productKey: "synthetic-testdrug-10mg-tablet",
    brandName: "TESTDRUG",
    genericName: "TESTOLOL SUCCINATE",
    strengthValue: 10,
    strengthUnit: "mg",
    denominatorValue: 1,
    denominatorUnit: null,
    dosageForm: "TABLET, FILM COATED",
    releaseCharacteristic: "unstated",
    route: "ORAL",
    productNdc: "99999-001",
    splSetId: "00000000-0000-0000-0000-000000000000",
    applicationNumber: "NDA999999",
    expectedRxcui: "999001",
    selectionRationale: SYNTHETIC_MARKER,
    ...overrides,
  };
}

export function syntheticNdcEntry(overrides: Partial<NdcDirectoryEntry> = {}): NdcDirectoryEntry {
  return {
    product_ndc: "99999-001",
    generic_name: "TESTOLOL SUCCINATE",
    brand_name: "TESTDRUG",
    labeler_name: "Synthetic Labs, Inc.",
    dosage_form: "TABLET, FILM COATED",
    route: ["ORAL"],
    marketing_category: "NDA",
    application_number: "NDA999999",
    active_ingredients: [{ name: "TESTOLOL SUCCINATE", strength: "10 mg/1" }],
    packaging: [{ package_ndc: "99999-001-30", description: "30 TABLET in 1 BOTTLE" }],
    openfda: { rxcui: ["999001"], unii: ["SYNTH00001"], spl_set_id: ["00000000-0000-0000-0000-000000000000"] },
    ...overrides,
  };
}

export function syntheticSplProduct(overrides: Partial<SplProduct> = {}): SplProduct {
  return {
    name: "TESTDRUG",
    formCode: "C42931",
    formDisplay: "TABLET, FILM COATED",
    route: ["ORAL"],
    ndc: "99999-001",
    activeIngredients: [
      {
        name: "TESTOLOL SUCCINATE",
        activeMoiety: "TESTOLOL",
        numeratorValue: "10",
        numeratorUnit: "mg",
        denominatorValue: "1",
        denominatorUnit: "1",
      },
    ],
    packageNdcs: ["99999-001-30"],
    ...overrides,
  };
}

export function syntheticSpl(overrides: Partial<ParsedSpl> = {}): ParsedSpl {
  return {
    setId: "00000000-0000-0000-0000-000000000000",
    splVersion: "1",
    effectiveDate: "2026-01-01",
    documentId: "synthetic-doc",
    title: `${SYNTHETIC_MARKER} TESTDRUG (TESTOLOL SUCCINATE) TABLET`,
    labeler: "Synthetic Labs, Inc.",
    products: [syntheticSplProduct()],
    sections: [
      {
        loincCode: "34067-9",
        printedNumber: "1",
        title: "1 INDICATIONS AND USAGE",
        paragraphs: ["Synthetic indication text."],
        tables: [],
        subsections: [],
        appliesToProducts: [],
        audience: "professional",
      },
    ],
    patientLabeling: [],
    ...overrides,
  };
}

export function syntheticRxNorm(overrides: Partial<RxNormIdentity> = {}): RxNormIdentity {
  return {
    concept: {
      rxcui: "999001",
      name: "testolol succinate 10 MG Oral Tablet [Testdrug]",
      tty: "SBD",
      synonym: null,
    },
    isCurrent: true,
    status: "Active",
    related: { IN: [{ rxcui: "999000", name: "testolol" }] },
    ndc11: ["99999000130"],
    provenance: [],
    ...overrides,
  };
}
