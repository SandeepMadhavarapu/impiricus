# Architecture

## Stack, and why

**Next.js 15 (App Router) + TypeScript.** Server-side route handlers keep model
and payer credentials off the client. React Server Components let the public
medication page render fully on the server, so a shared link is useful before
any JavaScript executes — which matters when the entire product is "someone
opens a link on a phone".

**Plain CSS with design tokens, not Tailwind.** One polished mobile surface does
not need a utility framework, and skipping it removes a class of build-config
risk. `src/app/globals.css` defines the token palette once, redefines it under
`prefers-color-scheme: dark`, and everything else is semantic classes.

**Zod at every trust boundary.** Fetched source records, chat requests, coverage
requests and analytics events are all parsed, not trusted.

**Vitest.** Fast, ESM-native, no transform config.

Deliberately absent: a database, a queue, a service worker, an ORM, a state
library. Nothing here needs them, and a working vertical slice beats unused
infrastructure.

---

## The evidence model

This is the core of the design. **Retrieval is the truth layer; the model is an
optional explainer.**

```
FDA label (openFDA + DailyMed)
        │  scripts/fetch-label.mjs — version-corroborated, provenance-stamped
        ▼
src/content/sources/*.json          ← raw label text + SPL version + retrieved-at
        │
        ├──► src/content/medications/*.ts   authored plain language,
        │       every claim carrying an exact quote                  [build-time verified]
        │
        └──► src/lib/retrieval        BM25 over passages with stable ids
                    │
                    ▼
              src/lib/chat/orchestrator
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
   model configured      no model
   compose + cite        verbatim excerpts
          │               (badged "not AI")
          ▼
   validateCitations  ← allow-list = passages supplied for THIS question
          │
          ├── all citations fabricated → withhold the answer
          └── some fabricated → drop them, disclose the count
```

Two independent guarantees fall out of this:

1. **Authored content cannot drift.** `tests/content.test.ts` asserts every
   quote in the plain-language layer is a literal substring of the retrieved
   label. Change the wording of a quote and the build fails.
2. **Model output cannot invent a source.** A passage id either came from the
   retrieval step for this specific question, or it is rejected. A real id from
   a section that was not retrieved is also rejected — the model could not have
   read it, so it cannot be relying on it.

### Why a no-AI mode exists

Without a model credential the product still works. `label-excerpts` mode runs
the same retrieval and shows the matched label text verbatim, badged
**"Label text · not AI"**.

This is not a degraded placeholder pretending to be an assistant. It is a
genuinely useful feature — a label search — and labelling it accurately is the
difference between an honest fallback and the thing the brief forbids: canned
responses presented as live AI.

---

## Module boundaries

| Module | Responsibility | Depends on |
|---|---|---|
| `lib/content` | Schemas, registry, citation verification | — |
| `lib/retrieval` | Chunking + BM25 over label sections | `lib/content` types |
| `lib/chat/providers` | `AssistantAdapter` interface; Anthropic + Impiricus adapters | `lib/config` |
| `lib/chat/grounding` | Citation extraction and validation | `lib/retrieval` |
| `lib/chat/orchestrator` | Safety → retrieval → model → validation | all of the above |
| `lib/safety` | Crisis and urgent-situation routing | — |
| `lib/coverage` | Evidence states + adapters | `lib/config` |
| `lib/providers` | Verified provider destinations | — |
| `lib/share` | Share URL construction | — |
| `lib/analytics` | Event allow-listing | — |
| `lib/security` | Rate limiting | — |

`lib/safety`, `lib/providers`, `lib/share` and `lib/analytics` have **no
dependencies on the rest of the app**, which is why their tests are fast and
their behaviour is easy to reason about.

The orchestrator takes an optional injected adapter (`AnswerDeps`), which is how
the model path — fabricated citations, timeouts, empty completions — is tested
without a credential.

---

## Explicit states

Nothing in this app has an implicit "probably fine" state.

**Integrations** are `configured` or `unconfigured`, surfaced publicly on the
page via `getIntegrationStates()`.

**Answers** carry a mode: `assistant`, `label-excerpts`, `not-covered`,
`unavailable`, `urgent`. The UI renders a different badge for each.

**Coverage** has five evidence states and, deliberately, no state called
"covered":

- `member-benefit-response` — a member-specific response was returned
- `formulary-listed` — on the plan's drug list; personal coverage unverified
- `restrictions-indicated` — listed, with prior auth / step therapy / limits
- `not-listed-on-checked-formulary` — **not** the same as "not covered"
- `unable-to-verify` — no source, timeout, unmatched plan, or stale data

**Evidence staleness** is computed from the retrieval timestamp; past 90 days
the page renders a staleness warning rather than presenting old content as
current.

---

## Security posture

Proportionate to a prototype that handles no accounts and stores nothing.

- Secrets are server-side; `server-only` guards config and adapters.
- All three POST routes: Zod validation + fixed-window rate limiting.
- `no-store, private` on chat and coverage; the public page is cacheable.
- Security headers in `next.config.ts`: CSP, nosniff, frame-deny, referrer
  policy, permissions policy. `unsafe-eval` is added **in development only** —
  the dev-mode HMR runtime needs it, and without it the client never hydrates.
- Rate-limit keys are salted SHA-256 hashes of the IP, so the limiter does not
  accumulate a visitor log.
- No message content is logged anywhere in the request path.
- Model output is rendered as React text. There is no `dangerouslySetInnerHTML`
  in the codebase.
- External links carry `rel="noopener noreferrer"`. There are no user-supplied
  redirects.

**No personal information is collected.** Chat history lives in component state
and disappears when the sheet closes. The coverage form deliberately does not
ask for a member ID, date of birth, or an insurance card. The provider
question-list is local and never transmitted. This is not primarily a privacy
feature — it is because an unconfigured prototype has nowhere appropriate to
store any of it.

---

## Analytics

Ten allow-listed events, with properties whitelisted per event and values
whitelisted per property. Anything unrecognised is dropped at the boundary.

**No event carries the medication slug.** Linking a person to interest in a
specific drug is precisely the inference this product should not enable, so
`medication_page_opened` is a bare counter plus a three-value referrer class.

Event names are audited by a test against a forbidden list: nothing may be named
`*_delivered`, `*_received`, `appointment_booked`, or `coverage_confirmed`. A
share is *initiated*; a provider CTA is *clicked*. Neither is an outcome.
