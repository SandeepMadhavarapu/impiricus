import { describe, it, expect } from "vitest";
import {
  isValidNpi,
  mapNppesResult,
  CMS_NPI_DISCLAIMER,
  NPPES_LIMITATIONS,
} from "@/sources/lib/providers/nppes";

/**
 * NPI lookup behaviour. Network-free: every case runs against a fixture
 * shaped like a real NPPES 2.1 response.
 *
 * The shapes below were taken from live responses during development, then
 * anonymised where they named a real individual. They are fixtures, not
 * evidence about any real provider.
 */

const INDIVIDUAL = {
  number: "1356046890",
  enumeration_type: "NPI-1",
  basic: {
    status: "A",
    first_name: "ADRIAN",
    last_name: "EXAMPLE",
    enumeration_date: "2023-04-03",
    last_updated: "2023-04-03",
    certification_date: "2023-04-03",
  },
  taxonomies: [
    { code: "183500000X", desc: "Pharmacist", license: "86744", primary: true, state: "CA" },
  ],
  addresses: [
    { address_purpose: "MAILING", city: "ROWLAND HEIGHTS", state: "CA", postal_code: "917482372" },
    {
      address_purpose: "LOCATION",
      city: "CERRITOS",
      state: "CA",
      postal_code: "907037821",
      telephone_number: "6268189906",
    },
  ],
};

const ORGANISATION = {
  number: "1234567893",
  enumeration_type: "NPI-2",
  basic: {
    status: "A",
    organization_name: "EXAMPLE COMMUNITY PHARMACY LLC",
    enumeration_date: "2010-01-04",
    last_updated: "2015-06-01",
    certification_date: "2015-06-01",
    authorized_official_first_name: "JANE",
    authorized_official_last_name: "DOE",
    authorized_official_telephone_number: "5551234567",
    authorized_official_title_or_position: "OWNER",
  },
  taxonomies: [
    {
      code: "3336C0003X",
      desc: "Pharmacy, Community/Retail Pharmacy",
      license: null,
      primary: true,
      state: null,
    },
  ],
  addresses: [{ address_purpose: "LOCATION", city: "RICHMOND", state: "VA", postal_code: "23220" }],
};

describe("NPI check digit", () => {
  /** Catching a typo locally means it is reported as a typo, not as "no such prescriber". */
  it("accepts a real NPI", () => {
    expect(isValidNpi("1356046890")).toBe(true);
  });

  it("accepts exactly one check digit per nine-digit base", () => {
    const accepted = [];
    for (let c = 0; c <= 9; c++) if (isValidNpi(`135604689${c}`)) accepted.push(c);
    expect(accepted).toEqual([0]);
  });

  it("rejects anything that is not ten digits", () => {
    expect(isValidNpi("135604689")).toBe(false);
    expect(isValidNpi("13560468901")).toBe(false);
    expect(isValidNpi("abcdefghij")).toBe(false);
    expect(isValidNpi("")).toBe(false);
  });

  /**
   * A documented limit, asserted so nobody later mistakes it for a bug.
   *
   * Luhn cannot detect a 09 <-> 90 transposition. 1356046809 passes the check
   * digit AND is a real enumerated NPI belonging to a different provider, so a
   * single mistyped digit can land on someone else's record. This is why the
   * UI asks the reader to confirm the NAME matches, rather than treating a
   * successful lookup as confirmation.
   */
  it("cannot detect a 09/90 transposition, which is why the name must be confirmed", () => {
    expect(isValidNpi("1356046890")).toBe(true);
    expect(isValidNpi("1356046809")).toBe(true);
  });
});

describe("mapping an individual", () => {
  const p = mapNppesResult(INDIVIDUAL);

  it("reads identity and status", () => {
    expect(p.npi).toBe("1356046890");
    expect(p.isIndividual).toBe(true);
    expect(p.status).toBe("active");
    expect(p.name).toBe("Adrian Example");
  });

  it("reports the self-selected specialty without implying certification", () => {
    expect(p.primarySpecialty).toBe("Pharmacist");
    expect(p.allSpecialties).toEqual(["Pharmacist"]);
  });

  /**
   * The registry carries a licence number CMS does not validate. Showing it
   * beside a name reads as verification, so presence is reported and the
   * number is not.
   */
  it("never returns the licence number, only whether one is on file", () => {
    expect(p.hasSelfReportedLicense).toBe(true);
    expect(p.licenseStates).toEqual(["CA"]);
    expect(JSON.stringify(p)).not.toContain("86744");
  });

  it("prefers the practice location over the mailing address", () => {
    expect(p.practiceLocation?.city).toBe("Cerritos");
    expect(p.practiceLocation?.phone).toBe("626-818-9906");
  });

  it("flags a record that has not been attested in over two years", () => {
    expect(p.certificationDate).toBe("2023-04-03");
    expect(p.yearsSinceCertification).toBeGreaterThanOrEqual(2);
    expect(p.possiblyStale).toBe(true);
  });
});

describe("mapping an organisation", () => {
  const o = mapNppesResult(ORGANISATION);

  it("reads the organisation name", () => {
    expect(o.isIndividual).toBe(false);
    // Short all-caps tokens are initialisms, not words. Lowercasing then
    // recapitalising produced "Llc".
    expect(o.name).toBe("Example Community Pharmacy LLC");
  });

  /**
   * Organisation records name a real person and give their direct line. That
   * individual did not publish it to appear in a patient app, and it is not
   * needed to confirm a pharmacy exists.
   */
  it("never exposes the authorised official's personal details", () => {
    const serialised = JSON.stringify(o);
    expect(serialised).not.toContain("JANE");
    expect(serialised).not.toContain("DOE");
    expect(serialised).not.toContain("5551234567");
    expect(serialised).not.toMatch(/authorized_official/i);
  });

  /** Generic, not name-specific: several shapes of source casing. */
  it("preserves deliberate capitals across different name shapes", () => {
    const named = (n: string) =>
      mapNppesResult({ ...ORGANISATION, basic: { ...ORGANISATION.basic, organization_name: n } }).name;
    expect(named("ACME HEALTH INC")).toBe("Acme Health INC");
    expect(named("RIVERSIDE PHARMACY PC")).toBe("Riverside Pharmacy PC");
    // Already cased by the source: left exactly alone.
    expect(named("CVS Pharmacy #1234")).toBe("CVS Pharmacy #1234");
  });

  it("handles an organisation with no licence on file", () => {
    expect(o.hasSelfReportedLicense).toBe(false);
    expect(o.licenseStates).toEqual([]);
  });
});

describe("status handling", () => {
  it("treats a missing or D status as deactivated, never as active", () => {
    expect(mapNppesResult({ ...INDIVIDUAL, basic: { ...INDIVIDUAL.basic, status: "D" } }).status).toBe(
      "deactivated"
    );
    expect(
      mapNppesResult({ ...INDIVIDUAL, basic: { ...INDIVIDUAL.basic, status: undefined } }).status
    ).toBe("deactivated");
  });

  /** An unknown code is surfaced, not silently mapped to active. */
  it("reports an unrecognised status as such and keeps the raw code", () => {
    const r = mapNppesResult({ ...INDIVIDUAL, basic: { ...INDIVIDUAL.basic, status: "Z" } });
    expect(r.status).toBe("unrecognised");
    expect(r.statusCode).toBe("Z");
  });
});

describe("what travels with every result", () => {
  it("carries CMS's disclaimer verbatim", () => {
    expect(CMS_NPI_DISCLAIMER).toBe(
      "Issuance of an NPI does not ensure or validate that the Health Care Provider is Licensed or Credentialed."
    );
  });

  it("states the limits that matter for acting on the result", () => {
    const all = NPPES_LIMITATIONS.join(" ").toLowerCase();
    expect(all).toMatch(/not proof of a current licence/);
    expect(all).toMatch(/insurance|accepting patients/);
    expect(all).toMatch(/out of date/);
  });
});

describe("degenerate inputs do not throw", () => {
  it("survives an empty record", () => {
    const r = mapNppesResult({});
    expect(r.npi).toBe("");
    expect(r.status).toBe("deactivated");
    expect(r.practiceLocation).toBeNull();
    expect(r.allSpecialties).toEqual([]);
  });

  it("survives a record with no LOCATION address", () => {
    const r = mapNppesResult({
      ...INDIVIDUAL,
      addresses: [{ address_purpose: "MAILING", city: "X", state: "CA" }],
    });
    expect(r.practiceLocation).toBeNull();
  });
});
