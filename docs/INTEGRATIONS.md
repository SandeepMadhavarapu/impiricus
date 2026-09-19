# Integration status

Every external dependency is explicitly CONFIGURED or UNCONFIGURED. The app
renders this same table publicly on the medication page, so a visitor can tell
what is connected without asking.

| Integration | Status | What works today | To enable |
|---|---|---|---|
| **Medication content** (openFDA + DailyMed) | **Configured** | Live. Label fetched, version-corroborated across two sources, stored with full provenance. | Already working. Re-run `npm run content:fetch`. |
| **Assistant — label excerpt search** | **Configured** | Deterministic BM25 over label sections, verbatim excerpts, explicitly not AI. | Already working; needs no credential. |
| **Assistant — conversational** | **Unconfigured** | Adapter, prompt, citation validation and failure handling are complete and tested against a stub. | Set `ANTHROPIC_API_KEY` and `ASSISTANT_PROVIDER=anthropic`. **This is the single remaining configuration step for the assistant.** |
| **Assistant — Impiricus** | **Not implemented** | Adapter boundary only. Returns `not-configured`. | Requires official documentation and an authorised patient-audience credential. None available to this codebase. |
| **Insurance coverage** | **Unconfigured** | Full input flow and all five evidence states. Returns "unable to verify". | Requires a real payer/PBM/formulary API. No such credential exists; there is no env var that fakes one. |
| **Insurance coverage — sample mode** | **Opt-in** | Fictional, visibly-banner-labelled scenarios for demonstrating result states. | `ENABLE_SAMPLE_COVERAGE=true`. Never used as a fallback. |
| **Provider referral submission** | **Not implemented** | No personal information is collected, transmitted or stored. Verified public destinations are offered instead. | Requires a scheduling/referral API **and** a real data-processing agreement. Do not enable without both. |
| **Provider destinations** | **Configured** | HRSA, CMS and FDA public services, each link verified live on 2026-09-19. | Already working. |
| **Public share origin** | **Unconfigured by default** | Falls back to `http://localhost:3000` and shows an operator warning. | Set `PUBLIC_ORIGIN` to the deployed https origin. **Required before sharing to another device.** |
| **Analytics** | **Optional** | Events sanitised against an allow-list, then discarded unless enabled. Nothing leaves the server. | `ANALYTICS_ENABLED=true` writes sanitised events to the server log. |

---

## Why the Impiricus adapter is empty

This is an independent prototype. No Impiricus endpoint, request schema,
authentication scheme or credential is known to this codebase, and inventing one
would produce exactly the failure this project is meant to avoid: an interface
that looks integrated and is not.

`src/patient/lib/chat/providers/index.ts` defines the `AssistantAdapter` interface the
orchestrator depends on. An authorised integration implements that interface and
nothing else changes — retrieval, grounding, citation validation, safety routing
and the UI are all provider-agnostic.

One safeguard is already in place: `getAssistantConfig()` refuses to select the
Impiricus provider unless `IMPIRICUS_AUDIENCE` is exactly `patient`. A
credential scoped to healthcare professionals must not be repurposed for a
patient-facing page.

## Why there is no coverage integration

Formulary and benefit data is not openly available per-plan. The honest options
were:

1. Invent a payer API — rejected. Fabricated coverage results are the most
   damaging thing this app could produce.
2. Scrape public plan PDFs — rejected. Matching a specific plan, year, strength
   and quantity from a PDF with enough confidence to show a result is not
   something this prototype can verify, and a wrong match would look identical
   to a right one.
3. Build the complete flow and every evidence state, return "unable to verify",
   and give genuinely useful next steps — **chosen.**

The single most useful real-world step is already surfaced first: a pharmacy can
run a test claim, which is the only thing that produces a binding answer.

## Adding a coverage adapter

Implement `CoverageAdapter` in `src/patient/lib/coverage/adapters.ts`:

```ts
export interface CoverageAdapter {
  id: string;
  displayName: string;
  check(req: CoverageRequest, productLabel: string): Promise<CoverageResult>;
}
```

Contract:

- Any failure resolves to `unable-to-verify`. `checkCoverageSafely()` enforces
  this for throws and timeouts, but an adapter must not swallow an error into a
  positive-looking result itself.
- A field the source did not return stays `null`. Never default a copay to zero
  or a tier to 1.
- A formulary listing sets `formulary-listed`, never `member-benefit-response`.
  Only a genuine member-specific benefit response earns that state.
- Populate `costEstimate` only when a real estimate was returned. `null` renders
  as "Not available"; a real `0` renders as `$0.00`.

The existing tests in `tests/coverage.test.ts` encode this contract and should
pass against any new adapter.

---

## Update — CMS Part D formulary (genuine plan-specific evidence)

The coverage flow previously had no real source at all. It now has one.

**What was added.** A complete integration against the CMS public dataset
*"Monthly Prescription Drug Plan Formulary and Pharmacy Network Information"* —
Medicare Part D formulary data published by CMS as public domain, keyed by
RXCUI. Our source record already carries this product's RXCUIs (153892 =
`montelukast 10 MG Oral Tablet [Singulair]`, confirmed against RxNorm), so plan
matching is exact rather than name-based guessing.

**Status: integration code complete; data not ingested.**

This is a *data* dependency, not a credential dependency. The code path is
written, typed, schema-validated and covered by 16 tests. The release URL
resolution was verified live:

```
release 2026-08 (modified 2026-08-26)
https://data.cms.gov/sites/default/files/2026-08/.../2026_20260819.zip
HTTP 200, 2188 MB
```

The archive is ~2.2 GB, so the snapshot is generated by the operator rather
than committed:

```bash
npm run coverage:ingest
```

That downloads the release, extracts only the rows matching this product's
RXCUIs plus the plan index, and writes
`src/sources/content/coverage/cms-part-d-snapshot.json` (a few hundred KB, gitignored).

**What a hit actually establishes.** That the drug appears on a *named plan's*
published formulary, with its tier and utilisation-management flags. That is
genuine, plan-specific, and verifiable.

**What it does not establish**, and the adapter never claims:

- It is not member coverage. A hit resolves to `formulary-listed` or
  `restrictions-indicated`, **never** `member-benefit-response`.
- It never produces a cost estimate. A formulary document does not know what
  you pay. `costEstimate` stays `null` on every path.
- It covers **Medicare Part D only**. Commercial and Medicaid plans are not in
  this dataset, and an unmatched plan returns `unable-to-verify` — never
  "not covered".
- Pharmacy network restrictions stay `null`: the basic drugs file does not
  publish them, so they are not guessed at.

**Adapter precedence** is real data → sample mode (only if explicitly opted in)
→ unconfigured. Real evidence always wins, so an operator cannot accidentally
demo fiction while genuine data is present. If no snapshot exists, the flow
reports "unable to verify" exactly as before.
