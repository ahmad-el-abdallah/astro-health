// Astro Health Station -- Pico NFC reader (replaces the ESP32-S3 +
// ESP-NOW reader, see docs/CLAUDE.md "Pico NFC reader"). This board has no
// WiFi/radio at all, so instead of relaying taps to the CYD over the air,
// it's plugged into the laptop over its own USB port and sends each
// scanned UID straight there as one JSON line
// (backend/pico_bridge.py reads this and feeds it into the same
// handle_cyd_message() the CYD's own "scan" messages already go through).
//
// Wiring (PN532 V3, UART mode -- switches SW1/SW2 both OFF):
//   PN532 VCC -> Pico 3V3(OUT)   PN532 GND -> Pico GND
//   PN532 data pins -> Pico GP1 / GP2 (either way round; both idle high)
// GP15 is passed as the library's "reset pin" even though PN532's RSTPDN
// isn't wired to it -- Adafruit_PN532's constructor unconditionally does
// pinMode(_reset, OUTPUT), and passing the conventional "none" sentinel
// (-1) misbehaves on this core. Any otherwise-unused real GPIO avoids it.
#include <Adafruit_PN532.h>

static const int PN532_TX_PIN = 2;
static const int PN532_RX_PIN = 1;
static const int PN532_RESET_PIN = 15;

static SerialPIO pn532Serial(PN532_TX_PIN, PN532_RX_PIN);
static Adafruit_PN532 nfc(PN532_RESET_PIN, &pn532Serial);

static const uint16_t POLL_TIMEOUT_MS = 200;
static const uint32_t CARD_GONE_MS = 500;      // unseen this long = taken away, next touch is new
static const uint32_t RECONNECT_MS = 1000;

static bool readerOk = false;
static bool cardPresent = false;
static uint8_t cardUid[10];
static uint8_t cardLen = 0;
static uint32_t cardSeenMs = 0;

static void flushPn532() {
  while (pn532Serial.available()) pn532Serial.read();
}

static void printUidHex(const uint8_t* p, size_t n) {
  char b[4];
  for (size_t i = 0; i < n; i++) {
    if (i) Serial.print(':');
    snprintf(b, sizeof(b), "%02X", p[i]);
    Serial.print(b);
  }
}

static bool tryConnect() {
  if (!nfc.getFirmwareVersion()) return false;
  flushPn532();
  nfc.setPassiveActivationRetries(0x08);
  flushPn532();
  nfc.SAMConfig();
  flushPn532();
  return true;
}

void setup() {
  Serial.begin(115200);
  nfc.begin();
  pn532Serial.setTimeout(30);
}

void loop() {
  static uint32_t lastReconnect = 0;
  uint32_t now = millis();

  if (!readerOk) {
    if (now - lastReconnect >= RECONNECT_MS) {
      lastReconnect = now;
      readerOk = tryConnect();
    }
  } else {
    uint8_t uid[10], len = 0;
    flushPn532();
    if (nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &len, POLL_TIMEOUT_MS) && len >= 4) {
      cardSeenMs = now;
      if (!(cardPresent && len == cardLen && !memcmp(uid, cardUid, len))) {
        cardPresent = true;
        memcpy(cardUid, uid, len);
        cardLen = len;
        Serial.print("{\"type\":\"scan\",\"uid\":\"");
        printUidHex(uid, len);
        Serial.println("\"}");
      }
    } else if (cardPresent && now - cardSeenMs >= CARD_GONE_MS) {
      cardPresent = false;
    }
    if (!nfc.getFirmwareVersion()) {
      readerOk = false;  // catches a pulled cable; next loop retries via tryConnect()
    } else {
      flushPn532();
    }
  }
  delay(40);
}
