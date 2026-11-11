// The CYD's own Wi-Fi access point (today's default) *or* joining the
// laptop's own Wi-Fi network instead (wifi_setup.ino, picked on-device) --
// either way, a one-client TCP server, so it can run from a power bank
// with no USB data cable to the laptop at all. Everything from there on is
// the exact same JSON-lines protocol USB serial already used (see
// protocol.ino), just over a socket instead of a UART --
// sendLine()/handleSerialIn() write and read both transports, so nothing
// else in the firmware needed to change for either Wi-Fi mode.
//
// ESP-NOW to the S3 reader keeps working unmodified: see the note in
// nfc.ino's setupLink() about WIFI_AP_STA vs plain WIFI_AP (now vestigial
// for the same reason ESP-NOW itself is, but harmless either way).

// Shared by both Wi-Fi modes -- the TCP server doesn't care how this
// device got its IP, only that it has one by the time this runs.
void startTcpServer() {
  tcpServer.begin();
}

void startAccessPoint() {
  WiFi.softAP(AP_SSID, AP_PASSWORD, LINK_CHANNEL);
  startTcpServer();
  Serial.printf("[wifi] access point \"%s\" up on channel %d, IP %s, port %u\n",
                AP_SSID, LINK_CHANNEL, WiFi.softAPIP().toString().c_str(), TCP_PORT);
  Serial.println("[wifi] on the laptop: join that Wi-Fi network, then run "
                  "app.py --wifi --wifi-host <the IP above>");
}

void handleTcpClient() {
  if (tcpClient && !tcpClient.connected()) {
    tcpClient.stop();
    tcpClient = WiFiClient();  // reset to falsy so this only logs once
    Serial.println("[wifi] laptop disconnected");
  }
  if (!tcpClient) {
    WiFiClient incoming = tcpServer.accept();
    if (incoming) {
      tcpClient = incoming;
      Serial.println("[wifi] laptop connected");
      // sendHello() only ever fires once at cold boot (astro_cyd.ino's
      // setup()) -- if this is the laptop joining *after* a tap already
      // happened over USB, it would otherwise never learn who's paired
      // (docs/CLAUDE.md "CYD pairing"). Re-announcing here covers exactly
      // that case; it's a harmless no-op resend otherwise.
      sendHello();
    }
  }
}
