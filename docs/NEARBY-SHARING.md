# Nearby Sound Sharing — Experimental

## Two-second public guide sound

The sender plays a **1.95-second** PCM WAV through an HTML audio element. It sends
one stable public medication identifier and an error check, not an encrypted token,
patient record, prescription, identity, or insurance details. The code is public
and replayable. It does not authenticate a doctor or confirm who sent it. The
patient sees the medication name and explicitly chooses **Open medication guide**.

Codes are pinned in `src/shared/lib/nearby-share/public-guides.ts`:

| Code | Guide |
|---|---|
| 01 | Singulair 10 mg tablet |
| 02 | Toprol XL 50 mg extended-release tablet |
| 03 | Ozempic 1.34 mg/mL injection |

Never reassign an existing code or derive codes from catalogue ordering. Add new
codes explicitly; unsupported codes fail closed. Both deployments need the same
mapping. No caller-supplied destination URL is accepted.

## Use on two devices

1. Patient: open `/receive`, or **Connect with a provider → My own doctor or prescriber**.
2. Press **Listen for guide**, allow microphone access, and wait for **Microphone ready**.
3. Doctor: select the guide at `/doctor`, press **Send Nearby**, then **Play sound**.
4. Keep the devices nearby, both screens open, media volume up, and headphones disconnected.
5. The patient confirms the displayed medication and presses **Open medication guide**.

There is no automatic long repeat. If reception fails, the doctor taps **Play sound**
again while the patient keeps listening. The receiver discards damaged packets and
continues listening for a retry for up to 60 seconds. Its listening window starts
after microphone permission and startup; setup has its own 60-second timeout.
Cancel, unmount, backgrounding, successful receipt and timeout stop the microphone.

## Deployment and APIs

Use HTTPS and set `PUBLIC_ORIGIN` to the deployed origin. Compact sounds require
no secret or database. `POST /api/guide-sounds` accepts `{ medicationSlug }` and
returns `{ code, receiveUrl }`. `POST /api/share-sessions/resolve` accepts
`{ guideCode }`, validates it against the supported catalogue, and returns its
label and local medication path. Responses are no-store. Audio stays on the device;
only the decoded public code is submitted. Do not log request bodies.

The old encrypted-token endpoints and MB1 decoder remain available for compatibility.
Those tokens still expire after 120 seconds and require matching `NEARBY_SHARE_SECRET`
values across production instances. New compact sounds do not use those tokens.

## Acoustic format and Safari playback

Four bytes: `0xd2` (marker/version), one public guide byte, CRC16-CCITT over those
two bytes. Eight four-bit symbols follow a 350 ms preamble. Each symbol has an
80 ms clock and a 120 ms data tone: 0.35 + 8 × 0.20 = **1.95 seconds**.
The frequencies remain 900–2400 Hz for data, 2700 Hz for clock, and 3000 Hz for
preamble, with 4 ms ramps. Error checking detects damage; it is not cryptographic
authentication. Keeping the wider tone intervals avoids relying on faster sampling.

The WAV is prepared before the **Play sound** click. `audio.play()` runs directly
inside that click, without waiting for a network request, to preserve Safari user
activation. Media playback avoids Web Audio’s iPhone silent-switch behavior.
Blocked or stalled playback produces an error. Completion does not confirm receipt.
CSP permits self/blob media; same-origin microphone access is permitted only on
`/receive` and `/medications/:slug`.

## Validation and limitations

Tests cover the fixed mapping, all three guide/API round trips, the WAV duration,
every single-symbol packet corruption, unknown-code rejection, delayed permission,
retry recovery, cancellation, and legacy compatibility. Browser loopback tests
exercise real WAV playback and decoding, but do not establish physical-phone
reliability. Noise, volume, Bluetooth routing and phone microphone processing
still require device testing. Use QR code or normal link sharing if sound fails.
