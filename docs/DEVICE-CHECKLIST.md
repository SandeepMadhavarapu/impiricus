# Physical-device verification checklist

**Status: NOT TESTED.** No item below has been performed on a physical device.

Browser automation cannot exercise OS-level sharing. A passing automated test
suite says nothing about whether AirDrop or Quick Share actually work, because
the Web Share API hands off to the operating system and the website has no
visibility into — or control over — what happens next.

## Prerequisites

1. Deploy to a public **HTTPS** origin. `navigator.share` and the Clipboard API
   both require a secure context, and `buildShareUrl` refuses non-https origins.
2. Set `PUBLIC_ORIGIN` to that origin. Without it, links and QR codes point at
   `localhost` and will fail on every other device.
3. Confirm the page shows no "PUBLIC_ORIGIN is not configured" operator warning.

---

## iPhone — Safari

| # | Test | Expected | Result |
|---|---|---|---|
| 1 | Open the medication URL | Content visible without scrolling past a splash | Not tested |
| 2 | Tap "Share medication information" | The iOS share sheet opens | Not tested |
| 3 | Check the sheet lists AirDrop | AirDrop appears among OS-provided options | Not tested |
| 4 | AirDrop to a second iPhone | Second device receives the link and opens the right page | Not tested |
| 5 | Dismiss the share sheet without sharing | "Sharing cancelled." — no error styling, no scary message | Not tested |
| 6 | Tap "Copy link", paste into Messages | Bare public URL, no query string | Not tested |
| 7 | Open the chat sheet, focus the input | Composer stays visible above the keyboard; log still scrollable | Not tested |
| 8 | Rotate to landscape with the chat open | Layout holds; no clipped controls | Not tested |
| 9 | VoiceOver through the page | Boxed warning announced; citations reachable; dialog announced as modal | Not tested |
| 10 | Settings → Reduce Motion, reopen the sheet | No slide-up animation, no spinner rotation | Not tested |

## Android — Chrome

| # | Test | Expected | Result |
|---|---|---|---|
| 11 | Open the medication URL | Content visible immediately | Not tested |
| 12 | Tap "Share medication information" | Android share sheet opens | Not tested |
| 13 | Check for Quick Share | Appears where the OS and device support it | Not tested |
| 14 | Quick Share to a second Android device | Second device receives the link and opens the right page | Not tested |
| 15 | Back-gesture out of the share sheet | Treated as cancellation, not failure | Not tested |
| 16 | Chat with the keyboard open | `dvh` sizing keeps the composer visible | Not tested |
| 17 | TalkBack through the page | Same expectations as VoiceOver | Not tested |

## QR scanning

| # | Test | Expected | Result |
|---|---|---|---|
| 18 | iPhone camera at the on-screen QR | Opens the correct medication page | Not tested |
| 19 | Android camera / Google Lens | Same | Not tested |
| 20 | Printed QR at ~4cm | Still scans (error correction level M) | Not tested |
| 21 | QR in dark mode | Code renders on a white plate — must still scan | Not tested |

## Clipboard fallback

| # | Test | Expected | Result |
|---|---|---|---|
| 22 | Desktop browser without Web Share (e.g. Firefox) | Primary button reads "Copy link to share" | Not tested |
| 23 | Deny clipboard permission | "select the link below and copy it manually" + the link is selectable | Not tested |

## Real destinations

| # | Test | Expected | Result |
|---|---|---|---|
| 24 | Tap 988 on a phone | Dialler opens with 988 | Not tested |
| 25 | Tap Poison Help 1-800-222-1222 | Dialler opens correctly | Not tested |
| 26 | Tap "Text HOME to 741741" | SMS composer opens, prefilled | Not tested |
| 27 | Open HRSA Find a Health Center | Real HRSA site loads | Link verified by fetch 2026-09-19; not tapped on device |
| 28 | Open Medicare Care Compare | Real CMS site loads | Link verified by fetch 2026-09-19; not tapped on device |

## Coverage integration

| # | Test | Expected | Result |
|---|---|---|---|
| 29 | Submit the coverage form | "Unable to verify with the available connection" | Verified in a desktop browser; not on device |
| 30 | With a real payer credential | Genuine evidence state | **Cannot be tested — no credential exists** |

---

## Sign-off

| Device | OS version | Browser | Tester | Date | Items passed |
|---|---|---|---|---|---|
| | | | | | |
