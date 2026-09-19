# Automatic source refresh

Automatic **detection and preparation**. **Reviewed** publication.

Nothing in this system publishes medical or coverage content on its own. It
polls sources, detects changes, regenerates candidates, and opens a pull
request for a person to read. A green workflow means *"a candidate is ready to
look at"*, not *"the data is correct"*.

---

## Does the deployed app update automatically? No.

This is the first thing to know, and it is not what the pipeline's own
documentation would otherwise imply.

**The app does not consume this pipeline.** It has its own parallel data path:

| The app reads | Produced by |
|---|---|
| `src/content/sources/*.json` (build-time import via `src/lib/content/registry.ts`) | `scripts/fetch-label.mjs` |
| `src/content/coverage/cms-part-d-snapshot.json` (runtime `readFileSync` in `src/lib/coverage/snapshot.ts`) | `scripts/ingest-formulary.mjs` |

It never reads `data-pipeline/data/exports/`. Regenerating pipeline exports
therefore changes **nothing** the user sees.

**End-to-end app refresh is blocked on teammate integration.** The pipeline
delivers validated artifacts and this integration note; the application code
belongs to teammates and was not modified.

### What integration would take

Either the app points at the pipeline's exports, or the pipeline writes into
the paths the app already reads. The first is cleaner:

```ts
// src/lib/coverage/snapshot.ts
const SNAPSHOT_PATH = path.join(
  process.cwd(), "data-pipeline", "data", "normalized", "insurance",
  "cms-part-d-snapshot.json"
);
```

The access layer has no equivalent in the app yet. `data/exports/access/*.json`
and `contracts/access-export.d.ts` are ready to import whenever someone wants
them.

---

## What is automated today

| Capability | Status |
|---|---|
| Daily source version checks across 6 sources | **Works**, once the workflow reaches `main` |
| Change detection with before/after evidence | **Works** |
| Candidate regeneration and validation | **Works** |
| Pull request with only generated data | **Works**, subject to one repository setting |
| Network-free tests on every push | **Works now**, on this branch |
| Publication | **Deliberately manual.** A human merges |
| App picks up merged data | **Blocked** on the integration above |

---

## Polling, not push. Check cadence is not publication cadence.

None of these sources offers a webhook. Every one is polled, and the two
cadences are different numbers:

| source | we check | publisher releases | max acceptable age | needs key |
|---|---|---|---|---|
| openfda | daily | per-endpoint `last_updated`; labels/enforcement roughly weekly | 7 days | no |
| dailymed | daily | continuous; per-SPL version bumps | 7 days | no |
| rxnav | daily | monthly full release, weekly updates | 31 days | no |
| cms-part-d | daily | monthly | 31 days | no |
| vamedicaid | daily | quarterly, published **weeks before** effect | 31 days | no |

Checking daily against a monthly release bounds detection latency to a day. It
does not make the data daily, and this is not "real-time".

---

## Commands

```bash
cd data-pipeline && npm install
```

| Command | What it does |
|---|---|
| `npm run env:check` | Confirms credential wiring. Never prints a value |
| `npm run refresh:check` | Reaches every source, compares versions, writes nothing |
| `npm run refresh:check -- --source openfda` | One source |
| `npm run refresh:check -- --dry-run` | Leaves no trace at all |
| `npm run refresh:cadence` | The table above, from the code |
| `npm run refresh:run` | Detects changes and builds a candidate manifest |
| `npm run refresh:run -- --force` | Refresh even when unchanged |
| `npm run refresh:manifests` | Every manifest and the last known good one |
| `npm run refresh:verify` | Checks the export tree against its manifest |
| `npm run refresh:rollback -- --manifest <id>` | Restores a previous bundle |

---

## The API key

**openFDA is the only source that takes a credential, and it is optional** —
without it openFDA works at a lower rate limit (40/min unauthenticated versus
240/min authenticated, as observed in the response headers).

### Locally

```bash
cd data-pipeline
cp .env.example .env.local
# paste the key after OPENFDA_API_KEY=   (no quotes, no spaces)
npm run env:check
```

`.env.local` is git-ignored by both the root and the pipeline `.gitignore`.
Node does **not** load it automatically; `src/config/env.ts` does, resolving
the path from the pipeline directory so it works from the repo root too.
**Process environment always wins**, so a stale local file can never override
a CI secret.

### In GitHub Actions

Settings → Secrets and variables → Actions → New repository secret, named
exactly `OPENFDA_API_KEY`. The workflows read it via
`secrets.OPENFDA_API_KEY`. It is never written to a log: `sanitizeUrl` rewrites
`api_key` to `REDACTED` in provenance, and `redactSecrets` scrubs error text.

---

## When the workflows actually run

This matters and is easy to get wrong.

| Workflow | Trigger | Active now on `feat/data-pipeline`? |
|---|---|---|
| `pipeline-tests.yml` | `push`, `pull_request` | **Yes.** These triggers work from any branch |
| `pipeline-refresh.yml` | `schedule` | **No.** GitHub runs scheduled workflows only from the **default branch**. The cron starts firing after merge to `main` |
| `pipeline-refresh.yml` | `workflow_dispatch` | **No.** The "Run workflow" button appears only once the file is on the default branch. After that you may target any branch |

So today the refresh workflow is verified by running the same commands locally
and by the workflow-safety tests that parse the YAML. **It is not running on a
schedule yet**, and nothing here claims it is.

### One repository setting

Workflow-created pull requests require Settings → Actions → General →
**"Allow GitHub Actions to create and approve pull requests"**. If it is off,
the PR step fails and the validated candidate is uploaded as an artifact
instead. No personal access token is needed; the built-in `GITHUB_TOKEN`
suffices.

---

## The state machine

```
discovered → fetched → parsed → validated → candidate-export
           → review-required | ready-for-publication → published
```

Two distinctions carry the design:

**"Unchanged" is not "unreachable."** Both leave exports untouched; they are
completely different facts. `no-change` is a success. A failed check does
**not** advance `lastSuccessfulCheck`, so a run summary can never imply
freshness it does not have.

**"Changed" is not "refresh due."** A source can be provably unchanged and
still need a refresh because our copy aged out. Folding staleness into
"changed" would assert the publisher did something it did not, so `outcome`
reports what the source did and `refreshDue` reports what we should do.

A failed or partial refresh never erases the last known good data, never
publishes an empty formulary as "not covered", never turns an unknown flag into
`false`, and never restamps old evidence with a new retrieval time.

---

## Current versus upcoming

The Virginia PDL is published **weeks before it takes effect**. On 2026-09-19
the newest published document was effective 2026-10-01 — twelve days away.

A newly discovered future-effective document is a **review blocker**, not an
activation. It is retained as upcoming; current coverage continues to come from
the version in force. See ACCESS.md for how the policy layer models this.

---

## Runbook

### A source is down

`refresh:check` reports `failed-retryable` with the HTTP status. Prior exports
are untouched and remain valid. `lastSuccessfulCheck` does not move, so the
staleness clock keeps running honestly. No action needed unless it persists
past the source's max acceptable age, at which point `refreshDue` flips to
`max-age-exceeded` and the data should be treated as ageing.

### The API key is rejected

`refresh:check` reports `failed-permanent` with 401/403, and the detail says
the key may be invalid or revoked. Retries stop immediately rather than burning
the rate limit.

1. `npm run env:check` — is it configured, and from where?
2. Regenerate at <https://open.fda.gov/apis/authentication/>
3. Update `.env.local` locally and the Actions secret in the repository
4. openFDA still works without a key meanwhile, at the lower limit

### The parser drifts

A change classified `parser-induced` means our build changed, not the source.
`PARSER_VERSION` is recorded in every manifest, and a diff whose two sides were
produced by different parser builds is reported as `ambiguous-needs-review`
rather than attributed to the publisher.

### New plan-year data appears

Expect a future-effective document and a review blocker. Do not activate it.
Confirm the effective date, let the candidate stay staged, and let the
effective-date logic switch over on the day.

### PR creation fails

Check the repository setting above. The candidate is attached to the run as the
`candidate-exports` artifact; download it, inspect it, and open the PR by hand.

### A clinical summary is stale

If supporting content changed, the summary is marked stale/unreviewed. Do not
silently attach it to new evidence — either re-review it or withhold the
affected claims per the existing contract.

### Rollback

```bash
npm run refresh:manifests                          # find the last good id
npm run refresh:rollback -- --manifest <id>
npm run refresh:verify                             # confirms the tree matches
```

Rollback restores from the snapshot taken at publication and then verifies
every file against the manifest, because a half-succeeded rollback is worse
than none. If no snapshot exists it says so rather than pretending; git history
is then the remaining route.

---

## Honest limitations

- **The app does not consume any of this yet.** Everything above prepares data
  that nothing currently displays.
- **The scheduled workflow has never run**, because it cannot until merge.
- **No end-to-end Actions run has been observed.** Local command verification
  and YAML-parsing tests are not the same thing as a successful Actions run,
  and are not reported as such.
- **`refresh:run` does not itself re-ingest.** It detects change and builds a
  candidate manifest; the workflow calls the existing `ingest`/`export`
  commands to regenerate. Splitting these keeps proven code paths in use.
- **Rollback needs a snapshot** taken at publication time. Manifests created
  before any publication have none.
- **Field-level diffing exists for the Virginia PDL only** (see ACCESS.md).
  Other sources are compared at version level, which detects *that* something
  changed but not *what*.
- **Review is a human process.** Nothing here validates clinical correctness,
  and an LLM must not approve a publication.
