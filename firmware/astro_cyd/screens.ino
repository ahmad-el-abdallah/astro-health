// The crew-facing screens (docs/build-prompt.md section 10, restyled
// 2026-11-11 to match firmware/tools/cyd_preview.html -- open that file
// directly in a browser to see the design reference these follow). Shared
// chrome (header/footer/tile/panel/vital/icons) lives in ui_kit.ino; this
// file is screen layout + touch handling + the timed/animated bits only.
// Nothing here blocks for more than ~20 ms; timed things (toasts, the
// reaction test, breathing, timeouts) are driven from
// updateScreenTimers(), called every loop().
//
// Scope note: this pass covers every screen a crew member sees. The
// Flight Surgeon's own on-device screens (crew list, alerts, inbox) from
// the same design reference are a separate, later phase -- today the
// surgeon's card still opens this same generic crew-home screen, see
// docs/CLAUDE.md's "CYD redesign" entry for why that's split out.
//
// Note on Arduino multi-tab sketches: every .ino tab is concatenated into
// one file for compiling, and arduino-cli auto-generates a prototype for
// every function near the top of that file. A prototype only needs the
// *types* of a function's parameters to already be declared by then --
// so the Screen enum and every shared variable live in astro_cyd.ino (the
// first tab) rather than here, even though most of the logic that uses
// them is in this file.

// ---- small drawing helpers ----
// Deliberately plain ints, not a Btn struct: see the note above about
// cross-tab prototype generation.
bool hitRect(int bx, int by, int bw, int bh, int x, int y) {
  return x >= bx && x <= bx + bw && y >= by && y <= by + bh;
}

// On a real mission the Flight Surgeon is Earth-based -- this role's
// physical presence on the station is a crew member serving as Crew
// Medical Officer, not the surgeon herself. Presentation-only: the DB
// role value, web app badge, and every permission check stay exactly
// "Flight surgeon" (docs/CLAUDE.md "CMO on-device framing") -- only this
// device's own on-screen label differs.
String displayRole(const String& role) {
  return role == "Flight surgeon" ? "Crew Medical Officer" : role;
}

void clearScreen() { tft.fillScreen(U_BG); }

// Greedy word-wrap: draws `s` as however many centered lines of at most
// maxW px it takes (e.g. a status note naming several flagged indicators,
// which used to get cut down to just one so it would fit on one line --
// see onStatusMsg). Assumes the caller already set the text color.
void drawWrapped(const String& s, int cx, int yTop, int maxW, int lineH, int font) {
  tft.setTextDatum(MC_DATUM);
  int y = yTop;
  String line = "";
  int start = 0;
  while (start <= (int)s.length()) {
    int sp = s.indexOf(' ', start);
    String word = (sp == -1) ? s.substring(start) : s.substring(start, sp);
    String trial = line.length() ? line + " " + word : word;
    if (line.length() == 0 || tft.textWidth(trial, font) <= maxW) {
      line = trial;
    } else {
      tft.drawString(line, cx, y, font);
      y += lineH;
      line = word;
    }
    if (sp == -1) break;
    start = sp + 1;
  }
  if (line.length()) { tft.drawString(line, cx, y, font); y += lineH; }
}

// ---- SOS: a small fixed corner tile on every full-width task screen
// (mood/symptoms/reaction/breathe/workout), or a proper column tile on
// Idle/crew home (drawSosTile(), ui_kit.ino's drawTile under the hood).
// Both set the shared sosX/Y/W/H globals so pointInSos() always hits
// wherever it was actually drawn last, instead of one hardcoded rect.
void drawSosButton() {
  sosX = 4; sosY = SCRH - U_FOOT_H - 44; sosW = 46; sosH = 44;
  drawTile(sosX, sosY, sosW, sosH, U_RED, iconAlert, "SOS", "", "");
}
void drawSosTile(int x, int y, int w, int h) {
  sosX = x; sosY = y; sosW = w; sosH = h;
  drawTile(x, y, w, h, U_RED, iconAlert, "SOS", "hold 2s", "");
}
bool pointInSos(int x, int y) { return hitRect(sosX, sosY, sosW, sosH, x, y); }

// ---- the Back button: every sub-screen's way back to where you came from, in the
// bottom-right corner (the mirror of the SOS corner). Each screen that draws it checks
// pointInBack() first in its own touch handler. ----
static const int BACK_W = 46, BACK_H = 44;
int backX() { return SCRW - 4 - BACK_W; }
int backY() { return SCRH - U_FOOT_H - BACK_H; }
void drawBackButton() {
  drawTile(backX(), backY(), BACK_W, BACK_H, U_SLATE, iconBack, "Back", "", "");
}
bool pointInBack(int x, int y) { return hitRect(backX(), backY(), BACK_W, BACK_H, x, y); }

// ---- screen: Idle ----
// ---- idle screen's own clock region (y 60-125): a real UTC clock once
// Join Wi-Fi actually has internet and NTP has synced (astro_cyd.ino's
// ntpLooksSynced(), set rolling via configTime() in wifi_setup.ino's
// pollWifiConnect()); the uptime-since-boot counter otherwise (AP mode,
// not yet connected, or connected but still syncing -- never shows a
// wrong/epoch time). Its own function, separate from the rest of
// drawIdleScreen(), so the 1s tick that keeps it ticking (updateScreenTimers())
// only ever repaints this one band, never the tiles/hint text/status lines
// below it. ----
void drawIdleClock() {
  int cx0 = U_PAD + U_COL_W + U_PAD, cw = SCRW - U_PAD - cx0, mid = cx0 + cw / 2;
  tft.fillRect(cx0, 60, cw, 65, U_BG);
  if (staMode && WiFi.status() == WL_CONNECTED && ntpLooksSynced()) {
    time_t now = time(nullptr);
    struct tm t;
    gmtime_r(&now, &t);
    char hh[3], mm[3], ss[3];
    snprintf(hh, sizeof(hh), "%02d", t.tm_hour);
    snprintf(mm, sizeof(mm), "%02d", t.tm_min);
    snprintf(ss, sizeof(ss), "%02d", t.tm_sec);
    int wHh = tft.textWidth(hh, 4), wColon = tft.textWidth(":", 4);
    int wMm = tft.textWidth(mm, 4), wSs = tft.textWidth(ss, 4);
    int x = mid - (wHh + wColon + wMm + wColon + wSs) / 2;
    tft.setTextDatum(ML_DATUM);
    tft.setTextColor(U_TEXT, U_BG); tft.drawString(hh, x, 75, 4); x += wHh;
    tft.setTextColor(U_CREW, U_BG); tft.drawString(":", x, 75, 4); x += wColon;
    tft.setTextColor(U_TEXT, U_BG); tft.drawString(mm, x, 75, 4); x += wMm;
    tft.setTextColor(U_CREW, U_BG); tft.drawString(":", x, 75, 4); x += wColon;
    tft.setTextColor(U_TEXT, U_BG); tft.drawString(ss, x, 75, 4);
    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(U_DIM, U_BG);
    tft.drawString("UTC", mid, 95, 1);
    char dateBuf[24];
    strftime(dateBuf, sizeof(dateBuf), "%a %d %b %Y", &t);
    tft.drawString(dateBuf, mid, 112, 2);
  } else if (staMode && WiFi.status() == WL_CONNECTED) {
    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(U_DIM, U_BG);
    tft.drawString("Syncing time...", mid, 92, 2);
  } else {
    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(U_TEXT, U_BG);
    char up[16];
    uint32_t s = millis() / 1000;
    snprintf(up, sizeof(up), "%lu:%02lu:%02lu", (unsigned long)(s / 3600), (unsigned long)((s / 60) % 60), (unsigned long)(s % 60));
    tft.drawString(up, mid, 92, 4);
  }
}

void drawIdleScreen() {
  clearScreen();
  drawHeader("ASTRO HEALTH", "", false, "", 0);
  int y, h;
  colRow(3, 0, y, h);
  drawTile(U_PAD, y, U_COL_W, h, U_CREW, iconNfc, "Tap card", "to sign in", "");
  colRow(3, 1, y, h);
  drawSosTile(U_PAD, y, U_COL_W, h);
  colRow(3, 2, y, h);
  drawTile(U_PAD, y, U_COL_W, h, U_SLATE, iconWifi, "Wi-Fi", staMode ? "Join Wi-Fi" : "Access Point", "");

  // Content band is narrower than the old full-width idle screen (the
  // left column now reserves U_COL_W+PAD px), so every string here is
  // either wrapped or font-4 rather than the old font-7 clock/long
  // sentence that only fit when this had the whole 320px to itself.
  int cx0 = U_PAD + U_COL_W + U_PAD, cw = SCRW - U_PAD - cx0, mid = cx0 + cw / 2;
  drawIdleClock();
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(U_DIM, U_BG);
  drawWrapped("Tap your crew card on the reader", mid, 140, cw - 10, 16, 2);
  String laptopTxt = laptopOnline ? "Laptop online" : "Laptop offline";
  int lw = tft.textWidth(laptopTxt, 1);
  tft.fillCircle(mid - lw / 2 - 8, 182, 4, laptopOnline ? U_GREEN : U_RED);
  tft.setTextDatum(ML_DATUM);
  tft.drawString(laptopTxt, mid - lw / 2, 182, 1);
  // Once off USB there's no serial console left to read an IP from -- this
  // is the only other place it's ever shown (see wifi_setup.ino). Also
  // shown mid-retry (not just once connected) so a dropped/not-yet-joined
  // link is visibly still trying, not indistinguishable from stuck.
  if (staMode) {
    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(U_DIM, U_BG);
    if (WiFi.status() == WL_CONNECTED) {
      tft.drawString("Wi-Fi: " + WiFi.localIP().toString(), mid, 200, 1);
    } else {
      tft.drawString("Wi-Fi: reconnecting...", mid, 200, 1);
    }
  }
  drawFooter(laptopOnline);
}

void idleTouch(int x, int y) {
  int y0, h;
  colRow(3, 2, y0, h);
  if (hitRect(U_PAD, y0, U_COL_W, h, x, y)) { enterWifiMenu(); return; }
}

// ---- screen: crew home (session menu + today's vitals) ----
// The center content band sits between the left (Mood/Symptoms/Reaction/
// Breathe) and right (Done/SOS) columns -- both reserved here, not just
// the left one, or the vitals grid's own right edge would land directly
// under the Done/SOS tiles.
static const int SESS_CX0 = U_PAD + U_COL_W + U_PAD;
static const int SESS_CW = SCRW - U_PAD - U_COL_W - U_PAD - SESS_CX0;

String levelChipWord(const String& level) {
  if (level == "RED") return "ALERT";
  if (level == "YELLOW") return "CHECK";
  if (level == "GREEN") return "GOOD";
  return "";
}

void drawSessionScreen() {
  clearScreen();
  String chip = levelChipWord(curLevel);
  // curRole just labels the header here in phase 1 -- the Flight Surgeon
  // still gets this exact same generic screen (see this file's header
  // comment); a distinct surgeon home screen is the later, separate pass.
  drawHeader(curName.length() ? curName : curUid, displayRole(curRole), false, chip, colorForLevel(curLevel));

  int y, h;
  colRow(4, 0, y, h); drawTile(U_PAD, y, U_COL_W, h, U_CREW, iconMood, "Mood", "", "");
  colRow(4, 1, y, h); drawTile(U_PAD, y, U_COL_W, h, U_CREW, iconSymptoms, "Symptoms", "", "");
  colRow(4, 2, y, h); drawTile(U_PAD, y, U_COL_W, h, U_CREW, iconTarget, "Reaction", "", "");
  colRow(4, 3, y, h); drawTile(U_PAD, y, U_COL_W, h, U_CREW, iconWind, "Breathe", "", "");

  int rx = SCRW - U_PAD - U_COL_W;
  colRow(2, 0, y, h); drawTile(rx, y, U_COL_W, h, U_SLATE, iconLogout, "Done", "", "");
  colRow(2, 1, y, h); drawSosTile(rx, y, U_COL_W, h);

  int x = SESS_CX0, w = SESS_CW;
  int vy = U_HEAD_H + U_PAD, vw = (w - U_PAD) / 2, vh = 46;
  // Short labels on purpose -- these tiles are only ~86px wide (two per
  // half of a column-squeezed content band), "Blood pressure" at font 1
  // would run past the tile's own level dot.
  drawVital(x, vy, vw, vh, "HR", vHr, vHrL, iconHeart);
  drawVital(x + vw + U_PAD, vy, vw, vh, "BP", vBp, vBpL, iconBp);
  drawVital(x, vy + vh + U_PAD, vw, vh, "Mood", vMood, vMoodL, iconMood);
  drawVital(x + vw + U_PAD, vy + vh + U_PAD, vw, vh, "Sleep", vSleep, vSleepL, iconSleep);
  int ny = vy + 2 * (vh + U_PAD), nh = SCRH - U_FOOT_H - U_PAD - ny;
  drawPanel(x, ny, w, nh, 0);
  if (exerciseRunning) {  // you went Back from the workout timer: here's the way back to it
    tft.setTextColor(U_GREEN, U_PANEL);
    drawWrapped("Workout running. Tap here to see the timer.", x + w / 2, ny + nh / 2 - 6, w - 16, 11, 1);
  } else {
    tft.setTextColor(U_DIM, U_PANEL);
    drawWrapped("Tap a card above, or Done when finished.", x + w / 2, ny + nh / 2 - 6, w - 16, 11, 1);
  }

  drawFooter(laptopOnline);
}

void sessionTouch(int x, int y) {
  int y0, h;
  colRow(4, 0, y0, h); if (hitRect(U_PAD, y0, U_COL_W, h, x, y)) { screen = SCR_MOOD; drawMoodScreen(); return; }
  colRow(4, 1, y0, h); if (hitRect(U_PAD, y0, U_COL_W, h, x, y)) { screen = SCR_SYMPTOMS; drawSymptomsScreen(); return; }
  colRow(4, 2, y0, h); if (hitRect(U_PAD, y0, U_COL_W, h, x, y)) { startReactionTest(); return; }
  colRow(4, 3, y0, h); if (hitRect(U_PAD, y0, U_COL_W, h, x, y)) { startBreathing(); return; }
  int rx = SCRW - U_PAD - U_COL_W;
  colRow(2, 0, y0, h); if (hitRect(rx, y0, U_COL_W, h, x, y)) { endSessionLocally("done"); return; }
  if (exerciseRunning) {  // the "Workout running" panel (same rect as drawSessionScreen's)
    int px = SESS_CX0, pw = SESS_CW, vy = U_HEAD_H + U_PAD, ny = vy + 2 * (46 + U_PAD);
    if (hitRect(px, ny, pw, SCRH - U_FOOT_H - U_PAD - ny, x, y)) { screen = SCR_EXERCISE_TIMER; drawExerciseTimer(); return; }
  }
}

void endSessionLocally(const char* reason) {
  sendEndSession(curUid, reason);
  // An explicit "done" clears the stored pairing (docs/CLAUDE.md "stale
  // pairing after Done" follow-up) -- otherwise the very next hello (any
  // reconnect, a restart, a brief Wi-Fi drop) still carries the same UID
  // and the backend auto-resumes the session right back, making Done not
  // actually sign you off. An idle timeout does NOT clear it -- same
  // asymmetry this project already uses for the web login (idle never
  // logs the browser out, only Done/Log out does): a device that just
  // went quiet for a while should still pick back up as you when it
  // reconnects, same as the original "USB to power bank" ask needs.
  if (strcmp(reason, "done") == 0) prefs.remove("pairedUid");
  curUid = ""; curName = ""; curLevel = "GRAY"; curRole = "Crew member";
  vHr = ""; vHrL = "GRAY"; vBp = ""; vBpL = "GRAY"; vMood = ""; vMoodL = "GRAY"; vSleep = ""; vSleepL = "GRAY";
  crewCount = 0; alertsCount = 0; selectedAlert = -1; inboxHasItem = false; viewingCrewId = -1;
  goIdle();
}

// ---- Flight Surgeon on-device screens (phase 2 of the CYD redesign) --
// design reference: firmware/tools/cyd_preview.html, screens 3-6. Her
// card starts a session exactly like any crew member's (sessionTouch()
// above is never reached for her -- goHome()/homeScreenEnum() route her
// here instead, see those functions' own comments). ----

// Reuses crew-home's own center-column geometry (left col + center + right
// col) since the chrome is identical -- same reasoning drawVital()'s
// callers already share SESS_CX0/SESS_CW for the two-vital-per-row grid.
void crewRowRect(int i, int& rx, int& ry, int& rw, int& rh) {
  rx = SESS_CX0; rw = SESS_CW; rh = 36; ry = U_HEAD_H + U_PAD + i * (rh + U_PAD);
}

void drawSurgeonHomeScreen() {
  clearScreen();
  String chip = alertsCount > 0 ? String(alertsCount) + " OPEN" : "";
  drawHeader(curName.length() ? curName : curUid, displayRole("Flight surgeon"), true, chip, U_RED);

  int y, h;
  colRow(2, 0, y, h); drawTile(U_PAD, y, U_COL_W, h, U_RED, iconAlert, "Alerts", "", alertsCount > 0 ? String(alertsCount) : "");
  colRow(2, 1, y, h); drawTile(U_PAD, y, U_COL_W, h, U_SLATE, iconMessage, "Inbox", "", inboxHasItem ? "1" : "");
  int rx2 = SCRW - U_PAD - U_COL_W;
  colRow(2, 0, y, h); drawTile(rx2, y, U_COL_W, h, U_SLATE, iconLogout, "Done", "", "");
  colRow(2, 1, y, h); drawSosTile(rx2, y, U_COL_W, h);

  int rx, ry, rw, rh;
  for (int i = 0; i < crewCount; i++) {
    crewRowRect(i, rx, ry, rw, rh);
    uint16_t lvl = colorForLevel(crewLevel[i]);
    drawPanel(rx, ry, rw, rh, lvl);
    tft.fillCircle(rx + 20, ry + rh / 2, 12, lvl);
    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(U_HEAD, lvl);
    tft.drawString(crewName[i].length() ? crewName[i].substring(0, 1) : "?", rx + 20, ry + rh / 2, 2);
    tft.setTextDatum(ML_DATUM);
    tft.setTextColor(U_TEXT, U_PANEL);
    tft.drawString(crewName[i], rx + 40, ry + rh / 2 - 8, 2);
    tft.setTextColor(U_DIM, U_PANEL);
    tft.drawString(crewHasAlert[i] ? "Open alert" : "No open alerts", rx + 40, ry + rh / 2 + 9, 1);
  }
  if (crewCount == 0) {
    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(U_DIM, U_BG);
    tft.drawString("No crew assigned yet", SESS_CX0 + SESS_CW / 2, U_HEAD_H + 40, 1);
  }
  drawFooter(laptopOnline);
  lastDrawnSurgeonHomeSignature = surgeonHomeSignature();
}

void surgeonHomeTouch(int x, int y) {
  int y0, h;
  colRow(2, 0, y0, h); if (hitRect(U_PAD, y0, U_COL_W, h, x, y)) { screen = SCR_ALERTS; drawAlertsScreen(); return; }
  colRow(2, 1, y0, h); if (hitRect(U_PAD, y0, U_COL_W, h, x, y)) { screen = SCR_INBOX; drawInboxScreen(); return; }
  int rx2 = SCRW - U_PAD - U_COL_W;
  colRow(2, 0, y0, h); if (hitRect(rx2, y0, U_COL_W, h, x, y)) { endSessionLocally("done"); return; }
  int rx, ry, rw, rh;
  for (int i = 0; i < crewCount; i++) {
    crewRowRect(i, rx, ry, rw, rh);
    if (hitRect(rx, ry, rw, rh, x, y)) {
      viewingCrewId = crewId[i];
      // Optimistic placeholder (name only) -- sendViewCrew()'s reply
      // (onCrewDetailMsg(), protocol.ino) fills in the real vitals,
      // same "show something now, correct it when the real data lands"
      // idiom onCardScanned() already uses for a fresh session.
      detailName = crewName[i]; detailLevel = "GRAY"; detailTs = ""; detailOnCyd = false;
      detailHr = ""; detailHrL = "GRAY"; detailBp = ""; detailBpL = "GRAY";
      detailTemp = ""; detailTempL = "GRAY"; detailSleep = ""; detailSleepL = "GRAY";
      screen = SCR_CREW_DETAIL;
      drawCrewDetailScreen();
      sendViewCrew(viewingCrewId);
      return;
    }
  }
}

void drawCrewDetailScreen() {
  clearScreen();
  drawHeader(detailName, "Crew", true, levelChipWord(detailLevel), colorForLevel(detailLevel));
  int y, h;
  colRow(1, 0, y, h);
  drawTile(U_PAD, y, U_COL_W, h, U_SLATE, iconBack, "Back", "", "");

  int x = U_PAD + U_COL_W + U_PAD, w = SCRW - U_PAD - x;
  int vy = U_HEAD_H + U_PAD, vw = (w - U_PAD) / 2, vh = 46;
  drawVital(x, vy, vw, vh, "HR", detailHr, detailHrL, iconHeart);
  drawVital(x + vw + U_PAD, vy, vw, vh, "BP", detailBp, detailBpL, iconBp);
  drawVital(x, vy + vh + U_PAD, vw, vh, "Temp", detailTemp, detailTempL, iconTemp);
  drawVital(x + vw + U_PAD, vy + vh + U_PAD, vw, vh, "Sleep", detailSleep, detailSleepL, iconSleep);

  int ny = vy + 2 * (vh + U_PAD);
  tft.setTextDatum(ML_DATUM);
  tft.setTextColor(U_DIM, U_BG);
  tft.drawString(detailTs.length() ? ("Last reading " + detailTs) : "No readings yet today", x, ny + 10, 1);
  tft.drawString(detailOnCyd ? "On the CYD now: yes" : "On the CYD now: no", x, ny + 28, 1);
  drawSosButton();
  drawFooter(laptopOnline);
}

void crewDetailTouch(int x, int y) {
  int y0, h;
  colRow(1, 0, y0, h);
  if (hitRect(U_PAD, y0, U_COL_W, h, x, y)) { screen = SCR_SURGEON_HOME; drawSurgeonHomeScreen(); }
}

// Fixed slots for all ALERTS_MAX rows (even if fewer alerts are open right
// now) so the hold-to-acknowledge bar below them never shifts position
// between redraws.
void alertRowRect(int i, int& rx, int& ry, int& rw, int& rh) {
  int x0 = U_PAD + U_COL_W + U_PAD;
  rx = x0; rw = SCRW - U_PAD - x0; rh = 34; ry = U_HEAD_H + U_PAD + i * (rh + U_PAD);
}
void ackBarRect(int& bx, int& by, int& bw, int& bh) {
  bx = U_PAD + U_COL_W + U_PAD; bw = SCRW - U_PAD - bx; bh = 32;
  by = U_HEAD_H + U_PAD + ALERTS_MAX * 38 + 4;
}

void drawAlertsScreen() {
  clearScreen();
  drawHeader("ALERTS", alertsCount > 0 ? (String(alertsCount) + " open") : "none open", true, "", 0);
  int y, h;
  colRow(1, 0, y, h);
  drawTile(U_PAD, y, U_COL_W, h, U_SLATE, iconBack, "Back", "", "");

  int rx, ry, rw, rh;
  for (int i = 0; i < alertsCount; i++) {
    alertRowRect(i, rx, ry, rw, rh);
    bool sel = (i == selectedAlert);
    uint16_t bg = sel ? U_PANEL2 : U_PANEL;
    drawPanel(rx, ry, rw, rh, U_RED);
    if (sel) tft.drawRoundRect(rx, ry, rw, rh, 6, TFT_WHITE);
    iconAlert(rx + 16, ry + rh / 2, 0.7, U_RED, bg);
    tft.setTextDatum(ML_DATUM);
    tft.setTextColor(U_TEXT, bg);
    tft.drawString(alertText[i], rx + 30, ry + rh / 2 - 7, 1);
    tft.setTextColor(U_DIM, bg);
    tft.drawString(alertWho[i] + " . " + alertTs[i], rx + 30, ry + rh / 2 + 8, 1);
  }
  if (alertsCount == 0) {
    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(U_DIM, U_BG);
    int cx0 = U_PAD + U_COL_W + U_PAD, cw = SCRW - U_PAD - cx0;
    tft.drawString("No open alerts", cx0 + cw / 2, U_HEAD_H + 40, 1);
  }
  if (selectedAlert >= 0 && selectedAlert < alertsCount) {
    int bx, by, bw, bh;
    ackBarRect(bx, by, bw, bh);
    drawHoldBar(bx, by, bw, bh, 0, "Hold here 2s to acknowledge");
  }
  drawSosButton();
  drawFooter(laptopOnline);
  lastDrawnAlertsSignature = alertsSignature();
}

void alertsTouch(int x, int y) {
  int y0, h;
  colRow(1, 0, y0, h);
  if (hitRect(U_PAD, y0, U_COL_W, h, x, y)) { screen = SCR_SURGEON_HOME; drawSurgeonHomeScreen(); return; }
  int rx, ry, rw, rh;
  for (int i = 0; i < alertsCount; i++) {
    alertRowRect(i, rx, ry, rw, rh);
    if (hitRect(rx, ry, rw, rh, x, y)) { selectedAlert = i; drawAlertsScreen(); return; }
  }
}

// Acknowledging is a *hold* on the bar below the selected alert, not a
// tap -- same "can't acknowledge by accident" reasoning the SOS button
// and the emergency screen's cancel already use, read every loop()
// alongside checkSosButton() (astro_cyd.ino), not from handleTouch()'s
// one-tap-per-press dispatch.
// holdingAlertId is captured when the hold *starts*, not read from
// selectedAlert only once it completes -- a periodic alerts_list refresh
// (every background tick, see sessions.py's refresh_surgeon_cyd()) could
// otherwise arrive mid-hold and shift the array, and a plain "whatever's
// at this index now" read at completion could ack a different alert than
// the one actually held.
static int holdingAlertId = -1;
void checkAckHold() {
  if (screen != SCR_ALERTS || selectedAlert < 0 || selectedAlert >= alertsCount) { ackHoldStartMs = 0; return; }
  int bx, by, bw, bh;
  ackBarRect(bx, by, bw, bh);
  int x, y;
  bool down = getTouchXY(x, y);
  if (down && hitRect(bx, by, bw, bh, x, y)) {
    if (!ackHoldStartMs) { ackHoldStartMs = millis(); holdingAlertId = alertId[selectedAlert]; }
    uint32_t held = millis() - ackHoldStartMs;
    if (held > ACK_HOLD_MS) {
      ackHoldStartMs = 0;
      sendAckAlert(holdingAlertId);
      // Optimistic local removal -- by id, not by selectedAlert's index,
      // in case a refresh shifted the array mid-hold (see this function's
      // own comment above). The laptop's own alerts_list refresh (sent
      // right after, see backend/logic/sessions.py's
      // _ack_alert_from_cyd()) will confirm/resend moments later anyway.
      int removeAt = -1;
      for (int i = 0; i < alertsCount; i++) if (alertId[i] == holdingAlertId) { removeAt = i; break; }
      if (removeAt >= 0) {
        for (int i = removeAt; i < alertsCount - 1; i++) {
          alertId[i] = alertId[i + 1]; alertWho[i] = alertWho[i + 1];
          alertText[i] = alertText[i + 1]; alertTs[i] = alertTs[i + 1];
        }
        alertsCount--;
      }
      selectedAlert = alertsCount > 0 ? 0 : -1;
      drawAlertsScreen();
    } else {
      static uint32_t lastBarDraw = 0;
      if (millis() - lastBarDraw > 80) { lastBarDraw = millis(); drawHoldBar(bx, by, bw, bh, (float)held / ACK_HOLD_MS, "Hold here 2s to acknowledge"); }
    }
  } else if (ackHoldStartMs) {
    ackHoldStartMs = 0;
    drawHoldBar(bx, by, bw, bh, 0, "Hold here 2s to acknowledge");
  }
}

static const char* QUICK_REPLIES[3] = { "Received, monitoring you", "Rest and re-check in 1 hour", "Contact me now" };
static const int INBOX_CARD_H = 70, INBOX_BTN_H = 32, INBOX_GAP = 4;

void drawInboxScreen() {
  clearScreen();
  drawHeader("INBOX", inboxHasItem ? "1 unread" : "", true, "", 0);
  int y, h;
  colRow(1, 0, y, h);
  drawTile(U_PAD, y, U_COL_W, h, U_SLATE, iconBack, "Back", "", "");

  int x = U_PAD + U_COL_W + U_PAD, w = SCRW - U_PAD - x;
  if (!inboxHasItem) {
    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(U_DIM, U_BG);
    tft.drawString("Nothing in your inbox", x + w / 2, U_HEAD_H + 50, 1);
    drawSosButton();
    drawFooter(laptopOnline);
    lastDrawnInboxSignature = inboxSignature();
    return;
  }

  int ry = U_HEAD_H + U_PAD;
  drawPanel(x, ry, w, INBOX_CARD_H, U_DOC);
  tft.setTextDatum(ML_DATUM);
  tft.setTextColor(U_DOC, U_PANEL);
  tft.drawString("REPORT FROM " + inboxWho, x + 8, ry + 9, 1);
  tft.setTextColor(U_DIM, U_PANEL);
  tft.drawString(inboxTs, x + w - 36, ry + 9, 1);
  tft.setTextColor(U_TEXT, U_PANEL);
  drawWrapped(inboxBody, x + w / 2, ry + 28, w - 16, 13, 1);

  int by = ry + INBOX_CARD_H + U_PAD;
  for (int i = 0; i < 3; i++) {
    int yy = by + i * (INBOX_BTN_H + INBOX_GAP);
    uint16_t fill = (i == 2) ? U_RED : U_DOC;
    tft.fillRoundRect(x, yy, w, INBOX_BTN_H, 6, fill);
    iconSend(x + 20, yy + INBOX_BTN_H / 2, 0.6, TFT_WHITE, fill);
    tft.setTextDatum(ML_DATUM);
    tft.setTextColor(TFT_WHITE, fill);
    tft.drawString(QUICK_REPLIES[i], x + 34, yy + INBOX_BTN_H / 2, 1);
  }
  drawSosButton();
  drawFooter(laptopOnline);
  lastDrawnInboxSignature = inboxSignature();
}

void inboxTouch(int x, int y) {
  int y0, h;
  colRow(1, 0, y0, h);
  if (hitRect(U_PAD, y0, U_COL_W, h, x, y)) { screen = SCR_SURGEON_HOME; drawSurgeonHomeScreen(); return; }
  if (!inboxHasItem) return;
  int x0 = U_PAD + U_COL_W + U_PAD, w = SCRW - U_PAD - x0;
  int by = U_HEAD_H + U_PAD + INBOX_CARD_H + U_PAD;
  for (int i = 0; i < 3; i++) {
    int yy = by + i * (INBOX_BTN_H + INBOX_GAP);
    if (hitRect(x0, yy, w, INBOX_BTN_H, x, y)) {
      sendQuickReply(inboxAstroId, QUICK_REPLIES[i]);
      inboxHasItem = false;  // optimistic, same reasoning as the alert-ack removal above
      drawInboxScreen();
      return;
    }
  }
}

// ---- screen: Mood ----
// Face colors: scores 1-2 red, 3 amber, 4-5 green (matches
// config/health_rules.json's mood bands closely enough for a quick visual
// cue -- the laptop's own evaluation of the logged score is the one that
// actually counts, this is just the button's color).
static const uint16_t MOOD_COLORS[5] = { U_RED, U_RED, U_AMBER, U_GREEN, U_GREEN };
const char* MOOD_LABELS[5] = { "Rough", "Low", "Okay", "Good", "Great" };
static const int MOOD_TOP = 40, MOOD_H = 110;
int moodColW() { return (SCRW - U_PAD * 6) / 5; }

void drawFace(int cx, int cy, int r, uint16_t color, int moodIdx) {
  tft.drawSmoothCircle(cx, cy, r, color, U_PANEL);
  tft.fillCircle(cx - r / 2, cy - r / 4, 2, color);
  tft.fillCircle(cx + r / 2, cy - r / 4, 2, color);
  if (moodIdx >= 3) tft.drawArc(cx, cy + r / 6, r / 2, r / 2 - 2, 20, 160, color, U_PANEL, true);
  else if (moodIdx == 2) tft.drawWedgeLine(cx - r / 2, cy + r / 2, cx + r / 2, cy + r / 2, 1.5, 1.5, color, U_PANEL);
  else tft.drawArc(cx, cy + r / 2 + 6, r / 2, r / 2 - 2, 200, 340, color, U_PANEL, true);
}

void drawMoodScreen() {
  clearScreen();
  drawHeader("HOW DO YOU FEEL?", "", false, "", 0);
  int w = moodColW();
  for (int i = 0; i < 5; i++) {
    int x = U_PAD + i * (w + U_PAD);
    drawPanel(x, MOOD_TOP, w, MOOD_H, 0);
    drawFace(x + w / 2, MOOD_TOP + 40, 18, MOOD_COLORS[i], i);
    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(U_TEXT, U_PANEL);
    tft.drawString(MOOD_LABELS[i], x + w / 2, MOOD_TOP + 78, 1);
    tft.fillCircle(x + w / 2, MOOD_TOP + 94, 3, MOOD_COLORS[i]);
  }
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(U_SUB, U_BG);
  tft.drawString("Tap the face that matches how you feel", SCRW / 2, MOOD_TOP + MOOD_H + 16, 1);
  drawSosButton();
  drawBackButton();
  drawFooter(laptopOnline);
}
void moodTouch(int x, int y) {
  if (pointInBack(x, y)) { goHome(); return; }
  int w = moodColW();
  for (int i = 0; i < 5; i++) {
    if (hitRect(U_PAD + i * (w + U_PAD), MOOD_TOP, w, MOOD_H, x, y)) {
      sendMood(curUid, i + 1);
      screen = SCR_SESSION; drawSessionScreen();
      return;
    }
  }
}

// ---- screen: Symptoms ----
const char* SYMPTOMS[8] = { "Headache", "Nausea", "Back pain", "Blurry vision", "Congestion", "Fatigue", "Chest pain", "Short of breath" };
const char* SYMPTOM_KEYS[8] = { "headache", "nausea", "back_pain", "blurry_vision", "congestion", "fatigue", "chest_pain", "shortness_of_breath" };
bool symptomChecked[8];
static const int SYMPT_TOP = U_HEAD_H + U_PAD, SYMPT_H = 30, SYMPT_GAP = 4;
static const int SEND_X = 4 + 60 + U_PAD;  // clear of the corner SOS tile
int sendW() { return SCRW - SEND_X - BACK_W - 4 - U_PAD; }  // and of the corner Back tile
int symptomColW() { return (SCRW - U_PAD * 3) / 2; }
void symptomRect(int i, int& bx, int& by, int& bw, int& bh) {
  int w = symptomColW(), row = i / 2, col = i % 2;
  bx = U_PAD + col * (w + SYMPT_GAP); by = SYMPT_TOP + row * (SYMPT_H + SYMPT_GAP); bw = w; bh = SYMPT_H;
}
void drawSymptomChip(int i) {
  int bx, by, bw, bh; symptomRect(i, bx, by, bw, bh);
  bool on = symptomChecked[i];
  tft.fillRoundRect(bx, by, bw, bh, 6, on ? U_AMBER : U_PANEL);
  tft.drawRoundRect(bx, by, bw, bh, 6, on ? U_AMBER : U_LINE);
  int bs = 14;
  if (on) { tft.fillRoundRect(bx + 7, by + bh / 2 - bs / 2, bs, bs, 3, U_HEAD); iconTick(bx + 7 + bs / 2, by + bh / 2, 0.5, U_AMBER, U_HEAD); }
  else tft.drawRoundRect(bx + 7, by + bh / 2 - bs / 2, bs, bs, 3, U_SUB);
  tft.setTextDatum(ML_DATUM);
  tft.setTextColor(on ? U_HEAD : U_TEXT, on ? U_AMBER : U_PANEL);
  tft.drawString(SYMPTOMS[i], bx + 7 + bs + 8, by + bh / 2, 1);
}
void drawSymptomsScreen() {
  clearScreen();
  drawHeader("ANY SYMPTOMS?", "tap all that apply", false, "", 0);
  for (int i = 0; i < 8; i++) drawSymptomChip(i);
  int sendY = SYMPT_TOP + 4 * (SYMPT_H + SYMPT_GAP) + 6;
  tft.fillRoundRect(SEND_X, sendY, sendW(), 36, 6, U_CREW);
  iconSymptoms(SEND_X + 22, sendY + 18, 0.6, TFT_WHITE, U_CREW);
  tft.setTextDatum(ML_DATUM);
  tft.setTextColor(TFT_WHITE, U_CREW);
  tft.drawString("Send", SEND_X + 38, sendY + 18, 2);
  drawSosButton();
  drawBackButton();
  drawFooter(laptopOnline);
}
void symptomsTouch(int x, int y) {
  if (pointInBack(x, y)) { for (int i = 0; i < 8; i++) symptomChecked[i] = false; goHome(); return; }
  int bx, by, bw, bh;
  for (int i = 0; i < 8; i++) {
    symptomRect(i, bx, by, bw, bh);
    if (hitRect(bx, by, bw, bh, x, y)) { symptomChecked[i] = !symptomChecked[i]; drawSymptomChip(i); return; }
  }
  int sendY = SYMPT_TOP + 4 * (SYMPT_H + SYMPT_GAP) + 6;
  if (hitRect(SEND_X, sendY, sendW(), 36, x, y)) {
    String items[8]; int n = 0;
    for (int i = 0; i < 8; i++) if (symptomChecked[i]) items[n++] = SYMPTOM_KEYS[i];
    sendSymptoms(curUid, items, n);
    for (int i = 0; i < 8; i++) symptomChecked[i] = false;
    screen = SCR_SESSION; drawSessionScreen();
  }
}

// ---- screen: Reaction test ----
int lastReactionMs = -1;
void startReactionTest() {
  reactionTrial = 0; reactionLapses = 0; reactionFalseStarts = 0;
  reactionCircleShown = false; lastReactionMs = -1;
  reactionPhaseStartMs = millis();
  reactionNextDelayMs = 2000 + random(0, 4000);
  screen = SCR_REACTION;
  drawReactionWaiting();
}
void drawReactionWaiting() {
  clearScreen();
  drawHeader("REACTION TEST", "tap the circle fast", false, "", 0);
  int dotsW = 10 * 12, x0 = SCRW / 2 - dotsW / 2;
  for (int i = 0; i < REACTION_TRIALS; i++)
    tft.fillCircle(x0 + i * 12, U_HEAD_H + 14, 3, i < reactionTrial ? U_CREW : i == reactionTrial ? TFT_WHITE : U_SLATE);
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(U_TEXT, U_BG);
  char t[24]; snprintf(t, sizeof(t), "Trial %d of %d", reactionTrial + 1, REACTION_TRIALS);
  tft.drawString(t, SCRW / 2, U_HEAD_H + 32, 2);
  tft.setTextColor(U_DIM, U_BG);
  tft.drawString("Wait for the circle, then tap it", SCRW / 2, CY, 2);
  if (lastReactionMs >= 0) {
    char lt[32]; snprintf(lt, sizeof(lt), "Last: %d ms . lapses %d", lastReactionMs, reactionLapses);
    tft.setTextColor(U_SUB, U_BG);
    tft.drawString(lt, SCRW / 2, SCRH - U_FOOT_H - 16, 1);
  }
  drawSosButton();
  drawBackButton();
  drawFooter(laptopOnline);
}
void drawReactionCircle() {
  tft.fillCircle(CX, CY, 50, U_GREEN);
}
void reactionTouch(int x, int y) {
  if (pointInBack(x, y)) { reactionCircleShown = false; goHome(); return; }  // stop the test, nothing sent
  if (!reactionCircleShown) {
    reactionFalseStarts++;
    return;  // tapped too early; keep waiting for the real circle
  }
  int ms = millis() - reactionCircleShownMs;
  reactionTimes[reactionTrial] = ms;
  lastReactionMs = ms;
  if (ms > 500) reactionLapses++;
  reactionTrial++;
  if (reactionTrial >= REACTION_TRIALS) {
    long total = 0;
    for (int i = 0; i < REACTION_TRIALS; i++) total += reactionTimes[i];
    int avg = total / REACTION_TRIALS;
    sendReaction(curUid, reactionTimes, REACTION_TRIALS, avg, reactionLapses, reactionFalseStarts);
    screen = SCR_SESSION; drawSessionScreen();
  } else {
    reactionCircleShown = false;
    reactionPhaseStartMs = millis();
    reactionNextDelayMs = 2000 + random(0, 4000);
    drawReactionWaiting();
  }
}

// ---- screen: Breathe ----
void startBreathing() {
  breatheStartMs = millis();
  screen = SCR_BREATHE;
  drawBreatheFrame();
}
void drawBreatheFrame() {
  uint32_t elapsed = millis() - breatheStartMs;
  uint32_t inCycle = elapsed % (BREATHE_PHASE_MS * 4);
  const char* phase; int radius;
  if (inCycle < BREATHE_PHASE_MS) { phase = "Breathe in"; radius = 20 + (inCycle * 40) / BREATHE_PHASE_MS; }
  else if (inCycle < 2 * BREATHE_PHASE_MS) { phase = "Hold"; radius = 60; }
  else if (inCycle < 3 * BREATHE_PHASE_MS) { phase = "Breathe out"; radius = 60 - ((inCycle - 2 * BREATHE_PHASE_MS) * 40) / BREATHE_PHASE_MS; }
  else { phase = "Hold"; radius = 20; }
  clearScreen();
  drawHeader("BREATHE", "4 . 4 . 4 . 4", false, "", 0);
  int deg = (int)(360.0 * elapsed / BREATHE_TOTAL_MS);
  if (deg > 0) tft.drawArc(CX, CY, 62, 56, 0, min(deg, 360), U_CREW, U_BG, true);
  else tft.drawCircle(CX, CY, 62, U_SLATE);
  tft.fillCircle(CX, CY, radius, U_CREW);
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(TFT_WHITE, U_CREW);
  tft.drawString(phase, CX, CY, 2);
  tft.setTextColor(U_DIM, U_BG);
  char rem[16]; snprintf(rem, sizeof(rem), "%lus left", (unsigned long)((BREATHE_TOTAL_MS - elapsed) / 1000));
  tft.drawString(rem, CX, CY + 90, 1);
  drawSosButton();
  drawBackButton();
  drawFooter(laptopOnline);
}

void breatheTouch(int x, int y) {
  if (pointInBack(x, y)) goHome();  // stop early: not logged as a breathing session
}

// ---- screen: Status (full-color result banner) ----
void onStatusMsg(const String& name, const String& level, const String& note) {
  curLevel = level;
  clearScreen();
  uint16_t bg = colorForLevel(level);
  tft.fillScreen(bg);
  const char* big = level == "RED" ? "ALERT" : (level == "YELLOW" ? "CHECK" : "ALL GOOD");
  uint16_t fg = level == "YELLOW" ? U_HEAD : TFT_WHITE;
  if (level == "GREEN") iconTick(CX, 46, 1.6, fg, bg); else iconAlert(CX, 46, 1.6, fg, bg);
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(fg, bg);
  tft.drawString(big, CX, 86, 4);
  tft.drawString(name, CX, 120, 2);
  drawWrapped(note, CX, 150, SCRW - 24, 20, 2);
  tft.setTextColor(fg, bg);
  tft.drawString("Tap anywhere to go back", CX, SCRH - 36, 1);
  tft.drawString("Demo with placeholder data. Not medical advice.", CX, SCRH - 20, 1);
  screen = SCR_STATUS;
  toastUntilMs = millis() + 4000;
  screenBeforeToast = homeScreenEnum();
}

// ---- screen: Exercise timer ----
void drawExerciseTimer() {
  clearScreen();
  drawHeader("WORKOUT", "", false, "", 0);
  uint32_t s = (millis() - exerciseStartMs) / 1000;
  iconExercise(CX, CY - 36, 1.4, U_GREEN, U_BG);
  char t[16]; snprintf(t, sizeof(t), "%02lu:%02lu", (unsigned long)(s / 60), (unsigned long)(s % 60));
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(U_TEXT, U_BG);
  tft.drawString(t, CX, CY + 6, 7);
  tft.setTextColor(U_DIM, U_BG);
  tft.drawString("elapsed", CX, CY + 40, 2);
  tft.setTextColor(U_SUB, U_BG);
  tft.drawString("Tap the tag again to stop", CX, SCRH - U_FOOT_H - 16, 1);
  drawSosButton();
  drawBackButton();
  drawFooter(laptopOnline);
}

void exerciseTimerTouch(int x, int y) {
  // Back leaves the workout running (it's timed on the laptop); the crew home shows a
  // "Workout running" line to come back here, and the tag (or the app) stops it.
  if (pointInBack(x, y)) goHome();
}

// ---- generic hold-to-confirm progress bar -- used by the Emergency
// screen's cancel-hold and (phase 2) the Alerts screen's
// acknowledge-hold. Pure drawing, no gesture/timing state of its own --
// each caller tracks its own hold start time and calls this every repaint
// with the resulting fraction (0 = not holding, 1 = done). ----
void drawHoldBar(int x, int y, int w, int h, float frac, const String& label) {
  tft.fillRoundRect(x, y, w, h, 16, 0x2104 /* translucent-ish dark */);
  int fw = (int)(w * constrain(frac, 0.0f, 1.0f));
  if (fw > 0) tft.fillRoundRect(x, y, fw, h, 16, TFT_WHITE);
  // The fill passes directly under this centered label once it's over
  // halfway -- flip to dark-on-white there so it never goes
  // white-on-white as the hold progresses.
  bool pastCenter = fw > w / 2;
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(pastCenter ? U_HEAD : TFT_WHITE, pastCenter ? TFT_WHITE : 0x2104);
  tft.drawString(label, x + w / 2, y + h / 2, 2);
}

// ---- screen: Alert / Emergency ----
static const int CANCEL_BAR_X = 40, CANCEL_BAR_Y = 186, CANCEL_BAR_W = 240, CANCEL_BAR_H = 32;
void drawCancelBar(float frac) {
  drawHoldBar(CANCEL_BAR_X, CANCEL_BAR_Y, CANCEL_BAR_W, CANCEL_BAR_H, frac, "Hold here 3s to cancel");
}
void drawEmergencyScreen(bool flashOn) {
  uint16_t bg = flashOn ? U_RED : U_BG;
  tft.fillScreen(bg);
  iconAlert(CX, 56, 2.2, TFT_WHITE, bg);
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(TFT_WHITE, bg);
  tft.drawString("EMERGENCY", CX, 100, 4);
  tft.drawString(emergencyText.length() ? emergencyText : "Help is coming", CX, 136, 2);
  drawCancelBar(0);
}

// ---- screen: Unknown tag ----
// Deliberately generic -- doesn't hint that assignment is even possible,
// let alone how (see docs/CLAUDE.md's "Superuser admin page"). Only a
// superuser logged into /admin can see/act on an unrecognized tap now, so
// the CYD has nothing useful to tell whoever's standing at the kiosk.
void onUnknownTagMsg(const String& uid) {
  clearScreen();
  drawHeader("ASTRO HEALTH", "", false, "", 0);
  iconCard(CX, 100, 1.6, U_DIM, U_BG);
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(U_TEXT, U_BG);
  tft.drawString("Unknown card", CX, 140, 2);
  tft.setTextColor(U_DIM, U_BG);
  tft.drawString(uid, CX, 162, 2);
  tft.setTextColor(U_SUB, U_BG);
  tft.drawString("Tap anywhere to go back", CX, 190, 1);
  drawFooter(laptopOnline);
  screen = SCR_UNKNOWN_TAG;
  toastUntilMs = millis() + 3000;
  screenBeforeToast = homeScreenEnum();
}

// ---- toast overlay ----
void showToast(const String& text, const String& level) {
  screenBeforeToast = screen;
  int w = min(SCRW - 16, 280), h = 50;
  int x = CX - w / 2, y = CY - h / 2;
  uint16_t fill = colorForLevel(level);
  tft.fillRoundRect(x, y, w, h, 8, fill);
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(level == "YELLOW" ? U_HEAD : TFT_WHITE, fill);
  tft.drawString(text, CX, CY, 2);
  toastUntilMs = millis() + TOAST_MS;
}
void onToastMsg(const String& text, const String& level) { showToast(text, level); }

// ---- navigation / message handlers wired from protocol.ino ----
void goIdle() { screen = SCR_IDLE; drawIdleScreen(); }

// Which "home" screen this session belongs on -- SCR_SESSION for crew,
// SCR_SURGEON_HOME for the Flight Surgeon, SCR_IDLE if nobody's signed in.
// Every spot that used to hand-write the old
// "curUid.length() ? SCR_SESSION : SCR_IDLE" ternary now goes through
// this instead, so adding the surgeon's own home screen only needed one
// place to change the decision, not every call site.
Screen homeScreenEnum() {
  if (!curUid.length()) return SCR_IDLE;
  return (curRole == "Flight surgeon") ? SCR_SURGEON_HOME : SCR_SESSION;
}
// Same decision, but actually draws it too (goIdle()'s counterpart for
// "go back to whichever screen this session's home is").
void goHome() {
  Screen s = homeScreenEnum();
  screen = s;
  if (s == SCR_SURGEON_HOME) drawSurgeonHomeScreen();
  else if (s == SCR_SESSION) drawSessionScreen();
  else drawIdleScreen();
}
// Redraw any screen as it is now -- used to come back to the page you were on after a
// toast (a toast used to drop you on Idle from every page but the three homes).
void drawScreen(Screen s) {
  switch (s) {
    case SCR_IDLE: drawIdleScreen(); break;
    case SCR_SESSION: drawSessionScreen(); break;
    case SCR_SURGEON_HOME: drawSurgeonHomeScreen(); break;
    case SCR_MOOD: drawMoodScreen(); break;
    case SCR_SYMPTOMS: drawSymptomsScreen(); break;
    case SCR_REACTION: drawReactionWaiting(); if (reactionCircleShown) drawReactionCircle(); break;
    case SCR_BREATHE: drawBreatheFrame(); break;
    case SCR_EXERCISE_TIMER: drawExerciseTimer(); break;
    case SCR_CREW_DETAIL: drawCrewDetailScreen(); break;
    case SCR_ALERTS: drawAlertsScreen(); break;
    case SCR_INBOX: drawInboxScreen(); break;
    case SCR_WIFI_MENU: drawWifiMenuScreen(); break;
    case SCR_WIFI_SCAN: drawWifiScanScreen(); break;
    case SCR_WIFI_KEYBOARD: drawWifiKeyboardScreen(); break;
    case SCR_WIFI_CONNECTING: drawWifiConnectingScreen(); break;
    default: goHome(); break;  // the timed banners (Status, Unknown card) and the emergency
  }
}

// Screens only reachable while a session is open -- used by
// onCardScanned()'s busy-check below (ignore a stray extra tap while any
// of these is showing, not just the two home screens).
bool isSessionScreen(Screen s) {
  return s == SCR_SESSION || s == SCR_MOOD || s == SCR_SYMPTOMS || s == SCR_REACTION || s == SCR_BREATHE ||
         s == SCR_SURGEON_HOME || s == SCR_CREW_DETAIL || s == SCR_ALERTS || s == SCR_INBOX;
}

void onCardScanned(const String& uid) {
  sendScan(uid);
  lastTouchMs = millis();
  if (isSessionScreen(screen)) {
    return;  // busy with a session already; ignore extra taps like Lifeline does
  }
  // Optimistic: open the session menu locally even if the laptop is slow
  // or offline (docs/build-prompt.md section 10) -- onSessionMsg() will
  // fill in the real name/level/role/vitals if and when it arrives. Guesses
  // "Crew member" for this first instant; if it's actually the Flight
  // Surgeon's card, onSessionMsg() flips the screen the moment her real
  // role arrives, same as a wrong-but-corrected optimistic level always did.
  curUid = uid; curName = ""; curLevel = "GRAY"; curRole = "Crew member";
  vHr = ""; vHrL = "GRAY"; vBp = ""; vBpL = "GRAY"; vMood = ""; vMoodL = "GRAY"; vSleep = ""; vSleepL = "GRAY";
  screen = SCR_SESSION;
  drawSessionScreen();
}

void onSessionMsg(const String& name, const String& uid, const String& level, uint32_t idleS) {
  curUid = uid.length() ? uid : curUid;
  curName = name; curLevel = level;
  if (idleS > 0) sessionIdleMs = idleS * 1000UL;
  lastTouchMs = millis();
  lastActivePingMs = lastTouchMs;
  // Any real login -- a fresh tap, or a resumed Wi-Fi reconnect -- keeps
  // the stored pairing current (docs/CLAUDE.md "CYD pairing"). Re-tapping
  // a different card naturally re-pairs the device to them.
  if (uid.length()) prefs.putString("pairedUid", uid);
  goHome();
}

void onExerciseMsg(const String& event, int minutes) {
  if (event == "start") { exerciseRunning = true; exerciseStartMs = millis(); screen = SCR_EXERCISE_TIMER; drawExerciseTimer(); }
  else { exerciseRunning = false; goHome(); }
}
void onSleepMsg(const String& event, float hours) {
  if (event == "start") showToast("Good night", "GREEN");
  else { char t[24]; snprintf(t, sizeof(t), "Slept %.1f h", hours); showToast(t, "GREEN"); }
}
void onReminderMsg(const String& text) {
  beepReminder();
  showToast(text, "YELLOW");
}
void onAlertMsg(const String& level, const String& text) {
  beepAlert();
  showToast(text, level);
}
void onEmergencyMsg(bool active, const String& text) {
  emergencyActive = active;
  emergencyText = text;
  if (active) { screen = SCR_ALERT_EMERGENCY; drawEmergencyScreen(true); }
  else { goHome(); }
}

// ---- Flight Surgeon message handlers, wired from protocol.ino ----
// crew_list/alerts_list/inbox_list arrive as one fast back-to-back burst
// (backend/logic/sessions.py's send_surgeon_payload(), now sent
// unconditionally every ~2s -- see that function's own docstring for why
// it's no longer diffed on the backend side). Redrawing straight from
// whichever message happens to trigger it (two earlier attempts: always
// the last one, then a simple post-redraw throttle) was wrong both times:
// the *first* message to arrive would otherwise redraw the whole screen
// using fresh data for itself but stale data for whichever of the other
// two hadn't landed yet -- showing the right crew list but a stale
// Alerts/Inbox badge count, for instance. Fixed properly: each message
// just marks the screen dirty and (re-)starts a short debounce timer
// (markSurgeonHomeDirty()); the actual repaint happens from
// checkSurgeonHomeRedraw() (called every loop(), astro_cyd.ino) once the
// burst has gone quiet for SURGEON_HOME_REDRAW_DEBOUNCE_MS, so it always
// reflects whichever of the three messages actually arrived by then --
// and even then, only if the content is actually different from what's
// already on screen (surgeonHomeSignature(), compared in
// drawSurgeonHomeScreen() itself), so an identical resend (the common
// case now that the backend always resends) never triggers the visible
// clear+repaint flash at all. Each message still redraws its own
// standalone sub-screen immediately when she's actually on it
// (Alerts/Inbox), unaffected by any of this.
String surgeonHomeSignature() {
  String s = String(crewCount);
  for (int i = 0; i < crewCount; i++) s += "|" + crewName[i] + ":" + crewLevel[i] + (crewHasAlert[i] ? "1" : "0");
  s += "#" + String(alertsCount);
  for (int i = 0; i < alertsCount; i++) s += "|" + String(alertId[i]);
  s += "#" + String(inboxHasItem ? 1 : 0) + ":" + String(inboxAstroId);
  return s;
}
void markSurgeonHomeDirty() {
  if (screen != SCR_SURGEON_HOME) return;
  surgeonHomeDirty = true;
  surgeonHomeRedrawDueMs = millis() + SURGEON_HOME_REDRAW_DEBOUNCE_MS;
}
void checkSurgeonHomeRedraw() {
  if (!surgeonHomeDirty || millis() < surgeonHomeRedrawDueMs) return;
  surgeonHomeDirty = false;
  if (screen != SCR_SURGEON_HOME) return;  // navigated away before the debounce settled
  if (surgeonHomeSignature() == lastDrawnSurgeonHomeSignature) return;  // nothing visually different
  drawSurgeonHomeScreen();  // updates lastDrawnSurgeonHomeSignature itself, at the end
}
// Alerts/Inbox signatures -- each covers only the fields its own message
// type can change (selectedAlert is local UI state, not data, so it's
// deliberately excluded: selecting a different row already redraws
// directly from alertsTouch(), this is only about *data* resends).
String alertsSignature() {
  String s = String(alertsCount);
  for (int i = 0; i < alertsCount; i++) s += "|" + String(alertId[i]);
  return s;
}
String inboxSignature() {
  return String(inboxHasItem ? 1 : 0) + ":" + String(inboxAstroId) + ":" + inboxBody;
}

void onCrewListMsg() { markSurgeonHomeDirty(); }
void onAlertsListMsg() {
  markSurgeonHomeDirty();
  if (screen == SCR_ALERTS && alertsSignature() != lastDrawnAlertsSignature) drawAlertsScreen();
}
void onInboxListMsg() {
  markSurgeonHomeDirty();
  if (screen == SCR_INBOX && inboxSignature() != lastDrawnInboxSignature) drawInboxScreen();
}
void onCrewDetailMsg() { if (screen == SCR_CREW_DETAIL) drawCrewDetailScreen(); }
void onLaptopBack() {
  // sendHello() otherwise only ever fires once at cold boot (or once per new
  // Wi-Fi client, see wifi_bridge.ino's handleTcpClient()) -- a USB replug
  // has no equivalent "new client" event to hook on the firmware side, so
  // the one-shot boot-time hello can easily be sent before the laptop's own
  // serial bridge has even reopened the port yet (its reconnect loop polls
  // every few seconds), losing the paired_uid that hello carries and
  // silently never resuming the session. This fires reliably the moment a
  // two-way connection is actually confirmed (the laptop's next periodic
  // ping gets through), regardless of transport or how long the gap was --
  // closing that race instead of guessing a fixed delay.
  sendHello();
  if (screen == SCR_IDLE) drawIdleScreen();
}
void onLaptopOffline() {
  if (screen == SCR_IDLE) drawIdleScreen();
}

// ---- touch dispatch ----
bool getTouchXY(int& x, int& y) {
  int rawX, rawY;
  if (!touchRaw(rawX, rawY)) return false;
  // Axes are swapped on this board/rotation (see the comment by RX_MIN in
  // astro_cyd.ino): the controller's raw X drives screen Y, raw Y drives
  // screen X. No flip needed on either -- both run the "natural" direction.
  x = (long)(rawY - RY_MIN) * SCRW / (RY_MAX - RY_MIN);
  y = (long)(rawX - RX_MIN) * SCRH / (RX_MAX - RX_MIN);
  x = constrain(x, 0, SCRW - 1);
  y = constrain(y, 0, SCRH - 1);
  return true;
}

void handleTouch() {
  static bool wasDown = false;
  static uint32_t lastDownMs = 0;
  int x, y;
  bool down = getTouchXY(x, y);
  uint32_t now = millis();
  if (!down) {
    if (wasDown && now - lastDownMs > 60) wasDown = false;
    return;
  }
  lastDownMs = now;
  lastTouchMs = now;
  // Keep the laptop's own copy of this session alive while someone is using the screen.
  if (curUid.length() && now - lastActivePingMs > ACTIVE_PING_MS) {
    lastActivePingMs = now;
    sendActive(curUid);
  }
  if (wasDown) return;  // one action per press
  wasDown = true;

  if (screen == SCR_ALERT_EMERGENCY) return;  // handled by checkSosButton()'s cancel-hold logic instead
  if (pointInSos(x, y)) return;               // handled by checkSosButton()
  beepTap();

  switch (screen) {
    case SCR_SESSION:      sessionTouch(x, y); break;
    case SCR_MOOD:         moodTouch(x, y); break;
    case SCR_SYMPTOMS:     symptomsTouch(x, y); break;
    case SCR_REACTION:     reactionTouch(x, y); break;
    case SCR_SURGEON_HOME: surgeonHomeTouch(x, y); break;
    case SCR_CREW_DETAIL:  crewDetailTouch(x, y); break;
    case SCR_ALERTS:       alertsTouch(x, y); break;
    case SCR_INBOX:        inboxTouch(x, y); break;
    case SCR_IDLE:            idleTouch(x, y); break;
    case SCR_WIFI_MENU:       wifiMenuTouch(x, y); break;
    case SCR_WIFI_SCAN:       wifiScanTouch(x, y); break;
    case SCR_WIFI_KEYBOARD:   wifiKeyboardTouch(x, y); break;
    case SCR_WIFI_CONNECTING: wifiConnectingTouch(x, y); break;
    case SCR_BREATHE:         breatheTouch(x, y); break;
    case SCR_EXERCISE_TIMER:  exerciseTimerTouch(x, y); break;
    case SCR_STATUS:
    case SCR_UNKNOWN_TAG:     toastUntilMs = 1; break;  // tap anywhere: go back now, don't wait
    default: break;
  }
}

// ---- the SOS button + the emergency screen's cancel-hold, read every loop ----
void checkSosButton() {
  int x, y;
  bool down = getTouchXY(x, y);

  if (screen == SCR_ALERT_EMERGENCY) {
    if (down) {
      if (!cancelHoldStartMs) cancelHoldStartMs = millis();
      uint32_t held = millis() - cancelHoldStartMs;
      if (held > EMERGENCY_CANCEL_HOLD_MS) {
        cancelHoldStartMs = 0;
        sendCancelEmergencyEvent();
        emergencyActive = false;
        goHome();
      } else {
        static uint32_t lastBarDraw = 0;
        if (millis() - lastBarDraw > 80) { lastBarDraw = millis(); drawCancelBar((float)held / EMERGENCY_CANCEL_HOLD_MS); }
      }
    } else if (cancelHoldStartMs) { cancelHoldStartMs = 0; drawCancelBar(0); }
    return;
  }

  if (down && pointInSos(x, y)) {
    if (!sosHoldStartMs) sosHoldStartMs = millis();
    else if (millis() - sosHoldStartMs > SOS_HOLD_MS) {
      sosHoldStartMs = 0;
      sendEmergencyEvent(curUid);
      emergencyActive = true;
      emergencyText = "Help is coming";
      screen = SCR_ALERT_EMERGENCY;
      drawEmergencyScreen(true);
    }
  } else {
    sosHoldStartMs = 0;
  }
}

// ---- per-frame updates for anything timed ----
void updateScreenTimers() {
  uint32_t now = millis();

  // Keeps the Idle screen's clock (real UTC once synced, the uptime
  // fallback otherwise) actually ticking -- nothing else here redraws Idle
  // on a timer at all, only on specific triggers (a laptop reconnect, a
  // toast expiring). Only this one small region repaints, not the whole
  // screen, so the tiles/hint text/status lines below it never flicker
  // just because a second passed.
  if (screen == SCR_IDLE && now - lastIdleClockDrawMs >= 1000) {
    lastIdleClockDrawMs = now;
    drawIdleClock();
  }

  if (toastUntilMs && now > toastUntilMs) {
    toastUntilMs = 0;
    screen = screenBeforeToast;
    drawScreen(screen);  // back to the exact page you were on, not Idle
  }

  // Same pre-existing scope as before phase 2 -- the idle timeout only
  // fires from a "home" screen, not from a sub-screen (Mood/Symptoms/...
  // or, now, Crew Detail/Alerts/Inbox); walking away mid-sub-screen was
  // already not caught by this check and that's unchanged here.
  if ((screen == SCR_SESSION || screen == SCR_SURGEON_HOME) && now - lastTouchMs > sessionIdleMs) {
    endSessionLocally("idle");
    return;
  }

  if (screen == SCR_REACTION && !reactionCircleShown && now - reactionPhaseStartMs > reactionNextDelayMs) {
    reactionCircleShown = true;
    reactionCircleShownMs = now;
    drawReactionCircle();
  }

  if (screen == SCR_BREATHE) {
    if (now - breatheStartMs > BREATHE_TOTAL_MS) {
      sendBreathingDone(curUid, (int)(BREATHE_TOTAL_MS / 1000));
      screen = SCR_SESSION; drawSessionScreen();
    } else {
      static uint32_t lastFrame = 0;
      if (now - lastFrame > 200) { lastFrame = now; drawBreatheFrame(); }
    }
  }

  if (screen == SCR_EXERCISE_TIMER) {
    static uint32_t lastFrame = 0;
    if (now - lastFrame > 1000) { lastFrame = now; drawExerciseTimer(); }
  }

  if (screen == SCR_ALERT_EMERGENCY) {
    static uint32_t lastFlash = 0;
    static bool flashOn = true;
    if (now - lastFlash > 400) { lastFlash = now; flashOn = !flashOn; drawEmergencyScreen(flashOn); }
  }
}
