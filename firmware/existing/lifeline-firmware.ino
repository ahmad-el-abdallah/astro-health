// Lifeline - v2.0 (lock screen for the CYD: it opens only for an allowed NFC card)
// Target: Cheap Yellow Display CYD-2432S028 (ESP32, 4 MB flash, ILI9341 320x240, XPT2046 touch).
// Display via LovyanGFX (configured in code). Built with arduino-cli + esp32 core 3.x.
//
// The ESP32-S3 NFC scanner (~/Desktop/ESP32S3-NFC-Reader) sends every card it sees over encrypted,
// signed ESP-NOW (protocol in nfc_link.h). This sketch decides who gets in. It keeps the allowed
// cards, each with a name, in NVS and shows:
//   SETUP   no card saved yet: the first card scanned becomes the key (after naming it)
//   LOCKED  "Scan your card": an allowed card opens HOME with its name, others are refused
//           (lockout after 5 in a row)
//   HOME    unlocked: who opened it, Cards and Lock buttons
//   CARDS   the allowed cards: tap one to rename it, delete (tap twice), add
//   ADDING  waiting for the card to add
//   NAMING  on-screen keyboard for a new card's name, or a rename
// It always starts locked, and locks again after AUTO_LOCK_MS without a touch.
//
// v2.0 is the lock only: the Wi-Fi web page, the SD-card docs reader and the health practice
// prototype of v1.x (~/Desktop/nasa) are gone.
//
// The board blocks below (pin map, bit-banged XPT2046 touch, LovyanGFX config, drawing helpers)
// are reused from CYD-OS / CYD Pomodoro - they are already proven on this exact board.

#define LGFX_USE_V1
#include <LovyanGFX.hpp>
#include <Preferences.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <algorithm>
#include "nfc_link.h"

// ---------------- CYD-2432S028 pin map ----------------
// Display (HSPI)
static const int PIN_TFT_SCLK = 14, PIN_TFT_MOSI = 13, PIN_TFT_MISO = 12;
static const int PIN_TFT_DC   = 2,  PIN_TFT_CS   = 15, PIN_TFT_RST  = -1;
static const int PIN_TFT_BL   = 21;                 // backlight (PWM)
// Touch (XPT2046, bit-banged)
static const int PIN_T_SCLK = 25, PIN_T_MOSI = 32, PIN_T_MISO = 39, PIN_T_CS = 33, PIN_T_IRQ = 36;
// RGB LED (active low) and speaker
static const int PIN_LED_R = 4, PIN_LED_G = 16, PIN_LED_B = 17;
static const int PIN_SPK = 26;

// ---------------- settings ----------------
static const char*    LOCK_VERSION  = "2.0";
static const int      ROTATION      = 3;                // LovyanGFX rotation: 3 = landscape, as CYD-OS showed it
static const int      BRIGHTNESS    = 200;              // 0-255
static const int      MAX_CARDS     = 5;
static const int      CARD_NAME_LEN = 16;               // characters (ASCII: the fonts have nothing else)
static const uint32_t AUTO_LOCK_MS  = 5UL * 60 * 1000;  // lock again after this long without a touch; 0 = never
static const int      MAX_WRONG     = 5;                // wrong cards in a row before a lockout
static const uint32_t LOCKOUT_MS    = 30000;
static const uint32_t HELLO_MS      = 1000;             // how often the lock sends the reader a new challenge

// ---------------- XPT2046 over bit-banged SPI ----------------
// One command per conversion (the scheme XPT2046_Bitbang uses on the CYD), several samples,
// medians, and a read is dropped if the samples disagree. Returns raw values in the same
// orientation as lgfx::Touch_XPT2046, so LovyanGFX's calibration math is unchanged.
class Touch_XPT2046_Soft : public lgfx::ITouch {
public:
  bool init() override {
    pinMode(PIN_T_CS, OUTPUT);   digitalWrite(PIN_T_CS, HIGH);
    pinMode(PIN_T_SCLK, OUTPUT); digitalWrite(PIN_T_SCLK, LOW);
    pinMode(PIN_T_MOSI, OUTPUT); digitalWrite(PIN_T_MOSI, LOW);
    pinMode(PIN_T_MISO, INPUT);  pinMode(PIN_T_IRQ, INPUT);
    _inited = true;
    return true;
  }
  void wakeup() override {}
  void sleep() override {}
  uint_fast8_t getTouchRaw(lgfx::touch_point_t* tp, uint_fast8_t count) override {
    if(!_inited || count == 0) return 0;
    tp->size = 0;
    if(digitalRead(PIN_T_IRQ)) return 0;           // IRQ goes low while the panel is pressed
    const int N = 7;
    int xs[N], ys[N];
    digitalWrite(PIN_T_CS, LOW);
    int z = read12(0xB0) + 4095 - read12(0xC0);    // pressure (Z1, Z2)
    for(int i=0;i<N;i++){ xs[i] = read12(0xD0); ys[i] = read12(0x90); }
    read12(0x90);                                  // ends with PD=00: power down, IRQ enabled
    digitalWrite(PIN_T_CS, HIGH);
    if(z < 400) return 0;
    std::sort(xs, xs+N); std::sort(ys, ys+N);
    // middle 5 samples must agree, otherwise this read was noisy (finger landing/lifting)
    if(xs[N-2] - xs[1] > 150 || ys[N-2] - ys[1] > 150) return 0;
    int x = xs[N/2], y = ys[N/2];
    if(x <= 128 || x > 3968 || y <= 128 || y > 3968) return 0;
    // Read this way, Y comes out mirrored compared with lgfx::Touch_XPT2046 (taps landed
    // left<->right swapped), so flip it to keep the same calibration.
    tp->x = x; tp->y = 4095 - y; tp->size = max(1, z >> 8);
    return 1;
  }
private:
  static void clk(){ digitalWrite(PIN_T_SCLK, HIGH); delayMicroseconds(2); digitalWrite(PIN_T_SCLK, LOW); delayMicroseconds(2); }
  // send a command byte, then clock out the 12-bit result (MSB first, valid after each falling edge)
  static int read12(uint8_t cmd){
    for(int b=7;b>=0;b--){ digitalWrite(PIN_T_MOSI, (cmd >> b) & 1); delayMicroseconds(1); clk(); }
    digitalWrite(PIN_T_MOSI, LOW);
    delayMicroseconds(4);                          // acquisition / BUSY
    int v = 0;
    for(int i=0;i<16;i++){ clk(); v = (v << 1) | digitalRead(PIN_T_MISO); }
    return (v >> 4) & 0xFFF;
  }
};

// ---------------- LovyanGFX device config ----------------
class LGFX : public lgfx::LGFX_Device {
  lgfx::Panel_ILI9341 _panel;
  lgfx::Bus_SPI       _bus;
  Touch_XPT2046_Soft  _touch;
  lgfx::Light_PWM     _light;
public:
  LGFX() {
    { auto c = _bus.config();
      c.spi_host = SPI2_HOST; c.spi_mode = 0;
      c.freq_write = 40000000; c.freq_read = 16000000;
      c.spi_3wire = false; c.use_lock = true; c.dma_channel = SPI_DMA_CH_AUTO;
      c.pin_sclk = PIN_TFT_SCLK; c.pin_mosi = PIN_TFT_MOSI; c.pin_miso = PIN_TFT_MISO; c.pin_dc = PIN_TFT_DC;
      _bus.config(c); _panel.setBus(&_bus); }
    { auto c = _panel.config();
      c.pin_cs = PIN_TFT_CS; c.pin_rst = PIN_TFT_RST; c.pin_busy = -1;
      c.panel_width = 240; c.panel_height = 320;
      c.offset_x = 0; c.offset_y = 0; c.offset_rotation = 0;
      c.readable = true; c.invert = false; c.rgb_order = false;
      c.dlen_16bit = false; c.bus_shared = false;
      _panel.config(c); }
    { auto c = _light.config();
      c.pin_bl = PIN_TFT_BL; c.invert = false; c.freq = 12000; c.pwm_channel = 7;
      _light.config(c); _panel.setLight(&_light); }
    { auto c = _touch.config();
      c.x_min = 300; c.x_max = 3900; c.y_min = 300; c.y_max = 3900;
      c.pin_int = PIN_T_IRQ; c.bus_shared = false; c.offset_rotation = 0;
      c.spi_host = -1; c.freq = 400000;
      c.pin_sclk = PIN_T_SCLK; c.pin_mosi = PIN_T_MOSI; c.pin_miso = PIN_T_MISO; c.pin_cs = PIN_T_CS;
      _touch.config(c); _panel.setTouch(&_touch); }
    setPanel(&_panel);
  }
};
LGFX tft;

// ---------------- types (declared before any function so Arduino's prototypes see them) ----------------
enum Screen  { SETUP, LOCKED, HOME, CARDS, ADDING, NAMING };
enum Icon    { IC_NONE, IC_PLUS, IC_BACK, IC_LOCK, IC_CARD };
enum KeyKind : uint8_t { K_CHAR, K_SHIFT, K_DEL, K_MODE, K_SPACE, K_CANCEL, K_SAVE };
struct Btn   { int x, y, w, h; const char* label; uint8_t icon; };
struct Key   { int16_t x, y, w, h; char ch; uint8_t kind; };
// Stored as-is in NVS "nfclock"/"cardsv2". v1.0 kept CardV1 under "cards"; loadCards() moves it.
struct Card   { uint8_t len; uint8_t uid[10]; char name[CARD_NAME_LEN + 1]; };
struct CardV1 { uint8_t len; uint8_t uid[10]; };
typedef void (*Sink)(const uint8_t* p, size_t n);  // where a screen capture goes (Serial)

// ---------------- palette (same dark theme + yellow accent as CYD-OS) ----------------
constexpr uint16_t rgb565(uint8_t r, uint8_t g, uint8_t b){ return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3); }
static const uint16_t C_BG      = rgb565(0x10,0x14,0x1a);
static const uint16_t C_PANEL   = rgb565(0x1c,0x23,0x2d);
static const uint16_t C_TEXT    = rgb565(0xf2,0xf4,0xf7);
static const uint16_t C_DIM     = rgb565(0x8b,0x95,0xa5);
static const uint16_t C_BTN     = rgb565(0x26,0x30,0x3d);
static const uint16_t C_ACCENT  = rgb565(0xff,0xb0,0x20);
static const uint16_t C_GREEN   = rgb565(0x2e,0xcc,0x71);
static const uint16_t C_RED     = rgb565(0xe5,0x48,0x4d);

// ---------------- state ----------------
Preferences prefs;                     // namespace "nfclock"
Screen screen = LOCKED;
int  SCRW = 320, SCRH = 240, CX = 160, CY = 120;

Card cards[MAX_CARDS]; int nCards = 0;
Card openedWith = {};                  // the card that unlocked HOME
uint32_t unlockedAt = 0, lastTouchMs = 0;
int  wrongInRow = 0; uint32_t lockoutUntil = 0;

QueueHandle_t rxQueue;                 // frames from the ESP-NOW callback (Wi-Fi task) to loop()
uint32_t nonceCur = 1, noncePrev = 1;  // the challenge the reader must echo (current, previous)
uint32_t lastReaderMs = 0; bool readerHeard = false, readerPn532 = false;

Btn  btnA, btnB, rowDel[MAX_CARDS], rowName[MAX_CARDS];
int  pendingDel = -1; uint32_t pendingDelAt = 0;   // first tap on Delete arms it, the second deletes
uint32_t fakeUntil = 0; int fakeX = 0, fakeY = 0;  // serial "tap x y"

// on-screen keyboard (NAMING)
static const char* const KB_ROWS[2][3] = {
  { "QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM" },
  { "1234567890", "-_.,'&()!", "/:;?@#+" },
};
Key  keys[40]; int nKeys = 0;
char kbText[CARD_NAME_LEN + 1] = ""; int kbLen = 0;
bool kbShift = true, kbNum = false;    // shift is one-shot: on at the start and after a space
int  kbTarget = -1;                    // card being renamed, or -1 = a new card (kbUid)
uint8_t kbUid[10]; int kbUidLen = 0;
Screen kbBack = CARDS;                 // where Cancel goes (SETUP or CARDS)
const char* SCREEN_NAME[] = { "setup", "locked", "home", "cards", "adding", "naming" };


// ---------------- small helpers ----------------
String uidHex(const uint8_t* u, int n){
  String s; char b[4];
  for(int i = 0; i < n; i++){ snprintf(b, sizeof(b), i ? ":%02X" : "%02X", u[i]); s += b; }
  return s;
}
String macStr(const uint8_t* m){ return uidHex(m, 6); }
// "04A1B2C3" or "04:a1:b2:c3" -> bytes; returns the length, 0 if it isn't 4/7/10 bytes of hex
int parseUid(String s, uint8_t* out){
  s.replace(":", "");
  int n = s.length() / 2;
  if(s.length() % 2 || (n != 4 && n != 7 && n != 10)) return 0;
  for(int i = 0; i < n; i++){
    char* end; char h[3] = { s[2*i], s[2*i+1], 0 };
    out[i] = strtoul(h, &end, 16);
    if(*end) return 0;
  }
  return n;
}
// printable ASCII only (the fonts have nothing else), trimmed, at most CARD_NAME_LEN
void setName(char* dst, String src){
  src.trim();
  int n = 0;
  for(size_t i = 0; i < src.length() && n < CARD_NAME_LEN; i++) if(src[i] >= 32 && src[i] < 127) dst[n++] = src[i];
  while(n && dst[n - 1] == ' ') n--;
  dst[n] = 0;
}
bool sameUid(const Card& a, const Card& b){ return a.len && a.len == b.len && !memcmp(a.uid, b.uid, a.len); }
void setLed(bool r, bool g, bool b){ digitalWrite(PIN_LED_R, !r); digitalWrite(PIN_LED_G, !g); digitalWrite(PIN_LED_B, !b); }
void tone2(int hz, int ms){ ledcWriteTone(PIN_SPK, hz); delay(ms); ledcWriteTone(PIN_SPK, 0); }
void beep(){ tone2(2300, 10); }
uint32_t lockoutLeft(){ int32_t d = (int32_t)(lockoutUntil - millis()); return (lockoutUntil && d > 0) ? d : 0; }
// 0 = nothing heard from the reader, 1 = it's there but its PN532 doesn't answer, 2 = ready
int readerState(){
  if(!readerHeard || millis() - lastReaderMs > LINK_TIMEOUT_MS) return 0;
  return readerPn532 ? 2 : 1;
}

// ---------------- allowed cards (NVS) ----------------
void saveCards(){ if(nCards) prefs.putBytes("cardsv2", cards, nCards * sizeof(Card)); else prefs.remove("cardsv2"); }
void loadCards(){
  nCards = 0;
  size_t n = prefs.getBytesLength("cardsv2");
  if(n && n % sizeof(Card) == 0 && n <= sizeof(cards)){
    nCards = prefs.getBytes("cardsv2", cards, n) / sizeof(Card);
    for(int i = 0; i < nCards; i++) cards[i].name[CARD_NAME_LEN] = 0;
    return;
  }
  n = prefs.getBytesLength("cards");   // v1.0: no names yet -> "Card N"
  if(n && n % sizeof(CardV1) == 0 && n <= MAX_CARDS * sizeof(CardV1)){
    CardV1 old[MAX_CARDS];
    int k = prefs.getBytes("cards", old, n) / sizeof(CardV1);
    for(int i = 0; i < k; i++){
      cards[i] = {}; cards[i].len = old[i].len; memcpy(cards[i].uid, old[i].uid, sizeof(old[i].uid));
      snprintf(cards[i].name, sizeof(cards[i].name), "Card %d", i + 1);
    }
    nCards = k; saveCards(); prefs.remove("cards");
    Serial.printf("[cards] moved %d card(s) from v1.0; they are named \"Card N\" until renamed\n", k);
  }
}
int findCard(const uint8_t* uid, int len){
  for(int i = 0; i < nCards; i++) if(cards[i].len == len && !memcmp(cards[i].uid, uid, len)) return i;
  return -1;
}
// returns the new card's index, or -1 (already there, list full, bad UID)
int addCard(const uint8_t* uid, int len, const char* name){
  if(nCards >= MAX_CARDS || len < 1 || len > 10 || findCard(uid, len) >= 0) return -1;
  Card& c = cards[nCards];
  c = {}; c.len = len; memcpy(c.uid, uid, len);
  setName(c.name, name);
  if(!c.name[0]) snprintf(c.name, sizeof(c.name), "Card %d", nCards + 1);
  nCards++; saveCards();
  return nCards - 1;
}
void delCard(int i){
  if(i < 0 || i >= nCards) return;
  for(int k = i; k < nCards - 1; k++) cards[k] = cards[k + 1];
  nCards--; saveCards();
}

// ---------------- drawing helpers (from CYD-OS) ----------------
bool hitB(const Btn& b, int x, int y){ return x>=b.x && x<=b.x+b.w && y>=b.y && y<=b.y+b.h; }
// blend two RGB565 colors, t = 0..255 towards b
uint16_t mix565(uint16_t a, uint16_t b, int t){
  int r = ((a>>11)&31) + ((((b>>11)&31) - ((a>>11)&31)) * t >> 8);
  int g = ((a>>5)&63)  + ((((b>>5)&63)  - ((a>>5)&63))  * t >> 8);
  int l = (a&31)       + (((b&31)       - (a&31))       * t >> 8);
  return (r<<11) | (g<<5) | l;
}
// padlock centred on (cx, cy), s = size in px; open lifts the shackle out of the right side
void drawPadlock(int cx, int cy, int s, uint16_t c, uint16_t bg, bool open = false){
  int bw = s * 4 / 5, bh = s * 11 / 20, r = s * 7 / 25, th = max(2, s / 9), leg = s / 10;
  int by = cy + (r + leg - bh) / 2;                 // body top; centres shackle + body as one shape
  int lift = open ? s / 6 : 0, sy = by - leg - lift; // shackle arc centre
  tft.fillArc(cx, sy, r, r - th, 180, 360, c);
  tft.fillRect(cx - r, sy, th, leg + lift + 1, c);                 // left leg, into the body
  tft.fillRect(cx + r - th, sy, th, open ? th : leg + 1, c);       // right leg: a stub when open
  tft.fillRoundRect(cx - bw / 2, by, bw, bh, max(2, s / 12), c);
  int ky = by + bh * 2 / 5, kr = max(2, s / 12);                   // keyhole
  tft.fillCircle(cx, ky, kr, bg);
  tft.fillRect(cx - max(1, kr / 2), ky, max(2, kr), bh / 3, bg);
}
// contactless card centred on (cx, cy), s = width in px
void drawCardIcon(int cx, int cy, int s, uint16_t c, uint16_t bg){
  int w = s, h = s * 5 / 8;
  tft.fillRoundRect(cx - w / 2, cy - h / 2, w, h, max(2, s / 12), c);
  int ox = cx - w / 5;                              // waves start left of the middle
  for(int k = 1; k <= 3; k++){ int r = k * s / 8; tft.fillArc(ox, cy, r, r - max(2, s / 20), -40, 40, bg); }
  tft.fillCircle(ox, cy, max(1, s / 24), bg);
}
// small icons for buttons, s = size in px, centred on (cx, cy)
void drawIcon(int ic, int cx, int cy, int s, uint16_t c, uint16_t bg){
  int h = s/2;
  switch(ic){
    case IC_PLUS: tft.fillRect(cx-h, cy-1, s, 3, c); tft.fillRect(cx-1, cy-h, 3, s, c); break;
    case IC_BACK: for(int t=0;t<3;t++){ tft.drawLine(cx+h/2-t, cy-h, cx-h/2-t, cy, c); tft.drawLine(cx-h/2-t, cy, cx+h/2-t, cy+h, c); } break;
    case IC_LOCK: drawPadlock(cx, cy, s + 2, c, bg); break;
    case IC_CARD: drawCardIcon(cx, cy, s + 4, c, bg); break;
  }
}
// raised button: soft shadow, lighter top edge, optional icon before the label
void drawButtonStyled(const Btn& b, uint16_t fill, uint16_t fg, bool pressed){
  if(pressed) fill = mix565(fill, 0xFFFF, 90);
  tft.fillRect(b.x, b.y, b.w, b.h, C_BG);
  int dy = pressed ? 2 : 0;
  if(!pressed) tft.fillRoundRect(b.x, b.y+3, b.w, b.h-3, 8, mix565(fill, 0x0000, 140));   // shadow
  tft.fillRoundRect(b.x, b.y+dy, b.w, b.h-3, 8, fill);
  tft.drawFastHLine(b.x+7, b.y+dy+1, b.w-14, mix565(fill, 0xFFFF, 70));                    // top shine
  tft.setTextDatum(middle_center); tft.setTextSize(1);
  int cy = b.y + dy + (b.h-3)/2;
  int is = !b.icon ? 0 : (!b.label[0] ? min(b.h - 12, 18) : (b.h > 44 ? 16 : 12));
  int gap = (b.icon && b.label[0]) ? 8 : 0;
  const lgfx::IFont* fonts[] = { &fonts::FreeSansBold12pt7b, &fonts::FreeSansBold9pt7b, &fonts::Font2 };
  int f = b.h > 44 ? 0 : 1, tw = 0;
  bool showText = b.label[0];
  for(; showText && f < 3; f++){ tft.setFont(fonts[f]); tw = tft.textWidth(b.label); if(is + gap + tw <= b.w - 10) break; }
  if(f == 3){ if(b.icon){ showText = false; gap = 0; tw = 0; } else { f = 2; tft.setFont(fonts[2]); tw = tft.textWidth(b.label); } }
  int total = is + gap + tw, x0 = b.x + (b.w - total)/2;
  if(b.icon) drawIcon(b.icon, x0 + is/2, cy, is, fg, fill);
  if(showText){
    tft.setTextColor(fg, fill);
    int tx = x0 + is + gap + tw/2;
    tft.drawString(b.label, tx, cy + 1);
    if(f == 2){ tft.setTextColor(fg); tft.drawString(b.label, tx + 1, cy + 1); }   // small font: fake bold
  }
  tft.setFont(&fonts::Font0);
}
void drawButton(const Btn& b, bool highlight, bool pressed = false){
  drawButtonStyled(b, highlight ? C_ACCENT : C_BTN, highlight ? C_BG : C_TEXT, pressed);
}
// hit test with a short pressed flash so every tap is visibly acknowledged
bool tapB(const Btn& b, int x, int y, bool highlight = false){
  if(!hitB(b, x, y)) return false;
  drawButton(b, highlight, true); delay(70); drawButton(b, highlight);
  return true;
}
void drawTitle(const char* s){
  tft.setFont(&fonts::FreeSansBold9pt7b); tft.setTextSize(1);
  tft.setTextDatum(middle_left); tft.setTextColor(C_TEXT, C_BG);
  tft.drawString(s, 10, 16);
  tft.setFont(&fonts::Font0);
}
// big line + small line, centred; the big line drops to a smaller font if it doesn't fit
void drawMessage(const char* big, const char* small, int y, uint16_t bigCol, uint16_t smallCol, uint16_t bg){
  tft.setTextDatum(middle_center);
  tft.setFont(&fonts::FreeSansBold12pt7b);
  if(tft.textWidth(big) > SCRW - 16) tft.setFont(&fonts::FreeSansBold9pt7b);
  tft.setTextColor(bigCol, bg); tft.drawString(big, CX, y);
  tft.setFont(&fonts::Font2); tft.setTextColor(smallCol, bg); tft.drawString(small, CX, y + 28);
  tft.setFont(&fonts::Font0);
}
// top right: is the reader there?
void drawReaderStatus(){
  static const char* TXT[] = { "Reader offline", "PN532 not answering", "Reader ready" };
  const uint16_t COL[] = { C_RED, C_ACCENT, C_GREEN };
  int s = readerState();
  tft.fillRect(SCRW - 172, 4, 168, 24, C_BG);
  tft.setFont(&fonts::Font2); tft.setTextDatum(middle_right); tft.setTextColor(C_DIM, C_BG);
  tft.drawString(TXT[s], SCRW - 10, 16);
  tft.fillCircle(SCRW - 10 - tft.textWidth(TXT[s]) - 9, 16, 4, COL[s]);
  tft.setFont(&fonts::Font0);
}

// ---------------- screens ----------------
void drawLockMessage(){                // under the padlock; redrawn every second during a lockout
  tft.fillRect(0, 148, SCRW, 70, C_BG);
  uint32_t left = lockoutLeft();
  char b[40];
  if(screen == SETUP) drawMessage("Set up your key", "Scan the card that will open this lock", 166, C_TEXT, C_DIM, C_BG);
  else if(left){
    snprintf(b, sizeof(b), "Try again in %lu s", (unsigned long)((left + 999) / 1000));
    drawMessage("Too many wrong cards", b, 166, C_RED, C_DIM, C_BG);
  } else drawMessage("Scan your card", "Hold it flat on the NFC reader", 166, C_TEXT, C_DIM, C_BG);
}
void drawLocked(){                     // SETUP and LOCKED
  tft.fillScreen(C_BG);
  drawTitle(screen == SETUP ? "Lifeline setup" : "Lifeline");
  drawReaderStatus();
  if(screen == SETUP) drawCardIcon(CX, 92, 84, C_ACCENT, C_BG);
  else drawPadlock(CX, 92, 84, lockoutLeft() ? C_RED : C_ACCENT, C_BG);
  drawLockMessage();
}
void drawHomeTimer(){                  // "Unlocked for" + auto-lock countdown, redrawn every second
  char b[32]; unsigned long s = (millis() - unlockedAt) / 1000;
  tft.fillRect(20, 118, SCRW - 40, 26, C_PANEL);
  snprintf(b, sizeof(b), "Unlocked %lu:%02lu", s / 60, s % 60);
  tft.setFont(&fonts::Font2); tft.setTextDatum(middle_left); tft.setTextColor(C_TEXT, C_PANEL);
  tft.drawString(b, 24, 131);
  if(AUTO_LOCK_MS){
    uint32_t idle = millis() - lastTouchMs;
    unsigned long left = idle < AUTO_LOCK_MS ? (AUTO_LOCK_MS - idle + 999) / 1000 : 0;
    snprintf(b, sizeof(b), "auto-lock in %lu:%02lu", left / 60, left % 60);
    tft.setTextDatum(middle_right); tft.setTextColor(C_DIM, C_PANEL);
    tft.drawString(b, SCRW - 24, 131);
  }
  tft.setFont(&fonts::Font0);
}
void drawHome(){
  tft.fillScreen(C_BG);
  drawTitle("Unlocked");
  drawPadlock(SCRW - 24, 16, 22, C_GREEN, C_BG, true);
  tft.fillRoundRect(10, 40, SCRW - 20, 110, 10, C_PANEL);
  tft.setFont(&fonts::Font2); tft.setTextDatum(middle_left); tft.setTextColor(C_DIM, C_PANEL);
  tft.drawString("Welcome back", 24, 56);
  tft.setFont(&fonts::FreeSansBold12pt7b);
  if(tft.textWidth(openedWith.name) > SCRW - 48) tft.setFont(&fonts::FreeSansBold9pt7b);
  tft.setTextColor(C_TEXT, C_PANEL); tft.drawString(openedWith.name, 24, 82);
  tft.setFont(&fonts::Font2); tft.setTextColor(C_DIM, C_PANEL);
  tft.drawString("card " + uidHex(openedWith.uid, openedWith.len), 24, 106);
  tft.drawFastHLine(20, 118, SCRW - 40, C_BTN);
  drawHomeTimer();
  int w = (SCRW - 30) / 2;               // Cards | Lock
  btnA = { 10, SCRH - 62, w, 52, "Cards", IC_CARD };
  btnB = { 20 + w, SCRH - 62, w, 52, "Lock", IC_LOCK };
  drawButton(btnA, false); drawButton(btnB, true);
}
void drawCardRow(int i){
  int y = 36 + i * 30;
  tft.fillRect(0, y, SCRW, 28, C_BG);
  rowDel[i]  = { SCRW - 76, y, 66, 26, "", IC_NONE };
  rowName[i] = { 10, y, SCRW - 92, 26, "", IC_NONE };
  if(i >= nCards) return;
  tft.fillRoundRect(10, y, SCRW - 20, 26, 6, C_PANEL);
  if(sameUid(cards[i], openedWith)) tft.fillCircle(22, y + 13, 4, C_GREEN);   // the card that opened it
  else {
    char n[4]; snprintf(n, sizeof(n), "%d", i + 1);
    tft.setFont(&fonts::Font2); tft.setTextDatum(middle_center); tft.setTextColor(C_DIM, C_PANEL);
    tft.drawString(n, 22, y + 13);
  }
  tft.setFont(&fonts::Font2); tft.setTextDatum(middle_left); tft.setTextColor(C_TEXT, C_PANEL);
  tft.drawString(cards[i].name, 36, y + 9);
  tft.setTextColor(C_TEXT); tft.drawString(cards[i].name, 37, y + 9);           // fake bold
  tft.setFont(&fonts::Font0); tft.setTextColor(C_DIM, C_PANEL);
  tft.drawString(uidHex(cards[i].uid, cards[i].len), 36, y + 21);
  bool sure = pendingDel == i;         // flat pill, not a raised button: the rows are tight
  uint16_t f = sure ? C_RED : C_BTN;
  rowDel[i].label = sure ? "Sure?" : "Delete";
  tft.fillRoundRect(rowDel[i].x, y + 3, rowDel[i].w, 20, 5, f);
  tft.setFont(&fonts::Font2); tft.setTextDatum(middle_center); tft.setTextColor(C_TEXT, f);
  tft.drawString(rowDel[i].label, rowDel[i].x + rowDel[i].w / 2, y + 13);
  tft.setFont(&fonts::Font0);
}
void drawCards(){
  tft.fillScreen(C_BG);
  char t[32]; snprintf(t, sizeof(t), "Allowed cards (%d/%d)", nCards, MAX_CARDS);
  drawTitle(t);
  tft.setFont(&fonts::Font0); tft.setTextDatum(middle_right); tft.setTextColor(C_DIM, C_BG);
  tft.drawString("tap a name to rename", SCRW - 10, 17);
  for(int i = 0; i < MAX_CARDS; i++) drawCardRow(i);
  int w = (SCRW - 30) / 2;
  btnA = { 10, SCRH - 50, w, 44, "Back", IC_BACK };
  btnB = { 20 + w, SCRH - 50, w, 44, "Add card", IC_PLUS };
  drawButton(btnA, false); drawButton(btnB, nCards < MAX_CARDS);
}
void drawAdding(){
  tft.fillScreen(C_BG);
  drawTitle("Add a card");
  drawReaderStatus();
  drawCardIcon(CX, 84, 84, C_ACCENT, C_BG);
  drawMessage("Scan the new card", "Then give it a name", 140, C_TEXT, C_DIM, C_BG);
  btnA = { CX - 70, SCRH - 50, 140, 44, "Cancel", IC_BACK };
  drawButton(btnA, false);
}

// ---------------- on-screen keyboard (NAMING) ----------------
void addKey(int x, int y, int w, char ch, uint8_t kind){
  if(nKeys < 40) keys[nKeys++] = { (int16_t)x, (int16_t)y, (int16_t)w, 40, ch, kind };
}
// 4 rows under the name field: 10 / 9 / shift + 7 + del / 123 space Cancel Save
void layoutKeyboard(){
  const char* const* rows = KB_ROWS[kbNum ? 1 : 0];
  int kw = SCRW / 10, top = 68, rh = 42;
  nKeys = 0;
  for(int i = 0; rows[0][i]; i++) addKey(i * kw, top, kw, rows[0][i], K_CHAR);
  int n1 = strlen(rows[1]), x1 = (SCRW - n1 * kw) / 2;
  for(int i = 0; i < n1; i++) addKey(x1 + i * kw, top + rh, kw, rows[1][i], K_CHAR);
  int n2 = strlen(rows[2]), side = (SCRW - n2 * kw) / 2;
  addKey(0, top + 2 * rh, side, 0, K_SHIFT);
  for(int i = 0; i < n2; i++) addKey(side + i * kw, top + 2 * rh, kw, rows[2][i], K_CHAR);
  addKey(side + n2 * kw, top + 2 * rh, SCRW - side - n2 * kw, 0, K_DEL);
  int y3 = top + 3 * rh, mw = 56, bw = 64;
  addKey(0, y3, mw, 0, K_MODE);
  addKey(mw, y3, SCRW - mw - 2 * bw, ' ', K_SPACE);
  addKey(SCRW - 2 * bw, y3, bw, 0, K_CANCEL);
  addKey(SCRW - bw, y3, bw, 0, K_SAVE);
}
void drawKey(const Key& k, bool pressed){
  uint16_t fill = C_BTN, fg = C_TEXT;
  if(k.kind == K_SAVE || (k.kind == K_SHIFT && kbShift && !kbNum)){ fill = C_ACCENT; fg = C_BG; }
  if(k.kind == K_SHIFT && kbNum) fg = C_DIM;        // nothing to shift in the symbols
  if(pressed) fill = mix565(fill, 0xFFFF, 90);
  tft.fillRect(k.x, k.y, k.w, k.h, C_BG);
  tft.fillRoundRect(k.x + 1, k.y + 1, k.w - 2, k.h - 3, 5, fill);
  char s[2] = { k.ch, 0 }; const char* label = s;
  switch(k.kind){
    case K_CHAR:   if(!kbNum && !kbShift) s[0] = tolower(k.ch); break;
    case K_SHIFT:  label = "shift"; break;
    case K_DEL:    label = "del"; break;
    case K_MODE:   label = kbNum ? "ABC" : "123"; break;
    case K_SPACE:  label = "space"; break;
    case K_CANCEL: label = "Cancel"; break;
    case K_SAVE:   label = "Save"; break;
  }
  tft.setTextDatum(middle_center);
  if(k.kind == K_CHAR) tft.setFont(&fonts::FreeSansBold9pt7b); else tft.setFont(&fonts::Font2);
  tft.setTextColor(fg, fill);
  tft.drawString(label, k.x + k.w / 2, k.y + (k.h - 3) / 2 + 1);
  tft.setFont(&fonts::Font0);
}
void drawKeys(){ for(int i = 0; i < nKeys; i++) drawKey(keys[i], false); }
void drawNameField(){
  tft.fillRoundRect(10, 30, SCRW - 20, 32, 6, C_PANEL);
  tft.setFont(&fonts::FreeSansBold9pt7b); tft.setTextDatum(middle_left); tft.setTextColor(C_TEXT, C_PANEL);
  tft.drawString(kbText, 18, 46);
  tft.fillRect(18 + tft.textWidth(kbText) + 2, 37, 2, 18, C_ACCENT);         // cursor
  char n[8]; snprintf(n, sizeof(n), "%d/%d", kbLen, CARD_NAME_LEN);
  tft.setFont(&fonts::Font0); tft.setTextDatum(middle_right); tft.setTextColor(C_DIM, C_PANEL);
  tft.drawString(n, SCRW - 18, 46);
}
void drawNaming(){
  tft.fillScreen(C_BG);
  drawTitle(kbTarget >= 0 ? "Rename card" : "Name this card");
  tft.setFont(&fonts::Font2); tft.setTextDatum(middle_right); tft.setTextColor(C_DIM, C_BG);
  tft.drawString(uidHex(kbUid, kbUidLen), SCRW - 10, 16);
  drawNameField();
  layoutKeyboard(); drawKeys();
}

void redraw(){
  switch(screen){
    case SETUP: case LOCKED: drawLocked(); break;
    case HOME:   drawHome(); break;
    case CARDS:  drawCards(); break;
    case ADDING: drawAdding(); break;
    case NAMING: drawNaming(); break;
  }
}
void toast(const char* m, uint16_t c){           // short message box, then redraw the screen
  int w = min(SCRW - 24, 290), h = 40;
  tft.fillRoundRect(CX - w / 2, CY - h / 2, w, h, 8, c);
  tft.setFont(&fonts::FreeSansBold9pt7b);
  if(tft.textWidth(m) > w - 12) tft.setFont(&fonts::Font2);
  tft.setTextDatum(middle_center); tft.setTextColor(c == C_ACCENT ? C_BG : C_TEXT, c);
  tft.drawString(m, CX, CY);
  tft.setFont(&fonts::Font0);
  delay(1400); redraw();
}
// full-screen green tick / red cross with LED and sound
void showResult(bool ok, const char* big, const char* small){
  uint16_t bg = ok ? C_GREEN : C_RED, fg = ok ? C_BG : C_TEXT;
  tft.fillScreen(bg);
  int cx = CX, cy = 82, h = 32;
  if(ok){ tft.drawWideLine(cx - h, cy, cx - h / 3, cy + h * 2 / 3, 5, fg); tft.drawWideLine(cx - h / 3, cy + h * 2 / 3, cx + h, cy - h * 2 / 3, 5, fg); }
  else  { tft.drawWideLine(cx - h, cy - h, cx + h, cy + h, 5, fg); tft.drawWideLine(cx + h, cy - h, cx - h, cy + h, 5, fg); }
  drawMessage(big, small, 160, fg, fg, bg);
  setLed(!ok, ok, false);
  if(ok){ tone2(2600, 60); delay(40); tone2(3200, 90); delay(900); }
  else  { tone2(400, 350); delay(1300); }
  setLed(false, false, false);
}

// ---------------- navigation ----------------
void openLocked(){ screen = nCards ? LOCKED : SETUP; pendingDel = -1; drawLocked(); }
void openHome()  { screen = HOME; drawHome(); }
void openCards() { screen = CARDS; pendingDel = -1; drawCards(); }
void openAdding(){ screen = ADDING; drawAdding(); }
void lockNow(){ Serial.println("[lock] locked"); openedWith = {}; openLocked(); }
void grant(int i, const char* small){
  openedWith = cards[i];
  unlockedAt = lastTouchMs = millis();
  showResult(true, cards[i].name, small);
  openHome();
}
// keyboard for a new card (back = SETUP or CARDS) or for renaming card i
void nameNewCard(const uint8_t* uid, int len, Screen back){
  kbTarget = -1; kbBack = back;
  memcpy(kbUid, uid, len); kbUidLen = len;
  kbText[0] = 0; kbLen = 0; kbShift = true; kbNum = false;
  lastTouchMs = millis();
  screen = NAMING; drawNaming();
}
void renameCard(int i){
  kbTarget = i; kbBack = CARDS;
  memcpy(kbUid, cards[i].uid, cards[i].len); kbUidLen = cards[i].len;
  strcpy(kbText, cards[i].name); kbLen = strlen(kbText); kbShift = kbLen == 0; kbNum = false;
  screen = NAMING; drawNaming();
}
void namingSave(){
  setName(kbText, kbText); kbLen = strlen(kbText);  // drop a trailing space
  if(!kbLen){ toast("Type a name first", C_ACCENT); return; }
  if(kbTarget >= 0){
    Serial.printf("[cards] %s renamed \"%s\" -> \"%s\"\n", uidHex(cards[kbTarget].uid, cards[kbTarget].len).c_str(),
                  cards[kbTarget].name, kbText);
    if(sameUid(cards[kbTarget], openedWith)) strcpy(openedWith.name, kbText);
    strcpy(cards[kbTarget].name, kbText); saveCards();
    screen = CARDS; toast("Name saved", C_GREEN);
    return;
  }
  int i = addCard(kbUid, kbUidLen, kbText);
  if(i < 0){ screen = CARDS; toast("Couldn't add the card", C_RED); return; }   // full, or added meanwhile
  Serial.printf("[cards] %s added as \"%s\"\n", uidHex(kbUid, kbUidLen).c_str(), cards[i].name);
  if(kbBack == SETUP) grant(i, "Key saved - welcome!");
  else { screen = CARDS; toast("Card added", C_GREEN); }
}
void namingCancel(){ if(kbBack == SETUP) openLocked(); else openCards(); }

// A card was scanned (from the reader, or the serial "sim" command).
void onTag(const uint8_t* uid, int len){
  String hex = uidHex(uid, len);
  Serial.printf("[nfc] card %s\n", hex.c_str());
  switch(screen){
    case SETUP:
      beep();
      nameNewCard(uid, len, SETUP);
      break;
    case LOCKED: {
      if(lockoutLeft()){ Serial.println("[lock] ignored: lockout"); return; }
      int i = findCard(uid, len);
      if(i >= 0){
        wrongInRow = 0;
        Serial.printf("[lock] %s (%s) allowed - unlocked\n", hex.c_str(), cards[i].name);
        grant(i, "Access granted");
        return;
      }
      bool lockout = ++wrongInRow >= MAX_WRONG;
      if(lockout){ wrongInRow = 0; lockoutUntil = millis() + LOCKOUT_MS; }
      Serial.printf("[lock] %s refused%s\n", hex.c_str(), lockout ? " - lockout" : "");
      char b[48];
      if(lockout) snprintf(b, sizeof(b), "Too many tries - wait %lu s", (unsigned long)(LOCKOUT_MS / 1000));
      else snprintf(b, sizeof(b), "Unknown card %s", hex.c_str());
      showResult(false, "Access denied", b);
      drawLocked();
      break;
    }
    case ADDING:
      lastTouchMs = millis();
      if(findCard(uid, len) >= 0){ screen = CARDS; toast("That card is already allowed", C_ACCENT); }
      else if(nCards >= MAX_CARDS){ screen = CARDS; toast("The list is full", C_RED); }
      else { beep(); nameNewCard(uid, len, CARDS); }
      break;
    default: break;                    // HOME / CARDS / NAMING: already open, or busy typing
  }
}

// ---------------- ESP-NOW link to the reader ----------------
uint32_t newNonce(){ uint32_t n; do n = esp_random(); while(!n); return n; }   // 0 = "reader has none yet"
// burn = after an accepted card: forget both, so that frame (or a copy) can't open the lock again
void rotateNonce(bool burn){ noncePrev = burn ? newNonce() : nonceCur; nonceCur = newNonce(); }
void sendHello(){
  LinkMsg m = {};
  m.magic = LINK_MAGIC; m.version = LINK_VERSION; m.type = LINK_HELLO; m.nonce = nonceCur;
  linkSign(m);
  esp_now_send(READER_MAC, (const uint8_t*)&m, sizeof(m));
}
// Runs in the Wi-Fi task: only copy the frame out; loop() checks it.
void onLinkRecv(const esp_now_recv_info_t* info, const uint8_t* data, int len){
  if(len != (int)sizeof(LinkMsg) || memcmp(info->src_addr, READER_MAC, 6)) return;
  LinkMsg m; memcpy(&m, data, sizeof(m));
  xQueueSend(rxQueue, &m, 0);
}
bool setupLink(){
  // Station mode, never connected: the radio only carries ESP-NOW, on LINK_CHANNEL.
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  esp_wifi_set_ps(WIFI_PS_NONE);
  esp_wifi_set_channel(LINK_CHANNEL, WIFI_SECOND_CHAN_NONE);
  uint8_t mac[6]; esp_wifi_get_mac(WIFI_IF_STA, mac);
  Serial.printf("[link] this CYD is %s, listening for the reader %s on channel %u\n",
                macStr(mac).c_str(), macStr(READER_MAC).c_str(), LINK_CHANNEL);
  if(memcmp(mac, LOCK_MAC, 6)) Serial.println("[link] WARNING: LOCK_MAC in nfc_link.h is not this board - the reader can't reach it");
  if(esp_now_init() != ESP_OK){ Serial.println("[link] esp_now_init failed"); return false; }
  esp_now_set_pmk(LINK_PMK);
  esp_now_peer_info_t p = {};
  memcpy(p.peer_addr, READER_MAC, 6); memcpy(p.lmk, LINK_LMK, 16);
  p.channel = LINK_CHANNEL; p.ifidx = WIFI_IF_STA; p.encrypt = true;
  if(esp_now_add_peer(&p) != ESP_OK){ Serial.println("[link] adding the reader as a peer failed"); return false; }
  esp_now_register_recv_cb(onLinkRecv);
  return true;
}
void handleLink(){
  LinkMsg m;
  while(xQueueReceive(rxQueue, &m, 0) == pdTRUE){
    if(!linkVerify(m)){ Serial.println("[link] dropped a frame with a bad signature"); continue; }
    if(m.type != LINK_HEARTBEAT && m.type != LINK_TAG) continue;
    readerHeard = true; lastReaderMs = millis(); readerPn532 = m.readerOk;
    if(m.type != LINK_TAG || m.uidLen < 4) continue;
    if(m.nonce != nonceCur && m.nonce != noncePrev){
      Serial.printf("[link] card %s came with an old challenge - ignored (replayed, or the reader missed our hellos)\n",
                    uidHex(m.uid, m.uidLen).c_str());
      if(screen == SETUP || screen == LOCKED || screen == ADDING) toast("Scan the card again", C_ACCENT);
      continue;
    }
    rotateNonce(true); sendHello();    // each challenge opens the lock once
    onTag(m.uid, m.uidLen);
  }
}

// ---------------- screenshots (serial "shotr", tools/shot.py) ----------------
// Run-length rows of the screen area: per row a u16 pair count, then (u16 run, u16 colour) pairs,
// colours as readRect returns them (RGB565, high byte first).
size_t streamRect(int x, int y, int w, int h, Sink out){
  static uint16_t line[320], pairs[640];
  size_t total = 0;
  for(int yy = y; yy < y + h; yy++){
    tft.readRect(x, yy, w, 1, line);
    uint16_t n = 0;
    for(int xx = 0; xx < w;){ uint16_t v = line[xx]; int r = 1; while(xx + r < w && line[xx + r] == v) r++; pairs[n++] = r; pairs[n++] = v; xx += r; }
    uint16_t cnt = n / 2;
    out((const uint8_t*)&cnt, 2); out((const uint8_t*)pairs, n * 2);
    total += 2 + n * 2;
  }
  return total;
}
void serialSink(const uint8_t* p, size_t n){ Serial.write(p, n); }

// ---------------- touch ----------------
void homeTouch(int x, int y){
  if(tapB(btnA, x, y)){ beep(); openCards(); }
  else if(tapB(btnB, x, y, true)){ beep(); lockNow(); }
}
void cardsTouch(int x, int y){
  if(tapB(btnA, x, y)){ beep(); openHome(); return; }
  if(hitB(btnB, x, y)){
    if(nCards >= MAX_CARDS){ beep(); toast("The list is full - delete one first", C_RED); }
    else if(tapB(btnB, x, y, true)){ beep(); openAdding(); }
    return;
  }
  for(int i = 0; i < nCards; i++){
    if(hitB(rowDel[i], x, y)){
      beep();
      if(pendingDel != i){             // first tap: ask
        int old = pendingDel; pendingDel = i; pendingDelAt = millis();
        if(old >= 0) drawCardRow(old);
        drawCardRow(i);
        return;
      }
      pendingDel = -1;
      if(nCards == 1){ toast("Keep at least one card", C_RED); return; }
      Serial.printf("[cards] %s (%s) deleted\n", uidHex(cards[i].uid, cards[i].len).c_str(), cards[i].name);
      delCard(i); drawCards(); toast("Card deleted", C_GREEN);
      return;
    }
    if(hitB(rowName[i], x, y)){ beep(); pendingDel = -1; renameCard(i); return; }
  }
}
// One key on the NAMING screen.
// c = the character to add for K_CHAR / K_SPACE (already in the right case).
void namingKey(uint8_t kind, char c){
  switch(kind){
    case K_CHAR: case K_SPACE: {
      if(kbLen >= CARD_NAME_LEN) return;
      if(kind == K_SPACE && (kbLen == 0 || kbText[kbLen - 1] == ' ')) return;     // no leading/double spaces
      kbText[kbLen++] = c; kbText[kbLen] = 0;
      bool shift = kind == K_SPACE ? true : (kbNum ? kbShift : false);            // capital after a space
      if(shift != kbShift){ kbShift = shift; if(!kbNum) drawKeys(); }
      drawNameField();
      return;
    }
    case K_DEL:
      if(!kbLen) return;
      kbText[--kbLen] = 0;
      if(!kbLen && !kbShift){ kbShift = true; if(!kbNum) drawKeys(); }
      drawNameField();
      return;
    case K_SHIFT:  if(!kbNum){ kbShift = !kbShift; drawKeys(); } return;
    case K_MODE:   kbNum = !kbNum; layoutKeyboard(); drawKeys(); return;
    case K_CANCEL: namingCancel(); return;
    case K_SAVE:   namingSave(); return;
  }
}
void namingTouch(int x, int y){
  for(int i = 0; i < nKeys; i++){
    const Key& k = keys[i];
    if(x < k.x || x >= k.x + k.w || y < k.y || y >= k.y + k.h) continue;
    drawKey(k, true); beep(); delay(40); drawKey(k, false);
    namingKey(k.kind, (k.kind == K_CHAR && !kbNum && !kbShift) ? tolower(k.ch) : k.ch);
    return;
  }
}
void handleTouch(){
  static bool wasDown = false; static uint32_t lastDownMs = 0;
  int32_t x, y;
  bool down = tft.getTouch(&x, &y);
  if(millis() < fakeUntil){ down = true; x = fakeX; y = fakeY; }
  uint32_t now = millis();
  if(!down){ if(wasDown && now - lastDownMs > 60) wasDown = false; return; }   // 60 ms release debounce
  lastDownMs = now; lastTouchMs = now;
  if(wasDown) return;                           // one action per press
  wasDown = true;
  Serial.printf("[touch] x=%d y=%d\n", (int)x, (int)y);
  switch(screen){
    case HOME:   homeTouch(x, y); break;
    case CARDS:  cardsTouch(x, y); break;
    case ADDING: if(tapB(btnA, x, y)){ beep(); openCards(); } break;
    case NAMING: namingTouch(x, y); break;
    default: break;                             // SETUP / LOCKED: only a card opens it
  }
}

// ---------------- serial dev commands ----------------
void handleSerial(){
  if(!Serial.available()) return;
  String c = Serial.readStringUntil('\n'); c.trim();
  uint8_t uid[10]; int n;
  if(c == "status"){
    static const char* RS[] = { "offline", "no-pn532", "ready" };
    Serial.printf("[status] v%s screen=%s cards=%d reader=%s wrong=%d lockout=%lus heap=%u\n", LOCK_VERSION,
                  SCREEN_NAME[screen], nCards, RS[readerState()], wrongInRow,
                  (unsigned long)(lockoutLeft() / 1000), (unsigned)ESP.getFreeHeap());
  } else if(c == "cards"){
    for(int i = 0; i < nCards; i++)
      Serial.printf("[cards] %d %s \"%s\"\n", i + 1, uidHex(cards[i].uid, cards[i].len).c_str(), cards[i].name);
    Serial.printf("[cards] %d of %d\n", nCards, MAX_CARDS);
  } else if(c.startsWith("add ")){                 // add <uid> [name]
    String rest = c.substring(4); rest.trim();
    int sp = rest.indexOf(' ');
    String name = sp < 0 ? "" : rest.substring(sp + 1);
    if(!(n = parseUid(sp < 0 ? rest : rest.substring(0, sp), uid))) Serial.println("[cards] usage: add 04A1B2C3 [name] (4, 7 or 10 bytes of hex)");
    else if((n = addCard(uid, n, name.c_str())) < 0) Serial.println("[cards] not added (already there, or the list is full)");
    else { Serial.printf("[cards] added %s \"%s\"\n", uidHex(cards[n].uid, cards[n].len).c_str(), cards[n].name);
           if(screen == SETUP) openLocked(); else if(screen == CARDS) drawCards(); }
  } else if(c.startsWith("name ")){                // name N <text>
    String rest = c.substring(5); rest.trim();
    int sp = rest.indexOf(' '), i = rest.toInt() - 1;
    char nm[CARD_NAME_LEN + 1]; setName(nm, sp < 0 ? "" : rest.substring(sp + 1));
    if(i < 0 || i >= nCards || !nm[0]) Serial.println("[cards] usage: name N new name (N from \"cards\")");
    else { if(sameUid(cards[i], openedWith)) strcpy(openedWith.name, nm);
           strcpy(cards[i].name, nm); saveCards(); Serial.printf("[cards] %d is now \"%s\"\n", i + 1, nm);
           if(screen == CARDS || screen == HOME) redraw(); }
  } else if(c.startsWith("del ")){
    int i = c.substring(4).toInt() - 1;
    if(i < 0 || i >= nCards) Serial.println("[cards] usage: del N (the number from \"cards\")");
    else { delCard(i); Serial.println("[cards] deleted"); if(screen == LOCKED && !nCards) openLocked(); else if(screen == CARDS) drawCards(); }
  } else if(c.startsWith("sim ")){                 // pretend the reader saw this card (test without the S3)
    if((n = parseUid(c.substring(4), uid))) onTag(uid, n); else Serial.println("[sim] usage: sim 04A1B2C3");
  } else if(c == "lock"){
    lockNow();
  } else if(c.startsWith("tap ")){
    if(sscanf(c.c_str() + 4, "%d %d", &fakeX, &fakeY) == 2) fakeUntil = millis() + 80;
  } else if(c == "shotr"){                         // run-length screen dump for tools/shot.py
    Serial.printf("\nSHOTR %d %d\n", SCRW, SCRH);
    streamRect(0, 0, SCRW, SCRH, serialSink);
    Serial.print("\nSHOT_END\n");
  } else if(c.length()){
    Serial.println("[dev] commands: status, cards, add <uid> [name], name N <name>, del N, sim <uid>, lock, tap x y, "
                   "shotr");
  }
}

// ---------------- setup / loop ----------------
void setup(){
  Serial.begin(115200); Serial.setTimeout(100); delay(100);
  Serial.printf("\n[lock] booting Lifeline v%s\n", LOCK_VERSION);
  pinMode(PIN_LED_R, OUTPUT); pinMode(PIN_LED_G, OUTPUT); pinMode(PIN_LED_B, OUTPUT);
  setLed(false, false, false);
  ledcAttach(PIN_SPK, 2300, 10); ledcWriteTone(PIN_SPK, 0);

  prefs.begin("nfclock", false);
  loadCards();

  tft.init(); tft.setRotation(ROTATION); tft.setBrightness(BRIGHTNESS);
  SCRW = tft.width(); SCRH = tft.height(); CX = SCRW / 2; CY = SCRH / 2;

  rxQueue = xQueueCreate(8, sizeof(LinkMsg));
  nonceCur = newNonce(); noncePrev = newNonce();
  setupLink();

  Serial.printf("[lock] %d card(s) allowed - starting %s\n", nCards, nCards ? "locked" : "in setup");
  openLocked();
}

void loop(){
  handleSerial();
  handleTouch();
  handleLink();

  static uint32_t lastHello = 0, lastSec = 0; static int lastRs = -1;
  uint32_t now = millis();
  if(now - lastHello >= HELLO_MS){ lastHello = now; rotateNonce(false); sendHello(); }

  int rs = readerState();
  if(rs != lastRs){
    static const char* RS[] = { "offline", "connected, but its PN532 doesn't answer", "ready" };
    Serial.printf("[link] reader %s\n", RS[rs]);
    lastRs = rs;
    if(screen == SETUP || screen == LOCKED || screen == ADDING) drawReaderStatus();
  }

  if(now - lastSec >= 1000){            // once a second
    lastSec = now;
    if(screen == LOCKED && lockoutUntil){ if(lockoutLeft()) drawLockMessage(); else { lockoutUntil = 0; drawLocked(); } }
    if(screen == HOME) drawHomeTimer();
    if(pendingDel >= 0 && now - pendingDelAt > 3000){ int i = pendingDel; pendingDel = -1; if(screen == CARDS) drawCardRow(i); }
    if(AUTO_LOCK_MS && (screen == HOME || screen == CARDS || screen == ADDING || screen == NAMING) &&
       now - lastTouchMs > AUTO_LOCK_MS){
      Serial.println("[lock] no touch for a while - auto-lock");
      lockNow();
    }
  }
  delay(5);
}