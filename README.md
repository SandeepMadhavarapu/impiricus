# MedBridge

A mobile-first, link-based medication education experience. Someone shares an
HTTPS link; the recipient opens it and immediately gets plain-language
information about one specific medication — what it is, what it treats, what it
might help with, and what the risks are — sourced from the FDA-approved label,
with every claim traceable to the exact text it came from.

**This is an independent hackathon prototype.** It is not affiliated with,
endorsed by, or connected to Impiricus, Organon, the FDA, or any insurer. No
clinician has reviewed its content.

---

## What actually works right now

| Capability | Status |
|---|---|
| Public medication page from a real FDA label, with provenance | **Working** |
| Native share sheet (`navigator.share`), copy link, QR code | **Working** |
| Medication assistant — deterministic label-excerpt search | **Working, no credential needed** |
| Medication assistant — conversational answers | **Awaiting `ANTHROPIC_API_KEY`** (code complete, tested with a stub adapter) |
| Crisis / overdose / emergency routing | **Working** |
| Provider connection via verified public destinations | **Working** |
| Provider referral *submission* | **Not implemented** — no authorised integration; no personal data is collected |
| Follow-up questions (conversation-aware retrieval) | **Working** |
| Unresolved question preserved across the provider handoff | **Working** |
| Insurance coverage input + result states | **Working** |
| Insurance coverage — real CMS Part D formulary evidence | **Integration complete; awaiting data ingest** (`npm run coverage:ingest`) |
| Insurance coverage against a member-specific payer API | **Not implemented** — no credential exists |

Nothing in this app fabricates a medical answer, a coverage result, or a
provider connection. Where something cannot be verified, it says so.

---

## Quick start

```bash
npm install
```

```bash
npm run dev
```

Then open <http://localhost:3000>. The root path redirects to the featured
medication.

### All commands

| Command | What it does |
|---|---|
| `npm run dev` | Development server on port 3000 |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint over `src`, `tests`, `scripts` |
| `npm test` | Vitest, single run |
| `npm run test:watch` | Vitest in watch mode |
| `npm run verify` | typecheck → lint → test → build |
| `npm run content:fetch` | Re-fetch the FDA label and rewrite the provenance-stamped source record |
| `npm run content:verify` | Check the stored label is still the current SPL version |
| `npm run coverage:ingest` | Download CMS Part D formulary data and write the plan-specific snapshot |
| `npm run coverage:ingest -- --dry-run` | Resolve the current CMS release without downloading (~2.2 GB) |

### Configuration

Copy `.env.example` to `.env.local`. **Every variable is optional** — the app
runs with none of them set and is explicit in the UI about what is not
connected.

The one you will want before demoing on a phone:

```bash
PUBLIC_ORIGIN=https://your-deployment-hostname.example
```

Without it, share links and QR codes point at `localhost` and will not open on
another device. The page shows an operator warning when this is unset.

---

## The medication

The vertical slice covers **SINGULAIR (montelukast sodium) 10 mg film-coated
tablet**, NDC `78206-172`, NDA `020829`, labeled by Organon LLC.

It was chosen for a public-awareness brief because it carries an FDA **boxed
warning about serious neuropsychiatric events** — including suicidal thoughts
and behaviour — that many people taking it do not know about. The label itself
instructs prescribers to *reserve* the drug for allergic rhinitis patients who
have not responded to alternatives, which fits a product that must not push
anyone toward requesting a medication.

Content is scoped to **one strength and one dosage form**. The underlying FDA
label also covers 4 mg and 5 mg chewable tablets and 4 mg oral granules; the app
says so prominently and refuses to generalise across them.

See [docs/PROVENANCE.md](docs/PROVENANCE.md) for the full source record.

---

## Architecture

Next.js 15 (App Router) + TypeScript, with plain CSS design tokens instead of a
utility framework. Zod at every trust boundary. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the reasoning.

Non-routing code is grouped by who it serves, not by technical layer:

```
src/
  app/                             Next.js routes only (must stay here for the router)
    medications/[slug]/page.tsx   public, statically generated medication page
    api/chat/                     assistant (rate-limited, no-store)
    api/coverage/                 coverage lookup (rate-limited, no-store)
    api/qr/[slug]/                QR code for the public URL
    api/analytics/                sanitising analytics sink

  patient/                         the patient-facing page and its dashboard
    components/                   MedicationSection, ChatSheet, CoverageSheet,
                                   ActionBar, PageOpenBeacon, the shared Sheet dialog
    lib/
      chat/                       orchestrator, grounding, model provider adapters
      coverage/                   evidence states + CMS formulary adapters
      safety/                     crisis + urgent-situation routing

  doctor/                         the clinician side and the handoff/sending mechanism
    components/                   ProviderSheet, ShareSection
    lib/
      handoff/                    carries the patient's unresolved question into the provider step
      providers/                  verified provider destinations
      share/                      share URL construction

  sources/                        everything the app's claims are sourced from
    components/                   ProvenancePanel
    content/
      sources/*.json              fetched FDA label + provenance (generated)
      medications/*.ts            authored plain-language layer w/ citations
    lib/
      content/                    schemas, registry, citation verification
      retrieval/                  BM25 passage search over label sections

  shared/                         cross-cutting infrastructure used by more than one area above
    lib/
      analytics/                 allow-listed event sanitisation
      security/                  rate limiting
      config.ts                  integration-state flags (what's actually connected)
```

`analytics`, `security` and `config` are used by patient, doctor *and* sources
code alike (e.g. every sheet calls `track()`), so they live in `shared` rather
than being forced into one of the three domain folders.

### The evidence model

Retrieval is the truth layer. The model, when configured, is an *optional
explainer* over retrieved passages — never the source of facts.

1. Label text is fetched from openFDA and DailyMed and stored with the SPL set
   id, version, effective date and retrieval timestamp.
2. The authored plain-language layer cites that text by exact quote. A test
   asserts every quote is a literal substring of the retrieved source, so a
   drifting quote fails the build.
3. At query time, BM25 retrieves passages with stable ids
   (`adverse_reactions#0`).
4. The model may cite only those ids. Any id it invents — or any real id that
   was not supplied for *this* question — is rejected.
5. An answer whose every citation was fabricated is **withheld**, and the label
   text is shown instead.

---

## Testing

```bash
npm test
```

194 tests across 10 files, all passing:

| File | Tests | Covers |
|---|---:|---|
| `content.test.ts` | 16 | citation quotes exist verbatim in source; product identity pinned; no fabricated clinical review |
| `retrieval.test.ts` | 20 | query→section routing; empty results for out-of-scope questions; bounded chunks |
| `chat.test.ts` | 23 | fabricated citations withheld; model failures honest; prompt injection; urgent precedence |
| `safety.test.ts` | 27 | crisis vs. informational distinction; overdose; anaphylaxis |
| `coverage.test.ts` | 23 | timeout/error never becomes positive; no fabricated copay; "not listed" ≠ "not covered" |
| `privacy.test.ts` | 18 | analytics allow-listing; rate limiting; verified provider destinations |
| `share.test.ts` | 8 | no private data in share URLs; slug rejection |
| `handoff.test.ts` | 18 | the unresolved question survives the handoff; crisis turns never do; stays local |
| `followup.test.ts` | 19 | elliptical follow-ups resolved from context; pronouns with no antecedent ask instead of guessing |
| `formulary.test.ts` | 16 | CMS formulary never becomes member coverage or a cost estimate; unmatched plan ≠ not covered |

---

## Deployment

**This app has not been deployed.** There is no public URL. To deploy:

1. Set `PUBLIC_ORIGIN` to the real https origin.
2. `npm run build`
3. Serve with `npm run start`, or deploy to any Node host that runs a Next.js
   standalone server.
4. Confirm HTTPS — `navigator.share` requires a secure context, and
   `buildShareUrl` refuses non-https origins outside localhost.
5. Re-run `npm run content:fetch` so the retrieval timestamp is current. Content
   older than 90 days renders a staleness warning.

Note that the in-process rate limiter is per-instance; a multi-instance
deployment needs a shared store. See [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

`PUBLIC_ORIGIN` is read at build time for the statically generated page, so set
it **before** running `npm run build`, and rebuild after changing it.

### Troubleshooting

**`EINVAL: invalid argument, readlink '.next/server/chunks'` during build.**
A dev server is running against the same `.next` directory. Stop it first, or
`rm -rf .next` and rebuild. This shows up readily on Windows and on
OneDrive-synced folders.

---

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — design decisions
- [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) — integration status and what each one needs
- [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) — requirement → implementation → verification → limitation
- [docs/PROVENANCE.md](docs/PROVENANCE.md) — medication source records
- [docs/LIMITATIONS.md](docs/LIMITATIONS.md) — known limitations
- [docs/DEVICE-CHECKLIST.md](docs/DEVICE-CHECKLIST.md) — physical-device tests (**none performed**)
- [docs/DEMO-SCRIPT.md](docs/DEMO-SCRIPT.md) — 90-second demo

---

## Safety

This software provides educational information. It does not diagnose, treat, or
give medical advice, and it must not be used to decide whether to start, stop or
change a medication.

In a medical emergency in the United States, call **911**. For a suspected
overdose, call Poison Help at **1-800-222-1222**. For mental-health crisis
support, call or text **988**.
