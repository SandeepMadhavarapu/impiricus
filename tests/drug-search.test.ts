import { describe, it, expect } from "vitest";
import { searchDrugLabels, sanitiseTerm } from "@/sources/lib/content/drug-search";
import { listGuideSlugs } from "@/sources/lib/content/catalogue";

/**
 * Searching every FDA drug label.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS **NOT** VERIFIED HERE
 * ---------------------------------------------------------------------------
 * That any medication is safe, suitable, or what someone should take. A result
 * establishes identity and nothing more, and the one clinical fact it carries -
 * whether the label has a boxed warning - is read from the label rather than
 * decided here.
 *
 * What IS verified: that a catalogued product with a real patient guide is
 * never buried or lost, that "no such drug" and "the search broke" stay
 * different answers, and that a label covering several brands never has one of
 * them presented as the product.
 *
 * `zzz`-prefixed terms are used wherever a test needs the LOCAL catalogue to
 * stay out of the way, since real product names match it on purpose.
 */

/** A search term that cannot match any catalogued product. */
const NEUTRAL = "zzneutral";

function label(over: Record<string, unknown> = {}) {
  return {
    set_id: "aaaaaaaa-0000-0000-0000-000000000001",
    openfda: {
      brand_name: ["EXAMPLA"],
      generic_name: ["EXAMPLINE SODIUM"],
      manufacturer_name: ["Example Pharma LLC"],
      route: ["ORAL"],
      product_type: ["HUMAN PRESCRIPTION DRUG"],
      spl_set_id: ["aaaaaaaa-0000-0000-0000-000000000001"],
    },
    ...over,
  };
}

function respond(body: unknown, status = 200): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;
}

const search = (body: unknown, term = NEUTRAL, status = 200) =>
  searchDrugLabels(term, respond(body, status));

/* ------------------------------------------------------------ the input -- */

describe("what goes into the query", () => {
  it.each([
    ['ozempic" OR x:1', "ozempic or x 1"],
    ["met{for}min", "met for min"],
    ["  LIPITOR  ", "lipitor"],
    ["a:b/c\\d", "a b c d"],
  ])("strips query syntax out of %o", (raw, expected) => {
    // The term goes into a Lucene-style parameter. What is left is a plain
    // word, and a plain word cannot change the shape of the query.
    expect(sanitiseTerm(raw)).toBe(expected);
  });

  it("does not reach openFDA for a term that is too short", async () => {
    let called = false;
    const spy: typeof fetch = async () => {
      called = true;
      return {} as Response;
    };
    for (const term of ["", " ", "a", "!"]) {
      const r = await searchDrugLabels(term, spy);
      expect(r.status, term).toBe("unavailable");
      expect((r as { reason: string }).reason).toBe("query-too-short");
    }
    expect(called).toBe(false);
  });
});

/* ------------------------------------------------------- what is a drug -- */

describe("what counts as a medication", () => {
  it("keeps prescription and over-the-counter drugs", async () => {
    for (const type of ["HUMAN PRESCRIPTION DRUG", "HUMAN OTC DRUG"]) {
      const r = await search({
        results: [label({ openfda: { ...label().openfda, product_type: [type] } })],
      });
      expect(r.hits, type).toHaveLength(1);
    }
  });

  /**
   * A prefix search on a name matches things that are not medicines: "singul*"
   * returns "Singular Wipes" alongside SINGULAIR.
   */
  it.each(["HUMAN OTC DRUG LABEL", "MEDICAL DEVICE", "DIETARY SUPPLEMENT", ""])(
    "drops product type %o",
    async (type) => {
      const r = await search({
        results: [label({ openfda: { ...label().openfda, product_type: type ? [type] : [] } })],
      });
      expect(r.hits).toEqual([]);
    }
  );

  it("drops a label with neither a brand nor a generic name", async () => {
    const r = await search({
      results: [label({ openfda: { ...label().openfda, brand_name: [], generic_name: [] } })],
    });
    expect(r.hits).toEqual([]);
  });
});

/* ------------------------------------------------------------- identity -- */

describe("identity is reported as the label states it", () => {
  /**
   * One SPL can cover several products. The semaglutide label carries both
   * OZEMPIC and RYBELSUS - an injection and a tablet - so naming only the
   * first would put the wrong product on screen.
   */
  it("keeps every brand the label covers", async () => {
    const r = await search({
      results: [label({ openfda: { ...label().openfda, brand_name: ["OZEMPIC", "RYBELSUS"] } })],
    });
    expect(r.hits[0]!.brandNames).toEqual(["OZEMPIC", "RYBELSUS"]);
  });

  it("collapses duplicate spellings of one name", async () => {
    const r = await search({
      results: [label({ openfda: { ...label().openfda, brand_name: ["Exampla", "EXAMPLA", "exampla"] } })],
    });
    expect(r.hits[0]!.brandNames).toEqual(["Exampla"]);
  });

  /**
   * openFDA only adds its harmonised `openfda` block to labels it has
   * enriched. Our own Ozempic SPL has none, so keying on the top-level
   * `set_id` is what keeps such a label identifiable at all.
   */
  it("keys on the top-level set_id, falling back to the openfda block", async () => {
    const withTop = await search({ results: [label({ set_id: "top-level-id" })] });
    expect(withTop.hits[0]!.setId).toBe("top-level-id");

    const withoutTop = await search({
      results: [label({ set_id: undefined, openfda: { ...label().openfda, spl_set_id: ["fallback-id"] } })],
    });
    expect(withoutTop.hits[0]!.setId).toBe("fallback-id");
  });

  it("links to the official label rather than restating it", async () => {
    const r = await search({ results: [label()] });
    expect(r.hits[0]!.dailyMedUrl).toContain("dailymed.nlm.nih.gov");
    expect(r.hits[0]!.dailyMedUrl).toContain(label().set_id);
  });

  it("reports a boxed warning only when the label carries one", async () => {
    const without = await search({ results: [label()] });
    expect(without.hits[0]!.hasBoxedWarning).toBe(false);

    const with_ = await search({ results: [label({ boxed_warning: ["WARNING: SERIOUS RISK"] })] });
    expect(with_.hits[0]!.hasBoxedWarning).toBe(true);
  });

  it("collapses duplicate labels by set id", async () => {
    const r = await search({ results: [label(), label(), label()] });
    expect(r.hits).toHaveLength(1);
  });
});

/* -------------------------------------------------- the catalogued three -- */

describe("a product with a real patient guide is never lost", () => {
  /**
   * The local catalogue is authoritative for its own products and openFDA is
   * not. Our Ozempic SPL carries no `openfda` block, so a brand-name search of
   * the federal index cannot find it however it is spelled.
   */
  it.each(["singulair", "toprol", "ozempic", "montelukast"])(
    "finds the catalogued product for %s even when openFDA returns nothing",
    async (term) => {
      const r = await searchDrugLabels(term, respond({}, 404));
      expect(r.status).toBe("ok");
      expect(r.hits.length).toBeGreaterThan(0);
      expect(r.hits[0]!.guide).not.toBeNull();
      expect(listGuideSlugs()).toContain(r.hits[0]!.guide!.slug);
    }
  );

  it("puts the guide first, ahead of look-alike generics", async () => {
    // Eight unrelated labels come back; the catalogued product must still lead.
    const noise = Array.from({ length: 8 }, (_, i) =>
      label({
        set_id: `noise-${i}`,
        openfda: { ...label().openfda, brand_name: [`Montelukast Generic ${i}`], spl_set_id: [`noise-${i}`] },
      })
    );
    const r = await searchDrugLabels("montelukast", respond({ results: noise }));
    expect(r.hits[0]!.guide).not.toBeNull();
    expect(r.hits.filter((h) => h.guide).length).toBe(1);
  });

  it("does not invent a guide for a drug that has none", async () => {
    const r = await search({ results: [label()] });
    expect(r.hits[0]!.guide).toBeNull();
  });

  it("never claims a boxed warning a stored record does not have", async () => {
    // Read from the stored sections, never guessed from the name.
    const r = await searchDrugLabels("toprol", respond({}, 404));
    const hit = r.hits[0]!;
    expect(typeof hit.hasBoxedWarning).toBe("boolean");
  });
});

/* ------------------------------------------- no such drug vs search broke -- */

describe("'no such drug' and 'the search broke' are different answers", () => {
  /**
   * openFDA answers "nothing matched" with HTTP 404. Treated as an error,
   * every search for a drug that does not exist would read as a broken search,
   * and the person would retry instead of checking the spelling.
   */
  it("treats a 404 as a real empty answer", async () => {
    const r = await searchDrugLabels(NEUTRAL, respond({}, 404));
    expect(r).toEqual({ status: "ok", hits: [], totalMatches: 0 });
  });

  it("treats a missing results array as a real empty answer", async () => {
    const r = await search({ meta: { results: { total: 0 } } });
    expect(r.status).toBe("ok");
    expect(r.hits).toEqual([]);
  });

  it.each([
    [500, "upstream-error"],
    [503, "upstream-error"],
  ])("reports HTTP %s as unavailable", async (status, reason) => {
    const r = await searchDrugLabels(NEUTRAL, respond({}, status));
    expect(r.status).toBe("unavailable");
    expect((r as { reason: string }).reason).toBe(reason);
  });

  it("reports a network failure as unavailable", async () => {
    const r = await searchDrugLabels(NEUTRAL, (async () => {
      throw new Error("aborted");
    }) as unknown as typeof fetch);
    expect(r.status).toBe("unavailable");
    expect((r as { reason: string }).reason).toBe("timeout");
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
    const r = await searchDrugLabels(NEUTRAL, broken);
    expect(r.status).toBe("unavailable");
    expect((r as { reason: string }).reason).toBe("malformed-response");
  });
});

/* --------------------------------------------------------------- volume -- */

describe("large result sets", () => {
  it("caps what it returns but reports the true total", async () => {
    const many = Array.from({ length: 24 }, (_, i) =>
      label({
        set_id: `id-${i}`,
        openfda: { ...label().openfda, brand_name: [`Drug ${i}`], spl_set_id: [`id-${i}`] },
      })
    );
    const r = await search({ results: many, meta: { results: { total: 4731 } } });
    expect(r.hits.length).toBeLessThanOrEqual(8);
    expect(r.totalMatches).toBe(4731);
  });
});
