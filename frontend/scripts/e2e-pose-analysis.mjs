// End-to-end browser check of the Mind page's Pose Analysis, run by hand against an ISOLATED
// copy of the app (never your live app/database -- port 5000 is refused). Real here: Edge,
// getUserMedia (Chromium's fake camera playing a picture as a video), the preview, the frame
// loop, the backend, MediaPipe Pose Landmarker (VIDEO mode), the report and the database.
//
//   node scripts/e2e-pose-analysis.mjs --base http://localhost:5058 [--image <photo of one person>]
//
// Without --image it checks everything that doesn't need a person in view: the empty state,
// "no body found" in good light, "too dark", the report saved and shown after a reload, the
// camera released on finish / Stop / leaving the page, the camera handed over between Face and
// Pose Analysis, and permission errors. With --image (a 640x480-ish photo, head to hips) it
// also checks real posture measurements. Temporary fake-camera files go in the system temp
// folder and are deleted at the end. Set up the isolated copy and its test card as described at
// the top of scripts/e2e-wanna-talk.mjs (start it with ASTRO_POSE_MODEL=<repo>/models/
// pose_analysis/pose_landmarker_lite.task and ASTRO_FACE_MODEL=<repo>/models/face_analysis/
// face_landmarker.task, since the copy has no models/ folder).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const base = arg("base", "http://localhost:5058").replace(/\/$/, "");
const image = arg("image", null);
const uid = arg("uid", "A1000001");
const python = arg("python", path.resolve("..", ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"));
if (new URL(base).port === "5000") { console.error("Refusing to run against port 5000 (your live app). Use an isolated copy."); process.exit(2); }
if (image && !fs.existsSync(image)) { console.error(`--image ${image} not found`); process.exit(2); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "astro-pose-e2e-"));
execFileSync(python, ["-c", `
import cv2, numpy as np, sys
empty = cv2.resize(cv2.imread(sys.argv[2]), (640, 480))  # a well-lit picture with no person (the app's Earth texture)
frames = {"noface": empty, "dark": np.zeros((480, 640, 3), np.uint8)}
if sys.argv[3]:
    img = cv2.imread(sys.argv[3]); h, w = img.shape[:2]; s = min(640 / w, 480 / h)
    img = cv2.resize(img, (int(w * s), int(h * s)))
    canvas = np.zeros((480, 640, 3), np.uint8); y, x = (480 - img.shape[0]) // 2, (640 - img.shape[1]) // 2
    canvas[y:y + img.shape[0], x:x + img.shape[1]] = img
    frames["person"] = canvas
for name, f in frames.items():
    open(sys.argv[1] + "/" + name + ".mjpeg", "wb").write(cv2.imencode(".jpg", f, [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tobytes() * 60)
`, tmp, path.resolve("public", "models", "missions", "earth.jpg"), image || ""]);

const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`); };

const TRACK_STREAMS = () => {
  window.__streams = [];
  const orig = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
  if (orig) navigator.mediaDevices.getUserMedia = async (c) => { window.__constraints = c; const s = await orig(c); window.__streams.push(s); return s; };
};
const camsEnded = (page) => page.evaluate(() => { const cams = window.__streams.filter((st) => st.getVideoTracks().length); return cams.length > 0 && cams.every((st) => st.getTracks().every((t) => t.readyState === "ended")); });
const liveCams = (page) => page.evaluate(() => window.__streams.filter((st) => st.getVideoTracks().some((t) => t.readyState === "live")).length);

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
  const section = page.getByRole("region", { name: "Pose Analysis" });
  const face = page.getByRole("region", { name: "Face Analysis" });
  await section.getByRole("button", { name: /Open camera|Retake/ }).waitFor({ timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('[aria-label="Pose Analysis"] button[disabled]'), null, { timeout: 15000 }).catch(() => {});
  return { browser, page, section, face, errors, others };
}

async function analyse(s) {
  await s.section.getByRole("button", { name: /Open camera|Retake/ }).click();
  await s.section.getByRole("button", { name: /Start analysis/ }).waitFor({ timeout: 10000 });
  const constraints = await s.page.evaluate(() => window.__constraints);
  await s.section.getByRole("button", { name: /Start analysis/ }).click();
  await s.page.waitForTimeout(3000);
  const liveText = await s.section.getByTestId("pose-live").innerText().catch(() => "");
  await s.section.getByRole("button", { name: "Retake" }).waitFor({ timeout: 30000 });
  const released = await camsEnded(s.page);
  const report = await s.page.evaluate(async () => {
    const id = (await (await fetch("/api/auth/me")).json()).astronaut_id;
    return (await (await fetch(`/api/astronauts/${id}/pose/latest`)).json()).analysis;
  });
  return { constraints, liveText, released, report };
}
const ob = (r, id) => r.observations.find((o) => o.id === id);

try {
  // ---- no person in view, good light
  let s = await session({ video: "noface" });
  const status = await s.page.evaluate(async () => (await (await fetch("/api/pose/status")).json()).state);
  check("backend: pose model ready", status === "ready", status);
  const emptyText = await s.section.innerText();
  check("no previous report: calm empty state", /No pose analysis yet/.test(emptyText) && (await s.section.getByRole("alert").count()) === 0);
  const none = await analyse(s);
  check("camera asked for video only (no microphone)", none.constraints && none.constraints.audio === false && !!none.constraints.video);
  check("no body: live hint says so", /No body found/.test(none.liveText), none.liveText);
  check("no body: report rated 'no body', every measure inconclusive", none.report.quality.rating === "no body" && none.report.observations.every((o) => o.status === "inconclusive"),
    `${none.report.quality.frames} frames @ ${none.report.quality.fps} fps`);
  check("report carries the model, disclaimer and limitations", /Pose Landmarker lite/.test(none.report.model) && /not a medical assessment/.test(none.report.disclaimer) && none.report.limitations.length > 0);
  check("camera released when the window ended", none.released);
  await s.page.reload();
  await s.section.getByTestId("pose-quality").waitFor({ timeout: 10000 });
  check("report shown after a page reload (from the database)", /No body found/.test(await s.section.getByTestId("pose-quality").innerText()));
  check("disclaimer shown under the report", /not a medical assessment/.test(await s.section.getByTestId("pose-disclaimer").innerText()));
  // Stop mid-window
  await s.section.getByRole("button", { name: /Open camera|Retake/ }).click();
  await s.section.getByRole("button", { name: /Start analysis/ }).waitFor({ timeout: 10000 });
  await s.section.getByRole("button", { name: /Start analysis/ }).click();
  await s.page.waitForTimeout(1500);
  await s.section.getByRole("button", { name: "Stop camera" }).click();
  await s.page.waitForTimeout(800);
  check("Stop camera mid-analysis releases the camera", await camsEnded(s.page));
  const sessionsLeft = await s.page.evaluate(async () => (await (await fetch("/api/pose/status")).json()));
  check("pose status still answers after a cancelled session", sessionsLeft.state === "ready");
  // Face <-> Pose hand-over: only one camera stream live at a time
  await s.face.getByRole("button", { name: /Open camera|Retake/ }).click();
  await s.face.getByRole("button", { name: /Start analysis/ }).waitFor({ timeout: 10000 });
  await s.section.getByRole("button", { name: /Open camera|Retake/ }).click();
  await s.section.getByRole("button", { name: /Start analysis/ }).waitFor({ timeout: 10000 });
  await s.page.waitForTimeout(500);
  const faceButtons = await s.face.getByRole("button", { name: /Open camera|Retake/ }).count();
  check("opening Pose's camera releases Face's (one camera stream live)", (await liveCams(s.page)) === 1 && faceButtons === 1, `live camera streams: ${await liveCams(s.page)}`);
  await s.face.getByRole("button", { name: /Open camera|Retake/ }).click();
  await s.face.getByRole("button", { name: /Start analysis/ }).waitFor({ timeout: 10000 });
  await s.page.waitForTimeout(500);
  check("and the other way round (Face takes it back from Pose)", (await liveCams(s.page)) === 1 && (await s.section.getByRole("button", { name: /Open camera|Retake/ }).count()) === 1);
  // leaving the page
  await s.page.getByRole("link", { name: /Today/ }).first().click().catch(async () => { await s.page.goto(base + "/today"); });
  await s.page.waitForTimeout(1000);
  check("leaving the Mind page releases the camera", (await liveCams(s.page)) === 0);
  check("no request left this laptop", s.others.length === 0, s.others.slice(0, 2).join(", "));
  check("no page errors", s.errors.length === 0, s.errors.join(" | "));
  await s.browser.close();

  // ---- too dark
  s = await session({ video: "dark" });
  const dark = await analyse(s);
  check("too dark: rated poor, live hint asks for light", dark.report.quality.rating === "poor" && /light/i.test(dark.liveText), `${dark.report.quality.issues.join(", ")} | ${dark.liveText}`);
  await s.browser.close();

  // ---- a real person (optional)
  if (image) {
    s = await session({ video: "person" });
    const p = await analyse(s);
    check("person: body found live", /Body found|Step back|closer|centre|light/i.test(p.liveText), p.liveText);
    check("person: frames usable", p.report.quality.usable_frames > 50, `${p.report.quality.usable_frames}/${p.report.quality.frames}, quality ${p.report.quality.rating}`);
    check("person: shoulder alignment measured", ob(p.report, "shoulder_alignment").status === "measured", ob(p.report, "shoulder_alignment").display);
    check("person: movement measured", ob(p.report, "movement").status === "measured", ob(p.report, "movement").display);
    await s.browser.close();
  } else {
    console.log("SKIP  real person in view (give --image <photo of one person, head to hips>)");
  }

  // ---- permission denied, camera missing
  for (const [failWith, expect] of [["NotAllowedError", /permission was denied/], ["NotFoundError", /No camera was found/]]) {
    s = await session({ video: "noface", failWith });
    await s.section.getByRole("button", { name: "Open camera" }).click();
    const alert = s.section.getByRole("alert");
    await alert.waitFor({ timeout: 5000 });
    check(`${failWith}: clear message, no crash`, expect.test(await alert.innerText()) && s.errors.length === 0, await alert.innerText());
    await s.browser.close();
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed (temporary camera files deleted)`);
process.exit(results.every(Boolean) ? 0 : 1);
