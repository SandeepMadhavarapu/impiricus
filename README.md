# MediZ

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
| Insurer and plan pickers | **Working**, on 5,517 verified plan identities from 525 insurers. A plan name is never treated as an identity: a name matching several plans equally is refused, not guessed |
| Coverage answers are about the product asked for | **Working**: strength and dosage form are compared structurally against the product before any lookup runs, so a mismatched request is refused rather than answered with the real product's tier |
| Pharmacy-by-ZIP search | **Working**, live against the CMS NPPES registry. Filtered to practice addresses actually in the searched ZIP |
| Find a clinician near a ZIP | **Working**, live against CMS NPPES: name, credential, specialty, practice address and a phone number that dials. A register, never a recommendation or a referral |
| Medication search | **Working**, live across all **262,883** FDA drug labels, with boxed-warning status per label |
| Medications with a full patient guide | **3**: all share the same patient layout, question/chat panel, coverage and provider actions; missing patient summaries use explicit placeholders |
| Read the summary aloud | **Working**, in English, Spanish and French. Translations are machine-produced, unreviewed, labelled as such, and shown as well as spoken |
| Automatic source refresh (openFDA, DailyMed, RxNorm, CMS Part D, VA Medicaid) | **Working**: `pipeline-refresh` runs daily at 07:15 UTC, regenerates when a source changed or aged out, validates pipeline + app + build, and opens a review PR. Never merges on its own. `OPENFDA_API_KEY` is set as a repo secret; the run works without it at a lower rate limit |
| Application checks in CI | **Working**: `app-tests` runs typecheck, lint, tests and the production build on every push and PR that touches the app |
| Fair balance enforced in CI | **Working**, see below |

Nothing in this app fabricates a medical answer, a coverage result, or a
provider connection. Where something cannot be verified, it says so.

### Where the data comes from

Every source is public, federal, and free. No key, no licence, no scraping, and
no vendor. Nothing below is seeded, sampled or hand-written.

| Source | Publisher | What it gives | How much |
|---|---|---|---|
| openFDA drug labels | FDA | Label text, identity, boxed-warning status | 262,883 labels |
| DailyMed | NLM | The authoritative full label | per product |
| RxNorm / RxNav | NLM | Concept identity — brand (SBD) vs generic (SCD) | per product |
| CMS Part D formulary | CMS | Tier, prior authorisation, step therapy, quantity limits | 5,517 plans, 525 insurers |
| CMS NPPES NPI Registry | CMS | Registered pharmacies and clinicians, with addresses and phone numbers | national |

Three of these are queried **live, per request** (label search, pharmacies,
clinicians). The rest are ingested by [data-pipeline/](data-pipeline/) into a
committed, verified snapshot, because coverage answers must be reproducible and
must not depend on a third party being up.

**The registries have sharp edges, and each one is handled rather than passed
through.** These are measured, not assumed:

- NPPES matches a ZIP against the **mailing** address as well as the practice
  location. One in seven pharmacy rows, and **one in three physician rows**,
  come back with a practice somewhere else — a Blacksburg search returned a
  practice two hours away. Everything is filtered on the practice address.
- openFDA answers "nothing matched" with **HTTP 404**, not an empty list. Read
  as an error, every search for a drug that does not exist would say the search
  is broken instead of "check the spelling".
- One SPL can cover **several products**. The semaglutide label lists both
  OZEMPIC and RYBELSUS — an injection and a tablet — so every brand a label
  covers is shown rather than the first one.
- A bad NPPES query returns **HTTP 200 with an `Errors` array**. Treated as an
  empty result, it would tell someone there is nobody near them when nothing
  was ever searched.

In every one of these, "we could not check" and "there is nothing there" are
kept as different answers, because to the person reading they mean opposite
things.

### What is deliberately not here

No commercial or Medicaid formulary data. CMS publishes only an index of issuer
URLs for Marketplace plans; the formularies themselves are insurer-hosted and
inconsistent, Transparency-in-Coverage files are terabyte-scale, and Medicaid
has no unified public API. The coverage answer names the dataset it checked and
says what it does not cover, rather than implying a completeness it lacks.

### One patient interface, two content sources

All three medications use the Singulair patient layout, including the full
conversation panel, follow-up questions, expandable sources, coverage, provider
handoff and sharing. The doctor preview uses the same section model. Missing
patient summaries retain their cards and dropdowns with “Will be updated when
more information is available.” Content differs by what is actually available:

| | `authored` | `official-label` |
|---|---|---|
| Who wrote it | A person, in plain language | Available warning text from the FDA label, verbatim; other summaries pending |
| Every claim cited | Yes, to an exact quote | It IS the source |
| Dosing shown | Yes, authored and cited | **No**, see below |
| Key points, headline | Authored | Safety cue and placeholder |
| Today | Singulair | Toprol XL, Ozempic |

There is deliberately **no third path** where the app generates plain language
from a label. Writing patient-facing medical prose from a source document is
the one thing this codebase exists to not do, and a model doing it quietly
would be indistinguishable, to a reader, from a clinician having written it.
Authoring a layer later upgrades a product automatically.

Chat retrieves from each medication’s own verified source record. Without a
model credential it shows label excerpts, explicitly marked as not AI; the first
excerpt is expanded. Toprol XL and Ozempic dosing/device questions use the
pending-information message until exact-product instructions are available.
Refresh a source with `npm run content:fetch -- <medication-slug>`; fetched
text is validated against product NDC, SPL set ID and DailyMed version.

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

## The medications

Three products carry a full patient guide. Every other FDA-labelled drug is
reachable through search, which returns identity and boxed-warning status and
links to the official label — and says plainly that no patient guide exists for
it. The two are never presented as the same thing.

| Product | Guide | Why it is here |
|---|---|---|
| **Singulair** (montelukast sodium) 10 mg film-coated tablet | authored, plain language, cited | the worked example below |
| **Toprol XL** (metoprolol succinate) 50 mg extended-release tablet | label text, verbatim | a product whose SPL carries **no** boxed warning, proving the app never claims an absent one |
| **Ozempic** (semaglutide) 1.34 mg/mL injection | label text, verbatim | a concentration rather than a dose, which is what the strength comparison exists to keep separate |

### The worked example

**SINGULAIR (montelukast sodium) 10 mg film-coated tablet**, NDC `78206-172`,
NDA `020829`, labeled by Organon LLC.

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
    api/directory/                insurer / plan / pharmacy / clinician lookups
    api/drug-search/              FDA label search (rate-limited, no-store)
    api/share-sessions/           encrypted nearby-share tokens
    api/guide-sounds/             stateless guide codes for sound transfer

  patient/                         the patient-facing page and its dashboard
    components/                   MedicationSection, ChatSheet, CoverageSheet,
                                   ActionBar, ReadAloud, PageOpenBeacon,
                                   the shared Sheet dialog
    lib/
      chat/                       orchestrator, passage selection, provider adapters
      coverage/                   evidence states, CMS formulary adapters, the
                                   payer/plan directory, NPPES pharmacy lookup
      safety/                     crisis + urgent-situation routing

  doctor/                         the clinician side and the handoff/sending mechanism
    components/                   ProviderSheet, ShareSection, AppChrome (tab bar),
                                   NearbyClinicians, DrugSearch
    lib/
      handoff/                    carries the patient's unresolved question into the provider step
      providers/                  verified destinations + NPPES clinician lookup
      share/                      share URL construction

  sources/                        everything the app's claims are sourced from
    components/                   ProvenancePanel
    content/
      sources/*.json              fetched FDA label + provenance (generated)
      medications/*.ts            authored plain-language layer w/ citations
    content/
      translations/               spoken-summary translations, with provenance
    lib/
      content/                    schemas, registry, citation verification,
                                   fair-balance checks, structured strength
                                   comparison, locales, FDA label search
      retrieval/                  BM25 passage search over label sections

  shared/                         cross-cutting infrastructure used by more than one area above
    components/                   AppBar, shared by both audiences
    lib/
      analytics/                 allow-listed event sanitisation
      security/                  rate limiting
      nppes/                     shared CMS registry client (pharmacies + clinicians)
      nearby-share/              encrypted tokens and stateless guide codes
      config.ts                  integration-state flags (what's actually connected)
```

`analytics`, `security` and `config` are used by patient, doctor *and* sources
code alike (e.g. every sheet calls `track()`), so they live in `shared` rather
than being forced into one of the three domain folders.

### The evidence model

Retrieval is the truth layer. **The model does not write medical text at all.**
It selects passages; the server supplies the words.

1. Label text is fetched from openFDA and DailyMed and stored with the SPL set
   id, version, effective date and retrieval timestamp.
2. The authored plain-language layer cites that text by exact quote. A test
   asserts every quote is a literal substring of the retrieved source, so a
   drifting quote fails the build.
3. At query time, BM25 retrieves passages carrying composite ids
   (`recordId@vVersion#passageId`), which cannot collide across products or
   label versions.
4. The model returns **identifiers only**, validated by a `.strict()` schema, so
   an adapter that starts volunteering an `answer` field fails validation rather
   than having it quietly rendered.
5. The server resolves those ids against the passages it built and renders **its
   own stored text**. There is nothing to verify after the fact, because nothing
   was authored: the words a reader sees came from the label.

An id the model invents invalidates the whole selection rather than being
dropped, because a model that fabricated one of six has shown it is guessing and
the other five carry no more warrant. `insufficient-evidence` stays reachable and
is not a failure state.

This replaced an earlier design that let the model write prose and checked the
citations afterwards. That had a hole no amount of tightening could close: prose
carrying **no** citation markers produced empty `citations` *and* empty
`rejected`, satisfying neither branch of the withholding rule, so unsourced model
text about a medicine shipped as an answer.

When the model is unavailable or returns something unusable, retrieval still
works and the page **says which mode produced the answer** — degradation is
disclosed to the reader, not silent.

---

## Testing

```bash
npm test
```

**637 tests across 33 files** in the app, plus **327 across 14 files** in the
data pipeline. All passing.

The table below is not exhaustive; it names what each file is *for*, since the
point of most of them is a property rather than a function.

| File | Tests | Covers |
|---|---:|---|
| `content.test.ts` | 16 | citation quotes exist verbatim in source; product identity pinned; no fabricated clinical review |
| `retrieval.test.ts` | 20 | query→section routing; empty results for out-of-scope questions; bounded chunks |
| `chat.test.ts` | 23 | model failures honest; prompt injection; urgent precedence |
| `evidence-selection.test.ts` | 35 | the model returns ids only; an invented id voids the whole selection; refusal wording is server-owned |
| `safety.test.ts` | 27 | crisis vs. informational distinction; overdose; anaphylaxis |
| `coverage.test.ts` | 23 | timeout/error never becomes positive; no fabricated copay; "not listed" ≠ "not covered" |
| `coverage-request-identity.test.ts` | 37 | strength parsed structurally, never string-matched; a dose is never equal to a concentration; a typed plan name matching several plans is refused |
| `formulary.test.ts` | 40 | CMS formulary never becomes member coverage or a cost estimate; unmatched plan ≠ not covered |
| `coverage-snapshot.test.ts` | 14 | the committed snapshot agrees with the pipeline on every demo scenario |
| `directory.test.ts` | 13 | a plan name yields candidates not an identity; plan keys unique where names are not |
| `pharmacy-lookup.test.ts` | 29 | rows outside the searched ZIP dropped; a failed lookup never reads as "none near you" |
| `clinician-lookup.test.ts` | 38 | practice-address filtering; deactivated NPIs dropped; specialty allow-list; people's names cased without mangling |
| `drug-search.test.ts` | 31 | HTTP 404 means "no such drug", not a broken search; every brand on a multi-brand label kept; catalogued products never lost |
| `read-aloud.test.ts` | 22 | long text split so a boxed warning at the end is still spoken; a cancel is not an error |
| `read-aloud-locales.test.ts` | 20 | a translation cannot outlive the English it came from; nothing claims a clinical review that did not happen |
| `locale-sharing.test.ts` | 34 | the page locales are not widened by a translated paragraph; share links carry no locale or personal data |
| `privacy.test.ts` | 18 | analytics allow-listing; rate limiting; verified provider destinations |
| `share.test.ts` / `share-component.test.ts` | 9 / 8 | no private data in share URLs; native share, cancellation, clipboard fallback |
| `handoff.test.ts` | 14 | the unresolved question survives the handoff verbatim; crisis turns never do |
| `followup.test.ts` | 23 | elliptical follow-ups resolved from context; pronouns with no antecedent ask instead of guessing |
| `doctor.test.ts` | 18 | step order; preview complete and verbatim; boxed warning first and flagged |
| `label-guide.test.ts` | 28 | label-sourced pages show no dosing and never claim an absent boxed warning |
| `fair-balance.test.ts` | 6 | no promotional wording; boxed warning named in a key point, ordered before benefits |
| `deployment-mode.test.ts` | 10 | the clinician workspace is not served on the patient deployment |
| `nfc.test.ts` | 31 | NDEF encoding; firmware read-back required before success is claimed |
| `nearby-*.test.ts` | 35 | sound protocol, encrypted tokens, replay properties |
| `medication-parity.test.ts` | 11 | every catalogued product gets the same interface |
| `config.test.ts` | 4 | `APP_MODE` defaults to patient |

A recurring shape across these files: the thing being asserted is usually that
the app **refuses** to say something. "We could not check" and "there is nothing
there" are tested as distinct outcomes in every lookup that has both.

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

Doctors press **Send Nearby** to prepare a public guide code, then **Play sound**
to transmit it in **1.95 seconds**. Direct media playback supports iPhone Safari without relying on
Web Audio’s silent-mode behavior.
Patients can choose **Receive guide with sound** on any medication page or in
the provider chooser. **My own doctor or prescriber** also includes the listener
directly, below the disabled account controls; receiving does not require sign-in.
The standalone `/receive` page remains available. The patient explicitly presses **Listen for guide** before
microphone permission is requested. Audio is processed locally and is never recorded
or uploaded. Only the decoded guide code is submitted to the server. The code is replayable,
identifies a public medication guide, and is not authentication. Native share,
AirDrop, Messages, Copy Link, and the existing QR code remain available.

See [the nearby sharing demo guide](docs/NEARBY-SHARING.md) for setup, code
testing, physical-device steps, protocol details, and known limitations.
