# Face Analysis: environment setup

This only prepares the environment for the upcoming **Face Health Analysis** module. There's no
UI, webcam or health detection yet, and nothing in the running app uses any of it. Everything
runs locally: no images or model data are sent anywhere.

Set up on 2026-11-13, on branch `feature/face-analysis-setup`.

## What's installed

It's installed into the project's existing virtual environment (`.venv`, **Python 3.14.6**,
Windows 11). No new environment was created.

| Package | Version | Why |
|---|---|---|
| `mediapipe` | 1.2.3 | Face Landmarker (MediaPipe Tasks API) |
| `opencv-contrib-python` | 5.0.0.93 | OpenCV (`import cv2`); MediaPipe's own OpenCV dependency |
| `numpy` | 2.5.4 | Already installed for the voice tone model; unchanged |

MediaPipe also pulled in these packages:

| Package | Version |
|---|---|
| `absl-py` | 2.5.1 |
| `flatbuffers` | 25.12.19 |
| `sounddevice` | 0.5.6 |
| `cffi` | 2.1.1 |
| `pycparser` | 3.12 |
| `matplotlib` | 3.11.2 |
| `contourpy` | 1.4.0 |
| `cycler` | 0.12.1 |
| `fonttools` | 4.68.0 |
| `kiwisolver` | 1.5.1 |
| `pillow` | 13.0.0 |
| `pyparsing` | 3.3.3 |
| `python-dateutil` | 4.0.0 |
| `tzdata` | 2026.6 |

Before installing, a `pip install --dry-run` confirmed that **no existing package would be
upgraded or downgraded**. After installing:
- `pip list` showed the same versions for everything that was already there: Flask 3.0.3,
  Flask-SocketIO 5.3.6, torch 2.15.0+cpu, transformers 5.22.2, numpy 2.5.4.
- `pip check` reported no broken requirements.
- The backend tests still pass.

The pinned list is in `requirements-face.txt`. `requirements.txt` was not changed.

## The model

| | |
|---|---|
| File | `models/face_analysis/face_landmarker.task` (gitignored, like all of `models/`) |
| Source | Google's official MediaPipe model storage, the file linked from the [Face Landmarker guide](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) |
| URL | `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task` |
| Version | float16, **version 1** (pinned; it was byte-identical to `latest` on 2026-11-13) |
| Size | 3,758,596 bytes |
| SHA-256 | `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff` |
| Contents | `face_detector.tflite`, `face_landmarks_detector.tflite`, `face_blendshapes.tflite`, `geometry_pipeline_metadata_landmarks.binarypb` |

`scripts/face_analysis/download_model.py` downloads it:
- **Only once:** if a valid file is already there, it does nothing.
- **Only from that official host:** the script refuses any other.
- **Safely:** the download goes to a temporary file first. It only replaces the destination after
  passing every check:
  - the size matches `Content-Length`;
  - the **MD5 matches the hash Google's storage reports** (`x-goog-hash`);
  - it's a valid zip bundle with the expected models inside.

  A failed or interrupted download leaves nothing behind. Network and HTTP errors are reported
  with exit code 1.

## Install (this machine or another one)

From the project folder, with the project's `.venv` already set up as in `README.md`:

```bash
.venv/bin/python -m pip install -r requirements-face.txt
.venv/bin/python scripts/face_analysis/download_model.py
.venv/bin/python scripts/face_analysis/verify_setup.py
```

On Windows, use `.venv\Scripts\python` instead of `.venv/bin/python`.

**Other machines:** MediaPipe 1.2.3 ships wheels for Windows (x64, ARM64), Linux (x86-64,
aarch64, glibc 2.28+) and macOS (Apple Silicon, 11+). These are `py3-none` wheels, so they don't
depend on the Python version; this setup was verified on 3.14. Linux also needs PortAudio for
`sounddevice` (`sudo apt install libportaudio2`). On Windows and macOS it's bundled.

## Verify

```bash
.venv/bin/python scripts/face_analysis/verify_setup.py
.venv/bin/python scripts/face_analysis/verify_setup.py --image path/to/photo-with-a-face.jpg
```

It reports only real results:

1. Imports MediaPipe, OpenCV and NumPy, and prints their versions.
2. Checks the model file.
3. Creates the Face Landmarker on the CPU.
4. Runs it on a blank frame and on a picture with no face (`frontend/public/models/missions/earth.jpg`).
   It must run and must find 0 faces.
5. With `--image`: reports the faces found, landmarks per face (478), blendshapes (52, top 3 shown)
   and whether a transformation matrix came back.

Result on 2026-11-13: **5/5 checks passed**. Initialisation took 132 ms; each no-face frame took
about 2 ms.

**Not tested yet: detection and landmarks on a real face.** The project has no photo with a face.
Run the second command above with one of your own photos. It stays on this computer.

## Known compatibility notes

- **One OpenCV package only.** `opencv-python`, `opencv-python-headless` and
  `opencv-contrib-python` all install the same `cv2` module and overwrite each other. MediaPipe
  depends on `opencv-contrib-python`, so that's the one used. Don't add the others.
- **OpenCV is version 5.0.** MediaPipe doesn't pin OpenCV, so pip picked the newest major version.
  It works for reading and converting images here. It's pinned in `requirements-face.txt` so a
  later 5.x or 6.x isn't picked up by surprise.
- **MediaPipe 1.x has only the Tasks API.** The old `mediapipe.solutions` (`mp.solutions.face_mesh`
  and so on) doesn't exist in this version. Use `mediapipe.tasks.python.vision.FaceLandmarker`, as
  `verify_setup.py` does.
- **Log noise.** MediaPipe prints `WARNING: Logging before InitGoogle() is written to STDERR` and a
  few TensorFlow Lite info lines when it starts. That's normal.
- **CPU only.** No GPU delegate is set up, and none is needed for single images.
- **Not used by the running app.** The backend doesn't import MediaPipe, so the app starts the same
  with or without these packages.

## Files

- `requirements-face.txt`: the optional, pinned dependencies.
- `scripts/face_analysis/download_model.py`: downloads and checks the model.
- `scripts/face_analysis/verify_setup.py`: the verification above.
- `docs/face-analysis-setup.md`: this file.
- `models/face_analysis/face_landmarker.task`: the model (not in Git).

## Phase 2: the Face Analysis feature (2026-11-13)

**Where:** the Mind page, in its own **Face Analysis** card below "Latest Conversation
Analysis". Voice tone and mood are untouched.

**How it works:**
1. **Open camera:** the browser asks for the camera. It's **video only**; the microphone is never
   requested. A mirrored live preview appears.
2. **Start analysis (12 s):** the browser sends a 640 px JPEG frame about 10 times a second to
   **this laptop's own backend** (`POST /api/astronauts/<id>/face/sessions/<sid>/frames`).
   - The backend runs MediaPipe Face Landmarker in **VIDEO mode**, with one landmarker per
     session.
   - It measures each frame, and the image is dropped immediately.
   - Live hints appear on the preview: "Move a little closer", "More light on your face",
     "Only one person in view, please", and so on.
3. **The report:** when the window ends, the report is computed, stored (numbers and text only)
   and shown. The camera is then **turned off**. *Retake* starts again. *Stop camera* turns it off
   at any time and discards the session. Leaving the page also turns it off.

**Measurements** (`backend/logic/face_metrics.py`), each with a value, a description, a
reliability (high / medium / low, or **inconclusive**), the reason for that reliability, and its
limitations:

| Observation | What's measured | Measured only when |
|---|---|---|
| Image quality and face positioning | light on the face (L\*), sharpness, face size, faces in view, frames usable | always reported |
| Eye openness | eye aspect ratio from the eyelid landmarks (about 0.3 when open), left/right difference | at least 6 s, half the frames usable |
| Eye closures (blinks) | count, rate per minute, mean and longest duration, share of time closed. "Closed" means below 55% of the person's own open level | same as above, at least 5 fps |
| Head position and movement | yaw, pitch and roll from the transformation matrix, their spread, and movement in face widths per second | same as above |
| Under-eye appearance | how much darker the skin under the eyes looks than the cheek, in L\* units | good light (L\* 30–85), sharp, frontal (±12°), not clipped, in at least 15 frames |
| Visible skin appearance | cheek and forehead L\*a\*b\* and evenness | as above, **and no colour cast** |

Blendshape scores aren't used as measurements, and no condition is ever inferred from any of this.

**Real model behaviour seen on this laptop:**
- **Speed:** about 7–8 ms per frame. Full 12 s windows run at 10 fps with 120 of 120 frames usable.
- **A real face:** eye openness 0.33–0.35; a front-facing head read as 0–3°.
- **Skin colour cast:** this room's light gave a cheek b\* of −28 to −31 (blue), so skin colour
  comes back **inconclusive** here, which is the correct result.
- **A very dark camera feed:** the model finds **no face at all**, so the report says "too dark to
  find a face" and the live hint asks for more light.
- **Two faces:** frames with more than one face are never analysed.

**Privacy:**
- Frames never leave this laptop.
- No video, images or landmarks are stored; the `face_analyses` table has numbers and text only.
- No audio is recorded.
- The camera stops when the window ends, on Stop, and when you leave the page.

**API:**
- `GET /api/face/status`: whether the model is ready, the window length and the frame rate.
- `POST /api/astronauts/<id>/face/sessions`: start an observation (self only). Returns 503 if the
  model isn't set up.
- `POST .../sessions/<sid>/frames?t=<ms>`: one JPEG (at most 1 MB and 1280 px). Returns live
  hints.
- `POST .../sessions/<sid>/finish`: the report, which is then stored.
- `POST .../sessions/<sid>/cancel`: drop the session.
- `GET /api/astronauts/<id>/face/latest`: the last report (the astronaut or the flight surgeon).

**Tests:**
- `tests/test_face_analysis.py` uses a synthetic face mesh plus the real model on blank and black
  frames. Set `ASTRO_FACE_TEST_IMAGE=<your photo>` to also run the real one-face, two-face and
  dark checks.
- `frontend/src/lib/faceCamera.test.js` and `.../mind/FaceAnalysis.test.jsx`.
- `frontend/scripts/e2e-face-analysis.mjs` is a browser test that plays your own photo as a fake
  camera, against an isolated copy only.

**Launch:**

```bash
.venv\Scripts\python app.py --wifi --wifi-host astro-cyd.local
```

Then open http://localhost:5000/mind in Chrome or Edge (the camera needs `localhost` or https).
