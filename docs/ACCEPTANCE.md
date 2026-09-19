# Acceptance matrix

Requirement → implementation → how it was verified → what remains limited.

**Verification legend**
- `test` — automated test, passing (`npm test`)
- `manual` — exercised in a browser against the running app
- `api` — exercised against the running HTTP endpoint
- `none` — not verified

---

## 1. Sharing

| Requirement | Implementation | Verification | Remaining limitation |
|---|---|---|---|
| Medication-specific public route | `/medications/[slug]`, statically generated | `manual` — page renders; `api` — 200 | Single medication in the registry |
| Shared URL opens the right medication | Slug lookup with no fuzzy fallback; unknown slug 404s | `test` (`content.test.ts`), `api` — 404 for `singulair-montelukast-5mg-chewable` | — |
| Native share via `navigator.share` | `ShareSection`, called directly in the click handler with no preceding `await` | `manual` — fallback path confirmed in a browser without Web Share | **Real share sheet not tested on a physical device** |
| Copy link | `navigator.clipboard.writeText` + manual-select fallback | `manual` | Clipboard API needs a secure context |
| QR code | `/api/qr/[slug]` renders SVG server-side from the validated origin | `manual` — 512×512 rendered; `api` — valid SVG, 404 for unknown slug | **Not tested by scanning with a real camera** |
| Cancelling share is not an error | `AbortError` → "Sharing cancelled." | `manual` (code path), `test` — n/a | Not exercised on a real share sheet |
| No "Delivered" / "Recipient opened" claims | Status text says the sheet closed and the device handles delivery | `test` (`privacy.test.ts` — no event name implies delivery) | — |
| No channel inference, no fake device discovery | No Bluetooth, no simulated progress, no nearby-device UI anywhere | `test` — no `airdrop`/`quick_share` event names | — |
| HTTPS in deployment | `buildShareUrl` throws for non-https outside localhost | `test` (`share.test.ts`) | Not deployed; unenforced until then |
| No private data in URLs / QR / previews | URL is bare path; query and hash stripped; share text is product-only | `test` (`share.test.ts`, 8 tests) | — |
| Validated public origin | `getPublicOrigin()` validates and normalises; never derived from `Host` | `test` indirect; `manual` — operator warning shows when unset | — |

## 2. Medication information

| Requirement | Implementation | Verification | Remaining limitation |
|---|---|---|---|
| First screen answers what/why/benefit/risk | Header + headline + scope note + sections, server-rendered | `manual` | — |
| Brand + generic names, strength, form, route | Identity grid from the openFDA NDC record | `manual`, `test` (identity pinned) | — |
| Approved uses and populations | "What is it approved to treat?" section, citing section 1 | `test` — quotes verified verbatim | — |
| Benefits and limitations | Separate sections, equal visual weight | `manual` | — |
| Common adverse reactions | Cites section 6 *with* the label's own comparability caveat | `test` | — |
| Boxed warning surfaced, not buried | Rendered first, `emphasis: "critical"`, red card | `test` — asserts boxed section is `sections[0]`; `manual` | — |
| Contraindications and interactions | Own section citing sections 4 and 7 | `test` | — |
| Special populations | Pregnancy / paediatric / geriatric, citing 8.1/8.4/8.5 | `test` | — |
| Links to authoritative sources | DailyMed + Medication Guide deep links | `manual` | — |
| Source revision + retrieval dates | Provenance panel: SPL version, effective date, DailyMed publish date, retrieved-at | `manual`, `test` | — |
| "Retrieved on" ≠ "clinically reviewed on" | `clinicallyReviewedAt` is `null`; UI states no review happened | `test` — asserts null | — |
| No invented percentages or frequencies | Only label figures, reproduced with context (e.g. headache 18.4% vs 18.1% placebo) | `test` — every quote is a verbatim substring | — |
| No merging of formulations | Scope note; content restricted to the 10 mg tablet | `test` — scope note mentions chewable; `api` — coverage refuses a 5 mg request | Medication Guide passages do span forms (see Limitations) |
| No personalised dosing | "How it is taken" states label dosing and defers to the prescriber | `test` — system prompt forbids it | — |
| No start/stop/switch recommendations | Absent by construction; forbidden in the system prompt | `test` | — |
| Does not claim completeness | Footer and side-effects section both disclaim | `manual` | — |

## 3. Assistant

| Requirement | Implementation | Verification | Remaining limitation |
|---|---|---|---|
| "Learn more" opens medication-aware chat | `ChatSheet`, medication fixed by the page | `manual` | — |
| Suggested questions | Five chips | `manual` | — |
| Impiricus routing when authorised | `impiricusAdapter` behind `AssistantAdapter`; config requires `IMPIRICUS_AUDIENCE=patient` | `test` — n/a (stub) | **Not implemented.** No documented endpoint exists to this codebase |
| Otherwise: identified assistant + evidence source | Anthropic adapter; label-excerpt mode when unconfigured | `test` (23 chat tests), `api` | Conversational mode **awaits a credential** |
| Grounded in retrieved evidence | Prompt carries only retrieved passages | `test` — prompt contains delimited `<passage>` blocks | — |
| Clickable citations that support the claim | Citations expand to the retrieved excerpt + DailyMed link | `manual`, `test` — excerpts verified against source text | Citation is passage-level, not sentence-level |
| Citations validated against source ids | `validateCitations` allow-lists the supplied passages | `test` — fabricated id rejected; real-but-unsupplied id rejected | — |
| Never generates source URLs | URLs are derived from the source record, never from model output | `test` | — |
| Says when sources do not answer | `not-covered` mode | `test`, `api` — "Does this cure diabetes?" → 0 citations | — |
| Emergencies prioritised over everything | Urgency assessed before retrieval and before any model call | `test` — spy adapter proves the model is never called | US resources only |
| Untrusted inputs cannot override rules | Passages delimited and declared non-instructions; injected ids still rejected | `test` (3 injection tests) | Prompt-level defence; not a formal guarantee |
| Credentials server-side | `server-only` on config/adapters/orchestrator | `test` — build separates client/server | — |
| Input size and conversation limits | Zod: message ≤ 2000 chars, history ≤ 12 turns | `test` indirect; schema enforced | — |
| Rate limits, timeouts, bounded retries | 20 req / 5 min; 25s timeout; one retry for transient failures only | `test` (`privacy.test.ts`), `api` | In-process limiter only |
| Sanitised output | Model output rendered as React text, never `dangerouslySetInnerHTML` | code review | — |
| No raw medical conversation logging | No logging of message content anywhere in the request path | code review | — |
| Ephemeral chat | History lives in component state only; no storage, no persistence | code review | — |
| Honest unavailable state | `unavailable` mode names the failure reason and still shows label text | `test` — timeout / rate-limited / upstream-error | — |
| Static content survives outage | Medication page is static and independent of the chat API | `manual` | — |
| Never silently falls back to canned text as AI | Excerpt mode is badged "Label text · not AI" | `test` — asserts mode is not `assistant` and note is absent | — |

## 4. Provider connection

| Requirement | Implementation | Verification | Remaining limitation |
|---|---|---|---|
| Offered as an optional next step | `suggestsProviderStep` is conservative | `test` — plain factual question gets no referral | — |
| Clarifies which kind of provider | Four-way choice before any route | `manual` | — |
| Best real route available | Route B: verified public destinations | `manual`, `test` — all https, no placeholders | No scheduling integration |
| Verified entries with sources | HRSA Find a Health Center, Medicare Care Compare, FDA MedWatch; each with a checked date | `manual` — all four URLs fetched and confirmed live on 2026-09-19 | Links can rot; re-check before demoing |
| Directory ≠ availability | Explicit limitations block | `test` — asserts "accepting new patients", "insurance network", "licensure" | — |
| No NPI-implies-availability | No directory of named providers at all | `test` — no NPI or "Dr." patterns | — |
| Confirm before sending personal info | Nothing is sent; the question list is local and never transmitted | code review, `test` — referral adapter unconfigured | Confirm-before-send belongs with a real integration |
| Accurate status language | Telehealth marked "Not available"; no booking claims | `test` | — |
| Duplicate submission prevention | N/A — nothing is submitted | — | Needed when a referral integration lands |

## 5. Insurance coverage

| Requirement | Implementation | Verification | Remaining limitation |
|---|---|---|---|
| Four evidence levels kept distinct | `CoverageEvidenceState`; no "covered" state exists | `test` (23 tests) | — |
| Progressive, minimal collection | Insurer, plan, year, state, strength, form, quantity, days' supply | `manual` | — |
| No card upload for a formulary question | Not requested anywhere; schema rejects member fields | `test` — `memberId`/`dob`/`ssn` stripped | — |
| Fields reported separately | Listing, tier, PA, step therapy, quantity limits, pharmacy, dates, timestamp | `manual`, `test` | — |
| "Not listed" ≠ "not covered" | Distinct state + explicit caveat | `test` | — |
| Failure never becomes positive | `checkCoverageSafely` degrades every throw/timeout to `unable-to-verify` | `test` — throwing and hanging adapters | — |
| Missing copay never renders as zero | `formatCost(null)` → "Not available" | `test` — asserts not `$0.00`; `manual` | — |
| Model cannot decide coverage | Coverage never touches the model | code review | — |
| No dose-change suggestions to fit limits | Absent; forbidden in the system prompt | `test` | — |
| Sample mode visibly labelled, opt-in | `ENABLE_SAMPLE_COVERAGE`; dashed banner; `isSample: true` | `manual` — banner verified; `test` | — |
| Sample never a silent fallback | Failure path returns `isSample: false` | `test` | — |
| Real next steps regardless | Test claim, member services, plan drug list, Medicare Plan Finder | `test`, `manual` | — |
| Strength/form mismatch refused | API rejects a strength that is not this product's | `api` — 5 mg chewable request refused | — |
| Plan year carried, not assumed | Echoed into scope and effective dates | `test` | — |

## 6. UX and accessibility

| Requirement | Implementation | Verification | Remaining limitation |
|---|---|---|---|
| Finished mobile site, not a dashboard | Single reading column, 36rem max, 17px base | `manual` — 375×812 | — |
| Accessible contrast, focus states | Token palette; 3px `:focus-visible` ring | `manual` | No automated contrast audit |
| Large touch targets | `--tap: 44px` on buttons, chips, summaries, inputs | `manual` | — |
| Reduced motion | `prefers-reduced-motion` disables animation and the spinner | code review | — |
| Loading / empty / error states | Spinner, suggestion chips, alert cards, 404 page | `manual` | Offline state not implemented |
| Works with the mobile keyboard | Sheet sized in `dvh`; inputs at 16px to stop iOS zoom | `manual` at 375×812 | **Not tested with a real on-screen keyboard** |
| Accessible dialog | `role="dialog"`, `aria-modal`, labelled, focus trap, Escape, focus restore, scroll lock | `manual` — verified programmatically end to end | — |
| Chat announcements | `aria-live="polite"` on the log; `role="status"` on progress | code review | Not tested with a screen reader |
| First screen is information, no splash | Root redirects straight to the medication page | `manual` | — |
| No fake testimonials / counts / badges | None present | code review | — |
| No "HIPAA compliant" claims | Not claimed anywhere | code review | — |

## 7. Architecture, security, measurement

| Requirement | Implementation | Verification | Remaining limitation |
|---|---|---|---|
| Separated concerns | Distinct modules for content, retrieval, orchestration, adapters, sharing, analytics | code review | — |
| Typed schemas at boundaries | Zod on source records, chat requests, coverage requests, analytics | `test` | — |
| Explicit integration states | `getIntegrationStates()`, rendered publicly on the page | `manual` | — |
| Public content separate from private data | Medication page static and public; chat/coverage `no-store, private` | `api` — headers confirmed | — |
| Server-side secrets | `server-only` imports | build | — |
| Request validation + rate limits | Zod + fixed-window limiter on all three POST routes | `test`, `api` | In-process only |
| Safe outbound URLs | External links `rel="noopener noreferrer"`; no user-supplied redirects | code review | — |
| Security headers | CSP, nosniff, frame-deny, referrer policy, permissions policy | `api` — headers confirmed | CSP uses `unsafe-inline`; `unsafe-eval` in dev only |
| Appropriate cache control | Public page cacheable; chat/coverage `no-store` | `api` | — |
| Minimal analytics | Ten allow-listed events; properties whitelisted per event | `test` (18 tests) | — |
| No slug/chat/PHI to analytics | Slug deliberately absent from every event | `test` | — |
| Share ≠ delivery, click ≠ appointment | Event names audited against a forbidden list | `test` | — |

---

## Not implemented

- Impiricus assistant integration (no documented endpoint available)
- Real payer / PBM / formulary integration
- Provider referral submission, and any storage of personal information
- Multi-medication catalogue
- Offline support / service worker
- Non-US emergency numbers and localisation

## Requires real-device testing

Everything in [docs/DEVICE-CHECKLIST.md](DEVICE-CHECKLIST.md). **No physical
device test has been performed.** Browser automation does not exercise
OS-level AirDrop or Quick Share.

---

# Addendum — independent diagnosis and repair

Run against the existing repository. No external audit document was supplied,
so findings below are from independent diagnosis against the running code.

## Defects confirmed and repaired

| # | Defect | How it was confirmed | Repair | Verification |
|---|---|---|---|---|
| 1 | **The provider handoff discarded the user's question.** `onOpenProvider` took no arguments; the provider step only rendered six generic prompts. | Read of `ChatSheet.tsx` / `ProviderSheet.tsx`; the prop signature took no payload and `QuestionBuilder` sourced only `defaultQuestionsForClinician`. | New `src/lib/handoff`. Question carried verbatim, shown on the choice screen with the reason it is open, placed first in the editable list badged "YOURS". | `test` (18) + `manual` — verified end to end in the production build: question "Can I drink alcohol while taking this?" arrived as item 1 of 7. |
| 2 | **Retrieval was single-turn, so follow-ups were unreliable.** `orchestrator.ts:70` searched `req.message` only; history reached the model but never the retriever. | Probe against the real label: `"Are any of those permanent?"` → **0 hits** → "not covered", though the label states NP symptoms sometimes persist. `"Is that the same for her?"` → **3 confident hits in Dosage and Administration** from a pronoun-only query. | New `src/lib/retrieval/context.ts`. Prior topic merged **only** when the message cannot stand alone; a pronoun with no antecedent now asks (`needs-clarification`) instead of guessing. | `test` (19) — both original failures encoded as regressions. |
| 3 | **Coverage had no real source.** Every lookup returned "unable to verify". | Read of `adapters.ts`; only `unconfigured` and `sample` existed. | CMS Part D formulary integration (`formulary.ts`, `snapshot.ts`, `cmsFormularyAdapter`, `scripts/ingest-formulary.mjs`). | `test` (16) + `api` — release resolution verified live (2026-08, HTTP 200, 2188 MB). **Data not ingested.** |
| 4 | **Dosage education omitted the age→strength mapping.** | Read of the `how-its-taken` section — it covered timing but not which product suits which age. | Added the label's explicit mapping (15+ → 10 mg tablet; 6–14 → 5 mg chewable; 2–5 → 4 mg chewable/granules; 6–23 months → granules) with four new verbatim-verified citations. | `test` — all 38 citations remain literal substrings of the retrieved label. |

## Claims deliberately NOT made

- **No physical AirDrop or Quick Share testing.** Unchanged from before; every
  item in `DEVICE-CHECKLIST.md` remains "Not tested". Browser automation cannot
  exercise an OS share sheet.
- **No live payer coverage.** The CMS integration is formulary evidence, not
  member benefits, and its data has not been ingested in this environment.
- **No successful provider connection.** Nothing is transmitted; the handoff is
  local preparation only.
- **Conversational assistant still unverified against a live model.** Tested
  against a stub adapter; no request has been made to a real model API.

## Test count

| | Baseline | After |
|---|---:|---:|
| Test files | 7 | 10 |
| Tests | 135 | 194 |
