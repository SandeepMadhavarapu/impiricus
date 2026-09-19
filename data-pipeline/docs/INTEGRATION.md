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
