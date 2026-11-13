import { describe, expect, it } from "vitest";
import { isBargeIn, isEcho, isStopCommand, spokenPart } from "./bargeIn.js";

const REPLY = "Your vitals look normal today. Keep drinking water and get some rest before your next workout.";

describe("talking over Astra", () => {
  it("you saying something new stops her", () => {
    expect(isBargeIn("wait what about my sleep", REPLY)).toBe(true);
    expect(isBargeIn("actually I feel dizzy", REPLY)).toBe(true);
  });
  it("a short stop word stops her", () => {
    for (const t of ["stop", "Wait!", "hold on", "hey Astra"]) expect(isBargeIn(t, REPLY)).toBe(true);
    expect(isStopCommand("hold on")).toBe(true);
    expect(isStopCommand("hold on what about sleep")).toBe(false);
  });
  it("the mic hearing her own words does not stop her", () => {
    expect(isBargeIn("your vitals look normal", REPLY)).toBe(false);
    expect(isBargeIn("keep drinking water and get some", REPLY)).toBe(false);
    expect(isBargeIn("um", REPLY)).toBe(false);
  });
  it("a final phrase that is only her voice is treated as echo", () => {
    expect(isEcho("keep drinking water and get some rest", REPLY)).toBe(true);
    expect(isEcho("what about my heart rate", REPLY)).toBe(false);
    expect(isEcho("stop", REPLY)).toBe(false);
    expect(isEcho("yes", "Should I log your mood as low?")).toBe(false); // answering her, not echo
  });
});

describe("noisy room", () => {
  it("needs 3 new words to stop her (a stop word still works)", () => {
    expect(isBargeIn("my sleep", REPLY, 3)).toBe(false);
    expect(isBargeIn("what about my sleep", REPLY, 3)).toBe(true);
    expect(isBargeIn("stop", REPLY, 3)).toBe(true);
  });
});

describe("spokenPart", () => {
  it("cuts back to the last whole word she said", () => {
    expect(spokenPart(REPLY, 25)).toBe("Your vitals look normal");
    expect(spokenPart(REPLY, 0)).toBe("");
    expect(spokenPart(REPLY, 999)).toBe(REPLY);
  });
});
