# Teammate handoff

Everything you need to consume this pipeline. You do not need to install it,
run it, or call any API from the browser.

---

## Exact paths

### Contracts (TypeScript types, zero dependencies)

```
data-pipeline/contracts/medication-export.d.ts
data-pipeline/contracts/insurance-export.d.ts
```

Copy them into the app or import them directly. No runtime code, no imports.

### Data

```
data-pipeline/data/exports/index.json                              medication catalogue
data-pipeline/data/exports/singulair-montelukast-10mg-tablet.json
data-pipeline/data/exports/toprol-xl-metoprolol-succinate-50mg-er-tablet.json
data-pipeline/data/exports/ozempic-semaglutide-1_34mg-per-ml-injection.json

data-pipeline/data/exports/insurance/source-register.json          discovery vs retrieval status
data-pipeline/data/exports/insurance/plans.json                    5,517 exact Part D plan identities
data-pipeline/data/exports/insurance/coverage-examples.json        real lookup responses
```

### Reports

```
data-pipeline/data/reports/verification.md    highlights/interaction/scope accounting
data-pipeline/data/reports/completeness.md    per-product source completeness
```

---

## Example: medication + plan lookup

```bash
cd data-pipeline
npm run coverage -- --product ozempic-semaglutide-1_34mg-per-ml-injection \
  --contract S5820 --plan 034 --segment 000 --year 2026
```

Real output, abbreviated:

```
state:    conditional
headline: Listed on this plan's formulary, with 2 restriction(s).

CHECKED
  plan:       AARP Medicare Rx Preferred from UHC (PDP)
  plan key:   medicare-partd-2026-S5820-034-000
  formulary:  00026000
  resolution: resolved - Resolved by contract S5820, plan 034, segment 000.
  rxcuis:     2398842(exact-product), 2398841(clinical-drug), 1991302(ingredient)

FOUND (1)
  rxcui 2398842 [exact-product] exactProduct=true
    tier 3 | PA yes | ST no | QL 3 per 28 days

RESTRICTIONS
  - Prior authorisation required (tier 3). This means the prescriber must submit
    information BEFORE the plan will pay. It is not an approval.
  - Quantity limit: 3 per 28 days.

UNKNOWN
  - Member eligibility, enrolment and deductible status: not checked.
  - The actual amount this person would pay: not determined.
  - The plan-defined meaning of the tier number: not in this dataset.

MEMBER BENEFIT VERIFIED: false
```

The same response shape is in `coverage-examples.json` for every
product × demo-plan pair, plus a counterexample.

### The two demo plans

| Plan | Why it is in the set |
|---|---|
| `S5820-034-000` AARP Medicare Rx Preferred (UHC), formulary `00026000` | Real utilisation management on an exact-product match. Also shows a plan NAME is not an identifier — 39 plans in this release share it. |
| `H0034-001-000` Hamaspik Medicare Select, formulary `00026303` | The only formulary among those retained that lists the BRANDED Singulair and Toprol XL concepts. |

---

## Every state, and what to render

### `CoverageState`

| State | Meaning | Render |
|---|---|---|
| `listed` | On the plan's published formulary, no restrictions recorded | "On your plan's drug list" — **not** "covered" |
| `conditional` | Listed, but PA / step therapy / quantity limits apply | List `restrictions` verbatim |
| `explicitly-excluded` | The source document excludes it | "Your plan's list excludes this" + exception route |
| `not-found-in-checked-source` | Absent from what we checked | **"We did not find it on the list we checked."** Never "not covered" |
| `ambiguous-plan` | Plan not pinned down; **nothing was checked** | Show `planResolution.candidates` and ask for `missingDisambiguators` |
| `ambiguous-drug` | Drug not pinned down at the requested granularity | Ask which product |
| `stale-source` | Evidence is from a different plan year | Show the year gap; do not apply the evidence |
| `source-unavailable` | The source could not be reached | "We could not check right now" |

### `PlanResolution.state`

| State | Meaning |
|---|---|
| `resolved` | Exactly one plan matched contract + plan + segment |
| `ambiguous` | Several matched. `candidates` populated, `missingDisambiguators` says what to ask for |
| `not-found` | No plan in this release matched |
| `source-unavailable` | Snapshot missing or invalid |

### `MatchGranularity` — read this before saying "your drug"

| Granularity | Meaning |
|---|---|
| `exact-product` | The plan lists THIS product's concept |
| `clinical-drug` | A generic clinical-drug concept, **not** the branded product |
| `ingredient` | Ingredient level only — much weaker |
| `drug-class` | Class level |
| `ambiguous-text` | A text entry we could not resolve |

```ts
const exact = result.found.filter((f) => f.isExactProductMatch);
if (result.found.length > 0 && exact.length === 0) {
  // result.unknown already explains it; surface that sentence.
}
```

### `Applicability` on label sections

| State | Meaning | Safe as product-specific guidance? |
|---|---|---|
| `exact-product` | Bound to this product | Yes |
| `explicitly-shared` | Covers several products including this one | Yes, if you show which |
| `document-level-unresolved` | The document did not scope it | **No.** Source material only |
| `not-applicable` | Belongs to a sibling product | **No.** Do not show as this product's |

Most sections are `document-level-unresolved`. That is honest, not a bug —
these SPLs simply do not scope sections structurally.

### `interactions.mentions[].direction` — check before warning

| Direction | Meaning | `isAdverseInteraction` |
|---|---|---|
| `no-significant-interaction-stated` | Label says **no** dose adjustment needed | `false` |
| `other-affects-this` | The other drug affects this one | `true` |
| `this-affects-other` | This drug affects the other | `true` |
| `interaction-described-direction-unclear` | Interaction described, direction unclear | `true` |
| `mentioned-unclassified` | Mentioned, no classifiable assertion | `true` |

**All 14 of Singulair's substances are `no-significant-interaction-stated`.**
Rendering the bare names would say the opposite of the label. Always render
`supportingText`, never the name alone.

### `readiness` on medication records

| Value | Meaning |
|---|---|
| `app-ready` | **Structurally** consumable. NOT clinically approved |
| `partial` | Usable, something material missing |
| `blocked` | Contains **no label content**. Render `blockedReason` |

---

## What is always false

```ts
record.clinicalReview.reviewed        // false — typed as the literal
coverage.memberBenefitVerified        // false — typed as the literal
interactions.checkingServiceAvailable // false — typed as the literal
```

No clinical review, no member-specific benefit verification, no
interaction-checking service. These are types, not conventions — they cannot be
set true without a deliberate schema change a reviewer would see.

---

## Commands

```bash
cd data-pipeline && npm install
```

| Command | Purpose |
|---|---|
| `npm run ingest` | Re-fetch medication labels and rebuild records |
| `npm run insurance:ingest` | Re-fetch CMS Part D evidence (~8.8 MB by range) |
| `npm run export` | Rewrite medication exports |
| `npm run insurance:export` | Rewrite register, plans, coverage examples |
| `npm run verify:report -- --live` | Regenerate accounting; check for a newer CMS release |
| `npm run report` | Completeness and conflict report |
| `npm test` | 140 fixture tests, no network |
| `npm run test:live` | Opt-in live smoke checks |

---

## Freshness

```ts
coverage.freshness.sourceRelease        // "2026-08" — CMS release label
coverage.freshness.sourcePublished      // "2026-08-26" — CMS modified date
coverage.freshness.retrievedAt          // when WE fetched it
coverage.freshness.planYear             // year the caller asked about
coverage.freshness.yearMismatch         // true => state is "stale-source"
```

`retrievedAt` is never a substitute for the document's own date. Compare
against `sourcePublished` for "how old is this evidence", and `retrievedAt`
for "how old is our copy".

---

## Questions this data cannot answer

`result.unknown` and `record.interactions.caveats` carry these at runtime. In
short: no patient prescription, no patient-specific dosing or suitability, no
member cost, no clinician instructions, no interaction checking against a
person's full medication list, no clinical review.

A coverage request takes plan selectors and a product key. It does **not**
accept a patient name, member ID, date of birth, diagnosis or credentials —
public plan comparison does not need them.
