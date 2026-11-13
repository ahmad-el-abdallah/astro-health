import { describe, expect, it } from "vitest";
import { countTones, encodeWav, latestTalk, pct, talkMix, TONE_DISCLAIMER, TONE_PRIVACY } from "./toneClip.js";

// The segmentation (speech vs. Astra vs. background) is tested in toneSegmentation.test.js.

describe("encodeWav", () => {
  it("writes a 16 kHz mono 16-bit PCM WAV", () => {
    const wav = encodeWav(Float32Array.from([0, 1, -1, 2, -2]));
    const v = new DataView(wav.buffer);
    const text = (o, n) => String.fromCharCode(...wav.subarray(o, o + n));
    expect(text(0, 4)).toBe("RIFF");
    expect(text(8, 4)).toBe("WAVE");
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(10);
    expect([0, 1, 2, 3, 4].map((i) => v.getInt16(44 + i * 2, true))).toEqual([0, 32767, -32768, 32767, -32768]); // clipped
  });
});

describe("results", () => {
  const rows = [
    { id: 1, ts: "2026-11-12T10:00:00Z", talk_id: "a", label: "sad", confidence: 0.6 },
    { id: 2, ts: "2026-11-13T09:00:00Z", talk_id: "b", label: "calm", confidence: 0.8 },
    { id: 3, ts: "2026-11-13T09:01:00Z", talk_id: "b", label: "happy", confidence: 0.5 },
    { id: 4, ts: "2026-11-13T09:02:00Z", talk_id: "b", label: "calm", confidence: 0.7 },
  ];
  it("summarises the latest talk only", () => {
    const t = latestTalk(rows);
    expect(t.talkId).toBe("b");
    expect(t.phrases.map((p) => p.id)).toEqual([2, 3, 4]);
    expect(t.top).toBe("calm");
    expect(t.topCount).toBe(2);
    expect(latestTalk([])).toBeNull();
  });
  it("averages all seven probabilities over a talk", () => {
    const s = (calm, happy) => ({ angry: 0, calm, disgust: 0, fearful: 0, happy, sad: 1 - calm - happy, surprised: 0 });
    const mix = talkMix([{ scores: s(0.8, 0.1) }, { scores: s(0.4, 0.5) }, { label: "sad" /* no scores: skipped */ }]);
    expect(mix.map((m) => m.tone)).toEqual(["calm", "happy", "surprised", "sad", "fearful", "angry", "disgust"]);
    const by = Object.fromEntries(mix.map((m) => [m.tone, m.p]));
    expect(by.calm).toBeCloseTo(0.6);
    expect(by.happy).toBeCloseTo(0.3);
    expect(by.sad).toBeCloseTo(0.1);
    expect(mix.reduce((a, m) => a + m.p, 0)).toBeCloseTo(1);
    expect(talkMix([]).every((m) => m.p === 0)).toBe(true);
  });
  it("formats probabilities", () => {
    expect(pct(0.4567)).toBe("46%");
    expect(pct(0.001)).toBe("<1%");
    expect(pct(0)).toBe("0%");
  });
  it("counts tones across the week", () => {
    expect(countTones(rows)).toEqual({ sad: 1, calm: 2, happy: 1 });
  });
  it("says it's an estimate, not a diagnosis, and keeps the two audio paths apart", () => {
    expect(TONE_DISCLAIMER).toMatch(/doesn.t diagnose/);
    expect(TONE_PRIVACY).toMatch(/on this laptop/);
    expect(TONE_PRIVACY).toMatch(/Google/);
    expect(TONE_PRIVACY).toMatch(/Microsoft/);
  });
});
