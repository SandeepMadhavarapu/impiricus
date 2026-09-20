import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  checkConceptIntegrity,
  identityChangesNeedingReview,
  CONCEPTS_MAX_AGE_DAYS,
  type ConceptArtifact,
  type CatalogueProduct,
} from "@/sources/lib/content/conceptIntegrity";
import { listGuides, productConcepts } from "@/sources/lib/content/catalogue";

/**
 * The RxNorm identity artifact cannot silently go stale.
 *
 * `product-concepts.json` is imported statically by the catalogue, so every
 * coverage answer depends on it - and it was produced by a script that nothing
 * called. Neither `content:sync` nor the refresh workflow touched it. Two
 * silent failures followed:
 *
 *   - a product added to the catalogue gets no entry, so `productConcepts`
 *     returns null and its coverage reads "unable to verify" for ever;
 *   - when openFDA re-harmonises a label's RXCUI, a refresh ships the new
 *     label joined to the OLD identity, and the coverage answer is then about
 *     a different product than the page.
 *
 * This suite is the enforcement point. It runs in `npm test`, which the
 * refresh workflow runs against the regenerated content BEFORE a candidate
 * pull request is opened - so a stale mapping fails the candidate rather than
 * shipping with it.
 */

const REPO = process.cwd();
const CONCEPTS_PATH = path.join(REPO, "src", "sources", "content", "rxnorm", "product-concepts.json");
const EXPORTS_DIR = path.join(REPO, "src", "sources", "content", "label-exports");
const SNAPSHOT_PATH = path.join(REPO, "src", "sources", "content", "coverage", "cms-part-d-snapshot.json");

const artifact = JSON.parse(readFileSync(CONCEPTS_PATH, "utf8")) as ConceptArtifact;
const snapshotRxcuis = (JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as { rxcuis: string[] }).rxcuis;

/** Read straight from the shipped label exports, not from the catalogue module. */
const shippedProducts: CatalogueProduct[] = readdirSync(EXPORTS_DIR)
  .filter((f) => f.endsWith(".json") && f !== "manifest.json")
  .map((f) => {
    const d = JSON.parse(readFileSync(path.join(EXPORTS_DIR, f), "utf8")) as {
      productKey: string;
      identifiers: { rxcui: string | null };
    };
    return { productKey: d.productKey, labelRxcui: d.identifiers.rxcui ?? null };
  });

describe("the shipped identity artifact", () => {
  it("agrees with the shipped labels and the shipped coverage snapshot", () => {
    const problems = checkConceptIntegrity(artifact, shippedProducts, snapshotRxcuis);
    expect(
      problems,
      problems.map((p) => `[${p.code}] ${p.productKey ?? "(artifact)"}: ${p.detail}`).join("\n")
    ).toEqual([]);
  });

  it("covers every product the catalogue publishes", () => {
    for (const guide of listGuides()) {
      expect(productConcepts(guide.slug), `${guide.slug} has no identity entry`).not.toBeNull();
    }
  });

  it("records where and when it came from", () => {
    expect(artifact.source?.url).toContain("rxnav.nlm.nih.gov");
    expect(typeof artifact.source?.retrievedAt).toBe("string");
    const age = (Date.now() - new Date(artifact.source!.retrievedAt!).getTime()) / 86_400_000;
    expect(age, `identity is ${Math.round(age)} days old`).toBeLessThan(CONCEPTS_MAX_AGE_DAYS);
  });
});

/* ------------------------------------------------- the rules themselves -- */

const base = (over: Partial<ConceptArtifact> = {}): ConceptArtifact => ({
  schemaVersion: 1,
  source: { retrievedAt: new Date().toISOString(), url: "https://rxnav.nlm.nih.gov/REST/" },
  products: {
    "p-one": {
      exact: { rxcui: "111", tty: "SBD", name: "Brand 10 MG Oral Tablet [Brand]" },
      genericEquivalent: { rxcui: "222", tty: "SCD", name: "generic 10 MG Oral Tablet" },
    },
  },
  ...over,
});

const oneProduct: CatalogueProduct[] = [{ productKey: "p-one", labelRxcui: "111" }];

describe("an outdated or invalid mapping cannot ship", () => {
  it("passes when everything agrees", () => {
    expect(checkConceptIntegrity(base(), oneProduct, ["111", "222"])).toEqual([]);
  });

  /** The re-harmonised-label case: the label moved, the identity did not. */
  it("catches a label whose RXCUI has moved on", () => {
    const problems = checkConceptIntegrity(base(), [{ productKey: "p-one", labelRxcui: "999" }], [
      "111",
      "999",
    ]);
    expect(problems.map((p) => p.code)).toContain("exact-disagrees-with-label");
  });

  it("catches a catalogue product with no entry", () => {
    const problems = checkConceptIntegrity(base(), [
      ...oneProduct,
      { productKey: "p-two", labelRxcui: "333" },
    ]);
    expect(problems.map((p) => p.code)).toContain("product-missing-entry");
  });

  it("catches a concept the coverage snapshot was never built for", () => {
    // It would report "not listed" on every plan: a false negative about
    // access, not a missing feature.
    const problems = checkConceptIntegrity(base(), oneProduct, ["222"]);
    expect(problems.map((p) => p.code)).toContain("rxcui-absent-from-coverage-snapshot");
  });

  it("catches a generic that is really the brand", () => {
    const broken = base();
    broken.products["p-one"]!.genericEquivalent = { rxcui: "111", tty: "SCD", name: "same" };
    expect(checkConceptIntegrity(broken, oneProduct, ["111"]).map((p) => p.code)).toContain(
      "generic-equals-exact"
    );
  });

  it("catches a generic that is not a generic clinical drug", () => {
    const broken = base();
    broken.products["p-one"]!.genericEquivalent = { rxcui: "222", tty: "SBD", name: "another brand" };
    expect(checkConceptIntegrity(broken, oneProduct, ["111", "222"]).map((p) => p.code)).toContain(
      "generic-not-a-clinical-drug"
    );
  });

  it("catches a label that claims an RXCUI the artifact does not record", () => {
    const broken = base();
    broken.products["p-one"]!.exact = null;
    expect(checkConceptIntegrity(broken, oneProduct).map((p) => p.code)).toContain(
      "entry-has-no-exact-concept"
    );
  });

  it("catches an artifact that is missing or malformed", () => {
    for (const bad of [null, undefined, {}, { schemaVersion: 2, products: {} }, "nope"]) {
      const problems = checkConceptIntegrity(bad, oneProduct);
      expect(problems.map((p) => p.code), `accepted ${JSON.stringify(bad)}`).toContain(
        "artifact-unusable"
      );
    }
  });

  it("catches an artifact that has gone stale", () => {
    const old = new Date(Date.now() - (CONCEPTS_MAX_AGE_DAYS + 5) * 86_400_000).toISOString();
    const problems = checkConceptIntegrity(
      base({ source: { retrievedAt: old, url: "https://rxnav.nlm.nih.gov/REST/" } }),
      oneProduct,
      ["111", "222"]
    );
    expect(problems.map((p) => p.code)).toContain("stale-retrieval");
  });
});

describe("a changed clinical identity is staged for review, not accepted", () => {
  it("reports a product whose own concept moved", () => {
    const next = base();
    next.products["p-one"]!.exact = { rxcui: "444", tty: "SBD", name: "Brand, reorganised" };
    const changes = identityChangesNeedingReview(base(), next);
    expect(changes.join(" ")).toMatch(/p-one: the product's own concept changed from 111 to 444/);
  });

  it("reports a changed generic relationship", () => {
    const next = base();
    next.products["p-one"]!.genericEquivalent = { rxcui: "555", tty: "SCD", name: "other generic" };
    expect(identityChangesNeedingReview(base(), next).join(" ")).toMatch(/generic equivalent changed/);
  });

  it("says nothing when nothing moved", () => {
    expect(identityChangesNeedingReview(base(), base())).toEqual([]);
  });

  it("treats a first run as nothing to review", () => {
    expect(identityChangesNeedingReview(null, base())).toEqual([]);
  });

  it("does not flag a newly added product as a changed identity", () => {
    const next = base();
    next.products["p-two"] = {
      exact: { rxcui: "777", tty: "SBD", name: "New [Brand]" },
      genericEquivalent: null,
    };
    expect(identityChangesNeedingReview(base(), next)).toEqual([]);
  });
});
