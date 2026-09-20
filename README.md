# MedBridge

A mobile-first, link-based medication education experience. A clinician builds
a patient guide from the FDA-approved label and shares it; the patient opens
the link and gets plain-language information about one specific medication:
what it is, what it treats, what it might help with, and what the risks are,
with every claim traceable to the exact text it came from.

## Live demo

Two deployments of this same repo, one per audience:

| | Link | What it is |
|---|---|---|
| **Patient guide** | **<https://impiricus.vercel.app>** | The real link a patient opens. Lands on the medication guide. |
| **Clinician demo** | **<https://impiricus-nmsb.vercel.app>** | The HCP workspace, shown as it would sit inside DocUpdate's app. Lands on `/doctor`. |

Both are open to anyone with the link, and neither collects a patient record.
They run the same build and differ only by the `APP_MODE` environment
variable. See [Two Vercel domains](#two-vercel-domains-patient-link-vs-doctor-demo).

**This is an independent hackathon prototype.** It is not affiliated with,
endorsed by, or connected to Impiricus, DocUpdate, Organon, the FDA, or any
insurer. No clinician has reviewed its content.

---

## What actually works right now

| Capability | Status |
|---|---|
| Public medication page from a real FDA label, with provenance | **Working** |
| Ingestion pipeline with verified product identity | **Working**, see [data-pipeline/](data-pipeline/) |
| Native share sheet (`navigator.share`), copy link, QR code | **Working** |
| Medication assistant: deterministic label-excerpt search | **Working, no credential needed** |
| Medication assistant: conversational answers | **Awaiting `ANTHROPIC_API_KEY`** (code complete, tested with a stub adapter) |
| Crisis / overdose / emergency routing | **Working** |
| Provider connection via verified public destinations | **Working** |
| Provider referral *submission* | **Not implemented**, no authorised integration; no personal data is collected |
| Follow-up questions (conversation-aware retrieval) | **Working** |
| Unresolved question preserved across the provider handoff | **Working** |
| Insurance coverage input + result states | **Working** |
| Insurance coverage: real CMS Part D formulary evidence | **Working**, on the committed 2026-08 CMS snapshot: 979 formulary rows for the three products across 5,517 plans. Resolves the exact plan by key, searches the product's own brand and generic concepts, and says which one it found |
| Insurance coverage against a member-specific payer API | **Not implemented**, no credential exists |
| Insurer and plan pickers | **Working**, on 5,517 verified CMS Part D plan identities. A plan name is never treated as an identity |
| Pharmacy-by-ZIP search | **Not implemented**, no pharmacy dataset is licensed. Falls back to a pharmacy type and says so |
| Medications available | **3**: one with an authored plain-language guide, two shown as verbatim FDA label text |
| Automatic source refresh (openFDA, DailyMed, RxNorm, CMS Part D, VA Medicaid) | **Working**: `pipeline-refresh` runs daily at 07:15 UTC, regenerates when a source changed or aged out, validates pipeline + app + build, and opens a review PR. Never merges on its own. `OPENFDA_API_KEY` is set as a repo secret; the run works without it at a lower rate limit |
| Application checks in CI | **Working**: `app-tests` runs typecheck, lint, tests and the production build on every push and PR that touches the app |
| Fair balance enforced in CI | **Working**, see below |

Nothing in this app fabricates a medical answer, a coverage result, or a
provider connection. Where something cannot be verified, it says so.

### Two kinds of guide

A medication reaches the patient page one of two ways, and the page says
which:

| | `authored` | `official-label` |
|---|---|---|
| Who wrote it | A person, in plain language | The FDA label, verbatim |
| Every claim cited | Yes, to an exact quote | It IS the source |
| Dosing shown | Yes, authored and cited | **No**, see below |
| Key points, headline | Yes | No, nobody wrote them |
| Today | Singulair | Toprol XL, Ozempic |

There is deliberately **no third path** where the app generates plain language
from a label. Writing patient-facing medical prose from a source document is
the one thing this codebase exists to not do, and a model doing it quietly
would be indistinguishable, to a reader, from a clinician having written it.
Authoring a layer later upgrades a product automatically.

An `official-label` page refuses three things, each covered by a test:

- **No dosing.** One SPL routinely covers several products dosed differently,
  and most sections are not structurally bound to any one of them. The page
  shows no dose at all rather than a dose with a caveat nobody reads, and
  points at the reader's own prescription and the full label.
- **No absence claims.** Toprol XL's current SPL carries no boxed-warning
  section, while metoprolol is a class people associate with one. A boxed
  warning renders when the document has one, and the page stays silent
  otherwise: a section missing from a document is a fact about the document.
- **No claim of plain language, and none of clinical review.**

### Fair balance

The patient guide restates an FDA label. It is not promotional material, and
the properties that keep it that way fail the build rather than depending on
whoever reviews the next content change. `tests/fair-balance.test.ts` runs over
**every** registered medication, so a product added later is held to the same
rules without anyone remembering to add a test:

- No superlatives, unsupported efficacy claims, comparative marketing, or
  risk-minimisation wording. Quoted label text is exempt and never passed
  through the check, since altering a quote would break its citation.
- The headline states indications only, so it can be written neither to sell
  nor to alarm. The balancing facts sit in `keyPoints` directly beneath it.
- A product with a boxed warning must name it in a `critical` key point, and
  critical points are ordered before any benefit point.
- The patient-facing scope note is checked for readability, because it is read
  by people in a second language and by people reading while unwell.

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

### Doctor to patient demo

Open `/doctor` for the clinician workspace, styled to sit inside DocUpdate's
app. It runs in three steps: **Step 1** pick a medication, **Step 2** preview
the guide (collapsed to headings, expandable per section, with the boxed
warning first and flagged), **Step 3** share it. **Share with Patient** is the
primary action; **Copy Link** and **QR code** sit beneath it as fallbacks. The
recipient opens the same `/medications/singulair-montelukast-10mg-tablet`
guide a patient would.

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
| `npm run content:sync` | Copy the pipeline's app-ready exports, Part D plan directory, formulary snapshot and product concept identities into `src/` |
| `npm run coverage:ingest` | Retired. Prints the current path (`data-pipeline` → `insurance:ingest` → `app:snapshot`, then `content:sync`) and exits |

### Configuration

Copy `.env.example` to `.env.local`. **Every variable is optional**. The app
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
warning about serious neuropsychiatric events**, including suicidal thoughts
and behaviour, that many people taking it do not know about. The label itself
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
    api/directory/                insurer / plan / pharmacy-by-ZIP lookups

  patient/                         the patient-facing page and its dashboard
    components/                   MedicationSection, ChatSheet, CoverageSheet,
                                   ActionBar, PageOpenBeacon, the shared Sheet dialog
    lib/
      chat/                       orchestrator, grounding, model provider adapters
      coverage/                   evidence states, CMS formulary adapters,
                                   and the payer/plan/pharmacy directory
      safety/                     crisis + urgent-situation routing

  doctor/                         the clinician side and the handoff/sending mechanism
    components/                   ProviderSheet, ShareSection, AppChrome (tab bar)
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
      content/                    schemas, registry, citation verification,
                                   fair-balance checks
      retrieval/                  BM25 passage search over label sections

  shared/                         cross-cutting infrastructure used by more than one area above
    components/                   AppBar, shared by both audiences
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
explainer* over retrieved passages, never the source of facts.

1. Label text is fetched from openFDA and DailyMed and stored with the SPL set
   id, version, effective date and retrieval timestamp.
2. The authored plain-language layer cites that text by exact quote. A test
   asserts every quote is a literal substring of the retrieved source, so a
   drifting quote fails the build.
3. At query time, BM25 retrieves passages with stable ids
   (`adverse_reactions#0`).
4. The model may cite only those ids. Any id it invents, or any real id that
   was not supplied for *this* question, is rejected.
5. An answer whose every citation was fabricated is **withheld**, and the label
   text is shown instead.

---

## Testing

```bash
npm test
```

264 tests across 16 files, all passing:

| File | Tests | Covers |
|---|---:|---|
| `content.test.ts` | 16 | citation quotes exist verbatim in source; product identity pinned; no fabricated clinical review |
| `retrieval.test.ts` | 20 | query→section routing; empty results for out-of-scope questions; bounded chunks |
| `chat.test.ts` | 23 | fabricated citations withheld; model failures honest; prompt injection; urgent precedence |
| `safety.test.ts` | 27 | crisis vs. informational distinction; overdose; anaphylaxis |
| `coverage.test.ts` | 23 | timeout/error never becomes positive; no fabricated copay; "not listed" ≠ "not covered" |
| `privacy.test.ts` | 18 | analytics allow-listing; rate limiting; verified provider destinations |
| `share.test.ts` | 8 | no private data in share URLs; slug rejection |
| `handoff.test.ts` | 14 | the unresolved question survives the handoff verbatim; crisis turns never do; stays local |
| `followup.test.ts` | 23 | elliptical follow-ups resolved from context; pronouns with no antecedent ask instead of guessing |
| `formulary.test.ts` | 18 | CMS formulary never becomes member coverage or a cost estimate; unmatched plan ≠ not covered |
| `doctor.test.ts` | 14 | step order; preview is complete and verbatim; boxed warning first and flagged; invalid products; public HTTPS sharing configuration |
| `share-component.test.ts` | 8 | direct native-share invocation, cancellation, clipboard/manual fallback, public-only payload, patient behavior |
| `config.test.ts` | 4 | `APP_MODE` defaults to patient; only an explicit, case-insensitive "doctor" switches it |
| `fair-balance.test.ts` | 6 | no promotional or comparative wording; headline carries no risk claim; boxed warning named in a key point, ordered before benefits; patient scope note stays readable |
| `label-guide.test.ts` | 28 | label-sourced pages show no dosing, never claim an absent boxed warning, never claim plain language or clinical review; the authored page is unchanged |
| `directory.test.ts` | 13 | a plan name yields candidates not an identity; plan keys are unique where names are not; pharmacies stay empty rather than invented |

---

## Deployment

Deployed to two Vercel projects, both from `main`:

- Patient guide: <https://impiricus.vercel.app>
- Clinician demo: <https://impiricus-nmsb.vercel.app>

To deploy your own:

1. Set `PUBLIC_ORIGIN` to the real https origin.
2. `npm run build`
3. Serve with `npm run start`, or deploy to any Node host that runs a Next.js
   standalone server.
4. Confirm HTTPS. `navigator.share` requires a secure context, and
   `buildShareUrl` refuses non-https origins outside localhost.
5. Re-run `npm run content:fetch` so the retrieval timestamp is current. Content
   older than 90 days renders a staleness warning.

**Shipping a change to the live sites:** `vercel redeploy` rebuilds a previous
deployment's source snapshot and will NOT pick up new commits. It only helps
for environment-variable changes. To ship code, run `vercel link --yes
--project <name>` then `vercel deploy --prod --yes`, once per project. When
checking that a deploy landed, grep the served HTML for markup that exists
only in the new version; a string present in both versions passes either way.

Note that the in-process rate limiter is per-instance; a multi-instance
deployment needs a shared store. See [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

`PUBLIC_ORIGIN` is read at build time for the statically generated page, so set
it **before** running `npm run build`, and rebuild after changing it.

### Two Vercel domains: patient link vs. doctor demo

This is one codebase with two audiences that are meant to live at two
different URLs: the real link a patient opens (which must land on the
medication page, not a marketing splash or a workspace UI) and a separate demo
URL for showing the `/doctor` workspace on its own. Both routes are always
reachable directly on either domain. `APP_MODE` only decides what the bare
domain ("/") redirects to.

Set this up as **two separate Vercel projects** pointing at the same GitHub
repo:

| | Project A: patient | Project B: doctor demo |
|---|---|---|
| `APP_MODE` | unset (or `patient`) | `doctor` |
| `PUBLIC_ORIGIN` | the patient project's own domain | the doctor project's own domain |
| `/` redirects to | `/medications/<slug>` | `/doctor` |
| Purpose | the link you actually share with patients | a demo URL for showing doctors/DocUpdate the workspace |

Steps, once per project:

1. In Vercel, **Add New → Project**, import this repo.
2. Under **Settings → Environment Variables**, set `APP_MODE` (`doctor` for
   the doctor-demo project, leave unset for the patient project) and
   `PUBLIC_ORIGIN` to that project's own domain. Every project needs its own
   value here, since it's used to build absolute share URLs and QR codes for
   *that* domain specifically.
3. Deploy. Vercel builds `/` as a static redirect, so `APP_MODE` must be set
   **before** the build runs (project env vars, not a `.env` file), so the two
   projects will end up with different static redirects from the same source.
4. Attach whatever custom domain/subdomain you want to each project under
   **Settings → Domains**.

Because `/doctor` is reachable on the patient domain too (and vice versa),
nothing needs duplicating in code to keep both projects in sync. Redeploying
either one from the same `main` branch picks up the same routes and content.

### Troubleshooting

**`EINVAL: invalid argument, readlink '.next/server/chunks'` during build.**
A dev server is running against the same `.next` directory. Stop it first, or
`rm -rf .next` and rebuild. This shows up readily on Windows and on
OneDrive-synced folders.

---

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): design decisions
- [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md): integration status and what each one needs
- [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md): requirement to implementation to verification to limitation
- [docs/PROVENANCE.md](docs/PROVENANCE.md): medication source records
- [docs/LIMITATIONS.md](docs/LIMITATIONS.md): known limitations
- [docs/DEVICE-CHECKLIST.md](docs/DEVICE-CHECKLIST.md): physical-device tests (**none performed**)
- [docs/DEMO-SCRIPT.md](docs/DEMO-SCRIPT.md): 90-second demo

---

## Safety

This software provides educational information. It does not diagnose, treat, or
give medical advice, and it must not be used to decide whether to start, stop or
change a medication.

In a medical emergency in the United States, call **911**. For a suspected
overdose, call Poison Help at **1-800-222-1222**. For mental-health crisis
support, call or text **988**.

### NFC Tap Point — hardware proof of concept

The doctor handoff area can program the selected guide's public HTTPS URL through
Web Serial → Arduino UNO R4 WiFi → I2C → Seeed Grove ST25DV64 NDEF memory. Verified
success requires a matching firmware write/read-back response. **Read NFC Memory**
independently retrieves the stored URI. Existing sharing options remain available.
The external 13.56 MHz antenna is unavailable, so iPhone tapping is not demonstrated.
See [NFC setup, firmware, and demo steps](hardware/nfc-tap/README.md).

### Nearby Sound Sharing — Experimental

Doctors can send a temporary opaque code using **Send Nearby / Send with sound**.
The patient opens `/receive` and explicitly presses **Listen for guide** before
microphone permission is requested. Audio is processed locally and is never recorded
or uploaded. Only the decoded token is submitted to the server. Native share,
AirDrop, Messages, Copy Link, and the existing QR code remain available.

See [the nearby sharing demo guide](docs/NEARBY-SHARING.md) for setup, manual token
testing, physical-device steps, protocol details, and known limitations.
