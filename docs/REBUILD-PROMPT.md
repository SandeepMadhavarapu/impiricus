# Rebuild prompt

A self-contained prompt for rebuilding this product from an empty repository.
It encodes the requirements *and* the specific traps this build hit, so a fresh
attempt does not rediscover them.

---

```text
Build a mobile-first, link-based medication education website in the current
repository. Implement, run, test, inspect and repair it until it works. Do not
stop at a plan or a mockup.

CORE JOURNEY
Someone shares an HTTPS link from their phone. The recipient opens it and
immediately sees plain-language information about one specific medication:
what it is, what it treats, potential benefits, common side effects, serious
risks, and limitations. A prominent "Learn more" button opens a
medication-scoped assistant. The assistant can offer to connect the user with
a healthcare provider. The user can check insurance coverage for a specific
strength, form, quantity and days' supply. The page can be re-shared without
leaking conversation or coverage data.

No app install, no account, no marketing splash. Optimise for understanding and
a clear next step, NOT for pressuring anyone into requesting a drug.

NON-NEGOTIABLE: A polished interface with fabricated medical answers, fake
coverage results, or nonexistent provider connections is a FAILED build. Where
something cannot be verified, say so.

STACK
Next.js 15 App Router + TypeScript. Server-side API routes so credentials never
reach the client. Plain CSS with design tokens in a single globals.css — do NOT
add Tailwind; a single mobile surface does not need it and it adds build-config
risk. Zod at every trust boundary. Vitest. No database, no queue, no state
library.

ARCHITECTURE — THE MOST IMPORTANT DECISION
Retrieval is the truth layer. The model is an OPTIONAL EXPLAINER over retrieved
passages, never the source of facts. Build in this order:

1. A fetch script pulls FDA label text from openFDA AND DailyMed, and writes a
   provenance-stamped JSON record: SPL set id, version, effective date,
   DailyMed published date, retrieval timestamp, source URLs, product NDC and
   application number. Record "retrievedAt" and a SEPARATE, null-by-default
   "clinicallyReviewedAt" — never conflate them.
   Guard: refuse to write the record if openFDA and DailyMed disagree on the
   SPL version, or if the NDC application number is not the expected one.

2. An authored plain-language layer cites that text by EXACT QUOTE. Write a
   test asserting every quote is a literal substring of the retrieved source
   (whitespace- and case-insensitive). A drifting quote must fail the build.

3. BM25 retrieval over label sections, chunked into passages with stable ids
   like "adverse_reactions#0". Deterministic, no embeddings, no network.

4. The model may cite ONLY ids retrieved for THAT question. Reject invented
   ids. Also reject real ids that were not supplied for this question — the
   model could not have read them. If EVERY citation is fabricated, withhold
   the answer and show label text instead. Test all of this with an injected
   stub adapter so it works with no API key.

5. With no model key, ship a deterministic "label excerpt search" mode that
   shows verbatim label text badged "Label text · not AI". This must never be
   presented as AI output.

MEDICATION SCOPE
Pick ONE medication with a real FDA label and build it completely. Prefer one
with a boxed warning — public-awareness value and it exercises risk
presentation. Scope content to ONE strength and ONE dosage form; if the SPL
covers others, say so prominently and refuse to generalise. Never invent
effectiveness percentages or side-effect frequencies. Preserve the label's own
qualifications ("not well understood", "cannot be directly compared"). Never
recommend starting, stopping or changing a medication.

SHARING
Public route /medications/[slug]. Use navigator.share called DIRECTLY from the
user gesture with no await before it. Provide copy-link and a server-rendered
QR code. Feature-detect and fall back.
- Resolving navigator.share means the sheet closed. NOTHING MORE. Never say
  "Delivered" or "Recipient opened".
- Cancellation (AbortError) is a normal outcome, not an error.
- AirDrop/Quick Share are OS capabilities offered through the system sheet. The
  site cannot select, force, or observe them. No Bluetooth, no fake device
  discovery, no simulated transfer progress.
- Share URLs carry the bare public path: no query string, no hash, no
  identifiers. Build them from a VALIDATED configured origin, never from a
  request Host header.

SAFETY — TIERED, THIS MATTERS
Assess urgency BEFORE retrieval and before any model call.
- Crisis (first-person suicidal statements, reported overdose) and urgent
  symptoms (anaphylaxis, severe breathing trouble) get help resources
  immediately. No provider form, no coverage check, no conversation in the way.
- BUT informational questions about the same risk ("can this cause suicidal
  thoughts?") must be ANSWERED from the label, with crisis resources shown
  alongside rather than instead. Intercepting those defeats the point of a
  public-awareness tool. Test both directions explicitly.

PROVIDER CONNECTION
Ask WHO they want first: their own clinician, a pharmacist, a new provider, or
telehealth. Offer the strongest REAL route. Use only verifiable public
destinations and actually fetch each URL to confirm it resolves; record the
check date. If no booking integration exists, say "Not available" — do not
fake it. If showing directories, state plainly that a listing does not mean
accepting new patients, in-network, or currently licensed. Do not collect
personal information into an unconfigured prototype; a "questions to bring"
list should stay local and be explicitly described as never transmitted.

INSURANCE COVERAGE
Model four DISTINCT evidence levels: general formulary info, member
eligibility, patient-specific cost estimate, final claim adjudication. Provide
NO state called "covered". Use: member-benefit-response, formulary-listed,
restrictions-indicated, not-listed-on-checked-formulary, unable-to-verify.
- "Not listed" is NOT "not covered".
- A missing credential, timeout, crash, unmatched plan or stale source must
  NEVER become a positive result. Test with deliberately throwing and hanging
  adapters.
- A null cost must render "Not available", never "$0.00". A real zero renders
  "$0.00". Test both.
- Do not require a member ID, date of birth, or card upload for a formulary
  question.
- Any sample data must be opt-in, banner-labelled, and never a fallback.
- Refuse to answer for a strength/form that is not this page's product.

SECURITY AND PRIVACY
Secrets server-side. Zod validation, rate limiting, timeouts and bounded
retries on every POST route. no-store on chat and coverage; the public page is
cacheable. Sanitise rendered output — no dangerouslySetInnerHTML. Never log raw
medical conversations. Chat is ephemeral. Analytics: allow-list event names AND
properties; drop anything unrecognised; NEVER record the medication slug (it
links a person to a drug). No event may be named *_delivered, *_received, or
appointment_booked — assert this in a test.

ACCESSIBILITY AND UX
Accessible dialog: role=dialog, aria-modal, labelled, focus trap both
directions, Escape to close, focus restored to the trigger, background scroll
locked. Size sheets in dvh so the mobile keyboard does not break them. 16px
inputs to stop iOS zoom. 44px touch targets. prefers-reduced-motion. Visible
focus rings. Verify no horizontal overflow at 375px AND at desktop width.

KNOWN TRAPS — DO NOT REDISCOVER THESE
1. A strict CSP without 'unsafe-eval' breaks Next.js DEV-mode hydration: every
   button silently does nothing. Add 'unsafe-eval' in development ONLY. Compute
   the isDev flag INSIDE the headers() function — Next compiles next.config.ts
   into a separate scope and a module-level const will be undefined there.
2. In .gitignore, anchor build patterns: "/coverage/" not "coverage/". An
   unanchored pattern silently excludes src/app/api/coverage/ and
   src/patient/lib/coverage/ from the repo.
3. "server-only" throws under Vitest. Alias it to a stub in vitest.config.ts.
4. Running `next build` while a dev server holds .next causes
   "EINVAL readlink .next/server/chunks". Stop the dev server first.
5. openFDA strengths look like "MONTELUKAST SODIUM 10 mg/1". Parse out the dose
   with a regex; do not strip the first word.
6. A query-intent boost keyed on a weak fragment like "what is" will manufacture
   citations for unrelated questions ("What is the capital of France?"). Make
   intent patterns specific, weight boosts per-section, and return NO results
   when there is neither lexical overlap nor genuine topical intent.
7. Chunking must hard-split text with no sentence punctuation, or one passage
   grows unbounded.
8. Wait for hydration before clicking in browser automation; the dev server
   compiles on first request.

VERIFICATION — REQUIRED
Write tests that target real failure risks, not happy paths: wrong
medication/strength/form match; unsupported clinical answers; citations absent
from retrieved evidence; prompt injection via source text and user input;
source outage; missing model credential; coverage timeout; wrong plan year;
formulary listing mistaken for member coverage; missing copay shown as zero;
failed request shown as success; private data in URLs or logs; share
unsupported/cancelled/fallback; unknown medication route.

Run typecheck, lint, tests and a production build. Fix failures and report
ACTUAL results. Then drive the running app in a browser: check narrow and wide
viewports, keyboard navigation, focus management, and confirm the production
build hydrates under the strict CSP with no console errors. Exercise the API
endpoints directly for validation rejections, cache headers and rate limiting.

DELIVERABLES
Working code. README with exact install/dev/build/test/deploy commands.
.env.example with placeholders only. Medication provenance records.
Integration status table. Acceptance matrix
(Requirement | Implementation | Verification | Remaining limitation).
Test results. Known limitations. Architecture explanation. Physical-device
checklist — mark every unperformed check "Not tested"; browser automation does
NOT prove AirDrop or Quick Share work. A 90-second demo script.

FINAL REPORT — distinguish clearly:
  implemented and verified / implemented but awaiting credentials /
  requires real-device testing / not implemented.
State whether deployment actually occurred. Do not invent a public URL.
Never claim "production ready" or "fully integrated" without evidence.

WORKING RULES
Inspect the repo first. State assumptions rather than inventing sponsor
requirements. Make reversible decisions autonomously; ask only when genuinely
blocked. Give short progress updates naming what works, what is uncertain, and
what you will verify next. If a credential is missing, finish all independent
work and the real integration boundary, then name the single remaining
configuration step. Never hide a dependency.
```
