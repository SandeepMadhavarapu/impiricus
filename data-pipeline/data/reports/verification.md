# Verification report

Generated 2026-09-19T20:17:25.659Z

Every number here is produced by code in `src/verify/` and `src/normalize/*Audit.ts`, re-runnable with `npm run verify:report`.

## FDA Highlights extraction accounting

The earlier figure of ~19,900 characters was a crude tag-strip that counted the SPL's raw pretty-print indentation and newlines. On a comparable basis (whitespace collapsed, as the parser measures) the same blocks hold far less. This table reconciles every block.

| SPL | Blocks | Raw w/ indentation | Source (collapsed) | In tables | Retained | Duplicate | Missing |
|---|---:|---:|---:|---:|---:|---:|---:|
| 482dcc92 | 8 | 6756 | 3512 | 150 | 436 | 3076 | 0 |
| 496ddfaa | 8 | 4823 | 2829 | 0 | 1990 | 839 | 0 |
| adec4fd2 | 10 | 8332 | 4671 | 0 | 0 | 4671 | 0 |
| **total** | **26** | **19911** | **11012** | **150** | **2426** | **8586** | **0** |

**Reconciled.** Every source character is accounted for as retained, duplicate, or deliberately routed to `tables`.

## Interaction substance audit

Every extracted substance is tied to the sentence it came from and classified by direction. Two kinds of negative statement are kept apart, because they are not the same claim:

- **`no-dose-adjustment-stated`** - the label says the dose need not change. It says **nothing** about whether an interaction exists. Interaction status is UNKNOWN.
- **`no-interaction-observed-stated`** - the label says an interaction was looked for and not observed, or was found not to be clinically significant.

Collapsing the first into the second would make this pipeline assert an absence the source never claimed. Singulair is exactly that case: all of its substances come from a dosing sentence.

| Product | Mentions | No dose adjustment (status unknown) | No interaction observed | Other affects this | This affects other | Direction unclear |
|---|---:|---:|---:|---:|---:|---:|
| ozempic-semaglutide-1_34mg-per-ml-injection | 1 | 0 | 0 | 0 | 0 | 1 |
| singulair-montelukast-10mg-tablet | 14 | 14 | 0 | 0 | 0 | 0 |
| toprol-xl-metoprolol-succinate-50mg-er-tablet | 2 | 0 | 0 | 1 | 0 | 0 |

### Extraction completeness

Zero extracted adverse mentions is a statement about the EXTRACTOR, not about the drug. `unparsed` counts sentences that discuss coadministration but yielded no name.

| Product | Sentences scanned | With coadministration phrase | Yielded substances | Unparsed | Level |
|---|---:|---:|---:|---:|---|
| ozempic-semaglutide-1_34mg-per-ml-injection | 8 | 2 | 1 | 1 | index-only-not-exhaustive |
| singulair-montelukast-10mg-tablet | 2 | 1 | 1 | 0 | index-only-not-exhaustive |
| toprol-xl-metoprolol-succinate-50mg-er-tablet | 11 | 3 | 2 | 1 | index-only-not-exhaustive |

### ozempic-semaglutide-1_34mg-per-ml-injection

**Interaction described** (1): insulin secretagogue
  - insulin secretagogue [interaction-described-direction-unclear]: "Patients receiving OZEMPIC in combination with an insulin secretagogue (e.g., sulfonylurea) or insulin may have an increased risk of hypoglycemia, including severe hypoglycemia"

### singulair-montelukast-10mg-tablet

**Label states no DOSE ADJUSTMENT needed** (14) - interaction status unknown, NOT cleared: benzodiazepines, decongestants, digoxin, fexofenadine, gemfibrozil, itraconazole, non-steroidal anti-inflammatory agents, oral contraceptives, prednisolone, prednisone, sedative hypnotics, theophylline, thyroid hormones, warfarin
  - source: "No dose adjustment is needed when SINGULAIR is co-administered with theophylline, prednisone, prednisolone, oral contraceptives, fexofenadine, digoxin, warfarin, gemfibrozil, itraconazole, thyroid hormones, sedative hypnotics, non-steroidal anti-inflammatory a"

### toprol-xl-metoprolol-succinate-50mg-er-tablet

**Interaction described** (1): beta-blocking agents
  - beta-blocking agents [other-affects-this]: "7.1 Catecholamine-depleting drugs may have an additive effect when given with beta-blocking agents. () 7.2 CYP2D6 Inhibitors are likely to increase metoprolol concentration. () 7.3 Beta-blockers inclu"
  - beta-blocking agents [mentioned-unclassified]: "Catecholamine depleting drugs (e.g., reserpine, monoamine oxidase (MAO) inhibitors) may have an additive effect when given with beta-blocking agents"


## Medicare Part D dataset scope

| Measure | Value |
|---|---:|
| Archive size | 2.14 GB |
| Bytes fetched (HTTP range) | 8.8 MB |
| Formulary rows READ | 1,125,804 |
| Formulary rows RETAINED | 979 |
| Rejected by RXCUI filter | 1,124,825 |
| Plan rows READ | 112,294 |
| Plan rows unique | 5,518 |
| Plan rows rejected (incomplete) | 0 |
| Plans RETAINED | 5,517 |
| Plans dropped (no matching formulary) | 1 |
| Cost rules retained / available | 30 / 172,660 |
| Explicit exclusion rows | 0 |

### What the two headline numbers actually mean

**The 979 formulary rows** are rows from the 2026-08 release of the CMS basic drugs formulary file whose RXCUI is one of the 6 concepts linked to our three products. They are not all Part D formulary rows, and they are not a nationwide coverage statement.

**The 5517 plans** are plans in the same release whose FORMULARY_ID appears on at least one retained row. A plan appearing here means its formulary carries one of our drugs at SOME match granularity - most often the generic clinical-drug concept, not the branded product. Branded Singulair and Toprol XL each appear on exactly one formulary in this release.

### Members fetched

| Member | Compressed | Uncompressed |
|---|---:|---:|
| basic drugs formulary file 20260831.zip | 7.9 MB | 8.2 MB |
| plan information 20260831.zip | 0.4 MB | 0.4 MB |
| beneficiary cost file 20260831.zip | 0.4 MB | 0.6 MB |
| excluded drugs formulary file 20260831.zip | 0.0 MB | 0.0 MB |

### Members deliberately skipped (10, 2.13 GB)

- geographic locator file 20260831.zip (0 MB) - Not required for formulary membership, utilisation management or plan mapping.
- indication based coverage formulary file 20260831.zip (0 MB) - Not required for formulary membership, utilisation management or plan mapping.
- insulin beneficiary cost file 20260831.zip (0 MB) - Not required for formulary membership, utilisation management or plan mapping.
- pharmacy networks file 20260831 part 1.zip (391 MB) - Pharmacy network data: 2.18 GB of the archive and not needed for formulary membership.
- pharmacy networks file 20260831 part 2.zip (391 MB) - Pharmacy network data: 2.18 GB of the archive and not needed for formulary membership.
- pharmacy networks file 20260831 part 3.zip (390 MB) - Pharmacy network data: 2.18 GB of the archive and not needed for formulary membership.
- pharmacy networks file 20260831 part 4.zip (388 MB) - Pharmacy network data: 2.18 GB of the archive and not needed for formulary membership.
- pharmacy networks file 20260831 part 5.zip (385 MB) - Pharmacy network data: 2.18 GB of the archive and not needed for formulary membership.

### Unmatched identifiers and completeness checks

- **RXCUIs searched with no formulary row anywhere (1):** 2398841. A real finding, not an error - these concepts are genuinely absent from every formulary in the release.
- **Referential integrity: PASS.** Every FORMULARY_ID on a retained row resolves to a plan.
- **Row arithmetic: PASS.** retained 979 + rejected 1,124,825 = 1,125,804 (read 1,125,804).

## Source dates, kept distinct

| Field | Value | Meaning |
|---|---|---|
| Dataset release | 2026-08 | CMS release label from the file path |
| Source published | 2026-08-26 | CMS catalogue `modified` date |
| Contract year | 2026 | The plan year the rows apply to |
| Retrieved at | 2026-09-19T19:58:18.826Z | When WE fetched it. Never a substitute for the above |
| Applicable effective dates | 2026-01-01 to 2026-12-31 | Part D plan year |

**Live catalogue check:** current release is `2026-08` (modified 2026-08-26). Our snapshot is current.
