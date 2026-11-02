// The CYD's own Wi-Fi access point + a one-client TCP server, so it can
// run from a power bank with no USB data cable to the laptop at all. The
// laptop's Wi-Fi joins this network (AP_SSID/AP_PASSWORD in astro_cyd.ino)
// and connects to TCP_PORT; everything from there on is the exact same
// JSON-lines protocol USB serial already used (see protocol.ino), just
// over a socket instead of a UART -- sendLine()/handleSerialIn() write and
// read both transports, so nothing else in the firmware needed to change.
//
// ESP-NOW to the S3 reader keeps working unmodified: see the note in
// nfc.ino's setupLink() about WIFI_AP_STA vs plain WIFI_AP.

void startAccessPoint() {
  WiFi.softAP(AP_SSID, AP_PASSWORD, LINK_CHANNEL);
  tcpServer.begin();
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
    }
  }
}
