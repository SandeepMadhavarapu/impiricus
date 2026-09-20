import { describe, it, expect } from "vitest";
import { findClinicians } from "@/doctor/lib/providers/clinicians";
import {
  PATIENT_SPECIALTIES,
  LISTING_MEANS,
  isOfferedSpecialty,
} from "@/doctor/lib/providers/specialties";
import { formatPhone, telHref, titleCasePersonName } from "@/shared/lib/nppes/client";

/**
 * Clinicians from the CMS NPPES register.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS **NOT** VERIFIED HERE
 * ---------------------------------------------------------------------------
 * That any clinician is licensed, practising, accepting patients, or in any
 * network. NPPES cannot answer those, so neither can this, and the caveats
 * that say so are asserted rather than assumed.
 *
 * What IS verified: that nobody appears who is not registered at a practice in
 * the ZIP searched, that a deactivated record never reaches a reader, and that
 * a lookup which could not run is never rendered as "nobody near you".
 */

const SPECIALTY = "Family Medicine";

function row(over: Record<string, unknown> = {}) {
  return {
    number: "1234567890",
    enumeration_type: "NPI-1",
    basic: { first_name: "GREGORY", last_name: "BEATO", credential: "D.O.", status: "A" },
    addresses: [
      {
        address_purpose: "LOCATION",
        address_1: "810 HOSPITAL DR",
        city: "BLACKSBURG",
        state: "VA",
        postal_code: "240603401",
        telephone_number: "540-951-3311",
      },
    ],
    taxonomies: [{ desc: "Family Medicine", primary: true }],
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

const find = (body: unknown, zip = "24060", specialty = SPECIALTY) =>
  findClinicians(zip, specialty, respond(body));

/* ------------------------------------------------------------- the ZIP -- */

describe("only clinicians whose practice is in the ZIP searched", () => {
  /**
   * The registry matches `postal_code` against the MAILING address too. For
   * physicians this is worse than for pharmacies: a third of rows for a
   * Blacksburg search came back with a practice location elsewhere, one of
   * them in Charlottesville, two hours away. Without this filter a patient is
   * handed a phone number for a practice they cannot reach.
   */
  it("drops a clinician whose practice is in another ZIP", async () => {
    const far = row({
      number: "9",
      basic: { first_name: "CAITLYN", last_name: "BULLER", credential: "DO", status: "A" },
      addresses: [
        {
          address_purpose: "LOCATION",
          address_1: "2250 IVY RD STE 200",
          city: "CHARLOTTESVILLE",
          state: "VA",
          postal_code: "22903",
          telephone_number: "434-654-4550",
        },
      ],
    });
    const r = await find({ results: [row(), far] });
    expect(r.status).toBe("ok");
    expect(r.clinicians.map((c) => c.id)).toEqual(["1234567890"]);
  });

  it("ignores a mailing address that happens to sit in the searched ZIP", async () => {
    const billing = row({
      number: "8",
      addresses: [
        { address_purpose: "MAILING", address_1: "PO BOX 1", city: "BLACKSBURG", state: "VA", postal_code: "24060" },
        { address_purpose: "LOCATION", address_1: "9 FAR RD", city: "ROANOKE", state: "VA", postal_code: "24011" },
      ],
    });
    const r = await find({ results: [billing] });
    expect(r.clinicians).toEqual([]);
  });

  it("matches on the first five digits of a ZIP+4", async () => {
    const r = await find({ results: [row()] });
    expect(r.clinicians).toHaveLength(1);
  });
});

/* -------------------------------------------------------- who is listed -- */

describe("who may appear", () => {
  /**
   * A deactivated NPI is not somebody to send a person to telephone. The
   * registry marks status "A" for active; anything else is dropped.
   */
  it.each(["D", "X", "", "  "])("drops a record whose status is %o", async (status) => {
    const r = await find({
      results: [row({ basic: { first_name: "A", last_name: "B", status } })],
    });
    expect(r.clinicians).toEqual([]);
  });

  it("keeps an active record", async () => {
    const r = await find({ results: [row()] });
    expect(r.clinicians).toHaveLength(1);
    expect(r.clinicians[0]!.name).toBe("Gregory Beato");
    expect(r.clinicians[0]!.credential).toBe("D.O.");
  });

  it.each([
    ["no first name", { basic: { first_name: "", last_name: "BEATO", status: "A" } }],
    ["no last name", { basic: { first_name: "GREGORY", last_name: "", status: "A" } }],
    ["no NPI", { number: "" }],
    ["no location address", { addresses: [{ address_purpose: "MAILING", postal_code: "24060" }] }],
    ["no street", { addresses: [{ address_purpose: "LOCATION", address_1: "", city: "BLACKSBURG", state: "VA", postal_code: "24060" }] }],
  ])("drops a row with %s rather than part-filling it", async (_label, over) => {
    const r = await find({ results: [row(over)] });
    expect(r.clinicians).toEqual([]);
  });

  it("collapses duplicate NPIs", async () => {
    const r = await find({ results: [row(), row(), row()] });
    expect(r.clinicians).toHaveLength(1);
  });

  it("orders by surname, implying no ranking", async () => {
    const mk = (n: string, first: string, last: string) =>
      row({ number: n, basic: { first_name: first, last_name: last, status: "A" } });
    const r = await find({
      results: [mk("3", "ANA", "ZAMORA"), mk("1", "BEN", "ABBOTT"), mk("2", "CARA", "MOLINA")],
    });
    expect(r.clinicians.map((c) => c.name)).toEqual(["Ben Abbott", "Cara Molina", "Ana Zamora"]);
  });

  /**
   * A ZIP can hold dozens. Rendering them all buries the caveats above the
   * list, so the page shows a few and says how many there are.
   */
  it("caps the list but reports the true total", async () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      row({ number: String(1000 + i), basic: { first_name: "A", last_name: `NAME${i}`, status: "A" } })
    );
    const r = await find({ results: many });
    expect(r.clinicians).toHaveLength(6);
    expect(r.totalInZip).toBe(20);
  });
});

/* ------------------------------------------------------------ the phone -- */

describe("the telephone number, which is the one actionable thing", () => {
  it.each([
    ["5409513311", "(540) 951-3311", "tel:+15409513311"],
    ["540-951-3311", "(540) 951-3311", "tel:+15409513311"],
    ["(540) 951-3311", "(540) 951-3311", "tel:+15409513311"],
    ["15409513311", "(540) 951-3311", "tel:+15409513311"],
  ])("formats %s for reading and for dialling", (raw, pretty, href) => {
    expect(formatPhone(raw)).toBe(pretty);
    expect(telHref(raw)).toBe(href);
  });

  it("returns an unexpected number unchanged rather than forcing a shape", () => {
    expect(formatPhone("+44 20 7946 0000")).toBe("+44 20 7946 0000");
    expect(telHref("+44 20 7946 0000")).toBeNull();
  });

  it("reports a missing number as missing", async () => {
    const r = await find({
      results: [row({ addresses: [{ address_purpose: "LOCATION", address_1: "1 MAIN ST", city: "BLACKSBURG", state: "VA", postal_code: "24060" }] })],
    });
    expect(r.clinicians[0]!.phone).toBeNull();
    expect(r.clinicians[0]!.phoneHref).toBeNull();
  });
});

/* ------------------------------------------------------------ the input -- */

describe("what the server will run", () => {
  it("does not reach the registry for a malformed ZIP", async () => {
    let called = false;
    const spy: typeof fetch = async () => {
      called = true;
      return {} as Response;
    };
    const r = await findClinicians("2406", SPECIALTY, spy);
    expect(called).toBe(false);
    expect(r).toEqual({ status: "unavailable", clinicians: [], totalInZip: 0, reason: "invalid-zip" });
  });

  /**
   * The taxonomy is put straight into an outbound query, so it is restricted
   * to the list the app itself offers rather than passed through.
   */
  it("refuses a specialty that is not on the offered list", async () => {
    let called = false;
    const spy: typeof fetch = async () => {
      called = true;
      return {} as Response;
    };
    const r = await findClinicians("24060", "Anything I Like", spy);
    expect(called).toBe(false);
    expect(r.status).toBe("unavailable");
    expect((r as { reason: string }).reason).toBe("unknown-specialty");
  });

  it("accepts every specialty it offers", () => {
    expect(PATIENT_SPECIALTIES.length).toBeGreaterThan(0);
    for (const s of PATIENT_SPECIALTIES) {
      expect(isOfferedSpecialty(s.value), s.value).toBe(true);
      expect(s.label.trim().length).toBeGreaterThan(0);
    }
  });
});

/* --------------------------------------------- could not check vs nobody -- */

describe("a failed lookup never reads as an empty neighbourhood", () => {
  it("reports a network failure as unavailable", async () => {
    const r = await findClinicians("24060", SPECIALTY, (async () => {
      throw new Error("aborted");
    }) as unknown as typeof fetch);
    expect(r.status).toBe("unavailable");
    expect((r as { reason: string }).reason).toBe("timeout");
  });

  it("reports a non-200 as unavailable", async () => {
    const r = await findClinicians("24060", SPECIALTY, respond({}, { ok: false, status: 503 }));
    expect(r.status).toBe("unavailable");
  });

  it("treats a 200 carrying Errors as unavailable, not as no results", async () => {
    const r = await find({ Errors: [{ description: "bad query" }] });
    expect(r.status).toBe("unavailable");
    expect((r as { reason: string }).reason).toBe("upstream-error");
  });

  /**
   * Several specialties genuinely have nobody registered in a given ZIP -
   * Blacksburg has no registered allergist or endocrinologist. That is a
   * truthful answer about a neighbourhood and is reported as ok/empty.
   */
  it("treats a matched-nothing response as a real empty answer", async () => {
    const r = await find({ result_count: 0 });
    expect(r).toEqual({ status: "ok", clinicians: [], totalInZip: 0 });
  });
});

/* ---------------------------------------------------------- the caveats -- */

describe("the list cannot be presented bare", () => {
  it("carries every limitation a register cannot answer", () => {
    const all = LISTING_MEANS.join(" ").toLowerCase();
    expect(all).toContain("not a recommendation");
    expect(all).toContain("accepting new patients");
    expect(all).toContain("insurance");
    expect(all).toContain("licensure");
    expect(all).toContain("self-reported");
  });

  it("says plainly that it is not a referral", () => {
    expect(LISTING_MEANS.join(" ").toLowerCase()).toContain("not a referral");
  });
});

/**
 * These are real people's names on a page they did not ask to be on. A short
 * first name must not stay shouted because it looks like an initialism, and a
 * surname must not lose the capital it actually carries.
 */
describe("people's names are cased without being mangled", () => {
  it.each([
    ["GREGORY BEATO", "Gregory Beato"],
    ["BEN ABBOTT", "Ben Abbott"],
    ["ANA ZAMORA", "Ana Zamora"],
    ["MARY-ANN O'NEILL", "Mary-Ann O'Neill"],
    ["SEAN MCDONALD", "Sean McDonald"],
    ["FIONA MACARTHUR", "Fiona MacArthur"],
    ["JOSE DE LA CRUZ", "Jose De La Cruz"],
  ])("cases %s", (raw, expected) => {
    expect(titleCasePersonName(raw)).toBe(expected);
  });
});
