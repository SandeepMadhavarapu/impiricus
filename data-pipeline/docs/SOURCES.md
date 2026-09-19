# Source research

Every endpoint below was **probed live** before it was written into the code.
Probe date: **2026-09-19**. Nothing here is an endpoint assumed to exist.

---

## A. RxNorm / RxNav

- **Publisher** U.S. National Library of Medicine
- **Docs** <https://lhncbc.nlm.nih.gov/RxNav/APIs/RxNormAPIs.html>
- **Base** `https://rxnav.nlm.nih.gov/REST`
- **Auth** none
- **Rate limit** NLM asks for no more than 20 requests/second per IP. This client caps at 15/s, concurrency 4.
- **Cadence** monthly full release, weekly updates between.
- **Licensing** RxNorm is public domain, but it aggregates source vocabularies with their own terms. Only RxNorm-normalized identifiers and relationships are retained.

### Endpoints used and verified

| Endpoint | Verified result |
|---|---|
| `/rxcui.json?name=` | "Singulair 10 MG Oral Tablet" resolves to `153892` |
| `/rxcui/{rxcui}/properties.json` | `153892` gives tty `SBD`, "montelukast 10 MG Oral Tablet [Singulair]" |
| `/rxcui/{rxcui}/historystatus.json` | `153892` is `Active`, `isCurrent: YES`, active since 04/2005 |
| `/rxcui/{rxcui}/allrelated.json` | returns TTY groups BN, DF, DFG, IN, SBD, SBDC, SBDF, SBDG, SCD, SCDC, SCDF, SCDG |
| `/rxcui/{rxcui}/ndcs.json` | `153892` gives `78206017201`, `78206017202` (11-digit) |
| `/ndcstatus.json?ndc=` | `0169-4130-13` gives `ACTIVE`, rxcui `2398842` |
| `/approximateTerm.json` | candidate generation only, never acceptance |

### Identifier semantics learned

- **TTY matters.** `SBD`, `SCD`, `BPCK` and `GPCK` are product-level and carry NDCs. `SBDC` and `SCDC` are *components* (a concentration) and carry **none** — verified: `SBDC 1991308` returns an empty `ndcList`. Comparing package NDCs against a component concept manufactures a false conflict.
- **`ndcstatus` is the reliable NDC-to-product-concept path.** It returned `2398842` for the Ozempic package where the harmonized block was empty.
- RxNav returns **11-digit** NDCs; the FDA NDC Directory publishes **10-digit hyphenated**. See NDC handling below.

### Unavailable

**The RxNav Drug Interaction API is discontinued.** Probed live:
`/interaction/interaction.json?rxcui=153892` returns **HTTP 404**. This pipeline
therefore produces **no interaction data at all**, and `interactionApiStatus()`
re-probes at run time so the audit reflects reality rather than memory.

---

## B. DailyMed

- **Publisher** U.S. National Library of Medicine
- **Docs** <https://dailymed.nlm.nih.gov/dailymed/app-support-mapping-files.cfm>
- **Base** `https://dailymed.nlm.nih.gov/dailymed/services/v2`
- **Auth** none
- **Rate limit** none published. Self-imposed 4/s, concurrency 2.
- **Cadence** continuous. Labelers submit revisions and DailyMed publishes daily.
- **Licensing** public domain. Label text is reproduced verbatim with attribution.

### Endpoints used and verified

| Endpoint | Verified result |
|---|---|
| `/spls.json?setid=` | HTTP 200, metadata with `spl_version` and `published_date` |
| `/spls/{setid}.xml` | HTTP 200, 236 KB full structured SPL |
| `/spls/{setid}/history.json` | HTTP 200, full version history (v5 Jun 2025, v4 Oct 2024, v3 Nov 2023 and earlier) |
| `/spls/{setid}/media.json` | HTTP 200 |
| `/spls/{setid}/packaging.json` | HTTP 200 |
| `/drugnames.json?drug_name=` | HTTP 200 |
| `/spls.json?drug_name=` | HTTP 200 — **this is how the Novo Nordisk Ozempic SPL was found** |

### Gotchas found the hard way

- **`/spls/{setid}.json` returns HTTP 415.** Only `.xml` serves the full document; the `.json` variants are the sub-resources above.
- **An explicit `Accept: application/xml` header returns HTTP 406.** Text fetches must send `*/*`. This cost a debugging cycle and is now commented in `src/sources/http.ts`.

### Why the XML, not openFDA text

openFDA returns each section as a flat array of strings, which destroys table
structure and subsection nesting. The XML preserves both. Verified: the
Singulair SPL parses to 22 top-level sections, **60 total nested**, and **10
tables**, with "Table 1: Recommended Dosage in Asthma" retaining headers
`["Age", "Dose"]` and the row `["Adult and adolescent patients 15 years of age
and older", "one 10 mg tablet"]`.

---

## C. openFDA

- **Publisher** U.S. Food & Drug Administration
- **Docs** <https://open.fda.gov/apis/>
- **Base** `https://api.fda.gov`
- **Auth** optional `api_key` query parameter, stripped from every persisted URL.
- **Rate limit** documented: without a key 240/min and 1,000/day; with a key 240/min and 120,000/day. Self-imposed 3/s.
- **Cadence** varies per endpoint. Each response carries `meta.last_updated`, which is recorded rather than assumed.
- **Licensing** public domain.

### Datasets used and verified

| Dataset | Verified | What it establishes |
|---|---|---|
| `drug/label` | HTTP 200, `last_updated 2026-09-18` | A **submitted** label, harmonized. Not proof of approval. |
| `drug/ndc` | HTTP 200 | An **NDC directory entry**. Listing is not approval. |
| `drug/drugsfda` | HTTP 200, `last_updated 2026-09-16` | An **approval record**, at application *and* product level. |
| `drug/enforcement` | HTTP 200, 6 records for montelukast | Recalls. Supplemental only. |
| `drug/event` | HTTP 200, 174,999 records | **Deliberately not implemented.** See below. |

### Coverage limitations found

- **The harmonized `openfda` block is frequently wrong or absent.**
  - Toprol XL `70842-111` is a **50 mg** product, yet its `openfda.rxcui` is `[866412, 866414, 866419, 866421]`, every one of which is a **100 mg or 200 mg** concept. Taking `openfda.rxcui[0]` would corrupt the record.
  - Ozempic `0169-4130` has an **entirely empty** `openfda` block: no `spl_set_id`, no `rxcui`.
- **`drug/label` coverage is incomplete relative to DailyMed.** A brand search for OZEMPIC returned four SPLs — three A-S Medication Solutions repackager copies and one oral-tablet label under a different NDA — and **not** the Novo Nordisk label for the product in question. Repackager copies of one original are **not** independent corroboration.

### FAERS is deliberately excluded

`drug/event` holds spontaneous adverse-event reports with no denominator and no
verified causality. It cannot support incidence, causation, or comparative
safety. This pipeline feeds patient-facing content, so counting those reports
would manufacture a statistic that does not exist. The omission is encoded as
`FAERS_POLICY` in `src/sources/openfda.ts` so it is visible in code review.

---

## D. Drugs@FDA

Accessed through `openFDA drug/drugsfda`. Docs: <https://open.fda.gov/apis/drug/drugsfda/>.

**Application-level facts are kept strictly separate from product-level facts.**
An application covers several products, each with its own strength, dosage form,
route and marketing status. The pipeline matches **one** product within the
application and records the rest in `otherProductsInApplication` — listed so a
reader can see the application is broader, never merged in.

Verified: `NDA020829` matched product `002` for Singulair 10 mg, and
`NDA019962` matched product `001` for Toprol XL 50 mg. For Ozempic the
product-level match was **not** confident, so `approval` is recorded as
`absent: ambiguous-applicability` rather than attaching application-level facts
to the product.

---

## E. NPPES

- **Publisher** Centers for Medicare & Medicaid Services
- **Docs** <https://npiregistry.cms.hhs.gov/api-page>
- **Base** `https://npiregistry.cms.hhs.gov/api` (`version=2.1` required)
- **Auth** none
- **Rate limit** none published. Self-imposed 2/s, concurrency 1. Results capped at 200 per request.
- **Cadence** weekly
- **Verified** HTTP 200 for both an NPI lookup and a taxonomy-plus-state search.

**Separate, optional module.** Nothing in the medication pipeline imports it.
Bulk harvesting is not implemented; a query without a selective criterion is
**rejected**, not paginated.

NPPES establishes enumeration, self-reported name, taxonomy and public practice
location. It is **not** proof of current licensure, credentialing, identity
authentication, acceptance of new patients, insurance participation, or any
relationship with a patient. Those limitations ship with every result in the
`limitations` array, so a consumer cannot render a directory hit as a verified
clinician without deliberately discarding the field.

---

## NDC handling

The FDA NDC is labeler-product-package, published as 10 digits in one of three
layouts: `4-4-2`, `5-3-2`, or `5-4-1`. Billing and RxNorm use 11 digits, always
`5-4-2`, produced by zero-padding the short segment.

**A 10-digit string without hyphens does not encode its layout.** `7820617201`
could pad to three different 11-digit codes. `toNdc11()` refuses it and returns
every possibility rather than picking one.

Verified conversions:

| Input | Layout | 11-digit | Cross-checked against |
|---|---|---|---|
| `78206-172-01` | 5-3-2 | `78206017201` | present in RxNorm NDC list for `153892` |
| `70842-111-02` | 5-3-2 | `70842011102` | present in RxNorm NDC list for `866438` |
| `0169-4130-13` | 4-4-2 | `00169413013` | present in RxNorm NDC list for `2398842` |
