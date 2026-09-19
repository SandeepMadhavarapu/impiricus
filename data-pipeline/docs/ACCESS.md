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
  plans) and **Virginia Medicaid fee-for-service** (statewide).
- **No member-specific coverage, eligibility, approval or copay.**
- **No clinical review.**
- Virginia **managed care** plans are out of scope; they publish separate
  formularies and are not conflated with fee-for-service.

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
| `npm test` | 182 fixture tests, no network |
| `npm run test:live` | Opt-in live checks |
| `npm run verify` | Typecheck plus fixture tests |

`access:export` performs live retrieval: the CMS release, two Virginia PDF
versions, and a reachability check on every URL it publishes.

---

## The demo narrative, tied to evidence

### 1. Singulair on Virginia Medicaid fee-for-service

**What the plan publishes.** Brand `Singulair® tabs/chew tabs/granules` is in
the **Non-Preferred Agents** column, page 73 of the PDL effective 10/01/2026
(v2), under *Leukotriene Receptor Antagonists*. Generic `montelukast
tabs/chewable tabs` is in the **Preferred** column on the same page.

That placement is verified three ways, independently:

| Signal | Evidence |
|---|---|
| Horizontal position | `Singulair` begins at x=223, the exact x of the "Non-Preferred Agents" header |
| Typography | `Singulair` is set in `TimesNewRomanPS-ItalicMT`; the document sets preferred agents in **bold** and non-preferred in *italic* |
| Document self-check | The footer reads `Version: 10/01/2026 v2`, matching the catalogue entry before anything was extracted |

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

`semaglutide` and `Ozempic` appear **nowhere** in the 73-page document.

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
Entity reconsideration. All three form URLs were reachability-checked.

### 4. Something actually changed

Comparing two genuinely published Virginia PDL versions:

**Cinryze™ moved from Preferred (07/01/2026 v4, page 52) to Non-Preferred
(10/01/2026 v2, page 54).** Confirmed by reading both documents.

8 such preference changes were detected. `isPatientNotification` is the literal
`false` on every record: a change is an item for review, not a notification.

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
| Financial assistance terms | **Not done this pass** | Manufacturer pages carry their own expiry and exclusion terms that must be quoted exactly and re-verified per retrieval. Deferred rather than approximated. |
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
