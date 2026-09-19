# 90-second demo script

**Setup:** deploy to HTTPS with `PUBLIC_ORIGIN` set, or run locally and demo the
QR on-screen. Leave `ENABLE_SAMPLE_COVERAGE` **unset** — the honest
"unable to verify" result is the stronger demo, and sample data risks being
mistaken for real payer data in a room full of people.

Have the page already open on a phone, mirrored.

---

### 0:00 — The link (10s)

> "Someone shares a medication link with a friend. Real share sheet — on iPhone
> that includes AirDrop, on Android it can include Quick Share. That's the
> operating system's job, not ours. We hand it a public URL and step back."

Tap **Share medication information**. Show the sheet. **Dismiss it.**

> "Cancelling is a normal outcome, so we say 'Sharing cancelled' — not an error.
> And notice we never claim it was delivered. We can't see that, so we don't say
> it."

### 0:10 — What the recipient sees (20s)

Scroll the page.

> "No app install, no account, no splash screen. Straight to the medication:
> Singulair, 10 mg tablet — and immediately, the FDA boxed warning about serious
> mental-health effects. Most people taking this drug don't know it's there.
>
> Benefits and risks get the same visual weight. And every single claim is
> checkable —"

Expand a **Sources** disclosure.

> "— that's the exact FDA label text, with the section number and a link to
> DailyMed. A test in the repo asserts that every quote on this page is a
> literal substring of the label we downloaded. If a quote drifts, the build
> fails."

### 0:30 — Ask a question (25s)

Tap **Learn more**, then **What are the common side effects?**

> "It answers from the label and shows the passages it used."

Point at the mode badge.

> "This badge is the important part. Right now there's no model key configured,
> so it says 'Label text · not AI' — this is verbatim label text, not a
> generated answer. We never dress canned text up as live AI.
>
> With a key set, the badge reads 'AI answer · grounded in the label', and the
> model may only cite passage IDs we actually retrieved. If it invents a
> citation, we drop it. If *every* citation is invented, we withhold the answer
> entirely and show the label text instead. That's tested."

Type: **"Does this cure diabetes?"**

> "And when the label doesn't cover something, it says so rather than guessing."

### 0:55 — Safety (10s)

Type: **"I took too many tablets"**

> "Poison Control, immediately. No provider form, no insurance check, no
> conversation in the way. Same for a crisis statement — that routes to 988.
>
> But asking *'can this cause suicidal thoughts?'* still gets a real answer from
> the boxed warning, with crisis resources alongside. Intercepting that question
> would defeat the entire point of a public-awareness tool."

### 1:05 — Provider (10s)

Tap **Connect with a provider**.

> "'Connect me with a provider' means four different things, so we ask. A
> pharmacist can usually answer today, for free.
>
> Telehealth booking says **Not available** — we have no scheduling integration,
> so we don't pretend. The directories are real HRSA and CMS services, and we
> state plainly that a listing doesn't mean they're accepting patients or take
> your insurance."

### 1:15 — Coverage (15s)

Tap **Check coverage**, fill a plan, submit.

> "Coverage depends on strength, form, quantity and days' supply — so we ask for
> those, and we deliberately don't ask for a member ID or a photo of your card.
>
> And the result: **unable to verify.** We have no payer connection, so that's
> the truthful answer. Note what it does *not* say — it doesn't say 'not
> covered', and every field reads 'Not available', never a fabricated $0 copay.
> A timeout or a crash produces this same state, never a positive one. That's
> tested with a deliberately broken adapter.
>
> Then the genuinely useful step: ask your pharmacy to run a test claim. That's
> the only thing that gives a binding answer."

### 1:30 — Close

> "135 tests. The interesting ones aren't the happy paths — they're the ones
> asserting we *refuse* to answer: fabricated citations, broken coverage
> lookups, wrong-strength requests, and out-of-scope questions."

---

## If asked

**"Is this the real Impiricus assistant?"**
No. Independent prototype, stated in the banner on every page. The adapter
boundary is built and the audience check is enforced; the integration itself
needs official documentation and an authorised patient-scope credential.

**"Why one medication?"**
A shallow catalogue would have meant unsourced content. One product, fully
sourced and scoped to a single strength and dosage form, demonstrates the
evidence model that a catalogue would need.

**"Does AirDrop actually work?"**
Not tested on hardware — see `docs/DEVICE-CHECKLIST.md`, where every item is
marked Not tested. Browser automation cannot prove an OS-level transfer.

**"What's the one thing missing?"**
`ANTHROPIC_API_KEY`. That switches the assistant from label-excerpt mode to
grounded conversational answers. Everything behind it — prompt, citation
validation, failure handling — is built and tested against a stub adapter.
