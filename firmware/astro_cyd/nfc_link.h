// ESP-NOW link between the ESP32-S3 NFC reader and this CYD terminal.
//
// This file is shared and must stay byte-for-byte identical to
// firmware/esp32s3_nfc_reader/nfc_link.h in this same repo (the two live
// boards that actually talk to each other) -- edit one, copy it over the
// other. It's also the same protocol Lifeline's lock sketch uses
// (firmware/existing/, reference-only, not wired to anything here), which
// is where this file originally came from.
//
// Traffic (one LinkMsg per ESP-NOW frame, unicast, encrypted with LINK_PMK/LINK_LMK):
//   reader -> lock  LINK_HEARTBEAT  every second: "I'm here", plus whether the PN532 answers
//   reader -> lock  LINK_TAG        a card was put on the reader (sent once per presentation)
//   lock -> reader  LINK_HELLO      every second: the lock's current challenge (nonce)
// The reader echoes the latest challenge it got in every frame. The lock only accepts a TAG whose
// challenge is current (or the one before), and changes it after each accepted TAG, so a recorded
// frame can't be replayed later. Every frame also carries a truncated HMAC-SHA256 (LINK_HMAC_KEY),
// so a frame that wasn't made with the key is dropped even if it gets past ESP-NOW.
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <mbedtls/md.h>

// Wi-Fi station MACs (esptool prints them). The reader sends from its station interface.
static const uint8_t READER_MAC[6] = {0x44, 0x1B, 0xF6, 0xFF, 0xDD, 0xB8};  // ESP32-S3
static const uint8_t LOCK_MAC[6]   = {0x8C, 0x94, 0xDF, 0x4E, 0x8E, 0x90};  // CYD

// Both boards sit on this Wi-Fi channel. The CYD's web-mirror access point runs on it too.
static const uint8_t LINK_CHANNEL = 6;

// Keys: random, made for this pair. Change all three together in both copies.
static const uint8_t LINK_PMK[16] = {0xDC, 0xB7, 0x7D, 0xAD, 0x07, 0x14, 0x9A, 0x7C,
                                     0x8B, 0x48, 0x3C, 0x36, 0xB5, 0xF5, 0x34, 0xF0};
static const uint8_t LINK_LMK[16] = {0x07, 0x82, 0xA2, 0x68, 0x37, 0xA0, 0x8C, 0x69,
                                     0x72, 0xFA, 0x49, 0xDD, 0x3D, 0x00, 0x5D, 0x25};
static const uint8_t LINK_HMAC_KEY[16] = {0xFF, 0x94, 0xAB, 0xE6, 0xB2, 0x9C, 0x99, 0xF5,
                                          0xB1, 0xA8, 0xF6, 0xC1, 0xAE, 0x86, 0x88, 0x34};

static const uint32_t LINK_MAGIC = 0x314B4C4E;  // "NLK1"
static const uint8_t LINK_VERSION = 1;
static const uint32_t LINK_TIMEOUT_MS = 3500;   // nothing heard for this long = the other side is gone

enum LinkType : uint8_t { LINK_TAG = 1, LINK_HEARTBEAT = 2, LINK_HELLO = 3 };

struct __attribute__((packed)) LinkMsg {
  uint32_t magic;     // LINK_MAGIC
  uint8_t version;    // LINK_VERSION
  uint8_t type;       // LinkType
  uint8_t readerOk;   // reader -> lock: 1 = the PN532 answers
  uint8_t uidLen;     // LINK_TAG: 4, 7 or 10; otherwise 0
  uint8_t uid[10];
  uint32_t nonce;     // HELLO: the lock's challenge; reader frames: the latest challenge received
  uint8_t sig[8];     // first 8 bytes of HMAC-SHA256(LINK_HMAC_KEY, every byte before this field)
};

inline void linkSign(LinkMsg &m) {
  uint8_t h[32];
  mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), LINK_HMAC_KEY, sizeof(LINK_HMAC_KEY),
                  (const uint8_t *)&m, offsetof(LinkMsg, sig), h);
  memcpy(m.sig, h, sizeof(m.sig));
}

inline bool linkVerify(const LinkMsg &m) {
  if (m.magic != LINK_MAGIC || m.version != LINK_VERSION || m.uidLen > sizeof(m.uid)) return false;
  LinkMsg c = m;
  linkSign(c);
  uint8_t diff = 0;  // compare without an early exit
  for (size_t i = 0; i < sizeof(m.sig); i++) diff |= c.sig[i] ^ m.sig[i];
  return diff == 0;
}
