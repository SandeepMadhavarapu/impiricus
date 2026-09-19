import { describe, it, expect } from "vitest";
import { decideResolution, releaseFromForm, parseStrength } from "@pipeline/identity/resolve.js";
import type { ResolutionInputs } from "@pipeline/identity/resolve.js";
import {
  syntheticSpec,
  syntheticNdcEntry,
  syntheticSpl,
  syntheticSplProduct,
  syntheticRxNorm,
} from "./fixtures/synthetic.js";

/**
 * Resolution-state tests, driven entirely by synthetic fixtures so they never
 * touch the network. Each case is a counterexample the resolver must not fall
 * for.
 */

function inputs(overrides: Partial<ResolutionInputs> = {}): ResolutionInputs {
  return {
    ndcEntry: syntheticNdcEntry(),
    spl: syntheticSpl(),
    splProduct: syntheticSplProduct(),
    rxnorm: syntheticRxNorm(),
    drugsFdaProductNumber: "001",
    provenance: [],
    failures: [],
    ...overrides,
  };
}

describe("verified-match requires agreement across critical dimensions", () => {
  it("accepts a product where everything agrees", () => {
    const r = decideResolution(syntheticSpec(), inputs());
    expect(r.state).toBe("verified-match");
    expect(r.evidence.every((e) => e.agrees)).toBe(true);
  });

  it("records evidence for every dimension it checked", () => {
    const r = decideResolution(syntheticSpec(), inputs());
    const dims = new Set(r.evidence.map((e) => e.dimension));
    expect(dims).toContain("ndc");
    expect(dims).toContain("strength");
    expect(dims).toContain("dose-form");
    expect(dims).toContain("route");
    expect(dims).toContain("salt");
  });

  /** No numeric confidence score may appear — it would hide which check failed. */
  it("exposes no confidence score", () => {
    const r = decideResolution(syntheticSpec(), inputs());
    expect(JSON.stringify(r)).not.toMatch(/"confidence"/);
    expect(JSON.stringify(r)).not.toMatch(/"score"/);
  });
});

describe("counterexamples the resolver must reject", () => {
  it("rejects a strength mismatch — the 50 mg vs 100 mg trap", () => {
    const r = decideResolution(
      syntheticSpec({ strengthValue: 50 }),
      inputs({ splProduct: syntheticSplProduct() }) // fixture is 10 mg
    );
    expect(r.state).toBe("conflicting");
    expect(r.rationale).toMatch(/strength/i);
  });

  it("rejects an immediate-release product when extended release was specified", () => {
    const r = decideResolution(
      syntheticSpec({ releaseCharacteristic: "extended" }),
      inputs()
    );
    expect(r.state).toBe("conflicting");
    expect(r.rationale).toMatch(/release-characteristic/i);
  });

  it("rejects a dose-form mismatch — tablet vs granule", () => {
    const r = decideResolution(
      syntheticSpec(),
      inputs({ splProduct: syntheticSplProduct({ formDisplay: "GRANULE" }) })
    );
    expect(r.state).toBe("conflicting");
    expect(r.rationale).toMatch(/dose-form/i);
  });

  it("rejects a route mismatch — oral vs subcutaneous", () => {
    const r = decideResolution(
      syntheticSpec({ route: "SUBCUTANEOUS" }),
      inputs()
    );
    expect(r.state).toBe("conflicting");
  });

  it("rejects an NDC mismatch", () => {
    const r = decideResolution(
      syntheticSpec({ productNdc: "99999-002" }),
      inputs()
    );
    expect(r.state).toBe("conflicting");
  });
});

describe("ambiguity is surfaced, not resolved by guessing", () => {
  it("is ambiguous when no single SPL product could be selected", () => {
    const r = decideResolution(syntheticSpec(), inputs({ splProduct: null }));
    expect(r.state).toBe("ambiguous");
    expect(r.rationale).toMatch(/no single product/i);
  });

  it("is unmatched when neither the NDC directory nor the SPL yielded a product", () => {
    const r = decideResolution(
      syntheticSpec(),
      inputs({ ndcEntry: null, splProduct: null, spl: null })
    );
    expect(r.state).toBe("unmatched");
  });

  it("is source-unavailable when every identity source failed", () => {
    const r = decideResolution(
      syntheticSpec(),
      inputs({
        ndcEntry: null,
        spl: null,
        splProduct: null,
        failures: [{ sourceId: "openfda", detail: "timed out" }],
      })
    );
    expect(r.state).toBe("source-unavailable");
    expect(r.rationale).toMatch(/timed out/);
  });

  /** A source failure must never be read as "nothing disagreed". */
  it("does not upgrade to verified-match when a source failed and nothing was checked", () => {
    const r = decideResolution(
      syntheticSpec(),
      inputs({
        ndcEntry: null,
        spl: null,
        splProduct: null,
        rxnorm: null,
        failures: [{ sourceId: "dailymed", detail: "HTTP 503" }],
      })
    );
    expect(r.state).not.toBe("verified-match");
  });
});

describe("multi-product documents", () => {
  it("lists other products in the same SPL without merging them", () => {
    const spl = syntheticSpl({
      products: [
        syntheticSplProduct(),
        syntheticSplProduct({ ndc: "99999-002", formDisplay: "GRANULE" }),
      ],
    });
    const r = decideResolution(syntheticSpec(), inputs({ spl }));
    expect(r.competingCandidates.length).toBe(1);
    expect(r.competingCandidates[0]!.why).toMatch(/do not transfer/i);
  });
});

describe("historical and inactive concepts", () => {
  it("does not treat a non-current RXCUI as a match", () => {
    const r = decideResolution(
      syntheticSpec(),
      inputs({ rxnorm: syntheticRxNorm({ isCurrent: false, status: "Obsolete" }) })
    );
    const ttyRow = r.evidence.find((e) => e.dimension === "rxnorm-tty");
    expect(ttyRow?.agrees).toBe(false);
    expect(ttyRow?.note).toMatch(/not current/i);
  });
});

describe("component-level concepts carry no NDCs", () => {
  /**
   * Regression for a real false positive: Ozempic's concentration concept
   * (SBDC 1991308) has an empty NDC list, so comparing package NDCs against it
   * reported a conflict that did not exist.
   */
  it("skips the NDC cross-check for an SBDC rather than failing it", () => {
    const r = decideResolution(
      syntheticSpec(),
      inputs({
        rxnorm: syntheticRxNorm({
          concept: { rxcui: "999002", name: "testolol 1.34 MG/ML [Testdrug]", tty: "SBDC", synonym: null },
          ndc11: [],
        }),
      })
    );
    expect(r.state).toBe("verified-match");
    const skipped = r.evidence.find((e) => e.note?.includes("NDC cross-check skipped"));
    expect(skipped).toBeDefined();
    expect(skipped!.agrees).toBe(true);
  });

  it("still runs the cross-check for a product-level concept", () => {
    const r = decideResolution(
      syntheticSpec(),
      inputs({ rxnorm: syntheticRxNorm({ ndc11: [] }) }) // SBD with no NDCs
    );
    expect(r.state).toBe("conflicting");
  });
});

describe("derived helpers", () => {
  it.each([
    ["TABLET, EXTENDED RELEASE", "extended"],
    ["TABLET, DELAYED RELEASE", "delayed"],
    ["TABLET, FILM COATED", "unstated"],
    ["CAPSULE, EXTENDED RELEASE", "extended"],
  ])("derives release characteristic of %s as %s", (form, expected) => {
    expect(releaseFromForm(form)).toBe(expected);
  });

  it("parses a discrete strength", () => {
    const s = parseStrength("10 mg/1", "unstated");
    expect(s?.numeratorValue).toBe(10);
    expect(s?.numeratorUnit).toBe("mg");
  });

  it("parses a ratio strength keeping the denominator unit", () => {
    const s = parseStrength("1.34 mg/mL", "unstated");
    expect(s?.numeratorValue).toBe(1.34);
    expect(s?.denominatorUnit).toBe("mL");
  });
});
