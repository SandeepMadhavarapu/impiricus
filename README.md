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

### Doctor → patient demo

Open `/doctor` for the **DocUpdate Integration Preview**. Select Singulair
10 mg film-coated tablet, preview the existing patient content and citations,
then choose **Share with Patient** or **Copy Link**. The recipient opens the
existing `/medications/singulair-montelukast-10mg-tablet` experience.

This is an independent preview, with no DocUpdate or Impiricus integration or
endorsement. No account, patient record, or prescription is created. Only the
bare public medication URL is shared. Native sharing uses the device's options;
cancellation is normal and no delivery confirmation is claimed.

Doctor-side sharing is disabled until `PUBLIC_ORIGIN` is a public HTTPS origin.
Deploy the app and configure that origin before building for an off-device demo.
The selector and preview work locally without it. The root route and existing
patient workflows are unchanged.

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

216 tests across 13 files, all passing:

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
| `followup.test.ts` | 23 | elliptical follow-ups resolved from context; pronouns with no antecedent ask instead of guessing |
| `formulary.test.ts` | 18 | CMS formulary never becomes member coverage or a cost estimate; unmatched plan ≠ not covered |
| `doctor.test.ts` | 10 | selection, unchanged preview content, provenance, invalid products, public HTTPS sharing configuration |
| `share-component.test.ts` | 8 | direct native-share invocation, cancellation, clipboard/manual fallback, public-only payload, patient behavior |
| `config.test.ts` | 4 | `APP_MODE` defaults to patient; only an explicit, case-insensitive "doctor" switches it |

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

### Two Vercel domains: patient link vs. doctor demo

This is one codebase with two audiences that are meant to live at two
different URLs: the real link a patient opens (which must land on the
medication page, not a marketing splash or a workspace UI) and a separate demo
URL for showing the `/doctor` workspace on its own. Both routes are always
reachable directly on either domain — `APP_MODE` only decides what the bare
domain ("/") redirects to.

Set this up as **two separate Vercel projects** pointing at the same GitHub
repo:

| | Project A — patient | Project B — doctor demo |
|---|---|---|
| `APP_MODE` | unset (or `patient`) | `doctor` |
| `PUBLIC_ORIGIN` | the patient project's own domain | the doctor project's own domain |
| `/` redirects to | `/medications/<slug>` | `/doctor` |
| Purpose | the link you actually share with patients | a demo URL for showing doctors/DocUpdate the workspace |

Steps, once per project:

1. In Vercel, **Add New → Project**, import this repo.
2. Under **Settings → Environment Variables**, set `APP_MODE` (`doctor` for
   the doctor-demo project, leave unset for the patient project) and
   `PUBLIC_ORIGIN` to that project's own domain — every project needs its own
   value here, since it's used to build absolute share URLs and QR codes for
   *that* domain specifically.
3. Deploy. Vercel builds `/` as a static redirect, so `APP_MODE` must be set
   **before** the build runs (project env vars, not a `.env` file) — the two
   projects will end up with different static redirects from the same source.
4. Attach whatever custom domain/subdomain you want to each project under
   **Settings → Domains**.

Because `/doctor` is reachable on the patient domain too (and vice versa),
nothing needs duplicating in code to keep both projects in sync — redeploying
either one from the same `main` branch picks up the same routes and content.

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

### Nearby Sound Sharing — Experimental

Doctors can send a temporary opaque code using **Send Nearby / Send with sound**.
The patient opens `/receive` and explicitly presses **Listen for guide** before
microphone permission is requested. Audio is processed locally and is never recorded
or uploaded. Only the decoded token is submitted to the server. Native share,
AirDrop, Messages, Copy Link, and the existing QR code remain available.

See [the nearby sharing demo guide](docs/NEARBY-SHARING.md) for setup, manual token
testing, physical-device steps, protocol details, and known limitations.
