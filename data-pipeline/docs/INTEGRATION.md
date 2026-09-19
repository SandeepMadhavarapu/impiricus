# Integration guide for UI teammates

You consume JSON. You do not need to install this package, run ingestion, or
call any API from the browser.

---

## Where the data is

```
data-pipeline/data/exports/index.json                      catalogue
data-pipeline/data/exports/<productKey>.json               one product each
data-pipeline/contracts/medication-export.d.ts             types, zero deps
```

All of it is committed. Copy the `.d.ts` into the app or import it directly.

## Reading a product

```ts
import type { MedicationExport, ExportIndex } from "../data-pipeline/contracts/medication-export";

const index: ExportIndex = await import("../data-pipeline/data/exports/index.json");
const med: MedicationExport = await import(
  "../data-pipeline/data/exports/singulair-montelukast-10mg-tablet.json"
);
```

Current `productKey` values:

| productKey | Display |
|---|---|
| `singulair-montelukast-10mg-tablet` | Singulair 10 mg tablet, film coated |
| `toprol-xl-metoprolol-succinate-50mg-er-tablet` | Toprol XL 50 mg tablet, extended release |
| `ozempic-semaglutide-1_34mg-per-ml-injection` | Ozempic 1.34 mg/mL injection, solution |

---

## The five things to get right

### 1. Check `readiness` before rendering anything

```ts
if (med.readiness === "blocked") {
  // There is NO label content in this record, by design.
  show(med.blockedReason);
  return;
}
```

`"app-ready"` means **structurally consumable**. It does **not** mean clinically
approved. `med.clinicalReview.reviewed` is `false` on every record.

### 2. Render the hierarchy, not a flat list

`professionalLabeling` is a tree. "5.1 Neuropsychiatric Events" is a
`subsection` of "5 WARNINGS AND PRECAUTIONS". Flattening it loses which warning
belongs to which topic.

```tsx
function Section({ s }: { s: ExportedSection }) {
  return (
    <section>
      <h3>{s.printedNumber ? `${s.printedNumber} ` : ""}{s.title}</h3>
      {s.paragraphs.map((p, i) => <p key={i}>{p}</p>)}
      {s.tables.map((t, i) => <Table key={i} table={t} />)}
      {s.subsections.map((sub, i) => <Section key={i} s={sub} />)}
    </section>
  );
}
```

### 3. Render tables as tables

A dosing table flattened to prose loses which dose belongs to which age group.
That is how a paediatric row becomes an adult instruction.

```tsx
<table>
  <caption>{t.caption}</caption>
  <thead>{t.headers.map((row, i) => <tr key={i}>{row.map((c, j) => <th key={j}>{c}</th>)}</tr>)}</thead>
  <tbody>{t.rows.map((row, i) => <tr key={i}>{row.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
</table>
```

`tables[]` content is **not** duplicated in `paragraphs[]`. If you render only
paragraphs, you silently drop the dosing table.

### 4. Prefer `patientLabeling` for patients

`patientLabeling` holds official patient-directed text — Medication Guide,
Instructions for Use — written for a lay reader by the labeler and reviewed by
FDA as part of the label. `professionalLabeling` is prescribing information.

Both are official. Neither is ours. Do not blend them into one stream.

### 5. Show `productsInDocument` when showing dosing

One SPL routinely covers several products. Singulair's covers **four** (10 mg
tablet, two chewable strengths, granules). Dosing text in
`professionalLabeling` may discuss any of them.

```ts
if (med.document.productsInDocument.length > 1) {
  note(`This label also covers: ${med.document.productsInDocument.join("; ")}`);
}
```

---

## Field meanings that are easy to get wrong

| Field | Means | Does **not** mean |
|---|---|---|
| `readiness: "app-ready"` | structurally consumable | clinically approved or reviewed |
| `identifiers.rxcui` | the RxNorm concept we **verified** | whatever `openfda.rxcui[0]` said (that was wrong for Toprol XL) |
| `identifiers.rxnormTty` | concept level, e.g. `SBD` | `SBDC` is a *component* and carries no NDCs |
| `display.labeledIngredient` | the ingredient as labeled, often a **salt** | the active moiety |
| `display.activeMoiety` | the moiety, when distinguished | interchangeable with the salt |
| `display.strengthDisplay` | preformatted, may be a ratio | a scalar you can parse to one number |
| `approval.available: false` | we could not confirm a **product-level** match | the drug is unapproved |
| `freshness.sourceEffectiveDate` | the label's own effective date | when we fetched it (`ingestedAt`) |
| `conflicts[]` empty | nothing detected | nothing exists |

### Strength is not a scalar

Ozempic is `1.34 mg/1 mL`. The denominator carries a unit and is load-bearing
for identity. Use `display.strengthDisplay` for presentation. If you need the
parts, read `verification.evidence` or the normalized record — do not regex the
display string.

### Salt vs active moiety

Toprol XL is `METOPROLOL SUCCINATE` (labeled) with moiety `METOPROLOL`.
Metoprolol **tartrate** is a different product with different dosing. Showing
only the moiety merges two products that must not be merged.

---

## Freshness and change detection

```ts
const ageDays = (Date.now() - Date.parse(med.freshness.ingestedAt)) / 86_400_000;
```

Compare against `sourceEffectiveDate` for "how old is this label", and
`ingestedAt` for "how old is our copy". They are different questions.

When a label is revised, `identifiers.splVersion` changes. `npm run refresh`
detects and reports that:

```
SOURCE VERSION CHANGED for <key>: SPL v5 -> v6.
Any derived summaries built against v5 must be revalidated before reuse.
```

**Never carry a derived summary across a version change without revalidating.**

---

## Auditing a match

`verification.evidence` is the full decision trail:

```ts
med.verification.evidence.forEach((e) => {
  console.log(`${e.agrees ? "OK" : "FAIL"} ${e.dimension}: expected "${e.expected}", observed "${e.observed}" [${e.source}]`);
});
```

There is no confidence score on purpose. A number like `0.87` hides which
dimension failed, and which dimension failed is the whole question.

---

## What this data does not contain

`med.notProvided` carries the list at runtime. In short: no patient
prescription, no patient-specific dosing or suitability, no insurance coverage
or cost, no clinician instructions or relationship, no drug-interaction
checking, no adverse-event incidence, no clinical review.

If a feature needs one of those, it needs a different source and a different
agreement. See [BOUNDARIES.md](BOUNDARIES.md).

---

# Insurance coverage (added in the second pass)

Types: `contracts/insurance-export.d.ts` (dependency-free).
Data: `data/exports/insurance/`.

```
source-register.json      what we discovered vs what we actually retrieved
plans.json                5,517 exact Part D plan identities + formulary mapping
coverage-examples.json    real lookup responses, including counterexamples
```

## Reading a coverage result

```ts
import type { CoverageLookupResult, CoverageExamples } from "../data-pipeline/contracts/insurance-export";

const examples: CoverageExamples = await import(
  "../data-pipeline/data/exports/insurance/coverage-examples.json"
);
```

Or run one locally:

```bash
npm run coverage -- --product ozempic-semaglutide-1_34mg-per-ml-injection \
  --contract S5820 --plan 034 --segment 000 --year 2026
```

## The six things to get right

### 1. Never resolve a plan from a name

39 plans in the 2026-08 release share the name
"AARP Medicare Rx Preferred from UHC (PDP)". A name produces **candidates**, not
an answer:

```ts
if (result.checked.planResolution.state !== "resolved") {
  showCandidates(result.checked.planResolution.candidates);
  askFor(result.checked.planResolution.missingDisambiguators); // contractId, planId, segmentId
  return; // state is "ambiguous-plan"; nothing was checked
}
```

### 2. `not-found` is not `not covered`

```ts
switch (result.state) {
  case "listed":                      // on the list, no restrictions recorded
  case "conditional":                 // on the list, WITH restrictions
  case "explicitly-excluded":         // the source really excludes it
  case "not-found-in-checked-source": // absent from what we checked. NOT "not covered"
  case "stale-source":                // evidence is from a different plan year
  case "ambiguous-plan":
  case "ambiguous-drug":
  case "source-unavailable":
}
```

Render `result.headline` — it is written to match the state.

### 3. Check `isExactProductMatch` before saying "your drug is covered"

In the CMS **2026-08** release, branded Singulair (RXCUI 153892) appears on
**exactly one** of the formularies we retained, while generic montelukast
clinical-drug concepts appear on hundreds. A `clinical-drug` match is not a
brand listing. That count describes this release and this RXCUI filter, not
Part D as a whole.

```ts
const exact = result.found.filter((f) => f.isExactProductMatch);
if (result.found.length > 0 && exact.length === 0) {
  // result.unknown already explains this; surface it.
}
```

### 4. Prior authorisation is not approval

`conditional` means the plan requires something *before* it will pay. Render
`result.restrictions` verbatim — each string already carries its own caveat.

### 5. A tier is not a dollar amount

Every cost figure carries a `basis`. The only basis this pipeline can produce is
`published-plan-cost-sharing-rule`, and each rule carries a caveat saying it is
not a price for any individual. Never render it as "you will pay".

### 6. Quantity-limit units are load-bearing

`quantityLimit.asStated` is `"3 per 28 days"`, not "3 per month". Use
`asStated`; do not recompose it from `amount` and `days`.

## Freshness

```ts
result.freshness.yearMismatch  // true => state is "stale-source"
result.freshness.sourceRelease // "2026-08"
result.freshness.retrievedAt   // when we fetched it, NOT the document's date
```

## What a coverage request may contain

Plan selectors and a product key. **No patient name, member ID, date of birth,
diagnosis or credentials** — public plan comparison does not require them and
the lookup does not accept them.

## What is never provided

`memberBenefitVerified` is `false` on every result. There is no eligibility
integration, no real-time benefit connection, and no adjudicated cost. See
`docs/BOUNDARIES.md`.
