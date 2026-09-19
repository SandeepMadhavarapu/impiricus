# Known limitations

Written plainly, because a prototype that oversells itself in a medical context
is worse than one that does less.

## Content

- **No clinical review.** No clinician has read any of this. `retrievedAt` is
  real; `clinicallyReviewedAt` is `null` and the UI says so. A test asserts it
  stays null.
- **One medication, one strength, one dosage form.** Singulair 10 mg
  film-coated tablet only.
- **The Medication Guide spans dosage forms.** The FDA's patient Medication
  Guide covers the tablet, chewable tablets and oral granules in one document.
  Retrieval can therefore surface a Medication Guide passage that mentions the
  chewable tablets (for example, the phenylalanine note) on a page about the
  10 mg tablet. The scope note is shown alongside every answer, and the system
  prompt instructs the model not to generalise, but the retrieval layer cannot
  currently split a mixed-form passage. This is the sharpest known content risk.
- **Not every risk is listed.** The page summarises; it does not reproduce the
  full label, and it says so.
- **Plain-language restatement is a human judgement.** Quote fidelity is
  machine-verified. Whether a paraphrase faithfully conveys a quote's meaning is
  not, and cannot be.
- **US labeling only.** Approvals, warnings and available products differ by
  country.

## Assistant

- **Conversational mode is unverified against a live model.** The adapter,
  prompt, citation validation and failure handling are complete and tested
  against a stub adapter. No request has been made to a real model API, because
  no credential exists in this environment.
- **Citations are passage-level, not sentence-level.** A citation shows the
  passage a claim came from, not the specific sentence.
- **Prompt-injection defence is prompt-level.** Retrieved text is delimited and
  declared non-instructional, and fabricated citations are rejected structurally
  — which is the stronger guarantee. But the prose of an answer is not formally
  constrained.
- **Retrieval is lexical.** BM25 with a light stemmer and intent boosts. It will
  miss paraphrases that share no vocabulary with the label.
- **English only.**

## Safety routing

- **US emergency numbers only** (911, 988, 1-800-222-1222, 741741). There is no
  region detection; a user outside the US gets US numbers.
- **Pattern-based detection.** Deliberately tuned to avoid intercepting
  informational questions about the boxed warning — which is the whole point of
  the page. That trade-off means an unusually-worded crisis statement may not
  match. Crisis resources are shown alongside any answer touching
  neuropsychiatric risk as a second line of defence.

## Coverage

- **No real payer connection exists.** Every lookup returns "unable to verify".
- **Sample mode is fictional.** Opt-in, banner-labelled, never a fallback.
- **No member-specific path.** The `member-benefit-response` state is modelled
  and rendered but unreachable without an authorised eligibility integration.

## Provider

- **No scheduling, referral or telehealth integration.** Telehealth is marked
  "Not available".
- **No provider directory.** Only official HRSA/CMS search tools. A directory
  with names would imply availability and network participation that a listing
  does not establish.
- **Link rot.** All destinations were verified live on 2026-09-19. Re-check
  before a demo.

## Platform and infrastructure

- **Not deployed.** There is no public URL.
- **AirDrop and Quick Share are untested on hardware.** Browser automation
  cannot exercise an OS share sheet. See `docs/DEVICE-CHECKLIST.md` — every item
  is marked Not tested.
- **Rate limiting is in-process.** A multi-instance deployment needs a shared
  store (Redis or equivalent); today each instance counts separately.
- **CSP uses `unsafe-inline` for scripts.** Next's App Router bootstrap requires
  it without nonce-forwarding middleware. `unsafe-eval` is dev-only.
- **No offline support.** Deliberate: a service worker caching medical content
  risks serving a stale label after a safety update.
- **No screen-reader testing.** ARIA roles, live regions, focus trapping and
  focus restoration were verified programmatically, not with VoiceOver or
  TalkBack.
- **No automated contrast audit.** Contrast was designed for, not measured.

## Scope

Not built: multi-medication catalogue, accounts, saved history, notifications,
internationalisation, NFC tag writing (an NFC tag can carry
the same public URL, but nothing in the app depends on it).

The `/doctor` workspace is a **DocUpdate Integration Preview**, not an actual
DocUpdate or Impiricus integration. It shares the existing public guide, with
no patient-specific records, authentication, prescriptions, or delivery tracking.
Doctor-side sharing requires a configured public HTTPS origin. OS sharing still
requires physical-device testing.

---

## Added during the repair pass

- **CMS formulary data is not ingested.** The integration is complete and
  tested, but `src/sources/content/coverage/cms-part-d-snapshot.json` does not exist in
  this environment, so coverage still reports "unable to verify". The source
  archive is ~2.2 GB. Run `npm run coverage:ingest`.
- **CMS data is Medicare Part D only.** Commercial and Medicaid plans are not in
  the dataset. Those plans return `unable-to-verify`, never "not covered".
- **Plan matching is token-overlap, not authoritative.** A conservative
  threshold (0.6) means a weak match returns "could not match that plan" rather
  than guessing. It can still fail to match a plan the user names correctly.
- **The snapshot is a point-in-time copy.** Formularies change mid-year. The
  release label and retrieval timestamp are shown on every result.
- **Elliptical detection is heuristic.** It keys on anaphors, continuation
  openers and content-token count. "this"/"it" are deliberately NOT anaphors —
  on a single-medication page they refer to the drug — which means a genuinely
  ambiguous "is it safe?" about something else may not trigger clarification.
- **The carried handoff question is not persisted.** Closing the sheet discards
  it. That is intentional (nothing is stored), but it means the question is lost
  if the user navigates away.
