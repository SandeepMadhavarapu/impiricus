# Teammate handoff

Everything you need to consume this pipeline. You do not need to install it,
run it, or call any API from the browser.

---

## Automatic refresh and the API key

Source checks, change detection and candidate preparation are automated;
publication is reviewed. **The app does not consume this pipeline yet** - see
[REFRESH.md](REFRESH.md), which states the integration gap plainly and gives
the runbook.

```bash
cd data-pipeline
cp .env.example .env.local     # paste the openFDA key after the "="
npm run env:check              # confirms wiring, never prints the value
npm run refresh:check          # reaches all 6 sources, writes nothing
```

openFDA is the only source that takes a key, and it is optional. In CI the key
comes from the repository Actions secret `OPENFDA_API_KEY`.

---

## Supported scope

- **Three selected medication products.** Not a drug database.
- **Public formulary evidence from the verified CMS release.**
- **Medicare Part D**, plus **Virginia Medicaid fee-for-service** (see
  [ACCESS.md](ACCESS.md)). No Marketplace, commercial, or Medicaid managed care.
- **No member-specific coverage or copay verification.**
- **No comprehensive interaction checker.**
- **No clinical review.**

Anything outside that list is unsupported: not partially supported, not
approximated. Where a question falls outside it the pipeline reports the
absence rather than filling it in.

The same statement ships as data, so the app can render it instead of
restating it:

```
data-pipeline/data/exports/index.json                     -> supportedScope
data-pipeline/data/exports/insurance/source-register.json -> supportedScope
```

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

## Access data: restrictions and official next steps

Added in the access layer, additively - nothing below this pipeline's existing
exports changed shape.

```
data-pipeline/contracts/access-export.d.ts
data-pipeline/data/exports/access/access-policies.json
data-pipeline/data/exports/access/source-changes.json
data-pipeline/data/exports/access/capability-manifest.json
data-pipeline/data/exports/access/coverage-matrix.json
```

It answers: what the plan publishes, what restriction applies, the official
next step with a verified form URL or phone number, and what is still unknown.

Worked example - Singulair on Virginia Medicaid FEE-FOR-SERVICE:

```
source:         PDL effective 07/01/2026 v4  -> sourceEffectivity.status = currently-effective
                (the newest PUBLISHED file is effective 10/01/2026 and is NOT in force yet)
listingStatus:  non-preferred            (page 72, Non-Preferred Agents column)
corroborated:   QuickList 07/01/2026 v3 (a separate, preferred-only document) does not list it
requirement:    "Non-preferred drugs require a SA"   - not a denial, not an approval
next step:      prescriber submits a service authorization
                fax 800-932-6651 | phone 800-932-6648 | WebPA / e-PA
                urgent: "For urgent requests, please call 800-932-6648."
also published: on denial a 34-day supply is authorised automatically
                appeal within 30 days; decision within 21 days
scopeWarning:   FEE-FOR-SERVICE ONLY - not Aetna/Anthem/Humana/Sentara/UHC managed care
unknown:        enrolment, approval, and any amount this person would pay
```

### Four things to check before rendering

1. **`sourceEffectivity.status`** must be `currently-effective`. Virginia
   publishes each PDL weeks ahead of its effective date, so the newest file is
   usually NOT the coverage in force. `upcomingChanges` carries what is coming;
   it must never replace the current fields.
2. **`scopeWarning`** - Virginia findings are fee-for-service only.
3. **`mayDisplayFormularyEvidence(...)`**, not just `mayLookUpCoverage`.
   Resolving the plan is necessary but NOT sufficient; five conditions must
   hold. `personalBenefitsVerified` is always `false`.
4. **`formType`** - a `generic-model-template` is a regulator's model form, not
   this plan's. A working URL proves availability, not applicability.

Read [ACCESS.md](ACCESS.md) before rendering any of it: `non-preferred` is not
excluded, `not-addressed-in-this-document` is not "not covered", and
`pipeline-suggested-navigation` marks a step as **ours**, not the plan's.

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

### `Applicability` on label sections — the limitation, stated plainly

| State | Meaning | Safe as product-specific guidance? |
|---|---|---|
| `exact-product` | Bound to this product | Yes |
| `explicitly-shared` | Covers several products including this one | Yes, if you show which |
| `document-level-unresolved` | The document did not scope it | **No.** Source material only |
| `not-applicable` | Belongs to a sibling product | **No.** Do not show as this product's |

**One SPL routinely covers several products that share a label but not a dose.**
Singulair's label covers the 10 mg tablet, the chewable tablets and the oral
granules, dosed differently. Most sections are not structurally bound to any one
of them.

So `document-level-unresolved` is the **majority state**, and it means exactly
one thing: *the document did not say which product this section is about.* It is
not a weak yes. It is not "probably this product". Nothing in the data upgrades
it, because the information is absent from the source.

**The limitation:** unresolved sections must not be used to generate
product-specific dosing instructions, administration steps or patient
directions — automatically or otherwise. They stay available to read and cite.

This is enforced in the data, not left to you:

```ts
// SAFE: exact-product and explicitly-shared only, at every depth.
export.productSpecificGuidance.sections

// NOT SAFE as generated dosing: every section, including unresolved ones.
export.professionalLabeling
```

`productSpecificGuidance` also reports `excludedUnresolvedCount` and
`excludedNotApplicableCount` so the omission is visible rather than silent. On
the three real labels:

| Product | Guidance sections | Unresolved, excluded | Not applicable, excluded |
|---|---:|---:|---:|
| singulair-montelukast-10mg-tablet | 20 | 37 | 3 |
| toprol-xl-metoprolol-succinate-50mg-er-tablet | 19 | 68 | 8 |
| ozempic-semaglutide-1_34mg-per-ml-injection | 14 | 33 | 9 |

An empty `sections` array would mean the document scoped nothing to this
product. It would **not** mean there is no dosing information, and it is not a
licence to fall back to unresolved sections.

### `interactions.mentions[].direction` — check before warning

| Direction | Meaning | `isAdverseInteraction` | `assertsNoInteraction` |
|---|---|---|---|
| `no-dose-adjustment-stated` | Label says the **dose need not change**. Says nothing about whether an interaction exists | `false` | **`false`** |
| `no-interaction-observed-stated` | Label says an interaction was **not observed** or not clinically significant | `false` | `true` |
| `other-affects-this` | The other drug affects this one | `true` | `false` |
| `this-affects-other` | This drug affects the other | `true` | `false` |
| `interaction-described-direction-unclear` | Interaction described, direction unclear | `true` | `false` |
| `mentioned-unclassified` | Mentioned, no classifiable assertion | `true` | `false` |

**The two negative directions are not interchangeable.** A drug can interact
measurably — a real change in exposure — and still need no dose adjustment
because the change is not large enough to matter for dosing. "No dose adjustment
is needed" is dosing guidance; it neither warns nor clears.

**All 14 of Singulair's substances are `no-dose-adjustment-stated`**, from:

> "No dose adjustment is needed when SINGULAIR is co-administered with
> theophylline, prednisone, … digoxin, warfarin, gemfibrozil …"

So for warfarin the honest rendering is *"the label says no dose change is
needed when taken together"* — not *"interacts with warfarin"* and not *"no
interaction with warfarin"*. Across all three products,
`assertsNoInteraction` is **true for nothing**: none of these labels states an
absence.

Always render `supportingText`. Never the name alone.

### `interactions.completeness` — before you read a zero

`0` extracted adverse mentions means **zero were extracted**. It does not mean
the label describes no adverse interactions, and it is not evidence that none
exist.

The extractor only harvests names from explicit enumerations following a
coadministration phrase. Interactions written as prose, as a drug class, inside
a table, or in any other section are not counted.

```ts
interactions.completeness.level  // "index-only-not-exhaustive" — no "complete" value exists
interactions.completeness.sentencesWithCoadministrationPhrase
interactions.completeness.sentencesYieldingSubstances
interactions.completeness.sentencesUnparsed  // the blind spot, reported
```

| Product | Scanned | With phrase | Yielded | Unparsed |
|---|---:|---:|---:|---:|
| singulair-montelukast-10mg-tablet | 2 | 1 | 1 | 0 |
| toprol-xl-metoprolol-succinate-50mg-er-tablet | 11 | 3 | 2 | 1 |
| ozempic-semaglutide-1_34mg-per-ml-injection | 8 | 2 | 1 | 1 |

Treat `mentions`, `noDoseAdjustmentStated`, `noInteractionObservedStated` and
`describedInteraction` as **incomplete indexes**. `interactions.sections` — the
full label sections, verbatim — is the evidence. Render from it.

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
| `npm test` | 204 fixture tests, no network |
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
