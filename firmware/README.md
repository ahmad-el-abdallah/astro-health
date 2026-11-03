# Astro Health Station -- firmware

Two sketches, two boards:

- **`astro_cyd/`** -- the CYD (ESP32-2432S028R). It does three things:
  1. Receives NFC tag taps from the separate ESP32-S3 reader board over ESP-NOW (see "NFC" below).
  2. Shows the 12 screens from `docs/build-prompt.md` section 10, and reads the touchscreen.
  3. Talks to the laptop over USB serial, one JSON line per message (`docs/build-prompt.md` section 6).
- **`esp32s3_nfc_reader/`** -- the separate ESP32-S3 board. Reads the PN532 and relays every
  UID to the CYD above over that same ESP-NOW link (see "The ESP32-S3 reader sketch" below).

## Libraries (install via Arduino IDE Library Manager, or `arduino-cli lib install "<name>"`)

| Library | Version used here | Used by |
| --- | --- | --- |
| TFT_eSPI (Bodmer) | 2.5.43 | `astro_cyd/` |
| XPT2046_Touchscreen (Paul Stoffregen) | 1.4.0 | `astro_cyd/` |
| ArduinoJson (Benoit Blanchon) | 7.4.3 | `astro_cyd/` |
| Adafruit_PN532 (Adafruit) | 1.3.4 | `esp32s3_nfc_reader/` |

Board core: **esp32 by Espressif Systems**. Board/FQBN used to compile-check `astro_cyd/`:
`esp32:esp32:esp32:PartitionScheme=huge_app` (same board entry Lifeline's `build.sh` uses).
`esp32s3_nfc_reader/` uses `esp32:esp32:esp32s3` instead (different chip).

## TFT_eSPI setup

TFT_eSPI normally wants its pin configuration in a `User_Setup.h` inside the *library*
folder. Instead, `tft_setup.h` in this sketch folder defines `USER_SETUP_LOADED 1` plus every
pin/driver macro. `TFT_eSPI.h` specifically looks for a file named exactly `tft_setup.h` via
`__has_include(<tft_setup.h>)`, searched on the compiler's include path — and Arduino puts the
sketch folder on that path for every file it compiles, library code included. That's what
makes a sketch-local config apply library-wide without editing `User_Setup.h`.

This has to be a separate header, not a `#define` block at the top of `astro_cyd.ino`:
`TFT_eSPI.cpp` is compiled as its own translation unit, as part of the library, and never sees
`#define`s written in a `.ino` file — only in a file named `tft_setup.h` that it explicitly
`__has_include`s. An earlier version of this sketch had the config inline in `astro_cyd.ino`
and the display stayed black despite the settings looking right; moving it into `tft_setup.h`
is what fixed it.

Pins (from the CYD pin map in `~/Desktop/Lifeline/lifeline-firmware/lifeline-firmware.ino`,
reused here since it's proven on this exact board, even though that project uses a different
graphics library):

| Signal | Pin |
| --- | --- |
| TFT SCLK / MOSI / MISO / DC / CS | 14 / 13 / 12 / 2 / 15 |
| TFT backlight | 21 |
| Touch SCLK / MOSI / MISO / CS / IRQ | 25 / 32 / 39 / 33 / 36 |
| RGB LED (active low) R / G / B | 4 / 16 / 17 |
| Speaker | 26 |

**Rotation**: set to `1` in `setup()`. If the image comes out upside-down or mirrored on
your actual board, try `3` (that's what the LovyanGFX-based Lifeline sketch uses) -- this
wasn't verified on real hardware for this project.

**Touch calibration**: `TS_MINX`/`TS_MAXX`/`TS_MINY`/`TS_MAXY` at the top of `astro_cyd.ino`.
If taps land in the wrong place, add a temporary `Serial.printf` of the raw `ts.getPoint()`
x/y in `getTouchXY()`, tap all four corners of the screen, and update the four constants
from what you see.

**microSD CS pin**: `SD_CS_PIN` in `protocol.ino` is set to `5`, a commonly-cited value for
this board in community sketches -- **not verified** on our hardware. The SD card is
optional (`docs/build-prompt.md` section 10: "If an SD card is present..."); if `SD.begin()`
fails, the firmware just runs without it (no queue/log persistence across a reboot, but
everything else works).

## NFC: the two-board ESP-NOW link, not a PN532 wired to this board

`docs/build-prompt.md` section 3 describes a PN532/MFRC522 wired straight to the CYD. Our
actual hardware is different: the PN532 is wired to a separate ESP32-S3 "reader" board, whose
own firmware now lives in this repo too -- `firmware/esp32s3_nfc_reader/` (2026-11-04; see
below) -- and relays every UID to this CYD over encrypted, signed ESP-NOW, the same link the
"Lifeline" NFC-lock project uses. We kept that link rather than rewiring an NFC reader onto
this board, so:

- `nfc_link.h` here must stay byte-for-byte identical to
  `firmware/esp32s3_nfc_reader/nfc_link.h` -- same MACs, channel and keys, because it's the
  same two physical boards. (It also matches Lifeline's own copy at `firmware/existing/`,
  which is reference-only and not wired to anything here.)
- `nfc.ino` is the CYD side of that link (`setupLink()`, `handleLink()`): it sends
  `LINK_HELLO` challenges, accepts a `LINK_TAG` only if its nonce is current/previous
  (replay protection), and turns every accepted tag into a `scan` message upstream to the
  laptop -- instead of a lock/unlock decision, which is what Lifeline does with it.
- The `readCardUid()` / `NFC_MODULE` (PN532 vs MFRC522) switch from the build prompt doesn't
  apply here: on the CYD side, "a card was read" means "an ESP-NOW `LINK_TAG` frame arrived",
  full stop.

Real NFC cards get formatted as colon-separated hex (e.g. `04:A1:B2:C3`, same convention as
Lifeline). `backend/seed.py` no longer seeds any fake object-tag UIDs by default (removed
2026-11-04, at the user's request, once real crew cards were in use) -- a real card's hex UID
shows up as "Unknown card" the first time it's scanned, and you assign it to an astronaut or
object from the superuser admin page (`/admin`, see the repo root README's "Superuser admin
page").

## The ESP32-S3 reader sketch (`firmware/esp32s3_nfc_reader/`, 2026-11-04)

Reads the PN532 over UART (HSU mode) and sends every UID to the CYD above. Ported from the
user's own separate, already-working project
(`github.com/ahmad-el-abdallah/ESP32S3-NFC-Reader`, PlatformIO) rather than written from
scratch -- a first pass at this guessed at pins and tuning with no real board to test against,
which was the wrong starting point once a working, measured-good version existed.

- **Library**: Adafruit\_PN532 (install the same way as the others, "Libraries" table above).
  Board: `esp32:esp32:esp32s3`.
- **Real, confirmed wiring** (PN532 V3, UART mode, switches SW1/SW2 both OFF -- read only at
  power-up, so unplug USB after changing either one): PN532 VCC -> 3V3, GND -> GND,
  TXD -> ESP32-S3 GPIO 4, RXD -> ESP32-S3 GPIO 5. No reset pin (the PN532 V3's 4-pin header
  doesn't expose one). These are now the actual constants in `esp32s3_nfc_reader.ino`, not
  placeholders.
- **The real cause of "takes a while / need to hold it close"**, per that project's own
  measurements (2026-10-24): Adafruit_PN532's UART driver reads a fixed-length reply (20 bytes
  after a card poll), but a 4-byte UID reply is 19 bytes and "no card" is 10 -- with Arduino's
  default Serial read timeout (1000 ms), it sat there waiting the full second on *every single
  poll*. Fixed with `pn532Serial.setTimeout(30)`: measured poll time dropped from ~1050 ms to
  ~90 ms. A first pass at this sketch (before the real project was found) instead tried a
  dedicated FreeRTOS core and a maxed-out internal retry count -- harmless, but nowhere near as
  impactful as this one timeout. Also ported: `flushPn532()` before every command (a longer
  reply leaves bytes behind that break the next one), card-present/removed tracking so a card
  is sent once per presentation, a periodic liveness ping while idle, and a `status` serial
  command for checking live poll timing.
- **Not verified on *this* astro-health repo's build yet** -- it compiles cleanly here
  (`arduino-cli compile --fqbn esp32:esp32:esp32s3`, 69% flash / 14% RAM) and was flashed to the
  real board, but actual read range/speed with astro-health's own CYD wasn't re-measured in
  this session -- confirm it feels fast on the real hardware, and watch the serial log
  (`arduino-cli monitor`, or type `status`) if anything still feels off.

## Upload steps

```bash
cd firmware/astro_cyd
arduino-cli compile --fqbn esp32:esp32:esp32:PartitionScheme=huge_app .
arduino-cli upload -p /dev/ttyUSB0 --fqbn esp32:esp32:esp32:PartitionScheme=huge_app .
```

(Or open `astro_cyd.ino` in the Arduino IDE, select "ESP32 Dev Module", the right port, and
Upload.) The port is normally the same CH340 port Lifeline's `build.sh` uses
(`/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0` on Linux).

The ESP32-S3 reader sketch is the same idea, different FQBN and sketch folder:

```bash
cd firmware/esp32s3_nfc_reader
arduino-cli compile --fqbn esp32:esp32:esp32s3 .
arduino-cli upload -p /dev/ttyACM0 --fqbn esp32:esp32:esp32s3 .
```

(Or the Arduino IDE, board "ESP32S3 Dev Module".) Most ESP32-S3 boards show up as `/dev/ttyACM0`
rather than the CH340's `/dev/ttyUSB0` -- check `ls /dev/serial/by-id/` if it's not obvious
which port is which.

**This firmware has only been compile-checked** (`arduino-cli compile`, 32% flash / 14% RAM --
re-confirmed 2026-11-04, including `screens.ino`'s `onStatusMsg()`/`drawWrapped()` word-wrap
addition, which compiles clean), not flashed or run on the real `astro_cyd` board. Please
verify on hardware: rotation, touch calibration, the SD CS pin if you use a card, and the
overall screen layout.

## Files

`astro_cyd/`:

| File | What's in it |
| --- | --- |
| `astro_cyd.ino` | Pin map, all shared state (see the comment in `screens.ino` on why), `setup()`/`loop()` |
| `tft_setup.h` | TFT_eSPI config (`USER_SETUP_LOADED` + pin/driver macros) — see "TFT_eSPI setup" above |
| `nfc_link.h` | Shared ESP-NOW protocol header -- keep byte-for-byte identical to `esp32s3_nfc_reader/nfc_link.h` |
| `nfc.ino` | ESP-NOW receive from the S3 reader |
| `protocol.ino` | Serial + Wi-Fi JSON lines in both directions, the offline queue |
| `wifi_bridge.ino` | The CYD's own access point + TCP server, for running off a power bank with no USB data cable |
| `screens.ino` | The 12 screens, touch handling, the SOS corner button |
| `led_sound.ino` | RGB LED + speaker beeps (both optional hardware) |

`esp32s3_nfc_reader/`:

| File | What's in it |
| --- | --- |
| `esp32s3_nfc_reader.ino` | PN532 setup + its dedicated polling task, ESP-NOW link, `setup()`/`loop()` |
| `nfc_link.h` | Same shared protocol header, byte-for-byte identical to `astro_cyd/nfc_link.h` |
