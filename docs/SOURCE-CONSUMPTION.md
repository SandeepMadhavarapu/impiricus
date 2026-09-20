# Every source, what it is used for, and what it does not establish

Written 2026-09-20 during the backend/data integration pass. It exists because
the previous failures all had the same shape: a source was correctly retrieved
and correctly parsed, and then something between the pipeline and the reader
either dropped it, mixed it with another product's, or presented it as a claim
it could not support. A per-source record of *what reaches a reader* is the
thing that was missing.

Companion to `data-pipeline/docs/EXPORT-CONSUMPTION.md`, which tracks the
artifacts. This tracks the sources.

---

## Ingested and reaching a reader

| Source | Used for | Reaches the app as | Freshness | What it does NOT establish |
|---|---|---|---|---|
| **openFDA drug label** | The SPL behind every medication page | `src/sources/content/label-exports/*.json` via `content:sync` | Checked daily by `pipeline-refresh`; release 2026-09-18 | That a clinician reviewed it. `clinicalReview.reviewed` is false on everything the pipeline can produce. |
| **DailyMed** | Human-readable label and Medication Guide links; SPL version corroboration | Provenance on each label export | Same run | Anything about a specific patient's prescription. |
| **RxNorm / RxNav** | Product identity: the concept each page IS, and its same-strength, same-form generic | `src/sources/content/rxnorm/product-concepts.json` | Refreshed by the pipeline-refresh workflow alongside the labels it describes; integrity enforced by `tests/rxnorm-lifecycle.test.ts`, which the workflow runs before opening a candidate. Regenerate manually with `node scripts/fetch-rxnorm-concepts.mjs`. | That brand and generic are interchangeable for a given person. Substitution is a prescriber and pharmacist decision. |
| **CMS Part D monthly formulary** | Formulary status, tier, prior authorisation, step therapy, quantity limits; the 5,517-plan directory | `src/sources/content/coverage/cms-part-d-snapshot.json` and `.../insurance/plans.json` | Release 2026-08, retrieved 2026-09-19 | Enrolment, eligibility, deductible status, or price. A drug list is not a benefit. |
| **NPPES NPI Registry** | Confirming one NPI a reader was given | `/api/provider`, rendered by `ProviderSheet` | Live per request | Licence, credentials, privileges, network participation, or identity. The CMS disclaimer ships with every response. |

## Retrieved, deliberately not wired

| Source | Status | Why not wired |
|---|---|---|
| **Virginia Medicaid PDL** | `discovered`; 9 policies and 94 classified changes exist in `data-pipeline/data/exports/access/` | The app's coverage flow is Medicare Part D only. Rendering VA fee-for-service evidence needs a market dimension in `CoverageRequest`; without one it would read as advice about the reader's own coverage. Mixing it into a Medicare answer is specifically forbidden. |
| **CMS quarterly SPUF** | `discovered` | Superseded by the monthly file for this purpose. |
| **Medicare Extra Help (LIS)** | `discovered` | Would change what somebody pays, and the app makes no payment claims at all. Wiring it without eligibility data would be worse than silence. |

## Discovered only — not ingested, and must not be described as available

| Source | Status |
|---|---|
| **CMS Marketplace PUF** | `discovered`. Commercial/exchange formularies are NOT in the app. A commercial plan name returns "unable to verify", never a Medicare answer. |
| **Commercial plan and PBM formularies** | `not-attempted`. No licence, no credential. |
| **Real-Time Prescription Benefit / eligibility APIs** | `not-attempted`. This is the only class of source that could answer "what will I pay", and none is connected. |

---

## Capabilities that do not exist

Recorded here so nothing in the codebase or documentation implies otherwise.

- **Every page is public.** `APP_MODE` is routing configuration, not
  authorization. Share URLs carry a product slug and nothing else; query and
  fragment are stripped when they are built. Patient accounts and private
  records are out of product scope, so there is nothing here to protect.
- **No EHR, benefits or clinical-review integration.**
- **No pharmacy dataset**, so pharmacy-by-ZIP returns empty and says so.
- Nothing is ever marked sent, delivered or reviewed, because nothing is sent.

---

## Known integration gaps

Cases where the backend now holds a true statement the existing UI has no place
to show properly. Recorded rather than papered over.

1. **Generic-equivalent formulary status.** When the branded product is not on
   a plan's list but its same-strength generic is, that is reported in prose
   under "What this does not tell you". The structured tier / prior
   authorisation / quantity-limit fields stay empty, because they describe the
   product the reader asked about. A second product's structured status has no
   slot in the current sheet. Showing it in the brand's fields is the exact
   defect this pass removed, so prose is the honest option until the UI grows
   a related-product row.

2. **Unresolved plan identity.** 39 plans share the name "AARP Medicare Rx
   Preferred from UHC (PDP)" across two contracts. A shared answer is given
   only when every tied candidate has a drug list AND they all publish the
   same thing about the product; then the drug answer is identical for all of
   them, and it is given with a
   caveat naming the contract ids and stating that the plan was NOT
   individually identified. A plan picker that submits a contract-plan-segment key already
   exists in the form; the caveat covers the case where somebody types a name
   instead.

3. **Rate limiting is per warm instance, not global.** The limiter is an
   in-process map. On a serverless host each instance counts separately and a
   cold start begins at zero. It raises the cost of casual abuse; it is not a
   quota and is not described as one.

---

## Status vocabulary

Kept distinct on purpose, because collapsing them is how "we found this source"
becomes "the app uses this source".

| Status | Meaning |
|---|---|
| **discovered** | The source exists and was located. Nothing was retrieved. |
| **retrieved** | Content was downloaded and stored with provenance. |
| **validated** | It parsed, and passed the pipeline's schema and applicability checks. |
| **application-consumed** | A vendored artifact under `src/sources/content/` is read at runtime by the app. This is the only status that means a reader can see it. |

Only openFDA, DailyMed, RxNorm and CMS Part D reach **application-consumed**.
NPPES is queried live per request rather than vendored.
