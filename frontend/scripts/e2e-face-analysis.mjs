// End-to-end browser check of the Mind page's Face Analysis, run by hand against an ISOLATED
// copy of the app (never your live app/database -- port 5000 is refused). Real here: Edge,
// getUserMedia (Chromium's fake camera playing YOUR photo as a video), the preview, the frame
// loop, the backend, MediaPipe Face Landmarker (VIDEO mode), the report and the database.
//
//   node scripts/e2e-face-analysis.mjs --base http://localhost:5057 --image <photo with one face>
//
// The photo is turned into temporary fake-camera videos (normal, dark, two faces) in the
// system temp folder and deleted at the end; it is never uploaded or kept. Set up the isolated
// copy and its test card as described at the top of scripts/e2e-wanna-talk.mjs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const base = arg("base", "http://localhost:5057").replace(/\/$/, "");
const image = arg("image", null);
const uid = arg("uid", "A1000001");
const python = arg("python", path.resolve("..", ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"));
if (new URL(base).port === "5000") { console.error("Refusing to run against port 5000 (your live app). Use an isolated copy."); process.exit(2); }
if (!image || !fs.existsSync(image)) { console.error("Give --image <a photo with one face> (it stays on this computer)."); process.exit(2); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "astro-face-e2e-"));
// MJPEG fake-camera files (concatenated JPEG frames), made with the project's own OpenCV
execFileSync(python, ["-c", `
import cv2, numpy as np, sys
img = cv2.imread(sys.argv[1]); h, w = img.shape[:2]; s = 640 / w
img = cv2.resize(img, (640, int(h * s)))
canvas = np.zeros((480, 640, 3), np.uint8); y = max(0, (480 - img.shape[0]) // 2); crop = img[:480]
canvas[y:y + crop.shape[0]] = crop
half = canvas[:, 80:400]
empty = cv2.resize(cv2.imread(sys.argv[3]), (640, 480))  # a well-lit picture with no face (the app's Earth texture)
for name, f in (("normal", canvas), ("dark", (canvas * 0.25).astype(np.uint8)), ("two", np.hstack([half, half])), ("noface", empty)):
    jpg = cv2.imencode(".jpg", f, [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tobytes()
    open(sys.argv[2] + "/" + name + ".mjpeg", "wb").write(jpg * 60)
`, image, tmp, path.resolve("public", "models", "missions", "earth.jpg")]);

const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// records every media stream the page opens, so we can prove the CAMERA was released (Astra's
// own wake-word microphone is a separate audio-only stream and isn't the camera's business)
const TRACK_STREAMS = () => {
  window.__streams = [];
  const orig = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
  if (orig) navigator.mediaDevices.getUserMedia = async (c) => { window.__constraints = c; const s = await orig(c); window.__streams.push(s); return s; };
};

async function session({ video, permission = true, failWith = null }) {
  const args = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"];
  if (video) args.push(`--use-file-for-fake-video-capture=${path.join(tmp, video + ".mjpeg")}`);
  const browser = await chromium.launch({ channel: "msedge", headless: true, args: permission ? args : ["--use-fake-device-for-media-stream"] });
  const ctx = await browser.newContext({ permissions: permission ? ["camera"] : [], viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(TRACK_STREAMS);
  if (failWith) await ctx.addInitScript((n) => { navigator.mediaDevices.getUserMedia = async () => { const e = new Error(n); e.name = n; throw e; }; }, failWith);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const others = [];
  page.on("request", (r) => { const u = new URL(r.url()); if (u.host !== new URL(base).host && !u.protocol.startsWith("data") && !u.protocol.startsWith("blob")) others.push(r.url()); });
  await page.goto(base + "/");
  const st = await page.evaluate(async (u) => (await fetch("/api/auth/nfc_login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uid: u }) })).status, uid);
  if (st !== 200) throw new Error(`login failed (${st}): add the test card to the isolated database`);
  await page.goto(base + "/mind");
  const section = page.getByRole("region", { name: "Face Analysis" });
  await section.getByRole("button", { name: /Open camera|Retake/ }).waitFor({ timeout: 15000 });
  return { browser, page, section, errors, others };
}

async function analyse(s) {
  await s.section.getByRole("button", { name: /Open camera|Retake/ }).click();
  await s.section.getByRole("button", { name: /Start analysis/ }).waitFor({ timeout: 10000 });
  const constraints = await s.page.evaluate(() => window.__constraints);
  await s.section.getByRole("button", { name: /Start analysis/ }).click();
  await s.page.waitForTimeout(3000);
  const liveText = await s.section.getByTestId("face-live").innerText().catch(() => "");
  await s.section.getByRole("button", { name: "Retake" }).waitFor({ timeout: 30000 });
  const released = await s.page.evaluate(() => { const cams = window.__streams.filter((st) => st.getVideoTracks().length); return cams.length > 0 && cams.every((st) => st.getTracks().every((t) => t.readyState === "ended")); });
  const camHasNoAudio = await s.page.evaluate(() => window.__streams.filter((st) => st.getVideoTracks().length).every((st) => st.getAudioTracks().length === 0));
  const report = (await s.page.evaluate(async () => (await (await fetch("/api/auth/me")).json()).astronaut_id).then((id) => s.page.evaluate(async (i) => (await (await fetch(`/api/astronauts/${i}/face/latest`)).json()).analysis, id)));
  return { constraints, liveText, released, camHasNoAudio, report };
}
const ob = (r, id) => r.observations.find((o) => o.id === id);

try {
  // ---- a real face
  let s = await session({ video: "normal" });
  const ok = await analyse(s);
  check("camera asked for video only (no microphone)", ok.constraints && ok.constraints.audio === false && !!ok.constraints.video);
  check("live preview feedback while analysing", ok.liveText.length > 0, ok.liveText);
  check("report: one face, frames usable", ok.report.quality.usable_frames > 50, `${ok.report.quality.usable_frames}/${ok.report.quality.frames} @ ${ok.report.quality.fps} fps, quality ${ok.report.quality.rating}`);
  check("eye openness measured from real landmarks", ob(ok.report, "eye_openness").status === "measured", ob(ok.report, "eye_openness").display);
  check("head position measured", ob(ok.report, "head_movement").status === "measured", ob(ok.report, "head_movement").display);
  check("every observation has a reliability and limitations", ok.report.observations.every((o) => o.reliability && o.limitations.length));
  check("camera released when the window ended", ok.released);
  check("the camera stream carries no audio", ok.camHasNoAudio);
  await s.page.reload();
  await s.section.getByTestId("face-quality").waitFor({ timeout: 10000 });
  check("report still shown after a page reload", (await s.section.getByTestId("face-quality").innerText()).includes("Image quality"));
  check("no request left this laptop", s.others.length === 0, s.others.slice(0, 2).join(", "));
  check("no page errors", s.errors.length === 0, s.errors.join(" | "));
  // stop mid-window releases the camera too
  await s.section.getByRole("button", { name: /Open camera|Retake/ }).click();
  await s.section.getByRole("button", { name: /Start analysis/ }).waitFor({ timeout: 10000 });
  await s.section.getByRole("button", { name: /Start analysis/ }).click();
  await s.page.waitForTimeout(1500);
  await s.section.getByRole("button", { name: "Stop camera" }).click();
  await s.page.waitForTimeout(800);
  check("Stop camera mid-analysis releases the camera", await s.page.evaluate(() => window.__streams.filter((st) => st.getVideoTracks().length).every((st) => st.getTracks().every((t) => t.readyState === "ended"))));
  await s.browser.close();

  // ---- poor lighting
  s = await session({ video: "dark" });
  const dark = await analyse(s);
  check("poor lighting: rated poor, measures inconclusive", dark.report.quality.rating === "poor" && ob(dark.report, "eye_openness").status === "inconclusive", `${dark.report.quality.issues.join(", ")} | ${ob(dark.report, "eye_openness").reliability_reason}`);
  check("poor lighting: the live hint asks for light", /light/i.test(dark.liveText), dark.liveText);
  await s.browser.close();

  // ---- two faces
  s = await session({ video: "two" });
  const two = await analyse(s);
  check("two faces: not analysed, reported", two.report.quality.multi_face_frames > 0 && ob(two.report, "eye_openness").status === "inconclusive", two.liveText);
  await s.browser.close();

  // ---- no face, in good light (Chromium's own test pattern is nearly black: "too dark" there is right)
  s = await session({ video: "noface" });
  const none = await analyse(s);
  check("no face: reported as no face", none.report.quality.rating === "no face", none.liveText);
  await s.browser.close();

  // ---- permission denied, camera missing
  for (const [failWith, expect] of [["NotAllowedError", /permission was denied/], ["NotFoundError", /No camera was found/]]) {
    s = await session({ video: "normal", failWith });
    await s.section.getByRole("button", { name: "Open camera" }).click();
    const alert = s.section.getByRole("alert");
    await alert.waitFor({ timeout: 5000 });
    check(`${failWith}: clear message, no crash`, expect.test(await alert.innerText()) && s.errors.length === 0, await alert.innerText());
    await s.browser.close();
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true }); // the fake-camera videos made from your photo
}
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed (temporary camera files deleted)`);
process.exit(results.every(Boolean) ? 0 : 1);
