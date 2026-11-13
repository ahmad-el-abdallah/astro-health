// On-device Wi-Fi mode setup: Access Point (today's default, wifi_bridge.ino)
// or Join Wi-Fi, picked from a menu reachable from Idle only, with a real
// network scan and an on-screen touch keyboard for the password -- not
// hardcoded credentials, not a phone-based captive portal (docs/CLAUDE.md
// "CYD Wi-Fi mode setup"). Two async state machines (scan, connect), polled
// from loop() every tick -- never a blocking WiFi.scanNetworks()/WiFi.begin()
// wait, which would freeze touch/SOS for several seconds (this file's own
// "loop() must never block" rule).

// ---- entry point (Idle screen only) ----
void enterWifiMenu() {
  screen = SCR_WIFI_MENU;
  drawWifiMenuScreen();
}

void drawWifiMenuScreen() {
  clearScreen();
  drawHeader("WI-FI MODE", staMode ? "Currently: Join Wi-Fi" : "Currently: Access Point", false, "", 0);
  int y, h;
  colRow(3, 0, y, h);
  drawTile(U_PAD, y, SCRW - 2 * U_PAD, h, U_CREW, iconWifi, "Access Point",
           "This device creates its own Wi-Fi network", "");
  colRow(3, 1, y, h);
  drawTile(U_PAD, y, SCRW - 2 * U_PAD, h, U_CREW, iconWifi, "Join Wi-Fi",
           "Connect to your own Wi-Fi network", "");
  colRow(3, 2, y, h);
  drawTile(U_PAD, y, U_COL_W, h, U_SLATE, iconBack, "Back", "", "");
  int sx = U_PAD + U_COL_W + U_PAD;
  drawSosTile(sx, y, SCRW - U_PAD - sx, h);  // SOS must stay reachable from every screen
  drawFooter(laptopOnline);
}

void wifiMenuTouch(int x, int y) {
  int y0, h;
  colRow(3, 0, y0, h);
  if (hitRect(U_PAD, y0, SCRW - 2 * U_PAD, h, x, y)) {
    if (staMode) { prefs.putBool("staMode", false); ESP.restart(); }
    else goIdle();  // already the active mode, nothing to change
    return;
  }
  colRow(3, 1, y0, h);
  if (hitRect(U_PAD, y0, SCRW - 2 * U_PAD, h, x, y)) {
    beginWifiScan();
    screen = SCR_WIFI_SCAN;
    drawWifiScanScreen();
    return;
  }
  colRow(3, 2, y0, h);
  if (hitRect(U_PAD, y0, U_COL_W, h, x, y)) { goIdle(); return; }
}

// ---- network scan ----
void beginWifiScan() {
  wifiScanInProgress = true;
  wifiScanCount = 0;
  WiFi.scanNetworks(true);  // async: picked up by pollWifiScan() from loop()
}

void pollWifiScan() {
  if (!wifiScanInProgress) return;
  int n = WiFi.scanComplete();
  if (n == WIFI_SCAN_RUNNING) return;
  wifiScanInProgress = false;
  if (n < 0) n = 0;  // WIFI_SCAN_FAILED or nothing found
  wifiScanCount = min(n, WIFI_NETWORKS_MAX);
  for (int i = 0; i < wifiScanCount; i++) {
    wifiScanSsid[i] = WiFi.SSID(i);
    wifiScanRssi[i] = WiFi.RSSI(i);
  }
  WiFi.scanDelete();
  if (screen == SCR_WIFI_SCAN) drawWifiScanScreen();
}

void wifiScanRowRect(int i, int& x, int& y, int& w, int& h) {
  x = U_PAD; w = SCRW - 2 * U_PAD;
  y = U_HEAD_H + U_PAD + i * 30;
  h = 26;  // tight enough that even 5 rows stay clear of the SOS corner below
}

static const int WIFI_SCAN_BACK_W = 70, WIFI_SCAN_BACK_H = 26;
void wifiScanBackRect(int& x, int& y, int& w, int& h) {
  // On the right, not the left -- the bottom-left corner is drawSosButton()'s
  // fixed spot on every screen, and this row's y does reach down into that
  // same band (only its x clears it).
  x = SCRW - WIFI_SCAN_BACK_W - U_PAD; y = SCRH - U_FOOT_H - WIFI_SCAN_BACK_H - U_PAD;
  w = WIFI_SCAN_BACK_W; h = WIFI_SCAN_BACK_H;
}

void drawWifiScanScreen() {
  clearScreen();
  drawHeader("JOIN WI-FI", wifiScanInProgress ? "Scanning..." : (String(wifiScanCount) + " network(s) found"),
             false, "", 0);
  int rx, ry, rw, rh;
  for (int i = 0; i < wifiScanCount; i++) {
    wifiScanRowRect(i, rx, ry, rw, rh);
    drawPanel(rx, ry, rw, rh, 0);
    iconWifi(rx + 16, ry + rh / 2, 0.55f, U_TEXT, U_PANEL);
    tft.setTextDatum(ML_DATUM);
    tft.setTextColor(U_TEXT, U_PANEL);
    tft.drawString(wifiScanSsid[i], rx + 30, ry + rh / 2, 1);
    int pct = constrain(map(wifiScanRssi[i], -90, -30, 0, 100), 0, 100);
    tft.setTextDatum(MR_DATUM);
    tft.setTextColor(U_DIM, U_PANEL);
    tft.drawString(String(pct) + "%", rx + rw - 10, ry + rh / 2, 1);
  }
  if (!wifiScanInProgress && wifiScanCount == 0) {
    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(U_DIM, U_BG);
    tft.drawString("No networks found", SCRW / 2, U_HEAD_H + 50, 1);
  }
  int bx, by, bw, bh;
  wifiScanBackRect(bx, by, bw, bh);
  drawKey(bx, by, bw, bh, "Back", U_SLATE, 1);
  drawSosButton();
  drawFooter(laptopOnline);
}

void wifiScanTouch(int x, int y) {
  int rx, ry, rw, rh;
  for (int i = 0; i < wifiScanCount; i++) {
    wifiScanRowRect(i, rx, ry, rw, rh);
    if (hitRect(rx, ry, rw, rh, x, y)) {
      wifiSelectedSsid = wifiScanSsid[i];
      wifiPwLen = 0; wifiPwBuf[0] = 0;
      wifiKbShift = false; wifiKbPage2 = false;
      screen = SCR_WIFI_KEYBOARD;
      drawWifiKeyboardScreen();
      return;
    }
  }
  int bx, by, bw, bh;
  wifiScanBackRect(bx, by, bw, bh);
  if (hitRect(bx, by, bw, bh, x, y)) { screen = SCR_WIFI_MENU; drawWifiMenuScreen(); return; }
}

// ---- password keyboard: a 10-column grid shared by every row, two pages
// (letters+shift / digits+symbols, phone-keyboard style) ----
static const char* KB_ROW0 = "qwertyuiop";
static const char* KB_ROW1 = "asdfghjkl";
static const char* KB_ROW2 = "zxcvbnm";
static const char* KB_ROW0_SYM = "1234567890";
static const char* KB_ROW1_SYM = "-_@#$%&*()";
static const char* KB_ROW2_SYM = ".,!?/:;";

// Rows must end above y=180 -- drawSosButton()'s fixed corner (every screen
// in this firmware keeps SOS reachable, see that function's own comment)
// occupies x:[4,50] y:[180,224], and used to go unnoticed here because this
// screen never drew one at all -- pointInSos() was then testing against
// whatever screen's SOS rect was drawn *last* (Idle's own SOS tile), which
// happened to land squarely on top of this row's first two keys and ate
// those taps silently before they ever reached this screen's own touch
// handler. (See docs/CLAUDE.md "stale SOS rect" follow-up.)
static const int KB_TOP = U_HEAD_H + 22;
static const int KB_ROW_H = 30;
static const int KB_GAP = 2;

void kbKeyRect(int row, int col, int colSpan, int& x, int& y, int& w, int& h) {
  int areaW = SCRW - 2 * U_PAD;
  int colW = (areaW - 9 * KB_GAP) / 10;
  x = U_PAD + col * (colW + KB_GAP);
  w = colW * colSpan + KB_GAP * (colSpan - 1);
  y = KB_TOP + row * (KB_ROW_H + KB_GAP);
  h = KB_ROW_H;
}

void appendPwChar(char c) {
  if (wifiPwLen >= WIFI_PW_MAX) return;
  wifiPwBuf[wifiPwLen++] = c;
  wifiPwBuf[wifiPwLen] = 0;
  drawWifiKeyboardScreen();
}

void drawWifiKeyboardScreen() {
  clearScreen();
  drawHeader("JOIN WI-FI", wifiSelectedSsid, false, "", 0);
  tft.setTextDatum(TL_DATUM);
  String shown = String(wifiPwBuf);
  tft.setTextColor(shown.length() ? U_TEXT : U_DIM, U_BG);
  tft.drawString(shown.length() ? shown : "(tap keys, or Connect for an open network)",
                 U_PAD, U_HEAD_H + 4, shown.length() ? 2 : 1);

  const char* row0 = wifiKbPage2 ? KB_ROW0_SYM : KB_ROW0;
  const char* row1 = wifiKbPage2 ? KB_ROW1_SYM : KB_ROW1;
  int x, y, w, h;
  for (int i = 0; row0[i]; i++) {
    kbKeyRect(0, i, 1, x, y, w, h);
    char c = row0[i];
    if (!wifiKbPage2 && wifiKbShift) c = toupper(c);
    drawKey(x, y, w, h, String(c), U_SLATE, 2);
  }
  for (int i = 0; row1[i]; i++) {
    kbKeyRect(1, i, 1, x, y, w, h);
    char c = row1[i];
    if (!wifiKbPage2 && wifiKbShift) c = toupper(c);
    drawKey(x, y, w, h, String(c), U_SLATE, 2);
  }
  if (!wifiKbPage2) {
    kbKeyRect(2, 0, 1, x, y, w, h);
    drawKey(x, y, w, h, "^", wifiKbShift ? U_CREW : U_SLATE, 2);
    for (int i = 0; KB_ROW2[i]; i++) {
      kbKeyRect(2, i + 1, 1, x, y, w, h);
      char c = wifiKbShift ? toupper(KB_ROW2[i]) : KB_ROW2[i];
      drawKey(x, y, w, h, String(c), U_SLATE, 2);
    }
  } else {
    for (int i = 0; KB_ROW2_SYM[i]; i++) {
      kbKeyRect(2, i, 1, x, y, w, h);
      drawKey(x, y, w, h, String(KB_ROW2_SYM[i]), U_SLATE, 2);
    }
  }
  kbKeyRect(2, 8, 2, x, y, w, h);
  drawKey(x, y, w, h, "<-", U_SLATE, 1);

  kbKeyRect(3, 0, 2, x, y, w, h);
  drawKey(x, y, w, h, wifiKbPage2 ? "ABC" : "123", U_SLATE, 1);
  kbKeyRect(3, 2, 4, x, y, w, h);
  drawKey(x, y, w, h, "Space", U_SLATE, 1);
  kbKeyRect(3, 6, 2, x, y, w, h);
  drawKey(x, y, w, h, "Cancel", U_SLATE, 1);
  kbKeyRect(3, 8, 2, x, y, w, h);
  drawKey(x, y, w, h, "Connect", U_CREW, 1);
  drawSosButton();
  drawFooter(laptopOnline);
}

void wifiKeyboardTouch(int x, int y) {
  const char* row0 = wifiKbPage2 ? KB_ROW0_SYM : KB_ROW0;
  const char* row1 = wifiKbPage2 ? KB_ROW1_SYM : KB_ROW1;
  int kx, ky, kw, kh;
  for (int i = 0; row0[i]; i++) {
    kbKeyRect(0, i, 1, kx, ky, kw, kh);
    if (hitRect(kx, ky, kw, kh, x, y)) {
      char c = row0[i];
      if (!wifiKbPage2 && wifiKbShift) c = toupper(c);
      appendPwChar(c);
      return;
    }
  }
  for (int i = 0; row1[i]; i++) {
    kbKeyRect(1, i, 1, kx, ky, kw, kh);
    if (hitRect(kx, ky, kw, kh, x, y)) {
      char c = row1[i];
      if (!wifiKbPage2 && wifiKbShift) c = toupper(c);
      appendPwChar(c);
      return;
    }
  }
  if (!wifiKbPage2) {
    kbKeyRect(2, 0, 1, kx, ky, kw, kh);
    if (hitRect(kx, ky, kw, kh, x, y)) { wifiKbShift = !wifiKbShift; drawWifiKeyboardScreen(); return; }
    for (int i = 0; KB_ROW2[i]; i++) {
      kbKeyRect(2, i + 1, 1, kx, ky, kw, kh);
      if (hitRect(kx, ky, kw, kh, x, y)) { appendPwChar(wifiKbShift ? toupper(KB_ROW2[i]) : KB_ROW2[i]); return; }
    }
  } else {
    for (int i = 0; KB_ROW2_SYM[i]; i++) {
      kbKeyRect(2, i, 1, kx, ky, kw, kh);
      if (hitRect(kx, ky, kw, kh, x, y)) { appendPwChar(KB_ROW2_SYM[i]); return; }
    }
  }
  kbKeyRect(2, 8, 2, kx, ky, kw, kh);
  if (hitRect(kx, ky, kw, kh, x, y)) {
    if (wifiPwLen > 0) { wifiPwLen--; wifiPwBuf[wifiPwLen] = 0; }
    drawWifiKeyboardScreen();
    return;
  }

  kbKeyRect(3, 0, 2, kx, ky, kw, kh);
  if (hitRect(kx, ky, kw, kh, x, y)) { wifiKbPage2 = !wifiKbPage2; drawWifiKeyboardScreen(); return; }
  kbKeyRect(3, 2, 4, kx, ky, kw, kh);
  if (hitRect(kx, ky, kw, kh, x, y)) { appendPwChar(' '); return; }
  kbKeyRect(3, 6, 2, kx, ky, kw, kh);
  if (hitRect(kx, ky, kw, kh, x, y)) { screen = SCR_WIFI_SCAN; drawWifiScanScreen(); return; }
  kbKeyRect(3, 8, 2, kx, ky, kw, kh);
  if (hitRect(kx, ky, kw, kh, x, y)) {
    wifiConnectError = "";
    beginWifiStaConnect(wifiSelectedSsid, String(wifiPwBuf), true);
    screen = SCR_WIFI_CONNECTING;
    drawWifiConnectingScreen();
    return;
  }
}

// ---- connect: async (WiFi.begin() itself never blocks; pollWifiConnect()
// polls WiFi.status() from loop() against a timeout) ----
void beginWifiStaConnect(const String& ssid, const String& password, bool isSetupFlow) {
  wifiConnectIsSetupFlow = isSetupFlow;
  wifiConnectPending = true;
  wifiConnectStartMs = millis();
  WiFi.disconnect();
  if (password.length()) WiFi.begin(ssid.c_str(), password.c_str());
  else WiFi.begin(ssid.c_str());  // open network
}

// Join Wi-Fi mode, after the first join: if the link drops (router restart, a signal blip)
// and stays down this long, join again ourselves. The ESP32's own auto-reconnect sometimes
// gives up for good, and the screen then said "Wi-Fi: reconnecting..." forever -- only a
// restart brought it back. Not while a Wi-Fi setup screen is open (a scan or a new join).
static const uint32_t WIFI_LOST_GRACE_MS = 8000;
static uint32_t wifiLostSinceMs = 0;
static bool mdnsUp = false;

static void watchWifiLink() {
  bool setupOpen = screen == SCR_WIFI_MENU || screen == SCR_WIFI_SCAN || screen == SCR_WIFI_KEYBOARD || screen == SCR_WIFI_CONNECTING;
  if (!staMode || wifiRestartAtMs || setupOpen || WiFi.status() == WL_CONNECTED) { wifiLostSinceMs = 0; return; }
  if (!wifiLostSinceMs) {
    wifiLostSinceMs = millis();
    Serial.println("[wifi] link lost, waiting for it to come back...");
  } else if (millis() - wifiLostSinceMs > WIFI_LOST_GRACE_MS) {
    wifiLostSinceMs = 0;
    Serial.println("[wifi] still down, joining again...");
    beginWifiStaConnect(wifiSelectedSsid, prefs.getString("staPassword", ""), false);  // retries until it's back
  }
}

void pollWifiConnect() {
  if (!wifiConnectPending) { watchWifiLink(); return; }
  if (WiFi.status() == WL_CONNECTED) {
    wifiConnectPending = false;
    startTcpServer();  // wifi_bridge.ino -- same server either Wi-Fi mode ends up using (a no-op if already listening)
    if (!mdnsUp && MDNS.begin("astro-cyd")) { MDNS.addService("astro-health", "tcp", TCP_PORT); mdnsUp = true; }
    configTime(0, 0, "pool.ntp.org", "time.nist.gov");  // UTC directly -- 0 offset, 0 DST
    Serial.printf("[wifi] joined \"%s\", IP %s, port %u (also at astro-cyd.local)\n",
                  wifiSelectedSsid.c_str(), WiFi.localIP().toString().c_str(), TCP_PORT);
    if (wifiConnectIsSetupFlow) {
      // New, just-proven-working credentials -- persist and restart into a
      // clean STA-only setup() (see astro_cyd.ino's own comment on why this
      // is never hot-switched). The normal boot-time reconnect above
      // (isSetupFlow=false) never reaches here a second time pointlessly --
      // it's already running with nothing left to save.
      prefs.putBool("staMode", true);
      prefs.putString("staSsid", wifiSelectedSsid);
      prefs.putString("staPassword", String(wifiPwBuf));
      wifiRestartAtMs = millis() + 4000;  // let them read the IP first
    }
    if (screen == SCR_WIFI_CONNECTING) drawWifiConnectingScreen();
    return;
  }
  if (millis() - wifiConnectStartMs > WIFI_CONNECT_TIMEOUT_MS) {
    wifiConnectPending = false;
    if (!wifiConnectIsSetupFlow) {
      // The background reconnect (boot, or any time the link drops) used to
      // just give up silently after one timeout -- the stored credentials
      // were never touched, but the device would sit there neither
      // connected nor running its own AP, which looks identical to "it
      // forgot my Wi-Fi" from the outside. A transient miss (the router
      // busy, weak signal at that exact moment, a slow DHCP lease) is
      // common and not a reason to stop trying -- retry indefinitely, same
      // philosophy as the laptop's own serial/Wi-Fi bridges never giving up
      // on reconnecting either. The *interactive* setup flow (testing a
      // password someone just typed) still stops and shows the error below
      // instead -- auto-retrying a genuinely wrong password forever would
      // hide the mistake rather than let them fix it.
      Serial.println("[wifi] background reconnect timed out, retrying...");
      beginWifiStaConnect(wifiSelectedSsid, prefs.getString("staPassword", ""), false);
      return;
    }
    wifiConnectError = "Wrong password, or the network is out of range.";
    if (screen == SCR_WIFI_CONNECTING) drawWifiConnectingScreen();
  }
}

void pollWifiRestart() {
  if (wifiRestartAtMs && millis() > wifiRestartAtMs) { wifiRestartAtMs = 0; ESP.restart(); }
}

// One-time Serial confirmation the moment NTP sync actually completes --
// useful on its own (no other message in this protocol ever reports real
// time), and the only way to confirm the clock got a plausible real value
// without looking at the physical screen.
void pollNtpAnnounce() {
  static bool announced = false;
  if (announced || !ntpLooksSynced()) return;
  announced = true;
  time_t now = time(nullptr);
  struct tm t;
  gmtime_r(&now, &t);
  char buf[32];
  strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S UTC", &t);
  Serial.printf("[ntp] synced: %s\n", buf);
}

void drawWifiConnectingScreen() {
  clearScreen();
  drawHeader("JOIN WI-FI", wifiSelectedSsid, false, "", 0);
  tft.setTextDatum(MC_DATUM);
  int cy = U_HEAD_H + 60;
  if (wifiConnectPending) {
    tft.setTextColor(U_TEXT, U_BG);
    tft.drawString("Connecting...", SCRW / 2, cy, 2);
  } else if (WiFi.status() == WL_CONNECTED) {
    tft.setTextColor(U_GREEN, U_BG);
    tft.drawString("Connected!", SCRW / 2, cy, 2);
    tft.setTextColor(U_TEXT, U_BG);
    tft.drawString("IP: " + WiFi.localIP().toString(), SCRW / 2, cy + 22, 1);
    tft.setTextColor(U_DIM, U_BG);
    tft.drawString("or astro-cyd.local -- restarting shortly", SCRW / 2, cy + 38, 1);
  } else {
    tft.setTextColor(U_RED, U_BG);
    tft.drawString("Couldn't connect", SCRW / 2, cy, 2);
    tft.setTextColor(U_DIM, U_BG);
    drawWrapped(wifiConnectError, SCRW / 2, cy + 20, SCRW - 40, 14, 1);
    int bx = SCRW / 2 - 130, by = cy + 55, bw = 120, bh = 30;
    drawKey(bx, by, bw, bh, "Try again", U_SLATE, 1);
    drawKey(bx + 140, by, bw, bh, "Other network", U_SLATE, 1);
  }
  drawSosButton();
  if (WiFi.status() != WL_CONNECTED) drawBackButton();  // once connected it restarts by itself
  drawFooter(laptopOnline);
}

void wifiConnectingTouch(int x, int y) {
  if (WiFi.status() == WL_CONNECTED) return;  // about to restart
  if (pointInBack(x, y)) {  // give up on this attempt and go back to the password
    if (wifiConnectPending) { wifiConnectPending = false; WiFi.disconnect(); }
    screen = SCR_WIFI_KEYBOARD;
    drawWifiKeyboardScreen();
    return;
  }
  if (wifiConnectPending) return;  // still connecting
  int cy = U_HEAD_H + 60 + 55;
  int bx = SCRW / 2 - 130, bw = 120, bh = 30;
  if (hitRect(bx, cy, bw, bh, x, y)) {
    wifiPwLen = 0; wifiPwBuf[0] = 0;
    screen = SCR_WIFI_KEYBOARD;
    drawWifiKeyboardScreen();
    return;
  }
  if (hitRect(bx + 140, cy, bw, bh, x, y)) {
    beginWifiScan();
    screen = SCR_WIFI_SCAN;
    drawWifiScanScreen();
    return;
  }
}
