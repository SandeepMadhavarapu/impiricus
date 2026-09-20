# Nearby Sound Sharing — Experimental

This is an independent hackathon prototype, not an Impiricus production integration.
It does not detect nearby devices in the background or verify patient identity.

## Setup and session design

Set `PUBLIC_ORIGIN` to the existing public HTTPS origin. Set `NEARBY_SHARE_SECRET`
to 64 hex characters generated with `openssl rand -hex 32`. Keep this server-only
secret identical on all instances and on separate doctor/patient deployments.
Production fails closed with a 503 if the secret is missing or malformed; normal
sharing remains available. Do not commit the secret.

There is no database or in-memory session map. AES-256-GCM authenticates and hides
an eight-byte payload: expiry timestamp and a four-byte SHA-256 registry identifier.
A cryptographically random 96-bit nonce makes each token different; the 128-bit
authentication tag detects tampering. The 36-byte token is represented as 72 hex
characters. Resolution requires exactly one matching supported medication in the
existing registry; hash collisions fail closed. No caller-provided URL is accepted.
The server returns the existing `/medications/[slug]` path and registry-derived label.

Sessions expire after 120 seconds and are reusable until expiry. There is no
redemption tracking, revocation, delivery acknowledgment, authentication, or distributed
rate limiting. Anybody who hears the signal can resolve the public guide during
that window. This is not a confidential transfer of medical records. A random
nonce plus authenticated ciphertext makes an opaque token; the acoustic packet
has no readable medication name, PHI, identity, insurance details, or URL.

`POST /api/share-sessions` accepts `{ "medicationSlug": "..." }` and returns
`token`, `expiresAt`, and a token-free `receiveUrl`. `POST /api/share-sessions/resolve`
accepts `{ "token": "..." }`. Both use `Cache-Control: no-store`. POST resolution
keeps tokens out of ordinary URL access logs/history. Do not enable request-body
logging for these endpoints. No nearby token is sent to analytics.

Development without a configured key uses a process-global random key (survives
HMR, not restarts). This fallback is single-process demo-only. It will NOT work
reliably across serverless instances. Configure the shared key for those deployments.

## Local test without sound

1. Run `npm run dev` and open `http://localhost:3000/doctor`.
2. Select Singulair. In the share area, expand **Demo / developer tools**.
3. Press **Create token without sound** and copy the temporary token.
4. Open `/receive`, expand **Demo / developer tools**, paste, and press **Resolve token**.
5. Verify **Medication guide received**, the registry product label, and **Open medication guide**.
6. Try a modified token and a token older than two minutes; both must fail safely.

Developer tools exist only in development builds. Local nearby testing is allowed
without the public-origin setup; the existing normal-sharing deployment gate remains.

## Two physical phones

Use the same HTTPS deployment (or deployments sharing the secret and registry).
HTTPS is required for microphone access on physical devices; localhost is acceptable
in development where browser rules permit it. A LAN HTTP address is not localhost.

DEVICE A — HCP

1. Open deployed `/doctor`.
2. Select Singulair.
3. Locate the **Share with Patient** share area and its **Send Nearby** option.
4. Press **Send Nearby** to prepare the sound. Wait until Device B shows **Microphone ready**,
   then tap **Play sound**. Use media volume and the built-in speaker, not headphones.

DEVICE B — PATIENT

1. On any patient medication page, choose **Receive guide with sound**, or open
   **Connect with a provider → My own doctor or prescriber** to use the embedded
   listener. The standalone deployed `/receive` page also works. No sign-in is needed.
2. Press **Listen for guide**.
3. Allow microphone access.
4. Hold the phone near Device A (start with 10–30 cm in a quiet room).
5. Device A sends the signal twice over about 35 seconds. It may be stopped once the patient receives the guide.
6. Verify Device B shows **Medication guide received** with the correct product.
7. Press **Open medication guide** and confirm the existing patient guide opens.

Keep both screens foregrounded and unlocked. Use built-in speakers, disable headphones,
and start at moderate-to-high volume. If transfer fails, retry after checking volume
and permissions; use existing **Share normally / Share with Patient**, AirDrop,
Messages, or Copy Link as the fallback. “Signal sent” does not confirm receipt.

## Acoustic protocol and browser behavior

Pure codec: `shared/lib/nearby-share/protocol.ts`. Fixed packet: `MB`, version 1,
36 opaque token bytes, CRC16-CCITT-FALSE. Each byte becomes two four-bit symbols.
The sender uses 16-FSK at 900–2400 Hz, 100 Hz apart; 2700 Hz is a clock delimiter
and 3000 Hz is a 600 ms preamble. Each nibble has an 80 ms clock and a 120 ms data
tone, with 4 ms amplitude ramps. The packet repeats twice, with a 500 ms gap,
for 34.5 seconds total. Audible midrange
frequencies avoid ultrasound and phone hardware extremes. The slower per-symbol
clock handles repeated symbols and avoids cumulative timing drift.

The receiver uses a 2048-point AnalyserNode, 10 ms polling, two consistent detections,
a ±35 Hz bin tolerance, a -65 dB threshold, and 7 dB separation from competing tones.
CRC detects corruption; server authentication is separate. No correction or automatic
retransmission exists. Listening times out after 30 seconds. Microphone tracks and
AudioContext are stopped on success, error, timeout, cancel, page hiding, and unmount;
late permission results after cancellation are immediately stopped. Microphone
Permissions-Policy permits same-origin microphone access on `/receive` and
`/medications/:slug`, where the embedded patient listener lives. Other routes
keep microphone access disabled. No listener starts until the patient presses Listen.

Browser microphone access requires explicit permission. The receiver resumes its
AudioContext within the Listen gesture. The sender generates a PCM WAV and uses
HTML media playback rather than Web Audio oscillators, because iPhone silent mode
can mute Web Audio. Token preparation and playback are separate steps so
`audio.play()` runs directly inside the Play sound gesture, without a network wait.
The page permits local blob media through CSP and cleans up the audio and blob URL
on cancellation or unmount. Startup and completion timeouts report stalled playback. See
[Web Audio](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext) and
[getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).
Safari cannot automatically listen while closed or locked. Background timer throttling,
echoes, noise processing, Bluetooth routing, volume, microphone frequency response,
and permission policies may interrupt or corrupt packets. Capture processing-disable
constraints are requests; devices can ignore them.

## Validation and remaining experiments

Unit tests cover API/client resolution, registry restrictions, randomization, expiry,
tampering, CRC vectors, every single-symbol corruption, packet framing, synthetic
frequency bins, and microphone lifecycle with mocked browser APIs. Existing native
sharing tests remain intact. Synthetic tests are NOT proof of acoustic reliability.
Real iPhone Safari and Android Chrome testing is still required. No physical transfer
success is claimed. Start with one quiet-room laptop-to-phone packet, then two iPhones;
the wider 80/120 ms slots and repeated packet improve recovery but still need
real-device validation in each target environment. Also test denial/retry, cancel during
permission prompt, timeout, switching tabs, locked screen, expired tokens, two
simultaneous senders, and fallback AirDrop.

The root app TypeScript config excludes the separately configured `data-pipeline`
package; its own typecheck/test scripts remain responsible for that package.

The receiver announces readiness only after microphone permission and audio startup.
Its 60-second listening window starts at that point, with a separate 60-second setup
timeout. Corrupt packets are discarded while listening continues for a repeated packet;
no unverified token is opened. Tests cover corruption recovery and delayed permission.
