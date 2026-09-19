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

`src/lib/chat/providers/index.ts` defines the `AssistantAdapter` interface the
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

Implement `CoverageAdapter` in `src/lib/coverage/adapters.ts`:

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
