# MediZ data pipeline

A self-contained medication ingestion and verification pipeline. It resolves an
**exact product**, retrieves its full official labeling, keeps every fact
traceable to a raw source capture, and emits JSON the app can consume without
installing anything from this folder.

**Isolation.** Everything lives under `data-pipeline/`. No application file,
route, schema, or root config is modified by this package. It has its own
`package.json`, its own `node_modules`, and its own test runner.

---

## Supported scope

- Three selected medication products.
- Public formulary evidence from the verified CMS release.
- Medicare Part D only.
- No member-specific coverage or copay verification.
- No comprehensive interaction checker.
- No clinical review.

Anything outside that list is unsupported rather than approximated. The same
statement ships as data in `data/exports/index.json` under `supportedScope`.


## Quick start

```bash
cd data-pipeline && npm install
```

```bash
npm run cli sources
```

Teammates consuming the data do **not** need to run any of this. Committed
exports live in `data/exports/`.

---

## Commands

| Command | What it does |
|---|---|
| `npm run cli sources` | Lists configured sources and live-probes the RxNav interaction API |
| `npm run resolve` | Resolves identity for every product and prints the evidence table |
| `npm run resolve <productKey>` | Resolves one product |
| `npm run ingest` | Retrieves, normalizes and writes `data/normalized/<key>.json` |
| `npm run ingest <productKey> -- --force` | Re-ingests one product, bypassing the 12-hour cache |
| `npm run validate` | Re-validates stored records against the schema |
| `npm run refresh` | Re-ingests everything and flags SPL version changes |
| `npm run export` | Writes app-consumable JSON to `data/exports/` |
| `npm run report` | Writes the completeness/conflict report |
| `npm run nppes -- --lastName Smith --state CA` | Targeted provider lookup |
| `npm run insurance:ingest` | Fetch CMS Part D formulary evidence (range-fetches ~8.8 MB of a 2.14 GB archive) |
| `npm run coverage -- --product <key> --contract S5820 --plan 034 --segment 000` | Coverage lookup for an exact plan |
| `npm run insurance:export` | Write source register, plan index and example lookups |
| `npm test` | Fixture-driven suite. **No network.** |
| `npm run test:live` | Opt-in live smoke checks, reported separately |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run verify` | typecheck + tests |

`OPENFDA_API_KEY` is optional and raises openFDA's daily limit. Nothing here
requires a key.

---

## What is ingested

Three products, chosen to exercise distinct identity failure modes rather than
to inflate a count. Rationale for each is in `src/config/products.ts`.

| Product | Exercises |
|---|---|
| `singulair-montelukast-10mg-tablet` | Multi-product SPL (one document, four products, three NDAs); salt vs active moiety |
| `toprol-xl-metoprolol-succinate-50mg-er-tablet` | Salt (succinate vs tartrate); extended vs immediate release; **mismatched harmonized RXCUIs** |
| `ozempic-semaglutide-1_34mg-per-ml-injection` | Ratio strength (mg/mL); **empty openFDA harmonized block**; repackager copies; concept level (SBDC vs SBD) |

---

## Layout

```
data-pipeline/
  contracts/medication-export.d.ts   dependency-free types for the app
  contracts/insurance-export.d.ts    coverage lookup + source register types
  src/
    config/        source registry (endpoints, limits, licensing) + product catalog
    sources/       http client, rxnav, dailymed, openfda, nppes
    identity/      NDC conversion, candidate generation, resolution states, FDA approval matching
    insurance/     Part D snapshot, plan resolution, coverage lookup
    normalize/     SPL XML -> structured sections; record assembly
    export/        app-consumable JSON
    schemas/       zod schemas and types
    cli.ts
  tests/
    fixtures/      SYNTHETIC data, clearly marked, never written to data/
  data/
    raw/           immutable captures + hashes (gitignored, regenerate)
    normalized/    full records with provenance (committed)
    exports/       app-consumable JSON (committed)
    reports/       completeness and conflict reports (committed)
  docs/
```

---

## How it stays honest

**Identity is earned, not assumed.** A product reaches `verified-match` only
when critical dimensions — NDC, strength, dose form, route, release
characteristic — agree across sources. Every dimension produces an evidence row
you can read. There is deliberately **no numeric confidence score**, because
"0.87" hides which check failed, and which check failed is the whole question.

**Absence is typed.** A missing field carries a reason:
`not-present-in-source`, `not-applicable`, `not-retrieved`, `retrieval-failed`,
`ambiguous-applicability`. An empty field never reads as "no risk".

**Tables survive.** Label content comes from the SPL XML, not openFDA's
flattened text, so "Table 1: Recommended Dosage in Asthma" keeps its Age → Dose
columns. Flattening it is how a paediatric row becomes an adult instruction.

**Failure never becomes data.** A source error raises. `ingest` leaves the last
known good record untouched and reports the failure.

**Raw captures are immutable**, content-hashed, and credential-stripped before
they are written.

---

## Documentation

- [docs/SOURCES.md](docs/SOURCES.md) — every source, probed live, with what it can and cannot establish
- [docs/INTEGRATION.md](docs/INTEGRATION.md) — for UI teammates: example reads and field meanings
- [docs/AUDIT.md](docs/AUDIT.md) — verified live vs fixture-tested vs unavailable
- `data/exports/insurance/source-register.json` — every insurance source, with discovery vs retrieval status
- [docs/BOUNDARIES.md](docs/BOUNDARIES.md) — what public sources cannot provide, and where those features belong
- `data/reports/completeness.md` — generated completeness and conflict report

---

## Safety

This pipeline supplies **public medication information only**. It does not
produce patient prescriptions, patient-specific dosing, insurance coverage,
clinician instructions, or clinical review, and it must not be extended to
fabricate them. See [docs/BOUNDARIES.md](docs/BOUNDARIES.md).
