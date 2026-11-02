// The serial protocol between this CYD and the laptop (docs/build-prompt.md
// section 6): one JSON object per line, at most 512 bytes, using
// ArduinoJson. Mirrors backend/protocol.py on the laptop side.
//
// Also owns the offline queue (docs/build-prompt.md section 10): if the
// laptop goes quiet, outgoing CYD events still work and queue in RAM
// (and on the SD card, if one is present) until the laptop is back.

static const int SD_CS_PIN = 5;  // community-reported CYD microSD CS pin -- confirm on your board
bool sdAvailable = false;
bool laptopOnline = false;
uint32_t lastLaptopRxMs = 0;

#define QUEUE_CAP 24
String outQueue[QUEUE_CAP];
int queueHead = 0, queueCount = 0;

void initQueue() {
  sdAvailable = SD.begin(SD_CS_PIN);
  if (sdAvailable) Serial.println("[sd] card present, logging to /log.csv");
  else Serial.println("[sd] no card (fine -- it's optional)");
}

void queuePush(const String& line) {
  int idx = (queueHead + queueCount) % QUEUE_CAP;
  outQueue[idx] = line;
  if (queueCount < QUEUE_CAP) queueCount++;
  else queueHead = (queueHead + 1) % QUEUE_CAP;  // full: drop the oldest
  if (sdAvailable) {
    File f = SD.open("/queue.jsonl", FILE_APPEND);
    if (f) { f.print(line); f.close(); }
  }
}

void flushQueue() {
  while (queueCount > 0) {
    Serial.print(outQueue[queueHead]);
    if (tcpClient && tcpClient.connected()) tcpClient.print(outQueue[queueHead]);
    queueHead = (queueHead + 1) % QUEUE_CAP;
    queueCount--;
  }
}

void logToSd(const String& line) {
  if (!sdAvailable) return;
  File f = SD.open("/log.csv", FILE_APPEND);
  if (f) { f.print(millis()); f.print(','); f.print(line); f.close(); }
}

// ---- outgoing: CYD -> laptop ----
// Written to both transports unconditionally: whichever one the laptop
// isn't actually using just receives bytes nobody reads, which is
// harmless, and it means the exact same firmware works whether the CYD is
// USB-tethered or running from a power bank on its own Wi-Fi.
void sendLine(JsonDocument& doc) {
  String line;
  serializeJson(doc, line);
  line += "\n";
  Serial.print(line);
  if (tcpClient && tcpClient.connected()) tcpClient.print(line);
  logToSd(line);
  if (!laptopOnline) queuePush(line);
}

void sendHello() {
  JsonDocument doc;
  doc["type"] = "hello"; doc["fw"] = FW_VERSION;
  sendLine(doc);
}
void sendScan(const String& uid) {
  JsonDocument doc;
  doc["type"] = "scan"; doc["uid"] = uid;
  sendLine(doc);
}
void sendMood(const String& uid, int value) {
  JsonDocument doc;
  doc["type"] = "mood"; doc["uid"] = uid; doc["value"] = value;
  sendLine(doc);
}
void sendSymptoms(const String& uid, const String items[], int n) {
  JsonDocument doc;
  doc["type"] = "symptoms"; doc["uid"] = uid;
  JsonArray arr = doc["items"].to<JsonArray>();
  for (int i = 0; i < n; i++) arr.add(items[i]);
  sendLine(doc);
}
void sendReaction(const String& uid, int trials[], int n, int avgMs, int lapses, int falseStarts) {
  JsonDocument doc;
  doc["type"] = "reaction"; doc["uid"] = uid;
  JsonArray arr = doc["trials_ms"].to<JsonArray>();
  for (int i = 0; i < n; i++) arr.add(trials[i]);
  doc["avg_ms"] = avgMs; doc["lapses"] = lapses; doc["false_starts"] = falseStarts;
  sendLine(doc);
}
void sendBreathingDone(const String& uid, int seconds) {
  JsonDocument doc;
  doc["type"] = "breathing_done"; doc["uid"] = uid; doc["seconds"] = seconds;
  sendLine(doc);
}
void sendEmergencyEvent(const String& uid) {
  JsonDocument doc;
  doc["type"] = "emergency"; doc["uid"] = uid;
  sendLine(doc);
}
void sendCancelEmergencyEvent() {
  JsonDocument doc;
  doc["type"] = "cancel_emergency";
  sendLine(doc);
}
void sendEndSession(const String& uid) {
  JsonDocument doc;
  doc["type"] = "end_session"; doc["uid"] = uid;
  sendLine(doc);
}
void sendPong() {
  JsonDocument doc;
  doc["type"] = "pong";
  sendLine(doc);
}

// ---- incoming: laptop -> CYD ----
// Reads whichever transport has a line ready -- USB serial (if the CYD
// happens to be plugged in, e.g. during development) or the Wi-Fi TCP
// client from wifi_bridge.ino (the normal case on a power bank). Either
// one feeds the exact same parser below.
void handleSerialIn() {
  String line;
  if (Serial.available()) {
    line = Serial.readStringUntil('\n');
  } else if (tcpClient && tcpClient.connected() && tcpClient.available()) {
    line = tcpClient.readStringUntil('\n');
  } else {
    return;
  }
  line.trim();
  if (!line.length()) return;

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, line);
  if (err || !doc["type"].is<const char*>()) return;  // not JSON, or no "type": probably our own debug text

  lastLaptopRxMs = millis();
  if (!laptopOnline) { laptopOnline = true; flushQueue(); onLaptopBack(); }

  String type = doc["type"].as<String>();
  if (type == "session") {
    onSessionMsg(doc["name"].as<String>(), doc["uid"].as<String>(), doc["level"].as<String>(), doc["points"].as<long>());
  } else if (type == "status") {
    onStatusMsg(doc["name"].as<String>(), doc["level"].as<String>(), doc["note"].as<String>());
  } else if (type == "toast") {
    onToastMsg(doc["text"].as<String>(), doc["level"] | String("GREEN"));
  } else if (type == "unknown_tag") {
    onUnknownTagMsg(doc["uid"].as<String>());
  } else if (type == "exercise") {
    onExerciseMsg(doc["event"].as<String>(), doc["minutes"] | 0);
  } else if (type == "sleep") {
    onSleepMsg(doc["event"].as<String>(), doc["hours"] | 0.0f);
  } else if (type == "reminder") {
    onReminderMsg(doc["text"].as<String>());
  } else if (type == "alert") {
    onAlertMsg(doc["level"].as<String>(), doc["text"].as<String>());
  } else if (type == "emergency") {
    onEmergencyMsg(doc["active"] | false, doc["text"] | String(""));
  } else if (type == "led") {
    onLedMsg(doc["color"].as<String>());
  } else if (type == "idle") {
    goIdle();
  } else if (type == "ping") {
    sendPong();
  }
}

void checkLaptopOffline() {
  if (laptopOnline && millis() - lastLaptopRxMs > LAPTOP_OFFLINE_MS) {
    laptopOnline = false;
    onLaptopOffline();
  }
}
