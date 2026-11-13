// lib/toneCapture.js with Web Audio and fetch faked (Vitest runs in Node): it attaches to the
// SHARED microphone source, records continuously while the call is open (in memory, capped),
// tags each block with whether Astra's sound was ACTUALLY playing, takes per-phrase
// snapshots, never reuses speech, turns speech into a 16 kHz WAV (or says why not), and posts
// it to this laptop's backend only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({ ctx: null, input: { analyser: null, source: null }, audible: false }));
vi.mock("./stationAudio.js", () => ({ audioCtx: () => shared.ctx, input: shared.input, astraAudible: () => shared.audible }));

const RATE = 16000;
const syllables = (seconds, rms) => Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => {
  const t = i / RATE;
  return 1.25 * rms * Math.max(0, Math.sin(2 * Math.PI * 4 * t)) ** 1.5 * Math.sin(2 * Math.PI * 150 * t);
});

function fakeAudio({ state = "running", sampleRate = RATE } = {}) {
  const nodes = [];
  class FakeWorkletNode {
    constructor(ctx, name, opts) {
      this.name = name;
      this.opts = opts;
      this.sent = [];
      this.port = { postMessage: (m) => this.sent.push(m), onmessage: null };
      nodes.push(this);
    }
    connect(x) { this.out = x; return x; }
  }
  globalThis.AudioWorkletNode = FakeWorkletNode;
  const ctx = {
    state, sampleRate, destination: { name: "speakers" },
    audioWorklet: { addModule: vi.fn(async () => {}) },
    createGain: () => ({ gain: { value: 1 }, connect(x) { this.to = x; return x; } }),
  };
  const source = { connected: [], connect(n) { this.connected.push(n); }, disconnect: vi.fn() };
  shared.ctx = ctx;
  shared.input.source = source;
  return { ctx, source, nodes };
}

// The worklet delivering audio in 50 ms blocks, as the audio thread would (with a fake clock).
let clock = 0;
function deliver(node, samples) {
  const size = RATE / 20;
  for (let i = 0; i < samples.length; i += size) {
    clock += 50;
    node.port.onmessage({ data: samples.slice(i, i + size) });
  }
}

let mod;
beforeEach(async () => {
  vi.resetModules();
  clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  shared.audible = false;
  shared.input.source = null;
  shared.ctx = null;
  mod = await import("./toneCapture.js");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); delete globalThis.fetch; });

describe("toneCapture: the shared microphone", () => {
  it("attaches a silent worklet to the existing mic source -- never opens its own", async () => {
    const gum = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: gum } });
    const { ctx, source, nodes } = fakeAudio();
    expect(await mod.toneCapture.start()).toBe(true);
    expect(ctx.audioWorklet.addModule).toHaveBeenCalledWith(mod.WORKLET_URL);
    expect(source.connected).toEqual([nodes[0]]);
    expect(nodes[0].out.gain.value).toBe(0); // pulled by the graph, but outputs nothing audible
    expect(nodes[0].sent).toEqual(["on"]);
    expect(gum).not.toHaveBeenCalled();
  });

  it("says why it couldn't start", async () => {
    expect(await mod.toneCapture.start()).toBe(false);
    expect(mod.toneCapture.lastStart).toBe("no AudioContext");
    fakeAudio({ state: "suspended" });
    expect(await mod.toneCapture.start()).toBe(false);
    expect(mod.toneCapture.lastStart).toBe("sound suspended");
    fakeAudio();
    shared.input.source = null;
    expect(await mod.toneCapture.start()).toBe(false);
    expect(mod.toneCapture.lastStart).toBe("shared microphone not open");
  });

  it("re-attaches when the shared mic was closed and reopened (a new source node)", async () => {
    const { nodes } = fakeAudio();
    await mod.toneCapture.start();
    const first = shared.input.source;
    const second = { connected: [], connect(n) { this.connected.push(n); }, disconnect: vi.fn() };
    shared.input.source = second;
    await mod.toneCapture.start();
    expect(first.disconnect).toHaveBeenCalledWith(nodes[0]);
    expect(second.connected).toEqual([nodes[0]]);
  });

  it("stop() during start() wins, and forgets everything", async () => {
    const { nodes } = fakeAudio();
    const p = mod.toneCapture.start();
    mod.toneCapture.stop();
    expect(await p).toBe(false);
    expect(mod.toneCapture.recording).toBe(false);
    await mod.toneCapture.start();
    deliver(nodes[0], syllables(1, 0.002));
    mod.toneCapture.stop();
    expect(mod.toneCapture.phrase(0)).toBeNull();
  });
});

describe("toneCapture: recording", () => {
  it("tags blocks with whether Astra's sound was actually playing", async () => {
    const { nodes } = fakeAudio();
    await mod.toneCapture.start();
    deliver(nodes[0], syllables(0.1, 0.002));
    shared.audible = true;
    deliver(nodes[0], syllables(0.1, 0.002));
    shared.audible = false;
    const snap = mod.toneCapture.phrase(0);
    expect(snap.blocks.map((b) => b.astra)).toEqual([false, false, true, true]);
    expect(snap.rate).toBe(RATE);
  });

  it("keeps only the last BUFFER_MS in memory", async () => {
    const { nodes } = fakeAudio();
    await mod.toneCapture.start();
    deliver(nodes[0], new Float32Array(RATE * 30));
    const snap = mod.toneCapture.phrase(0);
    const span = snap.blocks.at(-1).at - snap.blocks[0].at;
    expect(span).toBeLessThanOrEqual(mod.BUFFER_MS);
    expect(snap.blocks.length).toBeLessThanOrEqual(mod.BUFFER_MS / 50 + 1);
  });

  it("a phrase snapshot is a copy: the live buffer goes on", async () => {
    const { nodes } = fakeAudio();
    await mod.toneCapture.start();
    deliver(nodes[0], syllables(0.5, 0.002));
    const snap = mod.toneCapture.phrase(0);
    deliver(nodes[0], syllables(0.5, 0.002));
    expect(snap.blocks).toHaveLength(10);
    expect(mod.toneCapture.phrase(0).blocks).toHaveLength(20);
  });
});

describe("phraseToWav", () => {
  it("makes a normalised 16 kHz WAV of your speech right after Astra stops", async () => {
    const { nodes } = fakeAudio();
    await mod.toneCapture.start();
    deliver(nodes[0], new Float32Array(RATE)); // 1 s of quiet room
    shared.audible = true;
    deliver(nodes[0], syllables(2, 0.01)); // her, louder
    shared.audible = false;
    const listenFrom = clock;
    deliver(nodes[0], syllables(2, 0.0021)); // you, at the measured level
    deliver(nodes[0], new Float32Array(RATE / 2));
    const out = await mod.phraseToWav(mod.toneCapture.phrase(listenFrom - 1500));
    expect(out.skip).toBeUndefined();
    expect(out.astraMs).toBeGreaterThan(1500);
    expect(out.gainDb).toBeGreaterThan(20); // a quiet voice brought up before 16-bit
    const v = new DataView(out.wav.buffer);
    expect(String.fromCharCode(...out.wav.subarray(0, 4))).toBe("RIFF");
    expect(v.getUint32(24, true)).toBe(16000);
    expect(out.seconds).toBeGreaterThan(1.5);
    expect(out.usedUntil).toBeGreaterThan(listenFrom);
    mod.toneCapture.markUsed(out.usedUntil);
    expect((await mod.phraseToWav(mod.toneCapture.phrase(listenFrom))).skip).toBeDefined(); // not twice
  });

  it("says why there's no clip", async () => {
    expect(await mod.phraseToWav(null)).toMatchObject({ skip: "nothing recorded" });
    const { nodes } = fakeAudio();
    await mod.toneCapture.start();
    shared.audible = true;
    deliver(nodes[0], syllables(2, 0.01));
    expect((await mod.phraseToWav(mod.toneCapture.phrase(500))).skip).toBe("only Astra's voice");
  });

  it("resamples other mic rates with the browser's offline resampler", async () => {
    let made = null;
    globalThis.window = globalThis;
    globalThis.OfflineAudioContext = class {
      constructor(ch, length, rate) { made = { ch, length, rate }; this.length = length; }
      createBuffer(ch, n, rate) { return { n, rate, copyToChannel(s) { this.s = s; } }; }
      createBufferSource() { return { connect() {}, start() {} }; }
      get destination() { return {}; }
      async startRendering() { const L = this.length; return { getChannelData: () => Float32Array.from({ length: L }, (_, i) => 0.002 * Math.sin(i / 3)) }; }
    };
    const R = 48000;
    const blocks = [];
    const s = Float32Array.from({ length: R * 3 }, (_, i) => (i > R && i < 2.5 * R ? 0.003 * Math.max(0, Math.sin((2 * Math.PI * 4 * i) / R)) * Math.sin(i / 20) : 0));
    for (let i = 0; i < s.length; i += 2400) blocks.push({ samples: s.subarray(i, i + 2400), at: ((i + 2400) / R) * 1000, astra: false });
    const out = await mod.phraseToWav({ blocks, rate: R, from: 900, to: 3000, after: -Infinity });
    expect(made.rate).toBe(16000);
    expect(made.ch).toBe(1);
    expect(out.wav).toBeInstanceOf(Uint8Array);
    delete globalThis.OfflineAudioContext;
  });
});

describe("describeClip: the diagnostics line", () => {
  it("has the numbers for each stage and no audio or words", async () => {
    const { nodes } = fakeAudio();
    await mod.toneCapture.start();
    deliver(nodes[0], new Float32Array(RATE));
    deliver(nodes[0], syllables(2, 0.0021));
    deliver(nodes[0], new Float32Array(RATE / 2));
    const clip = await mod.phraseToWav(mod.toneCapture.phrase(900));
    const line = mod.describeClip(3, clip, "HTTP 200");
    expect(line).toMatch(/^\[astra\] voice tone phrase 3: clip \d+\.\d s, \d+ bytes WAV, gain \+\d+ dB/);
    expect(line).toMatch(/window \d+\.\d s @ 16000 Hz \(\d+ blocks in buffer\), Astra audible 0\.0 s/);
    expect(line).toMatch(/background 0\.\d{4} peak 0\.\d{4} \(\d+ dB\) onset 0\.\d{4} \| speech \d\.\d s in \d run\(s\) \| HTTP 200$/);
    expect(mod.describeClip(4, { skip: "only Astra's voice", blocks: 3 })).toMatch(/phrase 4: NO CLIP \(only Astra.s voice\)/);
  });
});

describe("sendClip: to this laptop's backend only", () => {
  it("posts the WAV to the same-origin API with the talk id", async () => {
    globalThis.fetch = vi.fn(async () => ({ status: 200, ok: true, json: async () => ({ label: "calm", confidence: 0.9 }) }));
    const wav = new Uint8Array([1, 2, 3]);
    const r = await mod.sendClip(1, "talk abc", wav);
    expect(r.label).toBe("calm");
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe("/api/astronauts/1/voice-tone?talk=talk%20abc"); // relative: never another host
    expect(opts).toMatchObject({ method: "POST", credentials: "same-origin", headers: { "Content-Type": "audio/wav" }, body: wav });
  });

  it("503 means the model isn't available here; other errors throw", async () => {
    globalThis.fetch = vi.fn(async () => ({ status: 503, ok: false }));
    expect(await mod.sendClip(1, "t", new Uint8Array())).toEqual({ unavailable: true });
    globalThis.fetch = vi.fn(async () => ({ status: 400, ok: false }));
    await expect(mod.sendClip(1, "t", new Uint8Array())).rejects.toThrow("400");
  });
});
