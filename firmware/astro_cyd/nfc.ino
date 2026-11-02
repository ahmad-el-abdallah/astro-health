// ESP-NOW receive from the separate ESP32-S3 NFC reader board. This board
// (the CYD) plays the same "lock" role nfc_link.h was written for: it
// sends LINK_HELLO with a fresh nonce every second, and only accepts a
// LINK_TAG whose nonce is the current or previous one (replay
// protection), exactly like the Lifeline project this link came from.
// The difference is what happens next: instead of granting/denying entry,
// every accepted tag becomes a `scan` message up to the laptop.

QueueHandle_t rxQueue;
uint32_t nonceCur = 1, noncePrev = 1;
uint32_t lastHelloMs = 0;
static const uint32_t HELLO_MS = 1000;

uint32_t newNonce() {
  uint32_t n;
  do { n = esp_random(); } while (!n);
  return n;
}

void rotateNonce(bool burn) {
  noncePrev = burn ? newNonce() : nonceCur;
  nonceCur = newNonce();
}

void sendLinkHello() {
  LinkMsg m = {};
  m.magic = LINK_MAGIC; m.version = LINK_VERSION; m.type = LINK_HELLO; m.nonce = nonceCur;
  linkSign(m);
  esp_now_send(READER_MAC, (const uint8_t*)&m, sizeof(m));
}

// Runs in the Wi-Fi task: only copy the frame out; loop() verifies and acts.
void onLinkRecv(const esp_now_recv_info_t* info, const uint8_t* data, int len) {
  if (len != (int)sizeof(LinkMsg) || memcmp(info->src_addr, READER_MAC, 6)) return;
  LinkMsg m;
  memcpy(&m, data, sizeof(m));
  xQueueSend(rxQueue, &m, 0);
}

void setupLink() {
  // WIFI_AP_STA, not plain WIFI_STA: this keeps the station interface (and
  // its MAC -- the same LOCK_MAC the S3 reader has always targeted) alive
  // alongside the new access point in wifi_bridge.ino, so ESP-NOW needs no
  // changes at all, and the S3 reader project needs none either. Both
  // interfaces share one radio and so share one channel; the AP is pinned
  // to LINK_CHANNEL in startAccessPoint() for exactly that reason.
  WiFi.mode(WIFI_AP_STA);
  WiFi.disconnect();
  esp_wifi_set_ps(WIFI_PS_NONE);
  rxQueue = xQueueCreate(8, sizeof(LinkMsg));
  nonceCur = newNonce();
  noncePrev = newNonce();
  if (esp_now_init() != ESP_OK) { Serial.println("[link] esp_now_init failed"); return; }
  esp_now_set_pmk(LINK_PMK);
  esp_now_peer_info_t p = {};
  memcpy(p.peer_addr, READER_MAC, 6);
  memcpy(p.lmk, LINK_LMK, 16);
  p.channel = LINK_CHANNEL; p.ifidx = WIFI_IF_STA; p.encrypt = true;
  if (esp_now_add_peer(&p) != ESP_OK) Serial.println("[link] adding the reader as a peer failed");
  esp_now_register_recv_cb(onLinkRecv);
}

void handleLink() {
  uint32_t now = millis();
  if (now - lastHelloMs >= HELLO_MS) {
    lastHelloMs = now;
    rotateNonce(false);
    sendLinkHello();
  }
  LinkMsg m;
  while (xQueueReceive(rxQueue, &m, 0) == pdTRUE) {
    if (!linkVerify(m)) continue;
    if (m.type != LINK_TAG || m.uidLen < 4) continue;
    if (m.nonce != nonceCur && m.nonce != noncePrev) continue;  // stale/replayed frame: ignore
    rotateNonce(true);  // this challenge is spent either way
    sendLinkHello();
    String uid = uidHex(m.uid, m.uidLen);
    onCardScanned(uid);
  }
}

String uidHex(const uint8_t* u, int n) {
  String s;
  char b[4];
  for (int i = 0; i < n; i++) {
    snprintf(b, sizeof(b), i ? ":%02X" : "%02X", u[i]);
    s += b;
  }
  return s;
}
