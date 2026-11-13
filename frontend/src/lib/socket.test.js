// The live updates the Mind page's voice tone sections depend on.
import { describe, expect, it, vi } from "vitest";

vi.mock("socket.io-client", () => ({ io: () => ({ on() {}, connect() {}, emit() {} }) }));

describe("live updates", () => {
  it("a finished conversation or a new estimate refreshes the latest conversation and the history", async () => {
    const { EVENT_INVALIDATIONS } = await import("./socket.js");
    expect(EVENT_INVALIDATIONS.voice_talk).toEqual(expect.arrayContaining([["voice-talk-latest"], ["voice-tone"]]));
    expect(EVENT_INVALIDATIONS.voice_tone).toEqual(expect.arrayContaining([["voice-tone"], ["voice-talk-latest"]]));
    // mood keeps its own refresh, untouched by voice tone
    expect(EVENT_INVALIDATIONS.voice_tone.flat()).not.toContain("history");
  });
});
