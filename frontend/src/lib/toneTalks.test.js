// lib/toneTalks.js: a conversation's phrases are tracked against its own id, the ones still
// being analysed when the call ends are waited for (not lost), and only then is it finished.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => []);
vi.mock("./api.js", () => ({
  post: vi.fn(async (path, body) => {
    calls.push([path, body]);
    if (path.endsWith("/voice-talks")) return { talk_id: `talk-${calls.length}` };
    if (path.endsWith("/finish")) return { status: "complete", ...body };
    return { status: "analysing" };
  }),
}));

let mod;
beforeEach(async () => {
  calls.length = 0;
  vi.resetModules();
  mod = await import("./toneTalks.js");
});
const deferred = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };

describe("toneTalks", () => {
  it("opens a conversation on the server and uses its id", async () => {
    const id = await mod.openTalk(1);
    expect(id).toBe("talk-1");
    expect(calls[0][0]).toBe("/astronauts/1/voice-talks");
  });

  it("counts each phrase's outcome against its own conversation", async () => {
    const a = await mod.openTalk(1);
    const b = await mod.openTalk(1);
    await Promise.all([
      mod.trackPhrase(a, async () => "analysed"),
      mod.trackPhrase(b, async () => "skipped"),
      mod.trackPhrase(a, async () => { throw new Error("network"); }),
    ]);
    expect(mod.talkCounts(a)).toEqual({ sent: 2, analysed: 1, skipped: 0, failed: 1, pending: 0 });
    expect(mod.talkCounts(b)).toEqual({ sent: 1, analysed: 0, skipped: 1, failed: 0, pending: 0 });
  });

  it("finishing waits for analyses still running when the call ended -- none is lost", async () => {
    const id = await mod.openTalk(1);
    const slow = deferred();
    mod.trackPhrase(id, async () => "analysed");
    mod.trackPhrase(id, () => slow.p); // still uploading when the voice screen closes
    const done = mod.finishTalk(id);
    await new Promise((r) => setTimeout(r, 0));
    // closed right away (the Mind page shows "analysing"), not finished yet
    expect(calls.map((c) => c[0].split("/").pop())).toEqual(["voice-talks", "close"]);
    expect(calls[1][1]).toEqual({ phrases_sent: 2 });
    slow.resolve("analysed");
    const final = await done;
    expect(calls.at(-1)[0]).toBe(`/astronauts/1/voice-talks/${id}/finish`);
    expect(calls.at(-1)[1]).toEqual({ phrases_sent: 2, phrases_skipped: 0, phrases_failed: 0 });
    expect(final.status).toBe("complete");
  });

  it("finish is safe to call twice", async () => {
    const id = await mod.openTalk(1);
    const [x, y] = [mod.finishTalk(id), mod.finishTalk(id)];
    expect(x).toBe(y);
    await x;
    expect(calls.filter((c) => c[0].endsWith("/finish"))).toHaveLength(1);
  });

  it("a conversation that couldn't be opened records nothing (analysis unavailable)", async () => {
    const api = await import("./api.js");
    api.post.mockImplementationOnce(async () => { const e = new Error("unavailable"); e.status = 503; throw e; });
    expect(await mod.openTalk(1)).toBeNull();
  });
});
