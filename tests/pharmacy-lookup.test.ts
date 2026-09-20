import { describe, it, expect } from "vitest";
import { findPharmacies } from "@/patient/lib/coverage/pharmacies";

/**
 * Pharmacy lookup against the CMS NPPES registry.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS **NOT** VERIFIED HERE
 * ---------------------------------------------------------------------------
 * That any particular pharmacy is open, in network, or stocks a medication.
 * NPPES cannot answer any of those, so neither can this, and no test here
 * pretends otherwise.
 *
 * What IS verified: that nothing reaches a reader which the registry did not
 * publish, that rows outside the searched ZIP are dropped, and that a lookup
 * which could not run never renders as "there are none near you".
 *
 * Every response below is shaped like a real one. The mailing/location split,
 * the bare "Pharmacy" taxonomy and the HTTP 200 carrying an `Errors` array are
 * all behaviours observed in the live registry, not invented edge cases.
 */

/* ------------------------------------------------------ response fixtures -- */

function row(over: Record<string, unknown> = {}) {
  return {
    number: "1234567890",
    basic: { organization_name: "BLACKSBURG PHARMACY INC" },
    addresses: [
      {
        address_purpose: "LOCATION",
        address_1: "1445 N MAIN ST",
        city: "BLACKSBURG",
        state: "VA",
        postal_code: "240603401",
      },
    ],
    taxonomies: [{ desc: "Pharmacy, Community/Retail Pharmacy", primary: true }],
    ...over,
  };
}

function respond(body: unknown, init: { ok?: boolean; status?: number } = {}): typeof fetch {
  return (async () =>
    ({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;
}

/* --------------------------------------------------------------- the ZIP -- */

describe("the searched ZIP is the one that is honoured", () => {
  /**
   * The registry matches `postal_code` against BOTH the practice location and
   * the mailing address. In a survey of 109 rows across eight ZIP codes, 15 -
   * one in seven - came back with a practice location in a DIFFERENT ZIP from
   * the one searched. Without this filter, "Pharmacy near you" lists a counter
   * that may be an hour away.
   */
  it("drops a row whose practice location is in another ZIP", async () => {
    const far = row({
      number: "9",
      basic: { organization_name: "GILES PHARMACY INC" },
      addresses: [
        {
          address_purpose: "LOCATION",
          address_1: "1615 WENONAH AVE",
          city: "PEARISBURG",
          state: "VA",
          postal_code: "24134",
        },
      ],
    });
    const result = await findPharmacies("24060", respond({ results: [row(), far] }));
    expect(result.status).toBe("ok");
    expect(result.pharmacies.map((p) => p.id)).toEqual(["1234567890"]);
  });

  it("ignores a mailing address that happens to sit in the searched ZIP", async () => {
    const billingOnly = row({
      number: "8",
      addresses: [
        { address_purpose: "MAILING", address_1: "PO BOX 1", city: "BLACKSBURG", state: "VA", postal_code: "24060" },
        { address_purpose: "LOCATION", address_1: "9 FAR RD", city: "ROANOKE", state: "VA", postal_code: "24011" },
      ],
    });
    const result = await findPharmacies("24060", respond({ results: [billingOnly] }));
    expect(result.pharmacies).toEqual([]);
  });

  it("matches on the first five digits of a ZIP+4", async () => {
    // The fixture's location carries "240603401"; the search is five digits.
    const result = await findPharmacies("24060", respond({ results: [row()] }));
    expect(result.pharmacies[0]!.zip).toBe("24060");
  });

  it("does not call the registry at all for a malformed ZIP", async () => {
    let called = false;
    const spy: typeof fetch = async () => {
      called = true;
      return {} as Response;
    };
    const result = await findPharmacies("2206", spy);
    expect(called).toBe(false);
    expect(result).toEqual({ status: "unavailable", pharmacies: [], reason: "invalid-zip" });
  });
});

/* ---------------------------------------------------------- what counts -- */

describe("which registered organisations count as a pharmacy", () => {
  it.each([
    ["Pharmacy, Community/Retail Pharmacy", "retail"],
    ["Pharmacy, Mail Order Pharmacy", "mail-order"],
    ["Pharmacy, Specialty Pharmacy", "specialty"],
  ])("maps %s to %s", async (desc, kind) => {
    const result = await findPharmacies(
      "24060",
      respond({ results: [row({ taxonomies: [{ desc, primary: true }] })] })
    );
    expect(result.pharmacies[0]!.kind).toBe(kind);
  });

  /**
   * The bare description "Pharmacy" was 41 of 109 rows in the survey - the
   * second largest group. It is not evidence of a retail counter, so it is
   * reported as `unspecified` rather than guessed into `retail` to make the
   * list look tidier. The form already accepts `unspecified`.
   */
  it.each([
    "Pharmacy",
    "Pharmacy, Clinic Pharmacy",
    "Pharmacy, Long Term Care Pharmacy",
    "Pharmacy, Home Infusion Therapy Pharmacy",
    "Pharmacy, Compounding Pharmacy",
    "Pharmacy, Institutional Pharmacy",
  ])("does not guess a dispensing model for %s", async (desc) => {
    const result = await findPharmacies(
      "24060",
      respond({ results: [row({ taxonomies: [{ desc, primary: true }] })] })
    );
    expect(result.pharmacies[0]!.kind).toBe("unspecified");
  });

  it("drops an organisation that is not a pharmacy at all", async () => {
    // The endpoint matches any of an organisation's taxonomies, so rows like
    // this come back from a pharmacy query.
    const result = await findPharmacies(
      "24060",
      respond({ results: [row({ taxonomies: [{ desc: "Clinic/Center, Infusion Therapy", primary: true }] })] })
    );
    expect(result.pharmacies).toEqual([]);
  });

  it("drops a pharmacy technician, which is a credential and not a place", async () => {
    const result = await findPharmacies(
      "24060",
      respond({ results: [row({ taxonomies: [{ desc: "Pharmacy Technician", primary: true }] })] })
    );
    expect(result.pharmacies).toEqual([]);
  });
});

/* --------------------------------------------------------- row integrity -- */

describe("a row is returned whole or not at all", () => {
  it.each([
    ["no organisation name", { basic: { organization_name: "   " } }],
    ["no NPI", { number: "" }],
    ["no location address", { addresses: [{ address_purpose: "MAILING", postal_code: "24060" }] }],
    ["no street", { addresses: [{ address_purpose: "LOCATION", address_1: "", city: "BLACKSBURG", state: "VA", postal_code: "24060" }] }],
    ["no city", { addresses: [{ address_purpose: "LOCATION", address_1: "1 MAIN ST", city: "", state: "VA", postal_code: "24060" }] }],
  ])("drops a row with %s rather than part-filling it", async (_label, over) => {
    const result = await findPharmacies("24060", respond({ results: [row(over)] }));
    expect(result.pharmacies).toEqual([]);
  });

  it("never sets a distance, because the registry publishes none", async () => {
    const result = await findPharmacies("24060", respond({ results: [row()] }));
    expect(result.pharmacies[0]!.distanceMiles).toBeUndefined();
  });

  it("collapses duplicate NPIs", async () => {
    const result = await findPharmacies("24060", respond({ results: [row(), row(), row()] }));
    expect(result.pharmacies).toHaveLength(1);
  });

  it("orders by name, making no claim about which is nearest", async () => {
    const result = await findPharmacies(
      "24060",
      respond({
        results: [
          row({ number: "3", basic: { organization_name: "ZEBRA DRUG" } }),
          row({ number: "1", basic: { organization_name: "ACME PHARMACY" } }),
          row({ number: "2", basic: { organization_name: "MIDTOWN RX" } }),
        ],
      })
    );
    expect(result.pharmacies.map((p) => p.name)).toEqual(["Acme Pharmacy", "Midtown RX", "Zebra Drug"]);
  });

  it("cases the shouted registry text for reading, keeping short initialisms", async () => {
    const result = await findPharmacies(
      "24060",
      respond({ results: [row({ basic: { organization_name: "CVS PHARMACY" } })] })
    );
    expect(result.pharmacies[0]!.name).toBe("CVS Pharmacy");
    expect(result.pharmacies[0]!.address).toContain("1445 N Main St");
  });
});

/* ------------------------------------------------- could not check vs none */

describe("a failed lookup never reads as an empty neighbourhood", () => {
  it("reports a network failure or timeout as unavailable", async () => {
    const result = await findPharmacies("24060", (async () => {
      throw new Error("aborted");
    }) as unknown as typeof fetch);
    expect(result).toEqual({ status: "unavailable", pharmacies: [], reason: "timeout" });
  });

  it("reports a non-200 as unavailable", async () => {
    const result = await findPharmacies("24060", respond({}, { ok: false, status: 503 }));
    expect(result.status).toBe("unavailable");
    expect((result as { reason: string }).reason).toBe("upstream-error");
  });

  it("reports unparseable JSON as unavailable", async () => {
    const broken = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token <");
        },
      }) as unknown as Response) as unknown as typeof fetch;
    const result = await findPharmacies("24060", broken);
    expect(result.status).toBe("unavailable");
    expect((result as { reason: string }).reason).toBe("malformed-response");
  });

  /**
   * The registry answers a bad query with HTTP 200 and an `Errors` array. Read
   * as an empty result, that would tell someone there is no pharmacy near them
   * when nothing was ever searched.
   */
  it("treats a 200 carrying Errors as unavailable, not as no results", async () => {
    const result = await findPharmacies(
      "24060",
      respond({ Errors: [{ description: "Postal Code must be at least 2 characters" }] })
    );
    expect(result.status).toBe("unavailable");
    expect((result as { reason: string }).reason).toBe("upstream-error");
  });

  /**
   * A query that genuinely matched nothing omits `results`. THAT is a real
   * answer about the neighbourhood, and is the one case reported as ok/empty.
   */
  it("treats a matched-nothing response as a real empty answer", async () => {
    const result = await findPharmacies("24060", respond({ result_count: 0 }));
    expect(result).toEqual({ status: "ok", pharmacies: [] });
  });
});
