# Verification audit

What was verified against live sources, what was tested with fixtures, what is
unavailable, and what remains unreviewed.

Audit date: **2026-09-19** (third pass).

---

## 0. Verification of the previous audit

The prior report's claims were treated as assertions and checked against the
implementation. **One was wrong in a way that lost real data.**

| Prior claim | Verdict | Evidence |
|---|---|---|
| "No interaction data is produced" | **Misleading** | All three labels have a Drug Interactions section (LOINC 34073-7). Singulair's carried 376 characters that were being exported. The claim conflated "no interaction-checking service" with "no interaction content". |
| "`appliesToProducts` is empty on every section" | **Confirmed** | 0 of 62, 0 of 63, 0 of 97 sections scoped. |
| "Ozempic approval unresolved" | **Confirmed, and fixable** | Resolved this pass to NDA209637 product 002. |
| "Enforcement matching is by generic name; `matchedOnNdc` false throughout" | **Confirmed** | 0 of 23 records verified across the three products. |

### Defect found during verification, not in the prior report

**FDA Highlights content was being silently dropped.** The parser read only a
section's own `<text>`, but `<excerpt><highlight><text>` holds the "Highlights
of Prescribing Information" summary, including the entire summary of Toprol XL
section 7 — which is why that section exported 0 characters.

Fixed, and Highlights are kept in a **separate field** from `paragraphs`,
because the label states they do not include all the information needed.

**Correction to this audit's earlier figure.** The "~19,900 characters" quoted
in the first version of this document was a crude tag-strip that counted the
SPL's raw pretty-print indentation and newlines. It overstated the content by
about 80%. The reconciled accounting, produced by `npm run verify:report`:

| Measure | Chars |
|---|---:|
| Raw tag-strip incl. indentation (the misleading figure) | 19,911 |
| Source text, whitespace-collapsed | 11,012 |
| Routed to `tables` rather than `highlights` | 150 |
| Retained as highlights-only content | 2,426 |
| Duplicate (also present in `paragraphs`) | 8,586 |
| **Unaccounted for** | **0** |

The large duplicate share is expected and not a defect: FDA Highlights are by
design a summary of the full prescribing information, so most of that text
legitimately appears in both places. Block-level detail is in
`data/reports/verification.md`.

---

## 1. Fixes verified live

| # | Fix | Evidence after the change |
|---|---|---|
| A | Interactions | All three: `availability: "label-section-available"`, `checkingServiceAvailable: false`. Absence is typed as `no-label-section` with a caveat that it is a fact about the document, not about safety. **See the corrections below — the substance list was misleading twice, in opposite directions, and both are fixed.** |
| B | Applicability | Real states. Singulair: 2 exact-product, 18 explicitly-shared, 37 document-level-unresolved, **3 not-applicable** (sections belonging to the chewable/granule siblings). `productSpecificSections()` excludes unresolved content. |
| C | Approval | **NDA209637 product 002** (4MG/3ML, Prescription). Products 001 and 002 both read 1.34 MG/ML; 001 is **Discontinued**. Package volume 3 mL, taken from RxNorm concept `2398842` ("3 ML … Pen Injector"), is what separates them. Without the volume the matcher returns `ambiguous` rather than guessing. |
| D | Recalls | Tiered. **0 verified, 23 candidates** across the three products. No false "this product was recalled". An empty verified list is explicitly documented as not proving the absence of recalls. |

Toprol XL also surfaced a real salt nuance: Drugs@FDA expresses its strength as
`EQ 50MG TARTRATE` — the succinate salt stated as tartrate equivalent.

### Correction: the interaction substance list inverted the label's meaning

The previous pass exported `namedSubstances` as a flat list. Singulair's read
*warfarin, digoxin, gemfibrozil, theophylline…* — which any consumer would
render as "interacts with warfarin". The source sentence says the opposite:

> "**No dose adjustment is needed** when SINGULAIR is co-administered with
> theophylline, prednisone, prednisolone, oral contraceptives, fexofenadine,
> digoxin, warfarin, gemfibrozil, itraconazole, thyroid hormones…"

The flat list is replaced by classified `mentions`, each carrying the sentence
it came from, preserved qualifiers, and an `isAdverseInteraction` flag.

Two extraction artifacts were also fixed: `"insulin secretagogue e"` (residue
from stripping a parenthetical) and `"ozempic"` (the product listing itself as
an interacting substance).

### Correction to the correction: dosing guidance is not an observed absence

The fix above then overreached in the opposite direction. It classified all 14
substances as `no-significant-interaction-stated` and this document claimed
"all 14 were statements of **no** clinically significant interaction."

**That claim was wrong.** The source sentence is *dosing guidance*. A drug can
interact measurably — a real change in exposure — and still require no dose
adjustment, because the change is not large enough to matter for dosing. The
label says the dose stands. It does not say the drugs do not interact.

Inverting a warning and manufacturing a clearance are the same class of error:
both assert something the source never said.

The single direction is now split, and the two are never merged:

| Direction | What the label claims | Interaction status |
|---|---|---|
| `no-dose-adjustment-stated` | The dose need not change | **Unknown** |
| `no-interaction-observed-stated` | An interaction was not observed, or not clinically significant | Stated absent, for what was studied |

Mentions also carry `assertsNoInteraction`, true only for the second, and
`isDosingGuidanceOnly`, true only for the first.

| Product | Mentions | No dose adjustment (status unknown) | No interaction observed | Interaction described |
|---|---:|---:|---:|---:|
| singulair-montelukast-10mg-tablet | 14 | **14** | 0 | 0 |
| toprol-xl-metoprolol-succinate-50mg-er-tablet | 2 | 0 | 0 | 1 (`other-affects-this`) |
| ozempic-semaglutide-1_34mg-per-ml-injection | 1 | 0 | 0 | 1 (direction unclear) |

Across all three products, `assertsNoInteraction` is true for **nothing**. None
of these labels states that an interaction is absent.

### Extraction completeness is now exported

"0 adverse mentions extracted" was readable as "no adverse interactions". It is
not the same claim, and the export now says so in the data rather than in a
caveat string.

`interactions.completeness.level` is the literal `"index-only-not-exhaustive"`.
There is no `"complete"` value, because the extractor cannot reach completeness:
it only harvests names from explicit enumerations following a coadministration
phrase, so prose, class-level and table-borne interactions are never counted.

| Product | Sentences scanned | With coadministration phrase | Yielded substances | Unparsed |
|---|---:|---:|---:|---:|
| singulair-montelukast-10mg-tablet | 2 | 1 | 1 | 0 |
| toprol-xl-metoprolol-succinate-50mg-er-tablet | 11 | 3 | 2 | 1 |
| ozempic-semaglutide-1_34mg-per-ml-injection | 8 | 2 | 1 | 1 |

`unparsed` is the blind spot, reported rather than hidden. The substance lists
are incomplete indexes; `interactions.sections` — the full label sections,
verbatim — remains the evidence.

### Defect found this pass: unresolved sections leaked through nesting

`productSpecificSections()` was documented as excluding
`document-level-unresolved` content. It selected matching nodes and returned
them **whole**, so an unresolved subsection rode along inside a safe parent. It
also emitted safe subsections twice, once nested and once hoisted.

Measured on the real exports before the fix, the "product-specific" trees
contained 37, 68 and 33 unresolved sections respectively — the exact content
the filter existed to withhold.

The filter is now depth-aware: every node in the returned tree is itself
`exact-product` or `explicitly-shared`, and a safe section under an unresolved
parent is hoisted rather than dropped. Verified on all three exports: the only
applicability states reachable through `productSpecificGuidance` are those two.

---

## 2. Insurance evidence — verified live

### The transfer problem, and how it was solved

The CMS Monthly Prescription Drug Plan file is **2.14 GB**. Reading the ZIP
central directory over HTTP range requests (host returns `Accept-Ranges: bytes`
and HTTP 206) showed why:

| Member | Size |
|---|---|
| pharmacy networks, parts 1-6 | **2.18 GB** |
| basic drugs formulary | 7.9 MB |
| plan information | 0.4 MB |
| beneficiary cost | 0.4 MB |
| excluded drugs / indication-based | ~0 MB |

Fetching only the needed members transfers **8.8 MB in about 4 seconds** — a
~250x reduction — and is the difference between documenting a dataset and
ingesting it.

### What was ingested

| Metric | Value |
|---|---|
| Release | 2026-08 (contract year 2026), modified 2026-08-26 |
| Formulary rows for our RXCUIs | 979 |
| Plans | 5,517 |
| Cost-sharing rules | 30 (demo plans only; the full file is 172,660 rows / ~23 MB) |
| Explicit exclusions | 0 |
| Committed snapshot | 1.9 MB |

### Demo plans, both real

| Plan | Evidence |
|---|---|
| **S5820-034-000** AARP Medicare Rx Preferred from UHC (PDP), formulary 00026000 | Ozempic RXCUI 2398842: **exact-product match**, tier 3, **prior authorisation**, **quantity limit 3 per 28 days** |
| **H0034-001-000** Hamaspik Medicare Select (HMO D-SNP), formulary 00026303 | The only formulary **among those we retained from the 2026-08 release** that lists branded Singulair (153892) and Toprol XL (866438), both tier 1, no restrictions |

### Counterexamples run against real data

| Test | Result |
|---|---|
| Brand vs generic on the UHC plan | Only the generic clinical-drug concept (200224) matched. `isExactProductMatch: false`, and `unknown` states that a generic listing does not establish the brand is listed. |
| Same drug on Hamaspik | Brand concept 153892 matched. `isExactProductMatch: true`. |
| Resolve by plan NAME | `ambiguous-plan`. **39 plans** share "AARP Medicare Rx Preferred". Candidates returned, nothing checked. |
| Wrong plan year (2025 vs 2026 evidence) | `stale-source`. Evidence reported, never applied. |
| Plan absent from release | `not-found`, nothing checked. |
| Drug absent from a resolved plan's formulary | `not-found-in-checked-source`, with the headline stating it is not the same as "not covered". |

---

## 3. Tested with synthetic fixtures

**159 tests across 7 files, all passing, no network.** Fixtures are marked
`SYNTHETIC-FIXTURE-DO-NOT-USE-AS-DATA` and never written to `data/`.

New coverage this pass, beyond the original 76:

- Interactions: LOINC-based lookup, substance extraction, absence never
  rendered as "no interactions", not-retrieved distinguished from no-section.
- Applicability: not-applicable for sibling-only sections, explicitly-shared
  for multi-product sections, unresolved left unresolved, single-product
  documents scoped to exact-product, unresolved excluded from product-specific
  output.
- Approval: all four real Drugs@FDA strength formats parsed; volume-based
  disambiguation; **ambiguous when volume is absent**; dose-form tolerance
  (`SOLUTION` vs `INJECTION, SOLUTION`).
- Recalls: all three tiers; candidates kept out of verified.
- Insurance: plan resolution, every coverage state, brand-vs-generic,
  quantity-limit units, cost basis tagging, schema-drift failure, no patient
  identifiers in any request shape.

### Live smoke checks

`npm run test:live` — opt-in, reported separately. 7 passing, including the
interaction-API probe which logs `available=false http=404`.

---

## 4. Unavailable, and why

| Capability | Status | Evidence |
|---|---|---|
| Interaction **checking service** | Unavailable | RxNav Interaction API HTTP 404, re-probed at run time. Label-described interactions ARE available and exported. |
| Marketplace / QHP drug-level formulary | **Not ingested** | CMS PUFs carry benefit design, not drug-level formularies. Those live in issuer machine-readable files with no public plan-to-formulary crosswalk. Registered as `discovered`. |
| Virginia Medicaid PDL | **Not ingested** | Published as PDF. Requires table extraction with footnote preservation plus row-by-row verification before any restriction could be exported. Registered as `discovered` rather than parsed badly. |
| Commercial / PBM formularies | **Not attempted** | A PBM standard formulary is not proof an employer plan uses it, and Transparency in Coverage files are multi-gigabyte rate files without drug-level membership. |
| Real-time prescription benefit | **Not attempted** | Requires a trading-partner agreement, credentials and patient identifiers. No public API exists and none is simulated. |
| Member-specific cost | **Impossible here** | `memberBenefitVerified` is typed as the literal `false`. |

---

## 5. Left unreviewed

- **No clinical review.** `clinicalReview.reviewed` is typed as literal `false`.
- **Applicability classification is heuristic.** It keys on dose-form words and
  strength phrases in a section's own text. It cannot invent structural scoping
  the document lacks, so most sections stay `document-level-unresolved` — which
  is honest, and is never an upgrade path to `exact-product`.
- **Named-substance extraction is conservative** and deliberately
  under-extracts. Toprol XL yields only one substance because its interactions
  live in prose subsections rather than enumerations. The full section text is
  exported regardless; the list is an incomplete index, not the evidence. This
  is now stated in the data as `completeness.level`, not only in prose, so a
  zero count cannot be misread as an absence.
- **Applicability is not upgraded by the guidance filter.** Excluding
  unresolved sections from `productSpecificGuidance` withholds them; it does
  not make the remainder complete. An empty guidance array would mean the
  document scoped nothing, not that no dosing information exists.
- **Cost-sharing rules are committed for demo plans only.** The full 172,660-row
  file is re-fetchable with `npm run insurance:ingest`.
- **No PDF extraction exists yet.** Every insurance source requiring it
  (Medicaid PDLs, commercial formularies) is registered as discovered, not
  parsed. No OCR path has been built or needed.
- **Enforcement `verified` lists are empty for all three products.** That is the
  honest outcome of NDC-based verification, not evidence of safety.

---

## 6. Prioritised datasets worth adding next

1. **CMS indication-based coverage formulary file** (~0 MB, already in the
   archive we range-fetch). Would populate `indicationCriteria`, currently null.
2. **CMS Quarterly SPUF pricing files**. Adds plan-level negotiated pricing —
   still not a member's cost, but a stronger cost basis than tier alone.
3. **Virginia Medicaid PDL PDF extraction**, with footnote preservation and
   manual verification of every demo-critical restriction.
4. **Marketplace issuer machine-readable formulary index**, if a documented
   plan-to-formulary mapping can be established for a specific issuer.
5. **Part D pharmacy network files**, only if pharmacy-level questions become a
   requirement — 2.18 GB for a narrow gain.
