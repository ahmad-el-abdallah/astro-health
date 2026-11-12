import { describe, expect, it } from "vitest";
import { MIC_DENIED, pickVoice, voiceErrorMessage } from "./useVoice.js";
import { echoParams, QUINDAR_HZ, quindarFrequency } from "./stationAudio.js";

const v = (name, lang) => ({ name, lang });

describe("pickVoice", () => {
  it("prefers a calm female Aria/Jenny voice first", () => {
    const voices = [v("Google US English", "en-US"), v("Microsoft Aria Online (Natural) - English (United States)", "en-US")];
    expect(pickVoice(voices).name).toMatch(/Aria/);
  });
  it("prefers an en-US/en-GB voice named female/Samantha/Zira/Google", () => {
    const voices = [v("Alex", "en-US"), v("Thomas", "fr-FR"), v("Google UK English Female", "en-GB"), v("Samantha", "en-US")];
    expect(pickVoice(voices).name).toBe("Google UK English Female");
  });
  it("ignores a nice name in the wrong language", () => {
    expect(pickVoice([v("Google français", "fr-FR"), v("Daniel", "en-AU")]).name).toBe("Daniel");
  });
  it("falls back to the first English voice", () => {
    expect(pickVoice([v("Thomas", "fr-FR"), v("Karen", "en-AU"), v("Alex", "en-US")]).name).toBe("Karen");
  });
  it("returns null (browser default) when there is no English voice or no voices yet", () => {
    expect(pickVoice([v("Thomas", "fr-FR")])).toBeNull();
    expect(pickVoice([])).toBeNull();
  });
});

describe("voiceErrorMessage", () => {
  it("explains a denied microphone and keeps text working", () => {
    expect(voiceErrorMessage("not-allowed")).toBe(MIC_DENIED);
  });
  it("names any other error", () => {
    expect(voiceErrorMessage("network")).toBe("Voice error: network");
  });
});

describe("quindar tones", () => {
  it("uses NASA's Apollo frequencies: 2525 Hz to start, 2475 Hz to end a transmission", () => {
    expect(quindarFrequency("start")).toBe(2525);
    expect(quindarFrequency("end")).toBe(2475);
    expect(QUINDAR_HZ).toEqual({ start: 2525, end: 2475 });
  });
});

describe("male browser voice", () => {
  it("prefers a known male voice", () => {
    const voices = [v("Microsoft Aria Online (Natural)", "en-US"), v("Google UK English Male", "en-GB"), v("Google US English", "en-US")];
    expect(pickVoice(voices, "male").name).toBe("Google UK English Male");
    expect(pickVoice([v("Samantha", "en-US"), v("Daniel", "en-GB")], "male").name).toBe("Daniel");
    expect(pickVoice([v("Microsoft Guy Online (Natural)", "en-US"), v("David", "en-US")], "male").name).toMatch(/Guy/);
  });
  it("falls back to an English voice that isn't clearly female, then any English voice", () => {
    expect(pickVoice([v("Samantha", "en-US"), v("Fred", "en-US")], "male").name).toBe("Fred");
    expect(pickVoice([v("Zara", "en-US"), v("Samantha", "en-US")], "male").name).toBe("Zara");
    expect(pickVoice([v("Samantha", "en-US")], "male").name).toBe("Samantha");
  });
  it("female stays the default", () => {
    expect(pickVoice([v("Google UK English Male", "en-GB"), v("Google US English", "en-US")]).name).toBe("Google US English");
  });
});

describe("echo levels", () => {
  it("off is clean; light < medium < strong", () => {
    expect(echoParams("off")).toBeNull();
    const [l, m, s] = ["light", "medium", "strong"].map(echoParams);
    for (const k of ["tail", "wet", "feedback", "echo"]) expect(l[k] < m[k] && m[k] < s[k]).toBe(true);
    expect(echoParams("nonsense")).toEqual(m);
  });
});
