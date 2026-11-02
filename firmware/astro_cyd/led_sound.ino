// RGB LED (active low) and the speaker beeper (docs/build-prompt.md
// section 10). Both are optional hardware -- every function here is a
// no-op-safe plain digitalWrite/ledcWriteTone, so a board with no speaker
// wired still works fine, it's just silent.

void setLed(bool r, bool g, bool b) {
  digitalWrite(PIN_LED_R, !r);
  digitalWrite(PIN_LED_G, !g);
  digitalWrite(PIN_LED_B, !b);
}

void onLedMsg(const String& color) {
  if (color == "GREEN") setLed(false, true, false);
  else if (color == "YELLOW") setLed(true, true, false);
  else if (color == "RED") setLed(true, false, false);
  else setLed(false, false, false);  // OFF
}

// The LED otherwise just follows curLevel while idle/in a session, and
// flashes fast during an emergency (handled by updateScreenTimers(), which
// already redraws the flashing emergency screen on the same cadence).
uint32_t lastLedFollowMs = 0;
void updateLed() {
  if (emergencyActive) {
    static uint32_t lastBlink = 0; static bool on = true;
    if (millis() - lastBlink > 200) { lastBlink = millis(); on = !on; setLed(on, false, false); }
    return;
  }
  // Outside an explicit `led` message, keep the LED in sync with whatever
  // level the session screen is showing.
  uint32_t now = millis();
  if (now - lastLedFollowMs < 200) return;  // a cheap debounce, not a blocking wait
  lastLedFollowMs = now;
  if (screen == SCR_SESSION || screen == SCR_STATUS) onLedMsg(curLevel);
  else if (screen == SCR_IDLE) onLedMsg("OFF");
}

// Each tone2() call blocks briefly (it's a short audio blip, not a long
// wait), used only for infrequent feedback -- taps, reminders, alerts --
// never inside a loop that needs to stay responsive every frame.
void tone2(int hz, int ms) {
  ledcWriteTone(PIN_SPK, hz);
  delay(ms);
  ledcWriteTone(PIN_SPK, 0);
}
void beepTap() { tone2(2300, 12); }
void beepReminder() { tone2(1800, 15); delay(10); tone2(1800, 15); }
void beepAlert() { tone2(500, 20); }
