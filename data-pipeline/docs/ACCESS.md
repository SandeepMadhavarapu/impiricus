# Medication access data

What a plan publishes, what restriction applies, the official next step, and
what we still cannot verify.

Everything below was retrieved from the cited source and re-checked against the
original. Nothing here is generated, inferred from a similar plan, or filled in
where a source was silent.

---

## Supported scope for this layer

- **Three medication products**, unchanged from the medication pipeline.
- **Two insurance markets**: Medicare Part D (nationwide dataset, two demo
  plans) and **Virginia Medicaid FEE-FOR-SERVICE** (statewide).

> **Virginia findings are FEE-FOR-SERVICE ONLY.** Virginia contracts with
> managed care organisations — Aetna, Anthem, Humana, Sentara and
> UnitedHealthcare — that publish their **own** formularies and their own
> authorization rules. Most Virginia Medicaid members are enrolled in one of
> those plans, not in fee-for-service. Nothing in this layer may be applied to
> a managed care member without retrieving that plan's own documents. Every
> Virginia policy carries this as `scopeWarning`.
- **No member-specific coverage, eligibility, approval or copay.**
- **No clinical review.**

---

## Files

```
data-pipeline/contracts/access-export.d.ts              types, additive only

data-pipeline/data/exports/access/access-policies.json  policies, requirements, next steps
data-pipeline/data/exports/access/source-changes.json   two published versions, diffed
data-pipeline/data/exports/access/capability-manifest.json  what is ready to display
data-pipeline/data/exports/access/coverage-matrix.json  source x product x plan
```

`medication-export.d.ts` and `insurance-export.d.ts` are **unchanged**. This
layer adds files; it moves nothing.

---

## Commands

```bash
cd data-pipeline && npm install
```

| Command | Purpose |
|---|---|
| `npm run access:export` | Retrieve, extract, verify links, diff versions, write all four access files |
| `npm run insurance:ingest` | Refresh the CMS Part D snapshot |
| `npm test` | 204 fixture tests, no network |
| `npm run test:live` | Opt-in live checks |
| `npm run verify` | Typecheck plus fixture tests |

`access:export` performs live retrieval: the CMS release, two Virginia PDF
versions, and a reachability check on every URL it publishes.

---

## The demo narrative, tied to evidence

### 1. Singulair on Virginia Medicaid fee-for-service

**What the plan publishes.** Brand `Singulair® tabs/chew tabs/granules` is in
the **Non-Preferred Agents** column, page 72 of the PDL **effective 07/01/2026
(v4) — the version in force**, under *Leukotriene Receptor Antagonists*.
Generic `montelukast tabs/chewable tabs` is in the **Preferred** column on the
same page.

### How that placement was checked, and what each check is worth

An earlier version of this document claimed the placement was "verified three
ways, independently". **That was wrong, and the correction matters.**

Horizontal position and typography are two encodings of one publisher decision
*inside the same file*. Their agreement checks that the parser read the file
consistently. It does not corroborate the fact, because a mistake in that file
— or a parsing error touching both — would leave them agreeing and still wrong.

| Check | What it is | What it is worth |
|---|---|---|
| Horizontal position | `Singulair` begins at x=223, the exact x of the "Non-Preferred Agents" header on that page | Primary reading |
| Typography | `Singulair` is set in `TimesNewRomanPS-ItalicMT`; preferred agents are **bold**, non-preferred *italic* | **Parser cross-check, same file — not corroboration** |
| Document self-check | The footer reads `Version: 07/01/2026 v4`, matching the catalogue before extraction | Confirms which document was read |
| **Separate document** | The publisher's **QuickList** (a preferred-agents-only list, effective 07/01/2026 v3) **does not list Singulair**, and **does list** `montelukast tab/chew tab` | **Independent corroboration** |

Only the last row is corroboration: a different document, differently laid out,
in which the same authority states the same thing. It is carried in the export
as `independentCorroboration`.

Absence from a preferred-only list is weaker than presence, and is labelled
`consistent-with-non-preferred` rather than proof.

**What restriction applies.** Page 1: *"Non-preferred drugs require a SA."*

**What the published policy requires next.** From the state's own documents:

| Actor | Step | Route |
|---|---|---|
| Prescriber | Submit a service authorization | fax 800-932-6651, phone 800-932-6648, or WebPA / e-PA |
| Prescriber | Urgent request | *"For urgent requests, please call 800-932-6648."* |
| Pharmacy | If the prescriber cannot be reached, dispense a 72-hour supply | phone 800-932-6648 |
| Plan | On denial, **34-day supply is authorised automatically**, without waiting for an appeal | no patient action |
| Patient | Appeal within **30 days**; decision within **21 days** of receipt | a prescriber filing on the patient's behalf needs explicit written authorization |

**What we cannot verify.** Whether this person is in fee-for-service or a
managed care plan; whether an SA would be approved; what they would pay.

### 2. Ozempic on Virginia Medicaid fee-for-service

`semaglutide` and `Ozempic` appear **nowhere** in the 72-page document in force
(nor in the 73-page upcoming version).

The export says `not-addressed-in-this-document`, never "not covered", because
page 1 states the list *"only includes select drug classes"* and that drugs not
on it *"are subject to Virginia's mandatory generic substitution
requirements"* — a defined status, not an exclusion.

### 3. Ozempic on Medicare Part D, plan S5820-034-000

`listed-with-restrictions`: prior authorization **and** a quantity limit of
3 per 28 days, from the plan's own formulary filing in the CMS 2026-08 release.

The prior-authorization requirement is worded as *"a requirement to ask, not an
approval"*, and the release carries the **flag only** — not the clinical
criteria the plan will apply. Those are a documented gap, not a silent one.

Next steps are the federally standardised route: the CMS Model Coverage
Determination Request Form, then redetermination, then Independent Review
Entity reconsideration. All three URLs were reachability-checked.

**These are MODEL TEMPLATES, not this plan's forms.** CMS publishes them for
the market segment; a sponsor may publish its own form, and some require it.
`formType` is `generic-model-template` and `routeApplicability` is
`market-segment-standard-plan-form-may-differ` on the first two steps, so a
consumer cannot render them as "this plan's submission route". The IRE step and
CMS-1696 are `verified-for-this-plan`, because that level is handled by CMS and
the IRE rather than the sponsor.

A working URL proves the template is **available**. It does not prove the plan
**accepts** it, and the link check makes no claim about applicability.

### 4. Something is *about to* change

**Corrected.** An earlier version of this document said Cinryze "moved" from
Preferred to Non-Preferred. It has not moved. It is **Preferred today**.

| | Version | Effective | Cinryze |
|---|---|---|---|
| In force | 07/01/2026 v4 | 2026-07-01 | **Preferred**, page 52 |
| Upcoming | 10/01/2026 v2 | 2026-10-01 | Non-Preferred, page 54 |

Virginia publishes each quarterly PDL **weeks before it takes effect** and
keeps superseded versions online, so "newest published file" and "coverage in
force" are different documents for most of every quarter. Building from the
newest file states next quarter's rules as today's — which this pipeline did,
until this pass.

The export now selects the version in force by effective date, carries the
upcoming version separately, and marks **every** change record
`effectiveStatus: "upcoming"` with `takesEffectOn`. 94 upcoming differences
were detected, 8 of them preference changes. `isPatientNotification` is the
literal `false` on every record.

---

---

## Page inspection record

Every exported demo row was read back out of the **currently effective**
document (v4) at its own coordinates, including headings, footnote markers and
continuation context.

**A pixel rendering could not be produced in this environment.** The publisher
serves the PDF with a download disposition, the browser pane refuses to render
`application/pdf` even when re-served locally with `Content-Disposition:
inline`, and rasterising through pdf.js in Node failed on a Path2D
incompatibility in the canvas binding. What follows is a positional
reconstruction from the document's own text geometry, plus corroboration from a
separate publisher document — not a screenshot.

### v4 page 72 — Leukotriene Receptor Antagonists

```
y=461  montelukast tabs/chewable | Accolate®                 | LENGTH OF AUTHORIZATION : 1 year
y=450  tabs                      | Singulair® tabs/chew tabs/
y=440                                                        | Routine PDL edits      (BOLD)
y=435                            | granules                  (ITALIC)
y=423                            | montelukast granules      (ITALIC)
```

- **Heading**: `Leukotriene Receptor Antagonists`, bold, spanning past x=223.
- **Continuation**: the Singulair entry wraps — `Singulair® tabs/chew tabs/`
  (y=450) continues as `granules` (y=435), both at x=223. The preferred entry
  wraps the same way: `montelukast tabs/chewable` + `tabs`.
- **Footnotes**: none on these rows; no asterisk markers present.

### v4 page 20 — Beta Blockers, and why criteria are not bound to drugs

```
y=202                                     | *Clinical Criteria for Hemangeol™   (BOLD, SA column)
y=199  Beta Blockers                                                            (BOLD, class heading)
y=184  atenolol      | acebutolol         | • Diagnosis of proliferating infantile hemangioma…
y=138  metoprolol tartrate | *Hemangeol™
y=130  metoprolol succinate | Inderal® XL
```

This is the misalignment, visible in the coordinates: the criteria block header
sits at **y=202**, *three points above* the `Beta Blockers` heading at
**y=199**. Any rule that walks the left column's headings and claims the right
column's text attributes those criteria to the wrong class. The asterisk on
`*Hemangeol™` (y=138) is what actually binds them, and Hemangeol is
propranolol.

`metoprolol succinate` is at x=87 (preferred). `Inderal® XL` shares its
baseline at x=223 and is a different drug — propranolol, non-preferred.

### v4 page 21 — Toprol XL

```
y=429                            | Toprol XL®     (ITALIC, x=223)
y=414  Beta Blockers + Diuretic Combinations       (BOLD heading, BELOW it)
```

`Toprol XL®` is on a different page from the Hemangeol criteria entirely, and
sits *above* the next class heading, so it belongs to the `Beta Blockers` block
continuing from page 20. The parser assigns it there.

### Extraction disputes affecting these rows

`columnDisputed` is set when horizontal position and typography disagree.
**Across all three demo products: 0 disputes.** Document-wide the rate is 1.2%
(27 of 2,241 cells), and every one is page furniture — a legend row on page 2,
a contact line on page 1 — never a drug row.

The resolution rule, recorded on each policy as `extractionDisputes` and
applied when a dispute does occur: **position wins**, because it is bound to
the column headers measured on the same page, whereas typography is a styling
convention the publisher applies inconsistently to legends and headings. The
disagreement is recorded rather than silently resolved.

---

## Reading the data correctly

| Value | Means | Does **not** mean |
|---|---|---|
| `non-preferred` | An authorization is required | Excluded |
| `not-addressed-in-this-document` | The source did not mention it | Not covered |
| `listed-with-restrictions` | Restrictions are published | Approved |
| `policy-applicability-unresolved` | A real document, unproven for this plan | This plan's requirement |
| `incomplete-extraction` | Read the cited page | The field is empty |
| `source-content` change | The publisher changed something | Tell the patient |
| `pipeline-suggested-navigation` | **Our** suggestion | The plan directs it |

Gate every coverage display on `CardMatchResult.mayLookUpCoverage`. Only
`exact-plan-identified` licenses showing a plan's formulary evidence.

---

## Defects found and fixed this pass

Recorded because each was, briefly, live in this pipeline.

1. **SA criteria filed as non-preferred drugs.** The "SA Criteria" header sits
   at x=628 while its content begins at x=375. Nearest-header binding put
   criteria in the non-preferred column. The boundary is now derived from the
   leftmost content right of the non-preferred header, and the derivation is
   recorded in the export.

2. **Every beta blocker filed under the wrong drug class.** The "Beta Blockers"
   heading carries a blank cell in the SA column, so a `cells.length === 1`
   test rejected it as a heading. Toprol XL was attributed to *Angiotensin
   Receptor Blockers + Diuretic Combinations*, and inherited the clinical
   criteria for **Hemangeol** — propranolol for infantile hemangioma. Empty
   cells are now dropped before the heading test.

3. **Preferred drugs opening new drug classes.** Preferred agents are bold, as
   headings are, so font weight alone made every preferred drug a class
   heading: 274 of 379 detected "classes" were false. Headings are merged cells
   that span past the non-preferred column edge; drug entries never do.

4. **Phantom formulary changes.** Change detection keyed on raw text, so
   `"* Fintepla®"` and `"* Fintepla"` read as one drug removed and another
   added. Keys are now normalised (footnote markers, trademark symbols,
   typographic dashes), and 182 line-wrap fragments are filtered before
   diffing. Detected changes fell from 137 to 94.

5. **Drugs in both columns silently halved.** A name can legitimately appear in
   both columns — montelukast tablets preferred, granules non-preferred. Keying
   one entry per name let the later row win and reported the survivor as a
   preference change. The tracked value is now the set of columns.

---

## Blockers, stated concretely

| Target | Status | Blocker |
|---|---|---|
| Plan-specific clinical PA criteria | **Blocked** | The CMS archive has no criteria file — verified by listing all 14 members of the 2.14 GB archive; it carries PA/ST as flags only. Insurer-hosted criteria: `uhc.com` returns **HTTP 403** to automated retrieval. A national PBM criteria document cannot be attributed to a contract-plan-segment without a documented mapping, so it would be `policy-applicability-unresolved` even if retrieved. |
| Virginia SA criteria bound to a drug | **Partial** | The SA Criteria column is not aligned to the left column's class headings — a criteria block's header can sit above the heading of the class its bullets govern. No rule over the left column establishes which criteria bind which drug. Criteria text is carried verbatim with page citations; `criteriaExtraction.complete` is `false`. |
| Financial assistance terms | **Not implemented — not attempted** | No adapter was built and **no retrieval was attempted**, so nothing is known about whether these sources are reachable. This is an implementation gap, not a source failure, and the manifest records `implementationStatus: not-attempted` with `sourceAvailability: not-assessed`. Manufacturer pages carry their own expiry and exclusion terms that must be quoted exactly and re-verified per retrieval; that work was deferred rather than approximated. |
| Marketplace / commercial formularies | **Blocked** | No public plan-to-formulary crosswalk; CMS public use files carry benefit design, not drug-level formularies. |
| Pharmacy network / stock | **Not attempted** | The network files are 2.18 GB of the archive. NPPES proves a pharmacy exists, never that it participates in a plan network or holds stock. |
| Member eligibility, copay, approval | **Impossible here** | Requires an authorised payer integration with a trading-partner agreement and patient identifiers. No public API exists and none is simulated. |

---

## Missing payer and member integrations

None of these exist in this pipeline, and no substitute is faked for any of
them:

- Real-time prescription benefit (member-specific cost at the point of care)
- Eligibility and benefit verification (X12 270/271)
- Electronic prior authorization submission and status (NCPDP SCRIPT ePA)
- Claim adjudication or accumulator data (deductible and out-of-pocket to date)
- Any authenticated payer member portal
- Impiricus / DocUpdate clinician delivery

`memberEligibilityDetermined` and `clinicallyReviewed` are the literal `false`
on every policy, and `isPatientNotification` the literal `false` on every
change record. They are types, not conventions: none can be set true without a
schema change a reviewer would see.

---

## Corrections made before integration

Six items were re-checked before teammates integrate this. Five were wrong.

1. **Current coverage was being read from a future document.** Virginia's
   newest published PDL is effective 2026-10-01; today is 2026-09-19. Every
   Virginia policy was built from it. Now the pipeline selects by effective
   date, refuses to fall back when everything is future-dated, and marks all 94
   detected differences `upcoming` with `takesEffectOn`. The Singulair, Toprol
   XL and Ozempic findings are unchanged between the two versions — only their
   page numbers and citations moved.

2. **"Source unavailable" claimed for a source never contacted.** Financial
   assistance is now `implementationStatus: not-attempted` with
   `sourceAvailability: not-assessed`. The manifest carries a
   `statusVocabulary` making the split explicit, and every other entry was
   re-labelled the same way.

3. **Resolving the plan was treated as licence to display coverage.** It is
   necessary, not sufficient. `mayDisplayFormularyEvidence` now requires five
   conditions: exact plan, a **verified plan-to-formulary relationship**, a
   medication match at a usable granularity, an applicable plan year and source
   version, and a lookup that returned usable evidence. `personalBenefitsVerified`
   is the literal `false` regardless of outcome.

4. **"Verified three ways independently" was an overstatement.** Position and
   typography are two encodings inside one file. Corroboration now comes from a
   genuinely separate publisher document, the QuickList. See the inspection
   record above.

5. **Fee-for-service scope was documented but not prominent.** Every Virginia
   policy now carries `scopeWarning` naming the five managed care organisations
   it does not cover, and unbound SA criteria are explicitly kept out of
   `requirements` — asserted by test.

6. **CMS model forms read as the plan's submission route.** They are generic
   templates; `formType` and `routeApplicability` now say so, and the docs
   state that a working URL confirms availability, not applicability.
