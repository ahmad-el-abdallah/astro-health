import { describe, expect, it } from "vitest";
import { confidentEnough, createLevelTracker, isYou, loudEnough, ROOMS, wakeIsYou } from "./hearing.js";

// A room: 6 s of background at `noise`, then `speech` for the last second.
function room(noise, speech) {
  const t = createLevelTracker();
  const now = 100_000;
  for (let ms = 6000; ms > 1000; ms -= 60) t.push(noise, now - ms);
  for (let ms = 1000; ms >= 0; ms -= 60) t.push(speech, now - ms);
  return { t, now };
}

describe("is that you or the room?", () => {
  it("your voice close to the mic is clearly above the background", () => {
    const { t, now } = room(0.02, 0.2);
    expect(t.floor()).toBeCloseTo(0.02);
    expect(loudEnough(t, 1500, "normal", now)).toBe(true);
    expect(loudEnough(t, 1500, "noisy", now)).toBe(true);
  });
  it("speech barely above the background is the room", () => {
    const { t, now } = room(0.03, 0.05);
    expect(loudEnough(t, 1500, "normal", now)).toBe(false);
    expect(loudEnough(t, 1500, "quiet", now)).toBe(true); // a quiet room takes everything
  });
  it("noisy room needs louder speech than normal", () => {
    const { t, now } = room(0.02, 0.055);
    expect(loudEnough(t, 1500, "normal", now)).toBe(true);
    expect(loudEnough(t, 1500, "noisy", now)).toBe(false);
  });
  it("never deaf: no meter data or a silent meter lets everything through", () => {
    expect(loudEnough(createLevelTracker(), 1500, "noisy", 1)).toBe(true);
    const { t, now } = room(0, 0);
    expect(loudEnough(t, 1500, "noisy", now)).toBe(true);
  });
  it("the recognizer's confidence", () => {
    expect(confidentEnough(0.2, "normal")).toBe(false);
    expect(confidentEnough(0.3, "normal")).toBe(true);
    expect(confidentEnough(0.45, "normal")).toBe(true);
    expect(confidentEnough(0.4, "noisy")).toBe(false);
    expect(confidentEnough(0, "noisy")).toBe(true); // no score given
    expect(confidentEnough(undefined, "normal")).toBe(true);
    expect(confidentEnough(0.1, "quiet")).toBe(true);
  });
  it("noisy room takes 3 new words to talk over her", () => {
    expect(ROOMS.noisy.bargeWords).toBe(3);
    expect(ROOMS.normal.bargeWords).toBe(2);
  });
});

describe("never miss the astronaut", () => {
  it("what the recognizer heard clearly is trusted, however quiet", () => {
    const { t, now } = room(0.03, 0.04); // barely above the background
    expect(isYou({ confidence: 0.9, sinceMs: 1500 }, t, "normal", now)).toBe(true);
    expect(isYou({ confidence: 0.5, sinceMs: 1500 }, t, "normal", now)).toBe(false); // unsure AND quiet
    expect(isYou({ confidence: 0.5, sinceMs: 1500 }, t, "quiet", now)).toBe(true);
    expect(isYou({ confidence: 0, sinceMs: 1500 }, t, "normal", now)).toBe(true); // no score: trusted
    expect(isYou({ confidence: 0.95, sinceMs: 1500 }, t, "noisy", now)).toBe(false); // noisy: loud or nothing
  });
  it("her name is only loudness-checked in a noisy room", () => {
    const { t, now } = room(0.03, 0.04);
    expect(wakeIsYou(0.6, t, "normal", now)).toBe(true);
    expect(wakeIsYou(0, t, "normal", now)).toBe(true); // an unfinished phrase has no score
    expect(wakeIsYou(0.6, t, "noisy", now)).toBe(false);
    expect(wakeIsYou(0.1, t, "normal", now)).toBe(false); // too unclear
  });
});
