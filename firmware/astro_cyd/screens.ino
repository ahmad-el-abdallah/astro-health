// The 12 screens (docs/build-prompt.md section 10). Simple shapes and
// TFT_eSPI's built-in fonts only -- no images, no LVGL. Touch targets are
// at least 44 px tall. Nothing here blocks for more than ~20 ms; timed
// things (toasts, the reaction test, breathing, timeouts) are driven from
// updateScreenTimers(), called every loop().
//
// Note on Arduino multi-tab sketches: every .ino tab is concatenated into
// one file for compiling, and arduino-cli auto-generates a prototype for
// every function near the top of that file. A prototype only needs the
// *types* of a function's parameters to already be declared by then --
// so the Screen enum and every shared variable live in astro_cyd.ino (the
// first tab) rather than here, even though most of the logic that uses
// them is in this file.

// ---- colors (mirrors the web app's status colors, section 13) ----
#define C_BG      TFT_BLACK
#define C_PANEL   0x18E3   // dark panel
#define C_TEXT    TFT_WHITE
#define C_DIM     0x8C71   // gray
#define C_ACCENT  0x3D1C   // teal-ish for buttons
#define C_GREEN   0x2CE9
#define C_YELLOW  0xF680
#define C_RED     0xF8A9

uint16_t colorForLevel(const String& level) {
  if (level == "GREEN") return C_GREEN;
  if (level == "YELLOW") return C_YELLOW;
  if (level == "RED") return C_RED;
  return C_DIM;
}

// ---- small drawing helpers ----
// Deliberately plain ints, not a Btn struct: Arduino auto-generates a
// prototype for every function near the top of the merged sketch, and a
// custom struct type isn't reliably visible there yet if it's defined
// further down in a tab -- see the note above this file's color block.
bool hitRect(int bx, int by, int bw, int bh, int x, int y) {
  return x >= bx && x <= bx + bw && y >= by && y <= by + bh;
}

void clearScreen() { tft.fillScreen(C_BG); }

void drawTitle(const String& s) {
  tft.setTextDatum(TL_DATUM);
  tft.setTextColor(C_TEXT, C_BG);
  tft.setTextSize(1);
  tft.drawString(s, 8, 6, 4);
}

void drawBigButton(int x, int y, int w, int h, const String& label, uint16_t fill, uint16_t fg) {
  tft.fillRoundRect(x, y, w, h, 8, fill);
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(fg, fill);
  tft.drawString(label, x + w / 2, y + h / 2, 2);
}

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

// SOS corner button, drawn last on every screen so it's always on top.
static const int SOS_X = 4, SOS_Y_OFFSET = 44, SOS_W = 46, SOS_H = 44;
void drawSosButton() {
  int y = SCRH - SOS_Y_OFFSET;
  tft.fillRoundRect(SOS_X, y, SOS_W, SOS_H, 6, C_RED);
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(TFT_WHITE, C_RED);
  tft.drawString("SOS", SOS_X + SOS_W / 2, y + SOS_H / 2, 2);
}
bool pointInSos(int x, int y) {
  int ry = SCRH - SOS_Y_OFFSET;
  return x >= SOS_X && x <= SOS_X + SOS_W && y >= ry && y <= ry + SOS_H;
}

// ---- screen: Idle ----
void drawIdleScreen() {
  clearScreen();
  drawTitle("Astro Health Station");
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(C_TEXT, C_BG);
  tft.drawString("Tap your card", CX, 90, 4);
  tft.setTextColor(C_DIM, C_BG);
  char up[24];
  uint32_t s = millis() / 1000;
  snprintf(up, sizeof(up), "Up %lu:%02lu:%02lu", (unsigned long)(s / 3600), (unsigned long)((s / 60) % 60), (unsigned long)(s % 60));
  tft.drawString(up, CX, 130, 2);
  tft.fillCircle(CX - 46, 155, 5, laptopOnline ? C_GREEN : C_RED);
  tft.drawString(laptopOnline ? "Laptop online" : "Laptop offline", CX + 10, 155, 1);
  drawSosButton();
}

// ---- screen: Session menu ----
// Layout constants shared between drawSessionScreen() and sessionTouch()
// so the drawn buttons and their hitboxes always agree.
static const int SESS_TOP = 44, SESS_H = 50, SESS_GAP = 6;
int sessColW() { return (SCRW - 8 - SESS_GAP) / 2; }

void drawSessionScreen() {
  clearScreen();
  tft.fillRect(0, 0, SCRW, 34, colorForLevel(curLevel));
  tft.setTextDatum(ML_DATUM);
  tft.setTextColor(C_BG, colorForLevel(curLevel));
  tft.drawString(curName.length() ? curName : curUid, 10, 17, 2);
  tft.setTextDatum(MR_DATUM);
  char pts[16]; snprintf(pts, sizeof(pts), "%ld pts", curPoints);
  tft.drawString(pts, SCRW - 10, 17, 2);

  int w = sessColW();
  drawBigButton(4, SESS_TOP, w, SESS_H, "Mood", C_ACCENT, C_TEXT);
  drawBigButton(4 + w + SESS_GAP, SESS_TOP, w, SESS_H, "Symptoms", C_ACCENT, C_TEXT);
  drawBigButton(4, SESS_TOP + SESS_H + SESS_GAP, w, SESS_H, "Reaction test", C_ACCENT, C_TEXT);
  drawBigButton(4 + w + SESS_GAP, SESS_TOP + SESS_H + SESS_GAP, w, SESS_H, "Breathe", C_ACCENT, C_TEXT);
  drawBigButton(4, SESS_TOP + 2 * (SESS_H + SESS_GAP), 2 * w + SESS_GAP, SESS_H, "Done", C_PANEL, C_TEXT);
  drawSosButton();
}

void sessionTouch(int x, int y) {
  int w = sessColW();
  if (hitRect(4, SESS_TOP, w, SESS_H, x, y)) { screen = SCR_MOOD; drawMoodScreen(); }
  else if (hitRect(4 + w + SESS_GAP, SESS_TOP, w, SESS_H, x, y)) { screen = SCR_SYMPTOMS; drawSymptomsScreen(); }
  else if (hitRect(4, SESS_TOP + SESS_H + SESS_GAP, w, SESS_H, x, y)) { startReactionTest(); }
  else if (hitRect(4 + w + SESS_GAP, SESS_TOP + SESS_H + SESS_GAP, w, SESS_H, x, y)) { startBreathing(); }
  else if (hitRect(4, SESS_TOP + 2 * (SESS_H + SESS_GAP), 2 * w + SESS_GAP, SESS_H, x, y)) { endSessionLocally(); }
}

void endSessionLocally() {
  sendEndSession(curUid);
  curUid = ""; curName = ""; curLevel = "GRAY"; curPoints = 0;
  goIdle();
}

// ---- screen: Mood ----
const char* MOOD_LABELS[5] = { ":(( ", ":( ", ":| ", ":) ", ":))" };
static const int MOOD_TOP = 70, MOOD_H = 80;
int moodColW() { return (SCRW - 20) / 5; }

void drawMoodScreen() {
  clearScreen();
  drawTitle("How do you feel?");
  int w = moodColW();
  for (int i = 0; i < 5; i++) drawBigButton(4 + i * w, MOOD_TOP, w - 4, MOOD_H, MOOD_LABELS[i], C_ACCENT, C_TEXT);
  drawSosButton();
}
void moodTouch(int x, int y) {
  int w = moodColW();
  for (int i = 0; i < 5; i++) {
    if (hitRect(4 + i * w, MOOD_TOP, w - 4, MOOD_H, x, y)) {
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
static const int SYMPT_TOP = 36, SYMPT_H = 36, SYMPT_GAP = 4;
int symptomColW() { return (SCRW - 20) / 2; }
void symptomRect(int i, int& bx, int& by, int& bw, int& bh) {
  int w = symptomColW(), row = i / 2, col = i % 2;
  bx = 4 + col * (w + SYMPT_GAP); by = SYMPT_TOP + row * (SYMPT_H + SYMPT_GAP); bw = w; bh = SYMPT_H;
}

void drawSymptomsScreen() {
  clearScreen();
  drawTitle("Any symptoms?");
  int bx, by, bw, bh;
  for (int i = 0; i < 8; i++) {
    symptomRect(i, bx, by, bw, bh);
    drawBigButton(bx, by, bw, bh, SYMPTOMS[i], symptomChecked[i] ? C_YELLOW : C_PANEL, symptomChecked[i] ? C_BG : C_TEXT);
  }
  int sendY = SYMPT_TOP + 4 * (SYMPT_H + SYMPT_GAP) + 6;
  drawBigButton(4, sendY, SCRW - 8, 40, "Send", C_ACCENT, C_TEXT);
  drawSosButton();
}
void symptomsTouch(int x, int y) {
  int bx, by, bw, bh;
  for (int i = 0; i < 8; i++) {
    symptomRect(i, bx, by, bw, bh);
    if (hitRect(bx, by, bw, bh, x, y)) {
      symptomChecked[i] = !symptomChecked[i];
      drawBigButton(bx, by, bw, bh, SYMPTOMS[i], symptomChecked[i] ? C_YELLOW : C_PANEL, symptomChecked[i] ? C_BG : C_TEXT);
      return;
    }
  }
  int sendY = SYMPT_TOP + 4 * (SYMPT_H + SYMPT_GAP) + 6;
  if (hitRect(4, sendY, SCRW - 8, 40, x, y)) {
    String items[8]; int n = 0;
    for (int i = 0; i < 8; i++) if (symptomChecked[i]) items[n++] = SYMPTOM_KEYS[i];
    sendSymptoms(curUid, items, n);
    for (int i = 0; i < 8; i++) symptomChecked[i] = false;
    screen = SCR_SESSION; drawSessionScreen();
  }
}

// ---- screen: Reaction test ----
void startReactionTest() {
  reactionTrial = 0; reactionLapses = 0; reactionFalseStarts = 0;
  reactionCircleShown = false;
  reactionPhaseStartMs = millis();
  reactionNextDelayMs = 2000 + random(0, 4000);
  screen = SCR_REACTION;
  drawReactionWaiting();
}
void drawReactionWaiting() {
  clearScreen();
  drawTitle("Reaction test");
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(C_TEXT, C_BG);
  char t[24]; snprintf(t, sizeof(t), "Trial %d / %d", reactionTrial + 1, REACTION_TRIALS);
  tft.drawString(t, CX, 40, 2);
  tft.setTextColor(C_DIM, C_BG);
  tft.drawString("Wait for the circle, then tap it", CX, CY, 2);
  drawSosButton();
}
void drawReactionCircle() {
  tft.fillCircle(CX, CY, 50, C_GREEN);
}
void reactionTouch(int x, int y) {
  if (!reactionCircleShown) {
    reactionFalseStarts++;
    return;  // tapped too early; keep waiting for the real circle
  }
  int ms = millis() - reactionCircleShownMs;
  reactionTimes[reactionTrial] = ms;
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
  drawTitle("Breathe");
  tft.fillCircle(CX, CY, radius, C_ACCENT);
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(C_TEXT, C_BG);
  tft.drawString(phase, CX, CY + 85, 2);
  char rem[16]; snprintf(rem, sizeof(rem), "%lus left", (unsigned long)((BREATHE_TOTAL_MS - elapsed) / 1000));
  tft.setTextColor(C_DIM, C_BG);
  tft.drawString(rem, CX, CY + 105, 1);
  drawSosButton();
}

// ---- screen: Status (full-color result banner) ----
void onStatusMsg(const String& name, const String& level, const String& note) {
  curLevel = level;
  clearScreen();
  uint16_t bg = colorForLevel(level);
  tft.fillScreen(bg);
  const char* big = level == "RED" ? "ALERT" : (level == "YELLOW" ? "CHECK" : "ALL GOOD");
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(level == "YELLOW" ? C_BG : TFT_WHITE, bg);
  tft.drawString(big, CX, 70, 4);
  tft.drawString(name, CX, 120, 2);
  drawWrapped(note, CX, 150, SCRW - 24, 20, 2);
  screen = SCR_STATUS;
  toastUntilMs = millis() + 4000;
  screenBeforeToast = curUid.length() ? SCR_SESSION : SCR_IDLE;
}

// ---- screen: Exercise timer ----
void drawExerciseTimer() {
  clearScreen();
  drawTitle("Workout");
  uint32_t s = (millis() - exerciseStartMs) / 1000;
  char t[16]; snprintf(t, sizeof(t), "%02lu:%02lu", (unsigned long)(s / 60), (unsigned long)(s % 60));
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(C_TEXT, C_BG);
  tft.drawString(t, CX, CY, 7);
  drawSosButton();
}

// ---- screen: Alert / Emergency ----
void drawEmergencyScreen(bool flashOn) {
  uint16_t bg = flashOn ? C_RED : C_BG;
  tft.fillScreen(bg);
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(TFT_WHITE, bg);
  tft.drawString("EMERGENCY", CX, 60, 4);
  tft.drawString(emergencyText.length() ? emergencyText : "Help is coming", CX, 110, 2);
  tft.drawString("Hold here 3s to cancel", CX, 160, 2);
}

// ---- screen: Unknown tag ----
void onUnknownTagMsg(const String& uid) {
  clearScreen();
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(C_TEXT, C_BG);
  tft.drawString("New tag", CX, 80, 4);
  tft.setTextColor(C_DIM, C_BG);
  tft.drawString("Assign it on the laptop", CX, 115, 2);
  tft.drawString(uid, CX, 140, 2);
  screen = SCR_UNKNOWN_TAG;
  toastUntilMs = millis() + 3000;
  screenBeforeToast = curUid.length() ? SCR_SESSION : SCR_IDLE;
}

// ---- toast overlay ----
void showToast(const String& text, const String& level) {
  screenBeforeToast = screen;
  int w = min(SCRW - 16, 280), h = 50;
  int x = CX - w / 2, y = CY - h / 2;
  uint16_t fill = colorForLevel(level);
  tft.fillRoundRect(x, y, w, h, 8, fill);
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(level == "YELLOW" ? C_BG : TFT_WHITE, fill);
  tft.drawString(text, CX, CY, 2);
  toastUntilMs = millis() + TOAST_MS;
}
void onToastMsg(const String& text, const String& level) { showToast(text, level); }

// ---- navigation / message handlers wired from protocol.ino ----
void goIdle() { screen = SCR_IDLE; drawIdleScreen(); }

void onCardScanned(const String& uid) {
  sendScan(uid);
  lastTouchMs = millis();
  if (screen == SCR_SESSION || screen == SCR_MOOD || screen == SCR_SYMPTOMS ||
      screen == SCR_REACTION || screen == SCR_BREATHE) {
    return;  // busy with a session already; ignore extra taps like Lifeline does
  }
  // Optimistic: open the session menu locally even if the laptop is slow
  // or offline (docs/build-prompt.md section 10) -- onSessionMsg() will
  // fill in the real name/level/points if and when it arrives.
  curUid = uid; curName = ""; curLevel = "GRAY"; curPoints = 0;
  screen = SCR_SESSION;
  drawSessionScreen();
}

void onSessionMsg(const String& name, const String& uid, const String& level, long points) {
  curUid = uid.length() ? uid : curUid;
  curName = name; curLevel = level; curPoints = points;
  lastTouchMs = millis();
  screen = SCR_SESSION;
  drawSessionScreen();
}

void onExerciseMsg(const String& event, int minutes) {
  if (event == "start") { exerciseRunning = true; exerciseStartMs = millis(); screen = SCR_EXERCISE_TIMER; drawExerciseTimer(); }
  else { exerciseRunning = false; screen = curUid.length() ? SCR_SESSION : SCR_IDLE; (screen == SCR_SESSION) ? drawSessionScreen() : drawIdleScreen(); }
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
  else { screen = curUid.length() ? SCR_SESSION : SCR_IDLE; (screen == SCR_SESSION) ? drawSessionScreen() : drawIdleScreen(); }
}
void onLaptopBack() {
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
  if (wasDown) return;  // one action per press
  wasDown = true;

  if (screen == SCR_ALERT_EMERGENCY) return;  // handled by checkSosButton()'s cancel-hold logic instead
  if (pointInSos(x, y)) return;               // handled by checkSosButton()
  beepTap();

  switch (screen) {
    case SCR_SESSION:  sessionTouch(x, y); break;
    case SCR_MOOD:      moodTouch(x, y); break;
    case SCR_SYMPTOMS:  symptomsTouch(x, y); break;
    case SCR_REACTION:  reactionTouch(x, y); break;
    default: break;  // Idle / Breathe / Status / Exercise timer / Unknown tag: no taps needed
  }
}

// ---- the SOS button + the emergency screen's cancel-hold, read every loop ----
void checkSosButton() {
  int x, y;
  bool down = getTouchXY(x, y);

  if (screen == SCR_ALERT_EMERGENCY) {
    if (down) {
      if (!cancelHoldStartMs) cancelHoldStartMs = millis();
      else if (millis() - cancelHoldStartMs > EMERGENCY_CANCEL_HOLD_MS) {
        cancelHoldStartMs = 0;
        sendCancelEmergencyEvent();
        emergencyActive = false;
        screen = curUid.length() ? SCR_SESSION : SCR_IDLE;
        (screen == SCR_SESSION) ? drawSessionScreen() : drawIdleScreen();
      }
    } else cancelHoldStartMs = 0;
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

  if (toastUntilMs && now > toastUntilMs) {
    toastUntilMs = 0;
    screen = screenBeforeToast;
    switch (screen) {
      case SCR_IDLE: drawIdleScreen(); break;
      case SCR_SESSION: drawSessionScreen(); break;
      default: goIdle(); break;
    }
  }

  if (screen == SCR_SESSION && now - lastTouchMs > SESSION_IDLE_MS) {
    endSessionLocally();
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
