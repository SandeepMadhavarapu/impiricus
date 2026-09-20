/**
 * Referential integrity between the RxNorm identity artifact, the catalogue
 * and the coverage snapshot.
 *
 * ---------------------------------------------------------------------------
 * WHY
 * ---------------------------------------------------------------------------
 * `product-concepts.json` is a HARD runtime dependency: catalogue.ts imports it
 * statically, and every coverage answer is looked up on the concept it names.
 * It was produced by a script that nothing called - not `content:sync`, not the
 * refresh workflow. Two failures followed from that, both silent:
 *
 *   - a product added to the catalogue would have no entry, so
 *     `productConcepts` returns null and its coverage is "unable to verify"
 *     for ever, with nothing failing;
 *   - if openFDA re-harmonises a label's RXCUI, the artifact keeps the old
 *     one, and a refresh ships new label data joined to a stale identity. The
 *     coverage answer would then be about a different product than the page.
 *
 * These checks are pure so the same rules run in the sync script, in the
 * refresh workflow and in a test. Nothing here calls the network: this is
 * integrity between artifacts that already exist.
 */

export interface ConceptEntry {
  exact: { rxcui: string; tty: string; name: string } | null;
  genericEquivalent: { rxcui: string; tty: string; name: string } | null;
}

export interface ConceptArtifact {
  schemaVersion: number;
  source?: { retrievedAt?: string; url?: string };
  products: Record<string, ConceptEntry>;
}

export interface CatalogueProduct {
  productKey: string;
  /** The RXCUI the label export itself carries. May be null. */
  labelRxcui: string | null;
}

export interface IntegrityProblem {
  productKey: string | null;
  code:
    | "artifact-unusable"
    | "product-missing-entry"
    | "entry-has-no-exact-concept"
    | "exact-disagrees-with-label"
    | "generic-equals-exact"
    | "generic-not-a-clinical-drug"
    | "rxcui-absent-from-coverage-snapshot"
    | "stale-retrieval";
  detail: string;
}

/** Days after which the identity artifact is treated as stale. */
export const CONCEPTS_MAX_AGE_DAYS = 90;

/**
 * Every way the identity artifact can be wrong about the products it serves.
 *
 * Returns problems rather than throwing, so a caller can decide whether to
 * fail a build or report. An empty array means the artifact, the catalogue and
 * the coverage snapshot all agree.
 */
export function checkConceptIntegrity(
  artifact: unknown,
  products: CatalogueProduct[],
  /** The RXCUIs the coverage snapshot was filtered to. Omit to skip that check. */
  snapshotRxcuis?: string[],
  now: Date = new Date()
): IntegrityProblem[] {
  const problems: IntegrityProblem[] = [];

  const doc = artifact as ConceptArtifact | null;
  if (
    doc === null ||
    typeof doc !== "object" ||
    doc.schemaVersion !== 1 ||
    typeof doc.products !== "object" ||
    doc.products === null
  ) {
    return [
      {
        productKey: null,
        code: "artifact-unusable",
        detail: "product-concepts.json is missing, malformed, or not schemaVersion 1",
      },
    ];
  }

  const retrievedAt = doc.source?.retrievedAt;
  if (typeof retrievedAt === "string") {
    const ageDays = (now.getTime() - new Date(retrievedAt).getTime()) / 86_400_000;
    if (Number.isFinite(ageDays) && ageDays > CONCEPTS_MAX_AGE_DAYS) {
      problems.push({
        productKey: null,
        code: "stale-retrieval",
        detail: `identity was retrieved ${Math.round(ageDays)} days ago, over the ${CONCEPTS_MAX_AGE_DAYS}-day limit`,
      });
    }
  }

  const covered = snapshotRxcuis === undefined ? null : new Set(snapshotRxcuis);

  for (const product of products) {
    const entry = doc.products[product.productKey];
    if (entry === undefined) {
      problems.push({
        productKey: product.productKey,
        code: "product-missing-entry",
        detail: "the catalogue publishes this product but the identity artifact has no entry for it",
      });
      continue;
    }

    if (entry.exact === null) {
      // A real state when openFDA harmonised no RXCUI - but then the label
      // must not claim one either, or the two disagree.
      if (product.labelRxcui !== null) {
        problems.push({
          productKey: product.productKey,
          code: "entry-has-no-exact-concept",
          detail: `the label export carries RXCUI ${product.labelRxcui} but the identity artifact records none`,
        });
      }
      continue;
    }

    /*
     * The check that catches a re-harmonised label. openFDA can change the
     * RXCUI it maps a product to; when it does, the identity artifact must be
     * regenerated before the new label ships, or the page and its coverage
     * answer describe different products.
     */
    if (product.labelRxcui !== null && product.labelRxcui !== entry.exact.rxcui) {
      problems.push({
        productKey: product.productKey,
        code: "exact-disagrees-with-label",
        detail:
          `the label export now carries RXCUI ${product.labelRxcui} but the identity artifact ` +
          `still records ${entry.exact.rxcui}. Regenerate it before shipping this label.`,
      });
    }

    if (entry.genericEquivalent !== null) {
      if (entry.genericEquivalent.rxcui === entry.exact.rxcui) {
        problems.push({
          productKey: product.productKey,
          code: "generic-equals-exact",
          detail: "the generic equivalent is the same concept as the product, which erases the distinction",
        });
      }
      if (entry.genericEquivalent.tty !== "SCD") {
        problems.push({
          productKey: product.productKey,
          code: "generic-not-a-clinical-drug",
          detail: `the generic equivalent has term type ${entry.genericEquivalent.tty}, expected SCD`,
        });
      }
    }

    if (covered !== null && !covered.has(entry.exact.rxcui)) {
      // Coverage is filtered to a set of RXCUIs. A product whose concept is
      // outside it can never be found, and would report "not listed" on every
      // plan - a false negative about access rather than a missing feature.
      problems.push({
        productKey: product.productKey,
        code: "rxcui-absent-from-coverage-snapshot",
        detail:
          `RXCUI ${entry.exact.rxcui} is not among the RXCUIs the coverage snapshot was built for, ` +
          `so this product would be reported as not listed on every plan`,
      });
    }
  }

  return problems;
}

/**
 * Identity changes that a person should look at rather than a build accept.
 *
 * An upstream relationship changing is not proof that the clinical identity
 * changed; RxNorm reorganises, and a product silently acquiring a different
 * concept is exactly the kind of change that must not ride along with a data
 * refresh. Returns a human-readable list, empty when nothing material moved.
 */
export function identityChangesNeedingReview(
  previous: ConceptArtifact | null,
  next: ConceptArtifact
): string[] {
  if (previous === null) return [];
  const out: string[] = [];
  for (const [key, nextEntry] of Object.entries(next.products)) {
    const prevEntry = previous.products?.[key];
    if (prevEntry === undefined) continue;

    if (prevEntry.exact?.rxcui !== nextEntry.exact?.rxcui) {
      out.push(
        `${key}: the product's own concept changed from ${prevEntry.exact?.rxcui ?? "none"} ` +
          `to ${nextEntry.exact?.rxcui ?? "none"}`
      );
    }
    if (prevEntry.genericEquivalent?.rxcui !== nextEntry.genericEquivalent?.rxcui) {
      out.push(
        `${key}: the generic equivalent changed from ${prevEntry.genericEquivalent?.rxcui ?? "none"} ` +
          `to ${nextEntry.genericEquivalent?.rxcui ?? "none"}`
      );
    }
  }
  return out;
}
