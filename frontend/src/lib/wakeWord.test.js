import { describe, expect, it } from "vitest";
import { createWakeListener, findWakeCommand, isName } from "./wakeWord.js";

describe("findWakeCommand", () => {
  it("hears the name on its own", () => {
    expect(findWakeCommand("Astra")).toEqual({ question: "" });
    expect(findWakeCommand("hey Astra")).toEqual({ question: "" });
    expect(findWakeCommand("okay astra.")).toEqual({ question: "" });
  });
  it("returns the question said in the same breath", () => {
    expect(findWakeCommand("astra how am I doing")).toEqual({ question: "how am I doing" });
    expect(findWakeCommand("Astra, what's my heart rate?")).toEqual({ question: "what's my heart rate?" });
    expect(findWakeCommand("so um astra is my temperature okay")).toEqual({ question: "is my temperature okay" });
  });
  it("hears common mishearings of the name", () => {
    expect(findWakeCommand("Astro how am I doing")).toEqual({ question: "how am I doing" });
    expect(findWakeCommand("hey Austra")).toEqual({ question: "" });
    expect(findWakeCommand("ostra what's my heart rate")).toEqual({ question: "what's my heart rate" });
  });
  it("ignores look-alike words and ordinary speech", () => {
    for (const s of ["the astronaut is fine", "Astro Health station", "open astro health", "I need extra water", "nothing here", "", null]) {
      expect(findWakeCommand(s)).toBeNull();
    }
  });
});

// A fake browser SpeechRecognition the tests can drive.
function harness() {
  const made = [];
  class FakeRec {
    constructor() { made.push(this); this.started = false; }
    start() { this.started = true; }
    abort() { this.aborted = true; }
  }
  const timers = [];
  const schedule = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const states = [], wakes = [];
  const l = createWakeListener({
    Recognition: FakeRec, schedule, unschedule: () => {},
    onWake: (w) => wakes.push(w), onState: (s) => states.push(s),
  });
  const say = (rec, transcript, isFinal = true, alts = []) => {
    const r = [{ transcript }, ...alts.map((t) => ({ transcript: t }))]; r.isFinal = isFinal;
    rec.onresult({ resultIndex: 0, results: [r] });
  };
  const runTimer = () => timers.shift().fn();
  const runLast = () => timers.pop().fn();
  return { made, timers, states, wakes, l, say, runTimer, runLast };
}

describe("hearing her name through noise", () => {
  it("one letter off still counts", () => {
    for (const w of ["Astra", "astra's", "Asta", "Astral", "Austra", "Ostra", "Astrah", "Astrid", "astro"]) expect(isName(w)).toBe(true);
    expect(findWakeCommand("Asta, how am I doing?")).toEqual({ question: "how am I doing?" });
  });
  it("but not words two letters away", () => {
    for (const w of ["extra", "pasta", "Austria", "astronaut", "aster", "after", "a", "ast"]) expect(isName(w)).toBe(false);
    expect(isName("Astro", "Health")).toBe(false);
  });
});

describe("createWakeListener", () => {
  it("wakes on a final phrase with the name, never on interim text", () => {
    const h = harness();
    h.l.start();
    const rec = h.made[0];
    expect(rec.continuous).toBe(true);
    h.say(rec, "astra how am I", false);
    expect(h.wakes).toEqual([]);
    h.say(rec, "astra how am I doing", true);
    expect(h.wakes).toEqual([{ question: "how am I doing" }]);
  });
  it("restarts itself when the browser ends it, backing off after errors", () => {
    const h = harness();
    h.l.start();
    h.made[0].onend();
    expect(h.timers[0].ms).toBe(100);
    h.runTimer();
    expect(h.made.length).toBe(2);
    h.made[1].onerror({ error: "network" });
    h.made[1].onerror({ error: "network" });
    h.made[1].onend();
    expect(h.timers[0].ms).toBe(600);
  });
  it("stops for good when the microphone is denied", () => {
    const h = harness();
    h.l.start();
    h.made[0].onerror({ error: "not-allowed" });
    h.made[0].onend();
    expect(h.states.at(-1)).toBe("blocked");
    expect(h.timers).toEqual([]);
  });
  it("pauses (e.g. while the voice screen is open) and resumes", () => {
    const h = harness();
    h.l.start();
    h.l.pause();
    expect(h.made[0].aborted).toBe(true);
    expect(h.states.at(-1)).toBe("paused");
    h.l.resume();
    expect(h.made.length).toBe(2);
    expect(h.states.at(-1)).toBe("listening");
  });
});

describe("ignoring the room", () => {
  it("a name that isn't loud or clear enough doesn't wake her", () => {
    const made = [];
    class FakeRec { constructor() { made.push(this); } start() {} abort() {} }
    const wakes = [], asked = [];
    const l = createWakeListener({
      Recognition: FakeRec, onWake: (w) => wakes.push(w), schedule: () => 1, unschedule: () => {},
      accept: (hit) => { asked.push(hit); return hit.confidence > 0.5; },
    });
    l.start();
    const say = (t, confidence, i = 0) => {
      const r = [{ transcript: t, confidence }]; r.isFinal = true;
      const results = []; results[i] = r;
      made[0].onresult({ resultIndex: i, results });
    };
    say("astra how am I", 0.2);
    expect(wakes).toEqual([]);
    expect(asked[0]).toMatchObject({ question: "how am I", confidence: 0.2 });
    say("astra how am I", 0.9, 1);
    expect(wakes).toEqual([{ question: "how am I" }]);
  });
});

describe("phrases the browser never finishes", () => {
  it("an unfinished phrase with the name wakes her after a short wait", () => {
    const h = harness();
    h.l.start();
    h.say(h.made[0], "astra", false);
    expect(h.wakes).toEqual([]);
    h.runLast();
    expect(h.wakes).toEqual([{ question: "" }]);
    h.say(h.made[0], "astra", true); // the late final for the same phrase: not a second wake
    expect(h.wakes.length).toBe(1);
  });
  it("the session ending with a half-heard name still wakes her", () => {
    const h = harness();
    h.l.start();
    h.say(h.made[0], "astra how am I doing", false);
    h.made[0].onend();
    expect(h.wakes).toEqual([{ question: "how am I doing" }]);
  });
  it("the final result wins when it comes in time", () => {
    const h = harness();
    h.l.start();
    h.say(h.made[0], "astra what is", false);
    h.say(h.made[0], "astra what is my heart rate", true);
    expect(h.wakes).toEqual([{ question: "what is my heart rate" }]);
  });
  it("pausing drops a half-heard name", () => {
    const h = harness();
    h.l.start();
    h.say(h.made[0], "astra", false);
    h.l.pause();
    h.timers.forEach((t) => t.fn());
    expect(h.wakes).toEqual([]);
  });
  it("checks the browser's other guesses too", () => {
    const h = harness();
    h.l.start();
    h.say(h.made[0], "extra how am I", true, ["astra how am I"]);
    expect(h.wakes).toEqual([{ question: "how am I" }]);
  });
});

describe("watchdog", () => {
  it("throws away a session that has gone silent without ending, and starts a fresh one", () => {
    const made = [];
    class FakeRec { constructor() { made.push(this); } start() {} abort() { this.aborted = true; } }
    let clock = 0;
    let tick = null;
    const l = createWakeListener({
      Recognition: FakeRec, now: () => clock, every: (fn) => { tick = fn; return 1; }, unevery: () => {},
      schedule: () => 1, unschedule: () => {}, watchdogMs: 45000,
    });
    l.start();
    clock = 30000; tick();
    expect(made.length).toBe(1); // still within the window
    made[0].onaudiostart(); // a sign of life resets it
    clock = 70000; tick();
    expect(made.length).toBe(1);
    clock = 120000; tick(); // 50 s with nothing at all
    expect(made[0].aborted).toBe(true);
    expect(made.length).toBe(2);
  });
});
