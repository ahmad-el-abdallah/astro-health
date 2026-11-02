// Astro Health Station -- CYD firmware (docs/build-prompt.md section 10).
// Target: CYD ESP32-2432S028R, 320x240 ILI9341, XPT2046 touch.
//
// This board only shows what the laptop tells it and relays raw events
// (card taps, mood/symptoms/reaction/breathing results, the SOS button).
// It does NOT decide who is allowed anywhere -- the laptop is the source
// of truth (docs/build-prompt.md section 5).
//
// NFC: our hardware has the PN532 wired to a separate ESP32-S3 "reader"
// board, which relays every card UID to this CYD over ESP-NOW (the same
// link and nfc_link.h used by the sibling "Lifeline" project). So unlike
// the original build prompt's "readCardUid()" idea (a PN532/MFRC522 wired
// straight to this board), card UIDs arrive via onLinkRecv() in nfc.ino.
//
// Split into tabs: astro_cyd.ino (this file: setup/loop + TFT_eSPI config),
// nfc.ino (ESP-NOW receive from the S3), protocol.ino (serial + Wi-Fi JSON
// lines), wifi_bridge.ino (the CYD's own access point + TCP server, so it
// can run from a power bank with no USB data cable to the laptop at all),
// screens.ino (the 12 screens + touch), led_sound.ino.
//
// The loop must never block for long: no delay() over ~20 ms anywhere.
// Every timed thing (toasts, reaction test, breathing, timeouts) uses
// millis() and is driven from loop().

// ---- TFT_eSPI config lives in tft_setup.h, not here ----
// See that file for why: a #define block here would only affect this
// sketch's own compilation, not TFT_eSPI.cpp's (it's compiled separately,
// as part of the library), which is why the display stayed black even
// though these exact settings looked right.

#include <TFT_eSPI.h>
#include <ArduinoJson.h>
#include <algorithm>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <SD.h>
#include "nfc_link.h"

// ---------------- touch wiring + calibration ----------------
// Touch is bit-banged (plain digitalWrite/digitalRead), not the
// XPT2046_Touchscreen library's hardware-SPI path: on real hardware that
// library's readings stayed pegged at all-1s (x=8191 y=8191 z=4095,
// unchanging) regardless of ESP32 SPI-host/pin tweaks -- a dead link to
// the chip we couldn't resolve. This exact bit-banged approach, pins and
// all, is proven working on this same physical board by the sibling
// "Lifeline" project, so we ported it rather than keep guessing at the
// hardware-SPI config.
//
// Measured on real hardware with the guided calibration routine (tap all
// four screen corners, one at a time) that briefly lived here: the touch
// controller's raw X axis tracks the screen's *vertical* position, and its
// raw Y axis tracks the screen's *horizontal* position -- axes swapped
// relative to the screen, not just offset -- with no inversion needed on
// either. getTouchXY() in screens.ino does that swap; RX_* calibrates the
// axis that drives screen Y, RY_* the one that drives screen X. If taps
// land in the wrong place on a different unit, these four numbers (and
// the swap itself) are what to re-derive.
static const int PIN_T_SCLK = 25, PIN_T_MOSI = 32, PIN_T_MISO = 39, PIN_T_CS = 33, PIN_T_IRQ = 36;
static const int RX_MIN = 180, RX_MAX = 3940;  // -> screen Y
static const int RY_MIN = 120, RY_MAX = 3800;  // -> screen X

// ---------------- RGB LED (active low) + speaker ----------------
static const int PIN_LED_R = 4, PIN_LED_G = 16, PIN_LED_B = 17;
static const int PIN_SPK = 26;

// ---------------- settings ----------------
static const char* FW_VERSION = "1.0";
static const uint32_t SESSION_IDLE_MS = 2UL * 60 * 1000;   // screen 2: back to Idle after this long untouched
static const uint32_t LAPTOP_OFFLINE_MS = 10UL * 1000;      // no `ping` for this long -> "Laptop offline"
static const uint32_t TOAST_MS = 3000;
static const uint32_t SOS_HOLD_MS = 2000;                   // hold the corner SOS button this long to send `emergency`
static const uint32_t EMERGENCY_CANCEL_HOLD_MS = 3000;       // hold on the Emergency screen this long to cancel locally

// ---------------- Wi-Fi bridge to the laptop (wifi_bridge.ino) ----------------
// Lets the CYD run from a power bank with no USB data cable at all: it
// broadcasts its own access point and the laptop's app connects over TCP
// instead of (or alongside) USB serial -- same JSON-lines protocol either
// way, see protocol.ino. Change these two values to set your own network
// name/password; AP_PASSWORD must be 8+ characters for WPA2.
static const char* AP_SSID = "AstroHealthCYD";
static const char* AP_PASSWORD = "astrohealth123";
static const uint16_t TCP_PORT = 8765;
WiFiServer tcpServer(TCP_PORT);
WiFiClient tcpClient;

TFT_eSPI tft = TFT_eSPI();

int SCRW = 320, SCRH = 240, CX = 160, CY = 120;

// ---------------- shared state (all tabs are one translation unit; these
// live here, the first tab, so they're defined before anything else uses
// them -- see the note about Arduino's per-sketch prototype generation in
// screens.ino) ----------------
enum Screen {
  SCR_IDLE, SCR_SESSION, SCR_MOOD, SCR_SYMPTOMS, SCR_REACTION, SCR_BREATHE,
  SCR_STATUS, SCR_EXERCISE_TIMER, SCR_ALERT_EMERGENCY, SCR_UNKNOWN_TAG,
};
Screen screen = SCR_IDLE;
Screen screenBeforeToast = SCR_IDLE;
uint32_t toastUntilMs = 0;

// the active session (empty uid = nobody tapped in / laptop hasn't named them yet)
String curUid = "", curName = "", curLevel = "GRAY";
long curPoints = 0;
uint32_t lastTouchMs = 0;

// exercise timer
bool exerciseRunning = false;
uint32_t exerciseStartMs = 0;

// emergency
bool emergencyActive = false;
String emergencyText = "";
uint32_t sosHoldStartMs = 0;    // holding the corner SOS button
uint32_t cancelHoldStartMs = 0; // holding Cancel on the emergency screen

// reaction test (10 trials; see docs/build-prompt.md section 10, screen 5)
static const int REACTION_TRIALS = 10;
int reactionTrial = 0;
int reactionTimes[REACTION_TRIALS];
int reactionLapses = 0, reactionFalseStarts = 0;
uint32_t reactionPhaseStartMs = 0, reactionCircleShownMs = 0;
bool reactionCircleShown = false;
uint32_t reactionNextDelayMs = 0;

// breathing (60s box breathing: 4s in / 4s hold / 4s out / 4s hold)
uint32_t breatheStartMs = 0;
static const uint32_t BREATHE_TOTAL_MS = 60000, BREATHE_PHASE_MS = 4000;

// ---------------- bit-banged XPT2046 touch (see the note above PIN_T_SCLK) ----------------
void touchInit() {
  pinMode(PIN_T_CS, OUTPUT);   digitalWrite(PIN_T_CS, HIGH);
  pinMode(PIN_T_SCLK, OUTPUT); digitalWrite(PIN_T_SCLK, LOW);
  pinMode(PIN_T_MOSI, OUTPUT); digitalWrite(PIN_T_MOSI, LOW);
  pinMode(PIN_T_MISO, INPUT);  pinMode(PIN_T_IRQ, INPUT);
}
static void touchClk() {
  digitalWrite(PIN_T_SCLK, HIGH); delayMicroseconds(2);
  digitalWrite(PIN_T_SCLK, LOW);  delayMicroseconds(2);
}
// Sends a command byte, then clocks out the 12-bit result (MSB first, valid after each falling edge).
static int touchRead12(uint8_t cmd) {
  for (int b = 7; b >= 0; b--) { digitalWrite(PIN_T_MOSI, (cmd >> b) & 1); delayMicroseconds(1); touchClk(); }
  digitalWrite(PIN_T_MOSI, LOW);
  delayMicroseconds(4);  // acquisition / BUSY
  int v = 0;
  for (int i = 0; i < 16; i++) { touchClk(); v = (v << 1) | digitalRead(PIN_T_MISO); }
  return (v >> 4) & 0xFFF;
}
// True raw 0-4095 x/y from the controller (no screen mapping applied --
// see getTouchXY() in screens.ino for the axis swap and scaling), plus a
// rough pressure value. False if nothing is pressed right now.
bool touchRaw(int& x, int& y) {
  if (digitalRead(PIN_T_IRQ)) return false;  // IRQ goes low while the panel is pressed
  const int N = 7;
  int xs[N], ys[N];
  digitalWrite(PIN_T_CS, LOW);
  int z = touchRead12(0xB0) + 4095 - touchRead12(0xC0);  // pressure (Z1, Z2)
  for (int i = 0; i < N; i++) { xs[i] = touchRead12(0xD0); ys[i] = touchRead12(0x90); }
  touchRead12(0x90);  // ends with PD=00: power down, IRQ enabled
  digitalWrite(PIN_T_CS, HIGH);
  if (z < 400) return false;
  std::sort(xs, xs + N); std::sort(ys, ys + N);
  // middle 5 samples must agree, otherwise this read was noisy (finger landing/lifting)
  if (xs[N - 2] - xs[1] > 150 || ys[N - 2] - ys[1] > 150) return false;
  x = xs[N / 2];
  y = ys[N / 2];
  if (x <= 100 || x > 4000 || y <= 100 || y > 4000) return false;
  return true;
}

void setup() {
  Serial.begin(115200);
  Serial.setTimeout(50);
  delay(100);
  Serial.printf("\n[astro_cyd] booting v%s\n", FW_VERSION);

  pinMode(PIN_LED_R, OUTPUT); pinMode(PIN_LED_G, OUTPUT); pinMode(PIN_LED_B, OUTPUT);
  setLed(false, false, false);
  ledcAttach(PIN_SPK, 2300, 10);
  ledcWriteTone(PIN_SPK, 0);

  tft.init();
  tft.setRotation(1);  // landscape; flip to 3 if the image comes out upside down on your unit
  SCRW = tft.width(); SCRH = tft.height(); CX = SCRW / 2; CY = SCRH / 2;
  tft.fillScreen(TFT_BLACK);

  touchInit();

  setupLink();     // nfc.ino: ESP-NOW receive from the S3 reader
  startAccessPoint();  // wifi_bridge.ino: the CYD's own Wi-Fi network for the laptop
  initQueue();     // protocol.ino: RAM (+ SD if present) offline queue

  sendHello();
  goIdle();
}

void loop() {
  handleTcpClient();     // wifi_bridge.ino: accept/track the laptop's TCP connection
  handleSerialIn();     // protocol.ino: parse laptop -> CYD JSON lines (serial or Wi-Fi)
  handleLink();          // nfc.ino: drain ESP-NOW frames from the S3
  handleTouch();         // screens.ino
  updateScreenTimers();  // screens.ino: toasts, reaction test, breathing, timeouts
  updateLed();           // led_sound.ino
  checkLaptopOffline();  // protocol.ino
  checkSosButton();      // screens.ino

  delay(5);
}
