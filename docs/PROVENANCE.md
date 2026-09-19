# Medication source records

Generated from `src/sources/content/sources/`. Regenerate the underlying record with `npm run content:fetch`; check it is still current with `npm run content:verify`.

---

## SINGULAIR (montelukast sodium)

### Product identity

| Field | Value |
|---|---|
| Brand name | SINGULAIR |
| Generic name | montelukast sodium |
| Strength | MONTELUKAST SODIUM 10 mg/1 |
| Dosage form | TABLET, FILM COATED |
| Route | ORAL |
| Product NDC | `78206-172` |
| FDA application | NDA020829 |
| Marketing category | NDA |
| Labeler | Organon LLC |
| RxCUI | 153892, 153893, 200224, 242438, 261367, 311759, 351246, 404406 |
| UNII | U1O3J18SFL |

Packaging:

- `78206-172-01` — 30 TABLET, FILM COATED in 1 BOTTLE (78206-172-01)
- `78206-172-02` — 90 TABLET, FILM COATED in 1 BOTTLE (78206-172-02)

### Document

| Field | Value |
|---|---|
| SPL set id | `482dcc92-b47f-4ea6-854a-f5ac2aea7842` |
| SPL version | 5 |
| SPL id | `57a12189-3bb3-4a5d-b5fe-fc57db87c134` |
| Effective date (FDA) | 2025-04-30 |
| Published date (DailyMed) | Jun 25, 2025 |
| Retrieved at | 2026-09-19T05:18:34.208Z |
| **Clinically reviewed** | **Never. No clinician has reviewed this content.** |

`effectiveDate` and `dailyMedPublishedDate` differ because they mean different things (FDA label effective time vs. DailyMed publication). Both are recorded rather than collapsed into one date.

### Dosage-form scope

This SPL covers more than one product:

- TABLET, FILM COATED (10 mg)
- TABLET, CHEWABLE (4 mg, 5 mg)
- GRANULE (4 mg)

**This record is scoped to the 10 mg film-coated tablet (NDA 020829) only.** Content and answers must not be generalised to the chewable tablets or oral granules, which have different strengths, dosing and populations.

### Sources

**openFDA Drug Label API** — U.S. Food & Drug Administration

- Query: `https://api.fda.gov/drug/label.json?search=set_id:%22482dcc92-b47f-4ea6-854a-f5ac2aea7842%22&limit=1`
- Source last updated: 2026-09-18

**openFDA NDC Directory API** — U.S. Food & Drug Administration

- Query: `https://api.fda.gov/drug/ndc.json?search=product_ndc:%2278206-172%22&limit=1`
- Source last updated: 2026-09-18

**DailyMed SPL Service v2** — U.S. National Library of Medicine

- Query: `https://dailymed.nlm.nih.gov/dailymed/services/v2/spls.json?setid=482dcc92-b47f-4ea6-854a-f5ac2aea7842`
- Source last updated: Sep 18, 2026 08:28:07PM EST

Human-readable:

- Full label: <https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=482dcc92-b47f-4ea6-854a-f5ac2aea7842>
- Medication Guide: <https://dailymed.nlm.nih.gov/dailymed/medguide.cfm?setid=482dcc92-b47f-4ea6-854a-f5ac2aea7842>

### Transcribed label sections (20)

| Label ref | Section | Characters |
|---|---|---:|
| BOXED WARNING | Boxed Warning | 2080 |
| 1 | Indications and Usage | 1546 |
| 2 | Dosage and Administration | 5416 |
| 3 | Dosage Forms and Strengths | 564 |
| 4 | Contraindications | 162 |
| 5 | Warnings and Precautions | 5369 |
| 6 | Adverse Reactions | 11416 |
| 7 | Drug Interactions | 397 |
| 8 | Use in Specific Populations | 8419 |
| 8.1 | Pregnancy | 1923 |
| 8.4 | Pediatric Use | 4798 |
| 8.5 | Geriatric Use | 729 |
| 10 | Overdosage | 409 |
| 11 | Description | 1841 |
| 12 | Clinical Pharmacology | 14011 |
| 12.1 | Mechanism of Action | 1265 |
| 14 | Clinical Studies | 20260 |
| 16 | How Supplied/Storage and Handling | 1601 |
| 17 | Patient Counseling Information | 2475 |
| MEDGUIDE | Medication Guide | 8558 |

Total: 93,239 characters, chunked into 139 retrieval passages.

### Citation integrity

The authored plain-language layer (`src/sources/content/medications/`) carries **34 citations**. Each names a source section and an exact quote, and `tests/content.test.ts` asserts every quote is a literal substring of the transcribed text above (whitespace- and case-insensitive).

A quote that drifts from its source fails the test suite, so this property holds at build time rather than by convention.

### Integrity guards in the fetch script

`scripts/fetch-label.mjs` refuses to write a record when:

- the NDC directory application number does not match the expected NDA, or
- openFDA and DailyMed disagree on the SPL version (one source is stale, and silently picking a winner would be wrong).
