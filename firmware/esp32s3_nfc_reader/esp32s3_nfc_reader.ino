// ESP32-S3 NFC reader: reads a PN532 over UART (HSU) and relays every card
// UID to the CYD over the same encrypted/signed ESP-NOW link Lifeline's
// lock uses (nfc_link.h, shared byte-for-byte with
// firmware/astro_cyd/nfc_link.h -- edit one, copy it over the other).
//
// Ported from the user's own proven, already-measured-working reader
// project (github.com/ahmad-el-abdallah/ESP32S3-NFC-Reader, same hardware:
// an Elechouse PN532 V3 on this exact ESP32-S3 board), not written from
// scratch -- an earlier version of this file guessed at pins and tuning
// with no real board to test against, which is the wrong starting point
// when a working one already exists.
//
// *** The real cause of "takes a while / need to hold it close" ***
// (measured in that project, 2026-10-24): Adafruit_PN532's UART driver
// reads a fixed-length reply (20 bytes after a card poll), but a 4-byte
// UID reply is 19 bytes and "no card" is 10 -- with Arduino's default
// Serial read timeout (1000 ms), the driver sat there waiting the full
// second for bytes that were never coming on *every single poll*. That's
// ~1050 ms per attempt. Fixed below with `pn532Serial.setTimeout(30)`:
// measured poll time dropped to ~90 ms. This is not a tuning nitpick, it's
// the dominant cost -- raising retry counts or polling on a dedicated core
// (an earlier version of this file tried that) barely matters next to a
// 1-second stall sitting inside every single attempt.
//
// Wiring (PN532 V3, UART mode -- switches SW1 and SW2 both OFF; the PN532
// only reads them at power-up, so unplug USB after changing either one):
//   PN532 VCC -> 3V3 (never 5V)   PN532 GND -> GND
//   PN532 TXD -> ESP32-S3 GPIO 4  PN532 RXD -> ESP32-S3 GPIO 5
// No reset pin wired (PN532 V3's 4-pin header doesn't expose one).

#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <Adafruit_PN532.h>
#include "nfc_link.h"

// ---- PN532 over UART (HSU) ----
static const int PN532_RX_PIN = 4;     // ESP32-S3 GPIO wired to the PN532's TXD
static const int PN532_TX_PIN = 5;     // ESP32-S3 GPIO wired to the PN532's RXD
static const int PN532_RESET_PIN = -1; // not wired on the PN532 V3's 4-pin header; -1 = none

// ---- reader behaviour (measured-good values from the proven project above) ----
static const uint8_t PN532_ACTIVATION_RETRIES = 0x08;  // give up quickly when no card is present -- the loop just re-polls
static const uint16_t POLL_TIMEOUT_MS = 200;           // max wait for one detection attempt
static const uint16_t POLL_INTERVAL_MS = 40;           // pause between polls
static const uint32_t CARD_GONE_MS = 500;              // unseen this long = taken away; the next touch is new
static const uint16_t PN532_HSU_READ_MS = 30;          // *** the actual fix -- see file header ***
static const uint32_t HEALTH_CHECK_MS = 3000;          // ping the PN532 this often while idle
static const uint32_t RECONNECT_MS = 3000;             // retry interval when it's missing

static const uint32_t HEARTBEAT_MS = 1000;             // matches the CYD's own LINK_HELLO cadence

static HardwareSerial& pn532Serial = Serial1;
static Adafruit_PN532 nfc(PN532_RESET_PIN, &pn532Serial);

// ---- state ----
static bool readerOk = false;
static uint32_t fwVersion = 0;
static bool cardPresent = false;
static uint8_t cardUid[10];
static uint8_t cardLen = 0;
static uint32_t cardSeenMs = 0;
static bool cydSeen = false;
static uint32_t pollCount = 0, pollTotalMs = 0, pollMaxMs = 0;  // for the "status" serial command

// Written by the ESP-NOW receive callback (Wi-Fi task), read by loop().
static volatile uint32_t cydNonce = 0;    // latest challenge from the CYD; echoed in every frame we send
static volatile uint32_t cydHeardMs = 0;  // millis() of its last valid LINK_HELLO, 0 = never

static String hexString(const uint8_t* p, size_t n, char sep) {
  String s;
  char b[4];
  for (size_t i = 0; i < n; i++) {
    if (sep && i) s += sep;
    snprintf(b, sizeof(b), "%02X", p[i]);
    s += b;
  }
  return s;
}

static String fwString() {
  char b[24];
  snprintf(b, sizeof(b), "PN5%02X v%u.%u", (unsigned)((fwVersion >> 24) & 0xFF),
           (unsigned)((fwVersion >> 16) & 0xFF), (unsigned)((fwVersion >> 8) & 0xFF));
  return b;
}

// ---- link to the CYD ----

static void onLinkRecv(const esp_now_recv_info_t* info, const uint8_t* data, int len) {
  if (len != (int)sizeof(LinkMsg) || memcmp(info->src_addr, LOCK_MAC, 6)) return;
  LinkMsg m;
  memcpy(&m, data, sizeof(m));
  if (m.type != LINK_HELLO || !linkVerify(m)) return;
  cydNonce = m.nonce;
  cydHeardMs = millis();
}

// Station mode, never connected: frames go out from the fixed READER_MAC on LINK_CHANNEL.
static void setupLink() {
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  esp_wifi_set_ps(WIFI_PS_NONE);  // stay awake, or HELLOs from the CYD get missed
  esp_wifi_set_channel(LINK_CHANNEL, WIFI_SECOND_CHAN_NONE);
  uint8_t mac[6];
  esp_wifi_get_mac(WIFI_IF_STA, mac);
  Serial.printf("[link] ESP-NOW from %s to the CYD %s on channel %u\n", hexString(mac, 6, ':').c_str(),
                hexString(LOCK_MAC, 6, ':').c_str(), LINK_CHANNEL);
  if (memcmp(mac, READER_MAC, 6))
    Serial.println("[link] WARNING: READER_MAC in nfc_link.h is not this board -- the CYD will ignore it");
  if (esp_now_init() != ESP_OK) { Serial.println("[link] esp_now_init failed"); return; }
  esp_now_set_pmk(LINK_PMK);
  esp_now_peer_info_t p = {};
  memcpy(p.peer_addr, LOCK_MAC, 6);
  memcpy(p.lmk, LINK_LMK, 16);
  p.channel = LINK_CHANNEL; p.ifidx = WIFI_IF_STA; p.encrypt = true;
  if (esp_now_add_peer(&p) != ESP_OK) { Serial.println("[link] adding the CYD as a peer failed"); return; }
  esp_now_register_recv_cb(onLinkRecv);
}

static void linkSend(LinkType type, const uint8_t* uid = nullptr, uint8_t len = 0) {
  LinkMsg m = {};
  m.magic = LINK_MAGIC; m.version = LINK_VERSION; m.type = type;
  m.readerOk = readerOk;
  m.nonce = cydNonce;
  if (uid) { m.uidLen = len; memcpy(m.uid, uid, len); }
  linkSign(m);
  esp_now_send(LOCK_MAC, (const uint8_t*)&m, sizeof(m));
}

static void linkTick() {
  static uint32_t lastBeat = 0;
  if (millis() - lastBeat >= HEARTBEAT_MS) {
    lastBeat = millis();
    linkSend(LINK_HEARTBEAT);
  }
  const uint32_t heard = cydHeardMs;  // read before millis(), so millis() - heard can't wrap
  const bool seen = heard && millis() - heard < LINK_TIMEOUT_MS;
  if (seen != cydSeen) {
    cydSeen = seen;
    Serial.println(seen ? "[link] CYD connected" : "[link] CYD stopped answering");
  }
}

// ---- PN532 ----

// Drop leftover bytes before a command. The library reads fixed-length replies, so a longer
// reply leaves bytes behind that would be taken for the next command's ACK and make it fail.
static void flushPn532() {
  while (pn532Serial.available()) pn532Serial.read();
}

static bool initReader() {
  nfc.begin();
  pn532Serial.setTimeout(PN532_HSU_READ_MS);  // *** the fix -- see file header ***
  fwVersion = nfc.getFirmwareVersion();
  if (!fwVersion) return false;
  flushPn532();
  nfc.setPassiveActivationRetries(PN532_ACTIVATION_RETRIES);
  flushPn532();
  nfc.SAMConfig();  // normal mode, no IRQ-on-card
  flushPn532();
  return true;
}

static bool tryConnect() {
  static bool reported = false;  // print the "not answering" hint once, not every retry
  if (!initReader()) {
    if (!reported) {
      Serial.println("[nfc] PN532 not answering on UART -- check GPIO 4/5 wiring and the SW1/SW2 switches (both OFF)");
      Serial.println("[nfc] Re-checking every few seconds -- fix the wiring and watch for \"Found\".");
    }
    reported = true;
    return false;
  }
  reported = false;
  Serial.printf("[nfc] Found %s on UART (RX %d, TX %d)\n", fwString().c_str(), PN532_RX_PIN, PN532_TX_PIN);
  return true;
}

// One detection attempt. ISO14443A covers Mifare Classic/Ultralight, NTAG and phones.
static bool readUid(uint8_t* uid, uint8_t& len) {
  flushPn532();  // also drops a late reply to a poll that timed out
  static uint8_t buf[255];  // the library copies as many bytes as the response claims; room for a corrupted length byte
  len = 0;
  if (!nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, buf, &len, POLL_TIMEOUT_MS)) return false;
  if (len < 4 || len > sizeof(cardUid)) return false;
  memcpy(uid, buf, len);
  return true;
}

static void pollCard() {
  uint8_t uid[10], len;
  if (readUid(uid, len)) {
    cardSeenMs = millis();
    if (cardPresent && len == cardLen && !memcmp(uid, cardUid, len)) return;  // same card still there
    cardPresent = true;
    memcpy(cardUid, uid, len);
    cardLen = len;
    linkSend(LINK_TAG, uid, len);
    Serial.printf("[nfc] %s sent to the CYD%s\n", hexString(uid, len, ':').c_str(),
                  cydSeen ? "" : " (but the CYD isn't answering)");
    return;
  }
  if (cardPresent && millis() - cardSeenMs >= CARD_GONE_MS) {
    cardPresent = false;
    Serial.printf("[nfc] %s removed\n", hexString(cardUid, cardLen, ':').c_str());
  }
}

// ---- serial ----

static void handleSerial() {
  if (!Serial.available()) return;
  String c = Serial.readStringUntil('\n');
  c.trim();
  if (c == "status") {
    Serial.printf("[status] reader=%s card=%s cyd=%s polls=%lu avg=%lums max=%lums\n",
                  readerOk ? fwString().c_str() : "missing",
                  cardPresent ? hexString(cardUid, cardLen, ':').c_str() : "none",
                  cydSeen ? "connected" : "not-heard", (unsigned long)pollCount,
                  (unsigned long)(pollCount ? pollTotalMs / pollCount : 0), (unsigned long)pollMaxMs);
    pollCount = pollTotalMs = pollMaxMs = 0;
  } else if (c.length()) {
    Serial.println("[dev] commands: status");
  }
}

// ---- setup / loop ----

void setup() {
  Serial.begin(115200);
  Serial.setTimeout(100);
  delay(200);
  Serial.println("\n=== ESP32-S3 NFC reader (astro-health) ===");

  setupLink();

  pn532Serial.begin(115200, SERIAL_8N1, PN532_RX_PIN, PN532_TX_PIN);
  Serial.printf("[nfc] Looking for the PN532 on UART (RX %d, TX %d)\n", PN532_RX_PIN, PN532_TX_PIN);
  readerOk = tryConnect();
}

void loop() {
  static uint32_t lastHealth = 0, lastReconnect = 0;
  const uint32_t now = millis();

  handleSerial();
  if (readerOk) {
    const uint32_t t0 = millis();
    pollCard();
    const uint32_t took = millis() - t0;
    pollCount++;
    pollTotalMs += took;
    if (took > pollMaxMs) pollMaxMs = took;
    // While idle, make sure the PN532 still answers (catches a pulled cable).
    if (!cardPresent && now - lastHealth >= HEALTH_CHECK_MS) {
      lastHealth = now;
      flushPn532();
      if (!nfc.getFirmwareVersion()) {
        readerOk = false;
        Serial.println("[nfc] PN532 stopped responding");
      }
    }
  } else if (now - lastReconnect >= RECONNECT_MS) {
    lastReconnect = now;
    readerOk = tryConnect();
  }

  linkTick();
  delay(POLL_INTERVAL_MS);
}
