# Which pipeline exports the app actually reads

Written 2026-09-20, after the coverage snapshot was found to have never reached
either deployment. The failure was not that anybody built the wrong thing — the
data was correct and sitting on disk. It was that nothing recorded which
exports the application consumes, so an export that silently stopped arriving
looked exactly like an export that was never meant to arrive.

This file is that record. Every export the pipeline writes appears below
exactly once, with its consumer or the reason it has none.

---

## Consumed by the application

| Export | Reaches the app via | Read by |
|---|---|---|
| `exports/<productKey>.json` (3 files) | `npm run content:sync` → `src/sources/content/label-exports/` | `src/sources/lib/content/catalogue.ts` |
| `exports/index.json` | `npm run content:sync` → `manifest.json` | `scripts/sync-label-exports.mjs` (integrity check) |
| `exports/insurance/plans.json` | `npm run content:sync` → `src/sources/content/insurance/plans.json` | `src/patient/lib/coverage/directory.ts` |
| `exports/app/cms-part-d-snapshot.json` | `npm run app:snapshot`, then `npm run content:sync` | `src/patient/lib/coverage/snapshot.ts` |

The last row is the one that was broken. Four things had to be true for CMS
formulary data to reach a reader, and none of them were:

1. the pipeline had to emit the **application's** schema, not its own
   (`app:snapshot` did not exist — the app rejected the pipeline's shape at
   load and fell back to "unable to verify");
2. `content:sync` had to copy it (it copied labels and plans, not this);
3. the destination had to be committed (`.gitignore` excluded the whole
   directory, so a Vercel build never saw it);
4. the loader had to be traced into the serverless bundle (it used
   `readFileSync(process.cwd()/…)`, which Next.js cannot trace — it is now a
   static `import`, like `plans.json` beside it).

Any one of those alone produces the same user-visible symptom: a page that says
it is "not connected to any formulary database" while the data exists. That is
why `tests/coverage-snapshot.test.ts` now validates the **shipped** artifact
with the **app's own** schema, rather than each side validating its own.

---

## Not consumed, on purpose

These are operator and provenance artifacts. They are correct and current; they
are not wired because wiring them would mean inventing patient- or
clinician-facing UI that nobody has specified, and a half-designed screen about
prior-authorization criteria is worse than no screen.

| Export | What it holds | Why it is not wired | What wiring it would need |
|---|---|---|---|
| `access/access-policies.json` | 9 published plan policies across Medicare Part D and Virginia Medicaid, each with the next steps its own policy documents describe | The app's coverage flow covers Part D only. Rendering VA Medicaid policies needs a market selector, and a market the reader is not enrolled in reads as advice about their own coverage. | A market dimension in `CoverageRequest`, a second adapter, and copy that states which market was checked. |
| `access/capability-manifest.json` | What has real evidence behind it and what does not, with the reason | An operator artifact. Its content is already reflected in the UI's own caveats. | Nothing, unless an internal status page is wanted. |
| `access/coverage-matrix.json` | Which source was checked for which product and plan, and what came back | Same. Useful for auditing a release, not for a reader. | Nothing. |
| `access/source-changes.json` | 94 classified differences between two genuinely retrieved published versions of the VA PDL | Change history is only meaningful next to the market it describes, which is not in the app. Showing "this changed" without "this is your plan" invites the wrong inference. | Depends on the VA Medicaid market above. |
| `insurance/coverage-examples.json` | 7 real lookups produced from the committed snapshot | Fixtures. They must never render as someone's coverage. | Nothing. They are better used as test input than as content. |
| `insurance/source-register.json` | Provenance for all 7 sources, separating discovery from retrieval | Operator artifact; the app surfaces provenance per product from the label exports instead. | Nothing. |

---

## If you add an export

Add a row above. An export with no row is either a consumer waiting to break or
a file nobody needed — and from the outside those look identical, which is the
whole reason this file exists.
