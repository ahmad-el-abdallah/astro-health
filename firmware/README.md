# Astro Health Station -- CYD firmware

`astro_cyd/` is the sketch that runs on the CYD (ESP32-2432S028R). It does three things:

1. Receives NFC tag taps from the separate ESP32-S3 reader board over ESP-NOW (see "NFC" below).
2. Shows the 12 screens from `docs/build-prompt.md` section 10, and reads the touchscreen.
3. Talks to the laptop over USB serial, one JSON line per message (`docs/build-prompt.md` section 6).

## Libraries (install via Arduino IDE Library Manager, or `arduino-cli lib install "<name>"`)

| Library | Version used here |
| --- | --- |
| TFT_eSPI (Bodmer) | 2.5.43 |
| XPT2046_Touchscreen (Paul Stoffregen) | 1.4.0 |
| ArduinoJson (Benoit Blanchon) | 7.4.3 |

Board core: **esp32 by Espressif Systems**. Board/FQBN used to compile-check this sketch:
`esp32:esp32:esp32:PartitionScheme=huge_app` (same board entry Lifeline's `build.sh` uses).

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
actual hardware is different: the PN532 is wired to a separate ESP32-S3 "reader" board
(`~/Desktop/ESP32S3-NFC-Reader`), which already reads cards over UART and relays every UID
to this CYD over encrypted, signed ESP-NOW -- the exact same link the "Lifeline" NFC-lock
project at `~/Desktop/Lifeline` uses. We kept that link rather than rewiring an NFC reader
onto this board, so:

- `nfc_link.h` here is an unmodified copy of Lifeline's (and the S3 reader's) shared header --
  same MACs, channel and keys, because it's the same two physical boards.
- `nfc.ino` is the CYD side of that link (`setupLink()`, `handleLink()`): it sends
  `LINK_HELLO` challenges, accepts a `LINK_TAG` only if its nonce is current/previous
  (replay protection), and turns every accepted tag into a `scan` message upstream to the
  laptop -- instead of a lock/unlock decision, which is what Lifeline does with it.
- **The ESP32-S3 reader's own firmware does not need to change at all.**
- The `readCardUid()` / `NFC_MODULE` (PN532 vs MFRC522) switch from the build prompt doesn't
  apply here: on the CYD side, "a card was read" means "an ESP-NOW `LINK_TAG` frame arrived",
  full stop.

Real NFC cards get formatted as colon-separated hex (e.g. `04:A1:B2:C3`, same convention as
Lifeline). The fake UIDs in `backend/seed.py` (`A1000001`, `T2000001`, ...) are plain demo
strings for the Simulator panel only -- a real card's hex UID is a different string, and you
assign it to an astronaut or object the first time it's scanned, via the Admin tab's "New tag
scanned" popup.

## Upload steps

```bash
cd firmware/astro_cyd
arduino-cli compile --fqbn esp32:esp32:esp32:PartitionScheme=huge_app .
arduino-cli upload -p /dev/ttyUSB0 --fqbn esp32:esp32:esp32:PartitionScheme=huge_app .
```

(Or open `astro_cyd.ino` in the Arduino IDE, select "ESP32 Dev Module", the right port, and
Upload.) The port is normally the same CH340 port Lifeline's `build.sh` uses
(`/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0` on Linux).

**This firmware has only been compile-checked** (`arduino-cli compile`, 32% flash / 14% RAM --
see the repo root README for the exact command), not flashed or run on the real board. Please
verify on hardware: rotation, touch calibration, the SD CS pin if you use a card, and the
overall screen layout.

## Files

| File | What's in it |
| --- | --- |
| `astro_cyd.ino` | Pin map, all shared state (see the comment in `screens.ino` on why), `setup()`/`loop()` |
| `tft_setup.h` | TFT_eSPI config (`USER_SETUP_LOADED` + pin/driver macros) — see "TFT_eSPI setup" above |
| `nfc_link.h` | Shared ESP-NOW protocol header, copied from Lifeline unchanged |
| `nfc.ino` | ESP-NOW receive from the S3 reader |
| `protocol.ino` | Serial + Wi-Fi JSON lines in both directions, the offline queue |
| `wifi_bridge.ino` | The CYD's own access point + TCP server, for running off a power bank with no USB data cable |
| `screens.ino` | The 12 screens, touch handling, the SOS corner button |
| `led_sound.ino` | RGB LED + speaker beeps (both optional hardware) |
