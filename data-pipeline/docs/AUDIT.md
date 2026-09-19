# Verification audit

What was verified against live sources, what was tested with synthetic
fixtures, what is unavailable, and what remains unreviewed.

Audit date: **2026-09-19**.

---

## 1. Verified live, against real sources

These ran against the real APIs and the results are reproduced in
`data/normalized/` and `data/exports/`.

| Check | Result |
|---|---|
| RxNav concept resolution | `153892` SBD Active; `866438` SBD Active; `2398842` SBD Active |
| RxNav NDC association | all three products' package NDCs present in the matching concept's NDC list |
| RxNav interaction API | **HTTP 404 — discontinued.** Re-probed at run time |
| DailyMed SPL XML retrieval | 3 documents, 236 KB / 1.1 MB / 0.9 MB |
| DailyMed version history | Singulair v5 (Jun 2025), v4, v3 present |
| openFDA `drug/ndc` | exact `product_ndc` match for all three |
| openFDA `drug/drugsfda` | product-level match for 2 of 3 |
| openFDA `drug/enforcement` | 6 / 16 / 1 records retrieved |
| NPPES v2.1 | HTTP 200 for NPI lookup and taxonomy search |
| Identity resolution | **3 of 3 verified-match** |
| Full ingest | 3 records written, schema-validated |
| Export | 3 exports + index written |

### Ingested record summary

| Product | Resolution | Readiness | SPL sections | Tables | Patient docs | Products in doc |
|---|---|---|---:|---:|---:|---:|
| Singulair 10 mg tablet | verified-match | app-ready | 60 | 10 | 3 | 4 |
| Toprol XL 50 mg ER tablet | verified-match | app-ready | 95 | 3 | 1 | 4 |
| Ozempic 1.34 mg/mL injection | verified-match | app-ready | 56 | 16 | 6 | 8 |

### Live smoke checks

`npm run test:live` — **7 passed**, reported separately from the fixture suite.
Includes the interaction-API probe, which logged
`interaction API: available=false http=404`.

---

## 2. Tested with synthetic fixtures

Fixture-driven suite: **76 tests across 4 files, all passing, no network.**
Fixtures live in `tests/fixtures/` and are marked
`SYNTHETIC-FIXTURE-DO-NOT-USE-AS-DATA`. They are never written to `data/`.

| Failure mode | How it is tested |
|---|---|
| Ambiguous NDC conversion | 10-digit unhyphenated input is refused, all 3 possibilities listed |
| Wrong strength | 50 mg spec vs 10 mg source resolves `conflicting` |
| IR vs ER confusion | extended-release spec vs unstated form resolves `conflicting` |
| Wrong dose form | tablet spec vs granule source resolves `conflicting` |
| Wrong route | oral spec vs subcutaneous resolves `conflicting` |
| Wrong NDC | mismatched product NDC resolves `conflicting` |
| Multiple products in one SPL | both products parsed; the unselected one is listed, never merged |
| Missing harmonized identifiers | resolution proceeds from SPL + NDC without the openfda block |
| Historical / inactive concepts | non-current RXCUI fails the TTY evidence row |
| Component-level concept | SBDC skips the NDC cross-check instead of failing it |
| Source unavailable | all sources failing resolves `source-unavailable`, never `verified-match` |
| Partial response | `splProduct: null` resolves `ambiguous`, not a guess |
| Table structure | Age/Dose columns preserved; cell text absent from paragraphs |
| Section hierarchy | 2.1 nests under 2; printed numbers extracted, never invented |
| Salt vs moiety | both retained; inactive ingredients excluded |
| Idempotency | parsing twice yields byte-identical output |
| Malformed input | raises rather than returning an empty-but-plausible document |
| Blocked export | carries no label content, only a reason |
| Credential leakage | no `api_key=` survives into persisted provenance URLs |

---

## 3. Defects found and fixed during the loop

Each was a real defect caught by running against live data, not a hypothetical.

| Defect | Detection | Fix |
|---|---|---|
| SPL sections and products parsed as 0 | Probe showed `root.component` is an array, so `.structuredBody` missed | Traverse the array and find the element carrying `structuredBody` |
| Active ingredients empty | SPL uses `<ingredient classCode="ACTIM">`, not `<activeIngredient>`; route lives on the **outer** `manufacturedProduct` | Rewrote `parseProduct(outer, inner)` against the real shape |
| All SPL fetches failed | `Accept: application/xml` returns **HTTP 406** from DailyMed | Text fetches send `*/*` |
| Ozempic falsely `conflicting` | Package NDCs compared against **SBDC 1991308**, which carries an empty NDC list | TTY-aware guard: skip the cross-check for component-level concepts; corrected the spec to SBD `2398842` |
| Wrong product identifiers in the catalogue | My initial Toprol and Ozempic NDCs were guesses; live query disproved both | Replaced with verified `70842-111` and `0169-4130` |

---

## 4. Unavailable

| Capability | Status | Evidence |
|---|---|---|
| Drug-drug interactions | **Unavailable.** RxNav Interaction API discontinued | HTTP 404, re-probed at run time |
| Ozempic approval detail | **Not asserted.** No confident product-level match within NDA209637 | `approval: absent (ambiguous-applicability)` |
| Novo Nordisk Ozempic label via openFDA | **Not indexed.** Only repackager copies returned | Retrieved via DailyMed name search instead |
| Adverse-event incidence | **Deliberately excluded.** FAERS has no denominator | `FAERS_POLICY` in `src/sources/openfda.ts` |

---

## 5. Left unreviewed

- **No clinical review of any kind.** `clinicalReview.reviewed` is `false` on every record and the schema types it as `false`, so it cannot be set true without a deliberate schema change.
- **No derived patient summaries were generated.** The pipeline exports official label text only. Phase 6 permits derived summaries with per-claim supporting passages; none were produced, so none needed review.
- **Section-to-product scoping is partial.** `appliesToProducts` is an empty array on every section because the SPLs examined do not scope sections with `<subject>`. Empty means "the document did not scope this", **not** "applies to all products" — but a consumer could misread it. `productsInDocument` is the mitigation.
- **Enforcement matching is by generic name.** Each record carries `matchedOnNdc`, and for these three products that flag is false throughout. A name match does not establish that this exact product was recalled.
- **openFDA `meta.last_updated` is recorded but not enforced.** Nothing currently fails on stale upstream data.

---

## 6. Not attempted

- Bulk NPPES harvesting. The API is for targeted lookups; a non-selective query is rejected.
- Any large dataset download. The largest retrieval here is a 1.1 MB SPL.
- Patient-facing derived content, insurance data, provider directories with availability, or any Impiricus integration. See [BOUNDARIES.md](BOUNDARIES.md).
