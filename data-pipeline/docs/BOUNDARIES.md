# Integration boundaries

What public sources cannot provide, why, and where each feature would have to
get its data instead.

This pipeline supplies **public medication information**. Every item below is
deliberately absent. None should be synthesised, inferred, or defaulted.

---

## Never fabricated

| Feature | Why public sources cannot supply it | Where it would come from |
|---|---|---|
| A patient's prescription | Prescriptions are PHI held by the prescriber and pharmacy. No public dataset contains them. | An authorised EHR or e-prescribing integration under a BAA |
| A clinician's personal instructions | Exist only in the clinical record | The prescriber, through an authorised channel |
| Patient-specific suitability | Requires history, comorbidities, concomitant medication, labs. The label states population-level indications, not individual fitness. | A licensed clinician |
| Member-specific insurance coverage | Eligibility and benefits are held by the payer or PBM | An authorised payer/PBM eligibility API |
| Copays and cost | Only a submitted pharmacy claim produces a binding amount | Pharmacy claim adjudication |
| A real clinician handoff | Requires a scheduling or referral system and consent | An authorised scheduling integration |
| Impiricus / DocUpdate integration | No documented endpoint, schema or credential is known to this codebase | Official documentation plus an authorised credential |
| Clinical review | A review is a person's judgement recorded with a name and date | A named clinician |

The schema enforces the last one structurally: `clinicalReview.reviewed` is
typed as the literal `false`, so it cannot be set true without a deliberate
schema change that a reviewer would see.

---

## Formulary data, if it is ever added

Public formulary data (for example the CMS Part D files) **may** be evaluated,
but it must be kept separate and must preserve one distinction:

- **Formulary listing** — this plan's published drug list includes the product.
- **Individual coverage** — this member, on this date, with this deductible, is covered.

A listing is not coverage. Anything derived from formulary documents belongs in
its own module with its own evidence states, never merged into
`MedicationExport`. This pipeline currently ingests none.

---

## Adverse events

`openFDA drug/event` (FAERS) is reachable and returns ~175,000 montelukast
records. It is **deliberately not ingested**.

Spontaneous reports have no denominator and no verified causality, so they
cannot establish incidence, causation, or comparative safety. Counting them
would manufacture a statistic that does not exist, and this pipeline feeds
patient-facing content.

If a future use case genuinely needs them — signal review, say — they belong in
a separately labelled supplemental dataset, never in a patient-facing field.
The policy is encoded as `FAERS_POLICY` in `src/sources/openfda.ts` so the
omission is visible in code review rather than looking like an oversight.

---

## Drug interactions

**Unavailable.** The RxNav Drug Interaction API was discontinued and returns
HTTP 404 (verified; re-probed at run time by `interactionApiStatus()`).

This pipeline produces **no interaction data**. An empty interactions field
would be read as "no interactions", so no such field exists at all. A future
interaction feature needs a licensed commercial knowledge base, and its
licensing terms will likely restrict redistribution.

---

## Provider directories

NPPES is implemented as a separate optional module and returns enumeration,
self-reported name, taxonomy and public practice location.

It does **not** establish current licensure, credentialing, identity
authentication, acceptance of new patients, insurance participation, or any
relationship with a patient. Those limitations ship in the `limitations` array
on every result.

Rendering an NPPES hit as a "verified provider" requires deliberately
discarding that field, which should not survive review. Real credentialing
comes from state licensing boards and payer credentialing systems.

---

## No real patient data

No patient data of any kind enters this pipeline. Every input is a public
identifier (NDC, RXCUI, SPL set id, application number) and every output is
public labeling.

If a future feature needs patient data, it needs a different pipeline with an
appropriate legal and technical basis — not an extension of this one.
