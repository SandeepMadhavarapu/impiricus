# NFC Tap Point — hardware proof of concept

## Scope and current evidence

MedBridge doctor UI → Web Serial/USB → Arduino UNO R4 WiFi → standard `Wire`
I2C through the Grove Base Shield → Seeed Grove ST25DV64 user EEPROM/NDEF memory.

The browser and firmware are implemented. The sketch **compiles** for the official
UNO R4 WiFi package. Automated browser transport tests use explicit test doubles;
they are not a hardware emulator or evidence that the attached chip was programmed.
**No sketch has been uploaded and no physical write/read verification has been
performed as part of this implementation.** Run the procedure below for that proof.

The external 13.56 MHz antenna is unavailable. RF communication to an iPhone is
**not demonstrated**. A successful I2C read-back does not mean “ready for phone tap”.
The firmware never emits VERIFIED based on elapsed time or a browser state change.

## Dependencies and verified APIs

- Arduino IDE 2.x (or Arduino CLI).
- Boards Manager: **Arduino UNO R4 Boards**, publisher Arduino. Validated with
  `arduino:renesas_uno` **1.6.0**, board **Arduino UNO R4 WiFi**,
  FQBN `arduino:renesas_uno:unor4wifi`.
- Library Manager: **STM32duino ST25DV**, publisher STMicroelectronics, **2.2.0**.
- `Wire` is supplied by the board package. No custom SDA/SCL pins or GPIOs are used.
- Chrome or Edge on the demo computer, using HTTPS or localhost with Web Serial.

The dependency's actual header/source was inspected: `ST25DV_IO` constructor,
`ST25DV_i2c_ReadID`, `ST25DV_i2c_WriteData`, and the device/address constants exist.
Its low-level driver is used directly so we do not initialize the example's GPO
pin, which is not present on this Grove connection. Including `ST25DVSensor.h`
lets Arduino find the library; we do not instantiate its high-level sensor class.

The upstream memory-read helper does not check that `requestFrom` returned every
requested byte. Our `readChip` instead uses standard Wire transactions and checks
the returned byte count. This is essential to avoid accepting stale RAM as proof.
Writes use 16-byte chunks through the official driver, which polls EEPROM readiness.
The firmware checks the ST25DV64K/KC IC ID and does not change passwords, lock bits,
RF configuration, or memory-area protection. A protected chip may reject writes.

**Compatibility warning:** the library's architecture metadata lists STM32/AVR/SAMD/ARC32,
not Renesas. Its unmodified 2.2.0 source successfully compiled for UNO R4 WiFi here;
physical I2C operation still requires manual validation. Do not suppress the warning
or interpret compilation as proof of electrical compatibility.

Primary references:

- [Seeed Grove ST25DV64 guide](https://wiki.seeedstudio.com/grove-nfc-st25dv64/)
- [STMicroelectronics Arduino library](https://github.com/stm32duino/ST25DV)
- [Verified low-level driver header](https://github.com/stm32duino/ST25DV/blob/main/src/ST25DV_IO/st25dv_io.h)
- [Driver implementation](https://github.com/stm32duino/ST25DV/blob/main/src/ST25DV_IO/st25dv_io.cpp)
- [Type 5 CC/NDEF reference implementation](https://github.com/sparkfun/SparkFun_ST25DV64KC_Arduino_Library/blob/main/src/SparkFun_ST25DV64KC_NDEF.cpp)
- [Web Serial browser requirements and lifecycle](https://developer.chrome.com/docs/capabilities/serial)

## Arduino IDE setup (manual)

1. Confirm the connected board is the **UNO R4 WiFi**. Keep the Grove module on
   the Base Shield's I2C connector using its existing GND/VCC/SDA/SCL connection.
   Check power/shield configuration against the actual hardware documentation;
   this sketch does not infer or change voltage settings.
2. Install **Arduino UNO R4 Boards 1.6.0** in Boards Manager and
   **STM32duino ST25DV 2.2.0** in Library Manager.
3. Open `medbridge_nfc_tap/medbridge_nfc_tap.ino`; keep `NdefUri.h` in that same folder.
4. Select **Arduino UNO R4 WiFi** under Tools → Board. Select its actual USB port
   using Arduino IDE's detected board/port list. Do not copy a guessed device path.
5. Click **Verify**. The library architecture warning described above is expected.
6. Click **Upload**. This replaces the board's current sketch. Programming through
   the demo later overwrites the first 256 bytes of NFC user memory.
7. Open Serial Monitor at **115200 baud**, newline or both NL & CR. On reset,
   expect `READY MEDBRIDGE_NFC` or `ERROR 00000000 INIT_FAILED`.
8. Send `HELLO 00000001`. Expect `READY 00000001 MEDBRIDGE_NFC`. If initialization
   fails, check the board selection, USB data cable, I2C connection and module power.
9. Close Serial Monitor before connecting from the browser; only one application
   can own the serial port. Also close any other serial terminal.

There is no EEPROM write on boot, HELLO, or READ_NDEF. Firmware upload itself is
separate from programming the NFC chip. Do not run a library example that writes
its sample URL unless intentionally testing that example.

## Browser setup and judging demo

1. Set the existing `PUBLIC_ORIGIN` in `.env.local` to the public **HTTPS** deployment
   containing the current patient-guide routes. Restart `npm run dev` after changing
   configuration. The browser may run locally; the NFC URL must remain public HTTPS.
   No localhost test exception, credentials, PHI, query, or fragment is accepted.
2. Open `http://localhost:3000/doctor` in Chrome/Edge (or an HTTPS deployment).
3. Select **Ozempic** from the existing medication catalogue. The selection, preview,
   name and URL all use the current source of truth; no medication is hardcoded in NFC.
4. In Step 3, locate **NFC Tap Point**. Confirm its displayed patient-guide URL.
5. Click **Connect NFC Hardware** and choose the UNO R4 WiFi USB port. A permission
   prompt is shown only after this click. Connection is confirmed only after a
   correlated firmware HELLO reply and chip ID check. Allow up to 12 seconds.
6. Click **Program NFC**. Observe Writing, then Reading. Only a matching VERIFIED
   reply can display **NFC PROGRAMMED & VERIFIED** and the verified URL.
7. Click **Read NFC Memory**. It independently retrieves the chip's current record
   and displays **NFC MEMORY READBACK**. It does not write and does not reuse the
   browser's previously requested URL.
8. Select **Singulair** using the existing library. The connection stays open across
   this client navigation, the target URL updates, and the old verification is cleared.
   Click **Program NFC**, then **Read NFC Memory** again. Compare the two different URLs.
9. For stronger evidence, disconnect/reconnect or power-cycle the board, then read
   NFC memory again. The last successfully programmed URL should persist.
10. Click **Disconnect** when done. Existing native share, AirDrop, Copy Link and QR
    controls are unchanged and remain available under their existing origin rules.

Unsupported browsers display an explanation instead of throwing. Cancelled port
selection, disconnect, write/read errors, malformed responses, and a mismatched URL
never display verified success. Serial commands time out after 12 seconds; after
timeout, reconnect and **read memory before retrying**, because a timed-out write
might have completed on the chip. Operations are serialized. Partial/disconnected
writes are not transactional; there is no claim of rollback.

## Serial protocol v1

115200 baud; printable ASCII, newline-delimited, CRLF accepted. Each request uses
an eight-character lowercase hex ID. The browser creates fresh random IDs and
accepts terminal replies only for its current request. IDs are correlation values,
not authentication. No local echo is treated as verification. Firmware is trusted;
this prototype does not cryptographically attest the chip or firmware.

```text
READY MEDBRIDGE_NFC

> HELLO a1b2c3d4
READY a1b2c3d4 MEDBRIDGE_NFC

> PROGRAM_NDEF_URI a1b2c3d5 https://your-public-host.example/medications/<current-catalogue-slug>
STATUS a1b2c3d5 WRITING
STATUS a1b2c3d5 READING
VERIFIED a1b2c3d5 https://your-public-host.example/medications/<current-catalogue-slug>

> READ_NDEF a1b2c3d6
STATUS a1b2c3d6 READING
NDEF_URI a1b2c3d6 https://your-public-host.example/medications/<current-catalogue-slug>
```

Replace placeholders with the actual URL displayed by `/doctor`; angle brackets
are not accepted. Omit the illustrative `>` prompt when typing commands.

Errors: `ERROR <id> INIT_FAILED|WRITE_FAILED|READ_FAILED|VERIFY_MISMATCH|INVALID_URL|MALFORMED_COMMAND`.
An unparseable/oversized command uses ID `00000000`. The browser never sends arbitrary
patient-entered URLs; the target is server-derived from the registered catalogue.
The firmware validates HTTPS guide URL shape and length, but has no copy of the
medication catalogue or allowed deployment domain: access to the serial port is
trusted operator access, not an authorization boundary.

## NDEF layout and what verification proves

Maximum URL: 240 ASCII bytes. The 256-byte memory image contains:

- Eight-byte NFC Forum Type 5 capability container:
  `E2 40 00 01 00 00 03 FF` (8 KiB device, 8184-byte data area).
- NDEF Message TLV (`03`, short length).
- One short, well-known URI record (`D1 01 <payload-length> 55 04 ...`).
  `04` encodes `https://`; the remaining bytes are the URL after that prefix.
- Terminator TLV `FE`, then zero padding through byte 255.

The sketch invalidates TLV length, writes the CC/body, then publishes the correct
length. After successful writes it issues new I2C reads into a separate buffer,
checks every received byte, compares all 256 bytes, decodes the record, and compares
the decoded URI to the command. Only then does it emit VERIFIED, with the URI
obtained from the read buffer. There is no simulation path.

`READ_NDEF` independently reads and validates this prototype's CC and URI layout.
Blank tags or other NDEF layouts return READ_FAILED; this is deliberately not a
general-purpose NDEF parser. Bytes outside the first 256 are untouched. The prior
URL is overwritten; there is no patient data or token written to the tag.

Once an appropriate antenna is attached, the intended separate test is:
iPhone NFC read → public HTTPS patient guide. Antenna tuning, RF readability,
iPhone notification/open behavior, and NDEF interoperability must all be tested
physically before claiming that path works.

## Checks and reproduction

App checks: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`.

Firmware compile (no upload):

```sh
arduino-cli core install arduino:renesas_uno@1.6.0
arduino-cli lib install 'STM32duino ST25DV@2.2.0'
arduino-cli compile --fqbn arduino:renesas_uno:unor4wifi hardware/nfc-tap/medbridge_nfc_tap
```

Actual compile result: 60,712 bytes flash / 262,144; 10,068 bytes global RAM / 32,768.

Pure C++ NDEF checks (not a hardware test):

```sh
c++ -std=c++11 -Wall -Wextra -Werror hardware/nfc-tap/tests/ndef-uri.test.cpp -o /tmp/medbridge-ndef-test
/tmp/medbridge-ndef-test
```

Automated tests cover current catalogue targets, unsafe URLs, protocol framing,
verification gating, stale IDs, fragmented replies, mismatches/errors, timeouts,
unplugging, write failure, stream lock cleanup, and changing the target medication.
Physical USB permissions, I2C writes/reads, protection state, power stability, and RF
remain manual checks. No board/package settings or existing clinical content were changed.
