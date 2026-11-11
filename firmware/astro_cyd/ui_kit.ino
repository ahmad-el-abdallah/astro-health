// Shared visual chrome for the CYD screens -- design reference:
// firmware/tools/cyd_preview.html (open directly in a browser; every
// screen at real 320x240 size with this same palette). Covers both the
// crew screens (idle, crew home, mood, symptoms, reaction, breathe,
// status, workout, emergency, unknown card) and, as of phase 2, the
// Flight Surgeon's own on-device screens (surgeon home, crew detail,
// alerts, inbox) -- see docs/CLAUDE.md's "CYD redesign" entries.
//
// Same multi-tab caveat as screens.ino: only simple types (int, String,
// uint16_t, function pointers to functions using only those) cross tab
// boundaries here, nothing from ArduinoJson -- Arduino's auto-generated
// prototypes for cross-tab calls are unreliable with more complex types.

uint16_t colorForLevel(const String& level) {
  if (level == "GREEN") return U_GREEN;
  if (level == "YELLOW") return U_AMBER;
  if (level == "RED") return U_RED;
  return U_GRAY;
}

// ---- icons: small vector glyphs on a 24-unit grid, same shapes as the
// mockup's line icons but drawn with TFT_eSPI primitives (no bitmaps/
// fonts). Each takes the tile's own background color so shapes that need
// to "cut" a hole (the sleep crescent) blend in instead of showing a
// wrong-color box. Signature matches IconFn (typedef'd in astro_cyd.ino,
// not here -- see that file's comment on why) so drawTile() can take any
// of these as a parameter. ----

void iconNone(int cx, int cy, float s, uint16_t color, uint16_t bg) {}

void iconHeart(int cx, int cy, float s, uint16_t color, uint16_t bg) {
  int r = (int)(5 * s), dx = (int)(4 * s), topY = cy - (int)(3 * s);
  tft.fillCircle(cx - dx, topY, r, color);
  tft.fillCircle(cx + dx, topY, r, color);
  tft.fillTriangle(cx - (int)(8 * s), topY, cx + (int)(8 * s), topY, cx, cy + (int)(9 * s), color);
}

void iconMood(int cx, int cy, float s, uint16_t color, uint16_t bg) {
  int r = (int)(9 * s);
  tft.drawSmoothCircle(cx, cy, r, color, bg);
  tft.fillCircle(cx - (int)(3 * s), cy - (int)(2 * s), max(1, (int)(1.2 * s)), color);
  tft.fillCircle(cx + (int)(3 * s), cy - (int)(2 * s), max(1, (int)(1.2 * s)), color);
  tft.drawArc(cx, cy + (int)(1 * s), (int)(5 * s), (int)(5 * s) - 1, 20, 160, color, bg, true);
}

void iconSleep(int cx, int cy, float s, uint16_t color, uint16_t bg) {
  tft.fillCircle(cx, cy, (int)(8 * s), color);
  tft.fillCircle(cx + (int)(4 * s), cy - (int)(3 * s), (int)(7 * s), bg);
}

void iconBp(int cx, int cy, float s, uint16_t color, uint16_t bg) {
  tft.drawWedgeLine(cx - 10 * s, cy, cx - 4 * s, cy, 1.2 * s, 1.2 * s, color, bg);
  tft.drawWedgeLine(cx - 4 * s, cy, cx - 1 * s, cy + 7 * s, 1.2 * s, 1.2 * s, color, bg);
  tft.drawWedgeLine(cx - 1 * s, cy + 7 * s, cx + 2 * s, cy - 8 * s, 1.2 * s, 1.2 * s, color, bg);
  tft.drawWedgeLine(cx + 2 * s, cy - 8 * s, cx + 5 * s, cy, 1.2 * s, 1.2 * s, color, bg);
  tft.drawWedgeLine(cx + 5 * s, cy, cx + 10 * s, cy, 1.2 * s, 1.2 * s, color, bg);
}

void iconSymptoms(int cx, int cy, float s, uint16_t color, uint16_t bg) {
  int w = (int)(14 * s), h = (int)(16 * s);
  tft.drawRoundRect(cx - w / 2, cy - h / 2, w, h, (int)(2 * s), color);
  tft.drawWedgeLine(cx - w / 2 + 3, cy - h / 2 + 5 * s, cx + w / 2 - 3, cy - h / 2 + 5 * s, 1, 1, color, bg);
  tft.drawWedgeLine(cx - w / 2 + 3, cy - h / 2 + 9 * s, cx + w / 2 - 7, cy - h / 2 + 9 * s, 1, 1, color, bg);
}

void iconTarget(int cx, int cy, float s, uint16_t color, uint16_t bg) {
  tft.drawCircle(cx, cy, (int)(9 * s), color);
  tft.drawCircle(cx, cy, (int)(5.5 * s), color);
  tft.fillCircle(cx, cy, max(1, (int)(2 * s)), color);
}

void iconWind(int cx, int cy, float s, uint16_t color, uint16_t bg) {
  for (int i = -1; i <= 1; i++) {
    int y = cy + i * (int)(5 * s);
    tft.drawWedgeLine(cx - 9 * s, y, cx + 4 * s - i, y - i, 1.3 * s, 1.3 * s, color, bg);
  }
}

void iconAlert(int cx, int cy, float s, uint16_t color, uint16_t bg) {
  int h = (int)(11 * s);
  tft.fillTriangle(cx, cy - h, cx - h, cy + h - 2, cx + h, cy + h - 2, color);
  tft.fillTriangle(cx, cy - h + (int)(3 * s), cx - h + (int)(3 * s), cy + h - 2 - (int)(2 * s),
                    cx + h - (int)(3 * s), cy + h - 2 - (int)(2 * s), bg);
  tft.drawWedgeLine(cx, cy - (int)(2 * s), cx, cy + (int)(2.5 * s), 1.4 * s, 1.4 * s, color, bg);
  tft.fillCircle(cx, cy + (int)(6 * s), max(1, (int)(1.3 * s)), color);
}

void iconNfc(int cx, int cy, float s, uint16_t color, uint16_t bg) {
  // Angles stay inside 0-360 with no wrap (drawArc's start must be < end).
  int ox = cx - (int)(6 * s);
  tft.fillCircle(ox, cy, max(1, (int)(1.4 * s)), color);
  for (int i = 1; i <= 3; i++) {
    int r = (int)(i * 4.2 * s);
    tft.drawArc(ox, cy, r, r - max(1, (int)(1.3 * s)), 40, 140, color, bg, true);
  }
}

void iconWifi(int cx, int cy, float s, uint16_t color, uint16_t bg) {
  int oy = cy + (int)(5 * s);
  tft.fillCircle(cx, oy, max(1, (int)(1.4 * s)), color);
  for (int i = 1; i <= 3; i++) {
    int r = (int)(i * 4.2 * s);
    // Same angle range as iconExercise's own upward-opening fan below --
    // 270 is "straight up" in drawArc's convention, so 200-340 is a
    // symmetric arc centered above the dot (a standard Wi-Fi glyph).
    tft.drawArc(cx, oy, r, r - max(1, (int)(1.3 * s)), 200, 340, color, bg, true);
  }
}

void iconCard(int cx, int cy, float s, uint16_t color, uint16_t bg) {
  int w = (int)(18 * s), h = (int)(13 * s);
  tft.drawRoundRect(cx - w / 2, cy - h / 2, w, h, (int)(2 * s), color);
  tft.fillRect(cx - w / 2 + 1, cy - h / 2 + (int)(3 * s), w - 2, (int)(2.5 * s), color);
}

void iconLogout(int cx, int cy, float s, uint16_t color, uint16_t bg) {
  int w = (int)(9 * s), h = (int)(16 * s);
  tft.drawRoundRect(cx - (int)(8 * s), cy - h / 2, w, h, (int)(2 * s), color);
  tft.drawWedgeLine(cx - (int)(1 * s), cy, cx + (int)(8 * s), cy, 1.3 * s, 1.3 * s, color, bg);
  tft.fillTriangle(cx + (int)(8 * s), cy - (int)(4 * s), cx + (int)(8 * s), cy + (int)(4 * s), cx + (int)(12 * s), cy, color);
}

void iconTick(int cx, int cy, float s, uint16_t color, uint16_t bg) {
  tft.drawWedgeLine(cx - (int)(6 * s), cy, cx - (int)(1.5 * s), cy + (int)(5 * s), 1.6 * s, 1.6 * s, color, bg);
  tft.drawWedgeLine(cx - (int)(1.5 * s), cy + (int)(5 * s), cx + (int)(7 * s), cy - (int)(6 * s), 1.6 * s, 1.6 * s, color, bg);
}

void iconTemp(int cx, int cy, float s, uint16_t color, uint16_t bg) {
  int w = (int)(5 * s), h = (int)(14 * s);
  tft.drawRoundRect(cx - w / 2, cy - h / 2, w, h, w / 2, color);
  tft.fillCircle(cx, cy + h / 2 + (int)(2 * s), (int)(4 * s), color);
}

void iconExercise(int cx, int cy, float s, uint16_t color, uint16_t bg) {
  tft.drawWedgeLine(cx - (int)(8 * s), cy, cx + (int)(8 * s), cy, 1.6 * s, 1.6 * s, color, bg);
  tft.fillRoundRect(cx - (int)(10 * s), cy - (int)(5 * s), (int)(4 * s), (int)(10 * s), (int)(1 * s), color);
  tft.fillRoundRect(cx + (int)(6 * s), cy - (int)(5 * s), (int)(4 * s), (int)(10 * s), (int)(1 * s), color);
}

// ---- phase 2 icons: Flight Surgeon on-device screens ----
void iconCrew(int cx, int cy, float s, uint16_t color, uint16_t bg) {
  int dx = (int)(5 * s), r = (int)(3 * s);
  for (int i = -1; i <= 1; i += 2) {
    tft.fillCircle(cx + i * dx, cy - (int)(3 * s), r, color);
    tft.drawArc(cx + i * dx, cy + (int)(5 * s), (int)(6 * s), (int)(6 * s) - max(1, (int)(1.3 * s)), 200, 340, color, bg, true);
  }
}

void iconMessage(int cx, int cy, float s, uint16_t color, uint16_t bg) {
  int w = (int)(18 * s), h = (int)(13 * s);
  tft.drawRoundRect(cx - w / 2, cy - h / 2, w, h, (int)(3 * s), color);
  tft.fillTriangle(cx - (int)(4 * s), cy + h / 2 - 1, cx + (int)(1 * s), cy + h / 2 - 1, cx - (int)(4 * s), cy + h / 2 + (int)(4 * s), color);
}

void iconBack(int cx, int cy, float s, uint16_t color, uint16_t bg) {
  tft.drawWedgeLine(cx + (int)(5 * s), cy - (int)(7 * s), cx - (int)(5 * s), cy, 1.6 * s, 1.6 * s, color, bg);
  tft.drawWedgeLine(cx - (int)(5 * s), cy, cx + (int)(5 * s), cy + (int)(7 * s), 1.6 * s, 1.6 * s, color, bg);
}

void iconSend(int cx, int cy, float s, uint16_t color, uint16_t bg) {
  tft.fillTriangle(cx - (int)(8 * s), cy - (int)(7 * s), cx - (int)(8 * s), cy + (int)(7 * s), cx + (int)(9 * s), cy, color);
  tft.drawWedgeLine(cx - (int)(8 * s), cy, cx - (int)(2 * s), cy, 1.1 * s, 1.1 * s, bg, bg);
}

void iconSchedule(int cx, int cy, float s, uint16_t color, uint16_t bg) {
  int w = (int)(16 * s), h = (int)(14 * s);
  tft.drawRoundRect(cx - w / 2, cy - h / 2, w, h, (int)(2 * s), color);
  tft.drawWedgeLine(cx - w / 2, cy - h / 2 + (int)(4 * s), cx + w / 2, cy - h / 2 + (int)(4 * s), 1, 1, color, bg);
}

// ---- header / footer chrome, drawn by every crew screen ----
// chipText/chipColor: the level word (CHECK/ALERT/GOOD), or "" for none.
void drawHeader(const String& title, const String& sub, bool doctor, const String& chipText, uint16_t chipColor) {
  tft.fillRect(0, 0, SCRW, U_HEAD_H, U_HEAD);
  tft.drawFastHLine(0, U_HEAD_H - 1, SCRW, U_LINE);
  tft.fillCircle(11, U_HEAD_H / 2, 4, doctor ? U_DOC : U_CREW);
  tft.setTextDatum(ML_DATUM);
  tft.setTextColor(U_TEXT, U_HEAD);
  tft.drawString(title, 20, U_HEAD_H / 2, 2);
  int afterTitle = 20 + tft.textWidth(title, 2) + 10;
  if (sub.length()) {
    tft.setTextColor(U_DIM, U_HEAD);
    tft.drawString(sub, afterTitle, U_HEAD_H / 2, 1);
  }
  if (chipText.length()) {
    int cw = tft.textWidth(chipText, 1) + 14;
    int cx0 = SCRW - cw - 6;
    tft.fillRoundRect(cx0, 4, cw, U_HEAD_H - 8, 6, chipColor);
    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(chipColor == U_AMBER ? U_HEAD : TFT_WHITE, chipColor);
    tft.drawString(chipText, cx0 + cw / 2, U_HEAD_H / 2, 1);
  }
}

void drawFooter(bool linkOk) {
  int y = SCRH - U_FOOT_H;
  tft.fillRect(0, y, SCRW, U_FOOT_H, U_HEAD);
  tft.drawFastHLine(0, y, SCRW, U_LINE);
  char up[24];
  uint32_t s = millis() / 1000;
  snprintf(up, sizeof(up), "FW %s . up %lu:%02lu:%02lu", FW_VERSION, (unsigned long)(s / 3600), (unsigned long)((s / 60) % 60), (unsigned long)(s % 60));
  tft.setTextDatum(ML_DATUM);
  tft.setTextColor(U_SUB, U_HEAD);
  tft.drawString(up, 6, y + U_FOOT_H / 2, 1);
  uint16_t chip = linkOk ? U_GREEN : U_RED;
  int cw = 46;
  tft.fillRoundRect(SCRW - cw - 4, y + 2, cw, U_FOOT_H - 4, 3, chip);
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(U_HEAD, chip);
  tft.drawString(linkOk ? "LAPTOP OK" : "NO LAPTOP", SCRW - cw / 2 - 4, y + U_FOOT_H / 2, 1);
}

// ---- tile: an icon + label (+ optional sub / badge), the basic button
// unit every column uses. iconFn may be iconNone if a tile needs no icon. ----
void drawTile(int x, int y, int w, int h, uint16_t color, IconFn iconFn, const String& label, const String& sub, const String& badge) {
  tft.fillRoundRect(x, y, w, h, 6, color);
  float iconSize = sub.length() ? 0.85f : 1.0f;
  int iconCy = sub.length() ? y + h / 2 - (int)(6 * iconSize) : y + h / 2 - 4;
  iconFn(x + w / 2, iconCy, iconSize, TFT_WHITE, color);
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(TFT_WHITE, color);
  tft.drawString(label, x + w / 2, iconCy + (int)(13 * iconSize), 1);
  if (sub.length()) {
    tft.setTextColor(U_TEXT, color);
    tft.drawString(sub, x + w / 2, iconCy + (int)(13 * iconSize) + 11, 1);
  }
  if (badge.length()) {
    int bw = 16;
    tft.fillRoundRect(x + w - bw - 2, y + 2, bw, 14, 6, U_RED);
    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(TFT_WHITE, U_RED);
    tft.drawString(badge, x + w - bw / 2 - 2, y + 9, 1);
  }
}
bool hitTile(int x, int y, int w, int h, int tx, int ty) { return hitRect(x, y, w, h, tx, ty); }

// ---- key: a compact labeled button for the Wi-Fi setup keyboard
// (wifi_setup.ino) -- like drawTile but text-only and small enough for a
// 10-column keyboard row, not an icon+label tile. ----
void drawKey(int x, int y, int w, int h, const String& label, uint16_t color, int font) {
  tft.fillRoundRect(x, y, w, h, 4, color);
  tft.drawRoundRect(x, y, w, h, 4, U_LINE);
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(TFT_WHITE, color);
  tft.drawString(label, x + w / 2, y + h / 2, font);
}

// Splits the content band (between header and footer) into n equal rows
// in a column of width U_COL_W, returning row i's y and h via out-params.
void colRow(int n, int i, int& y, int& h) {
  int top = U_HEAD_H + U_PAD, total = SCRH - U_FOOT_H - U_PAD - top;
  h = (total - (n - 1) * U_PAD) / n;
  y = top + i * (h + U_PAD);
}

// ---- panel: a plain rounded card, content drawn by the caller after ----
void drawPanel(int x, int y, int w, int h, uint16_t edge) {
  tft.fillRoundRect(x, y, w, h, 6, U_PANEL);
  tft.drawRoundRect(x, y, w, h, 6, U_LINE);
  if (edge != 0) tft.fillRect(x, y + 2, 3, h - 4, edge);
}

// ---- vital: one small stat card (icon+label, big value, level dot) ----
void drawVital(int x, int y, int w, int h, const String& label, const String& value, const String& level, IconFn iconFn) {
  drawPanel(x, y, w, h, 0);
  iconFn(x + 13, y + 13, 0.5f, U_DIM, U_PANEL);
  tft.setTextDatum(ML_DATUM);
  tft.setTextColor(U_DIM, U_PANEL);
  tft.drawString(label, x + 21, y + 11, 1);
  tft.setTextColor(U_TEXT, U_PANEL);
  tft.drawString(value.length() ? value : "--", x + 7, y + h - 11, 2);
  tft.fillCircle(x + w - 9, y + h - 9, 3, colorForLevel(level));
}
