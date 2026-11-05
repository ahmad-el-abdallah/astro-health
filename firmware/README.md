# Astro Health Station -- firmware

Two live sketches, two boards (plus one dead board kept for reference):

- **`astro_cyd/`** -- the CYD (ESP32-2432S028R). It does two things now (a third, ESP-NOW
  receive, is vestigial -- see "NFC" below):
  1. Shows the 12 screens from `docs/build-prompt.md` section 10, and reads the touchscreen.
  2. Talks to the laptop over USB serial, one JSON line per message (`docs/build-prompt.md` section 6).
- **`pico_nfc_reader/`** -- a Raspberry Pi Pico (RP2040, no WiFi) reading the PN532. Plugged
  into the laptop over its own USB port and sends scans straight there (see "NFC" below) --
  **this is the live NFC reader as of 2026-11-05.**
- **`esp32s3_nfc_reader/`** -- **dead hardware.** This was the original reader board (PN532 ->
  ESP-NOW -> the CYD above), replaced by the Pico after the physical ESP32-S3 chip failed
  permanently (WiFi radio brownouts on every power source tried, then a corrupted/unsupported
  eFuse hardware-revision reading no toolchain recognized). Kept in the repo for reference, not
  deleted, same as `firmware/existing/` -- don't try to revive this board or debug its firmware.

## Libraries (install via Arduino IDE Library Manager, or `arduino-cli lib install "<name>"`)

| Library | Version used here | Used by |
| --- | --- | --- |
| TFT_eSPI (Bodmer) | 2.5.43 | `astro_cyd/` |
| XPT2046_Touchscreen (Paul Stoffregen) | 1.4.0 | `astro_cyd/` |
| ArduinoJson (Benoit Blanchon) | 7.4.3 | `astro_cyd/` |
| Adafruit_PN532 (Adafruit) | 1.3.4 | `esp32s3_nfc_reader/` (dead), `pico_nfc_reader/` |

Board core: **esp32 by Espressif Systems**. Board/FQBN used to compile-check `astro_cyd/`:
`esp32:esp32:esp32:PartitionScheme=huge_app` (same board entry Lifeline's `build.sh` uses).
`esp32s3_nfc_reader/` uses `esp32:esp32:esp32s3` instead (different chip, and dead hardware --
see above).

`pico_nfc_reader/` uses a *different* board manager entry: **`rp2040:rp2040` (earlephilhower),
not** the official `arduino:mbed_rp2040` core -- the official core doesn't support the per-pin
UART remapping (`Serial1.setRX()`/`.setTX()`, `SerialPIO`) this sketch needs. Add it with:

```bash
arduino-cli config add board_manager.additional_urls \
  https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json
arduino-cli core install rp2040:rp2040
```

FQBN: `rp2040:rp2040:rpipico`.

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

## NFC: a Pico plugged straight into the laptop, not wired to the CYD at all

`docs/build-prompt.md` section 3 describes a PN532/MFRC522 wired straight to the CYD. The
actual hardware went through two revisions since: first a PN532 on a separate ESP32-S3 board
relaying to the CYD over ESP-NOW, **now (2026-11-05) a Raspberry Pi Pico reading the same PN532
and talking directly to the laptop over USB, bypassing the CYD entirely for this.** See
docs/CLAUDE.md's "Pico NFC reader replaces the dead ESP32-S3" for the full story of why (the
ESP32-S3 board failed permanently -- not a pins/firmware issue, the physical chip).

- The Pico has no WiFi/Bluetooth at all, so an ESP-NOW-style relay to the CYD was never an
  option. Instead `pico_nfc_reader.ino` sends `{"type":"scan","uid":"..."}` lines over its own
  USB-serial connection to the laptop, and `backend/pico_bridge.py` feeds those into the same
  `handle_cyd_message()` the CYD's own "scan" messages already go through -- see
  `backend/pico_bridge.py`'s own docstring and docs/CLAUDE.md for the backend side.
- `astro_cyd/nfc.ino` (`setupLink()`, `handleLink()`) and `nfc_link.h` are still in the CYD
  sketch, still compile, and are harmless to leave in place, but **nothing sends ESP-NOW frames
  to the CYD anymore** -- the ESP32-S3 board that used to is dead. Don't expect logs from that
  path, and don't spend time debugging it; it's vestigial, same category as the surgeon-PIN
  code mentioned elsewhere in docs/CLAUDE.md.
- Real NFC cards are formatted as colon-separated hex (e.g. `04:A1:B2:C3`, same convention as
  Lifeline, unchanged by any of this). `backend/seed.py` no longer seeds any fake object-tag
  UIDs by default -- a real card's hex UID shows up as "Unknown card" the first time it's
  scanned (on the CYD, if tapped there, since the admin backlog logic doesn't care which bridge
  the scan came from), and you assign it to an astronaut or object from the superuser admin
  page (`/admin`, see the repo root README's "Superuser admin page").

## The ESP32-S3 reader sketch (`firmware/esp32s3_nfc_reader/`) -- dead hardware, reference only

**Do not try to revive this board or debug this firmware.** The physical ESP32-S3 chip failed
permanently on 2026-11-05: its WiFi radio brownout-resets the instant it tries to calibrate
(reproduced with the PN532 fully disconnected, across every cable/port/power source tried,
including disabling the brownout detector in software), and it separately started reporting a
corrupted/nonexistent eFuse hardware revision that no toolchain -- not Arduino's core, not
PlatformIO, not a same-day-built official ESP-IDF `release/v5.4` -- recognizes. Full diagnosis
in docs/CLAUDE.md. Kept in the repo for reference (same convention as `firmware/existing/`),
not deleted. The library/pin/timing notes below are preserved as history, not as something to
act on.

Reads the PN532 over UART (HSU mode) and sent every UID to the CYD over ESP-NOW. Ported from
the user's own separate, already-working project
(`github.com/ahmad-el-abdallah/ESP32S3-NFC-Reader`, PlatformIO) rather than written from
scratch -- a first pass at this guessed at pins and tuning with no real board to test against,
which was the wrong starting point once a working, measured-good version existed.

- **Library**: Adafruit\_PN532. Board: `esp32:esp32:esp32s3`.
- **Real, confirmed wiring** (PN532 V3, UART mode, switches SW1/SW2 both OFF -- read only at
  power-up, so unplug USB after changing either one): PN532 VCC -> 3V3, GND -> GND,
  TXD -> ESP32-S3 GPIO 4, RXD -> ESP32-S3 GPIO 5. No reset pin (the PN532 V3's 4-pin header
  doesn't expose one).
- **The real cause of "takes a while / need to hold it close"**, per that project's own
  measurements (2026-10-24): Adafruit_PN532's UART driver reads a fixed-length reply (20 bytes
  after a card poll), but a 4-byte UID reply is 19 bytes and "no card" is 10 -- with Arduino's
  default Serial read timeout (1000 ms), it sat there waiting the full second on *every single
  poll*. Fixed with `pn532Serial.setTimeout(30)`: measured poll time dropped from ~1050 ms to
  ~90 ms. This exact fix carried over into `pico_nfc_reader.ino` below, since it's the same
  library and the same root cause.

## The Pico reader sketch (`firmware/pico_nfc_reader/`, 2026-11-05) -- the live one

Reads the same PN532 module over UART, sends every UID to the laptop over USB serial (not to
the CYD -- see "NFC" above). Board: `rp2040:rp2040:rpipico` (earlephilhower core, see
"Libraries" above for why not the official one).

- **Wiring**: PN532 VCC -> Pico `3V3(OUT)`, GND -> GND, the two PN532 data pins -> Pico GP1/GP2
  (whichever way round; swap `PN532_TX_PIN`/`PN532_RX_PIN` in the sketch if a fresh board lands
  them the other way -- both idle high, so you can't tell which is which just by probing).
- **Why `SerialPIO`, not `Serial1`/`Serial2`**: RP2040's hardware UARTs only map to specific
  fixed pin groups (GP0/1, GP4/5, GP8/9, GP12/13, GP16/17, GP20/21, GP24/25, GP28/29 -- TX/RX
  pairs, not arbitrary pins). GP1/GP2 isn't one of those pairs. `SerialPIO` (RP2040's PIO-based
  software serial, part of the earlephilhower core) can use any two pins instead, which is what
  let the wiring stay put rather than needing yet another rewire once the actual pins were
  figured out.
- **A real Adafruit_PN532 library bug, not a wiring issue**: its UART constructor
  unconditionally runs `pinMode(_reset, OUTPUT)`, and passing the conventional "no reset pin"
  sentinel (`-1`) doesn't behave safely with that on this core -- `PN532_RESET_PIN` is set to
  `15` in the sketch (a real, otherwise-unused GPIO; the PN532's actual RSTPDN pin stays
  unconnected, same as on the ESP32-S3 build) specifically to avoid it. See docs/CLAUDE.md for
  how this was diagnosed (a raw byte probe worked on wiring the library failed on, seconds
  apart, with nothing physically changed in between).
- **Verified end-to-end** against the real backend, not just this sketch in isolation: a real
  crew card produced a correct `scan` -> `session_started`/`session_ended` sequence over
  `app.py`'s Socket.IO stream.

## Upload steps

```bash
cd firmware/astro_cyd
arduino-cli compile --fqbn esp32:esp32:esp32:PartitionScheme=huge_app .
arduino-cli upload -p /dev/ttyUSB0 --fqbn esp32:esp32:esp32:PartitionScheme=huge_app .
```

(Or open `astro_cyd.ino` in the Arduino IDE, select "ESP32 Dev Module", the right port, and
Upload.) The port is normally the same CH340 port Lifeline's `build.sh` uses
(`/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0` on Linux).

The Pico reader sketch uses a different core and a UF2 upload instead of a serial flash:

```bash
cd firmware/pico_nfc_reader
arduino-cli compile --fqbn rp2040:rp2040:rpipico --upload -p /dev/ttyACM0 .
```

If that doesn't find the board (prints "No drive to deploy" instead of flashing), the board
isn't in its USB bootloader -- hold **BOOTSEL**, plug it in (or replug it) while still holding,
then release, and re-run the same command.

(The `esp32s3_nfc_reader` sketch also still compiles with `esp32:esp32:esp32s3` the same way
it always did, but **do not flash it** -- see "The ESP32-S3 reader sketch" above, that board is
dead hardware.)

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
| `nfc_link.h` | Shared ESP-NOW protocol header -- vestigial, see "NFC" above (kept byte-for-byte identical to `esp32s3_nfc_reader/nfc_link.h` anyway, in case this ever matters again) |
| `nfc.ino` | ESP-NOW receive -- vestigial, see "NFC" above; nothing sends to it anymore |
| `protocol.ino` | Serial + Wi-Fi JSON lines in both directions, the offline queue |
| `wifi_bridge.ino` | The CYD's own access point + TCP server, for running off a power bank with no USB data cable |
| `screens.ino` | The 12 screens, touch handling, the SOS corner button |
| `led_sound.ino` | RGB LED + speaker beeps (both optional hardware) |

`pico_nfc_reader/` (the live reader):

| File | What's in it |
| --- | --- |
| `pico_nfc_reader.ino` | PN532 setup over `SerialPIO`, `setup()`/`loop()`, sends `{"type":"scan","uid":"..."}` lines over USB serial to the laptop |

`esp32s3_nfc_reader/` (dead hardware, reference only):

| File | What's in it |
| --- | --- |
| `esp32s3_nfc_reader.ino` | PN532 setup + its dedicated polling task, ESP-NOW link, `setup()`/`loop()` |
| `nfc_link.h` | Same shared protocol header, byte-for-byte identical to `astro_cyd/nfc_link.h` |
