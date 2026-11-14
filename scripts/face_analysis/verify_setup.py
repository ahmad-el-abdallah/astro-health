"""Check the Face Analysis environment, with real results only.

    .venv/bin/python scripts/face_analysis/verify_setup.py                     (Windows: .venv\\Scripts\\python)
    .venv/bin/python scripts/face_analysis/verify_setup.py --image photo.jpg   (a photo with a face)

1. imports MediaPipe, OpenCV and NumPy and prints their versions;
2. checks models/face_analysis/face_landmarker.task (scripts/face_analysis/download_model.py);
3. creates a MediaPipe Face Landmarker from it, on the CPU;
4. runs it on a blank frame and on a picture known to have no face (the app's own Earth
   texture) -- the pipeline must run and must find 0 faces;
5. with --image: runs it on your photo and reports the faces, landmarks (478 per face) and
   blendshapes (52) it found. Without one, image-based face detection stays UNTESTED, and the
   script says so.

Everything runs locally; no image or model data leaves this computer. Exit code 0 only when
every check that ran passed.
"""
import argparse
import os
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MODEL_PATH = os.path.join(REPO, "models", "face_analysis", "face_landmarker.task")
NO_FACE_IMAGE = os.path.join(REPO, "frontend", "public", "models", "missions", "earth.jpg")

results = []


def report(name, ok, detail=""):
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  -- {detail}" if detail else ""))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--image", action="append", default=[], help="a photo with a face (repeatable)")
    args = ap.parse_args()

    # 1. imports
    try:
        import cv2
        import mediapipe as mp
        import numpy as np
        from mediapipe.tasks import python as mp_tasks
        from mediapipe.tasks.python import vision
    except ImportError as e:
        report("import mediapipe / opencv / numpy", False, f"{e} -- see docs/face-analysis-setup.md")
        return 1
    report("import mediapipe / opencv / numpy", True,
           f"python {sys.version.split()[0]}, mediapipe {mp.__version__}, opencv {cv2.__version__}, numpy {np.__version__}")

    # 2. the model file
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from download_model import check
    ok, msg = check(MODEL_PATH)
    report("model file", ok, f"{MODEL_PATH}: {msg}" + ("" if ok else " -- run scripts/face_analysis/download_model.py"))
    if not ok:
        return 1

    # 3. create the landmarker
    options = vision.FaceLandmarkerOptions(
        base_options=mp_tasks.BaseOptions(model_asset_path=MODEL_PATH),
        running_mode=vision.RunningMode.IMAGE,
        num_faces=2,
        output_face_blendshapes=True,
        output_facial_transformation_matrixes=True,
    )
    t0 = time.perf_counter()
    try:
        landmarker = vision.FaceLandmarker.create_from_options(options)
    except Exception as e:  # noqa: BLE001 -- report whatever MediaPipe raises
        report("Face Landmarker initialises", False, f"{type(e).__name__}: {e}")
        return 1
    report("Face Landmarker initialises", True, f"{(time.perf_counter() - t0) * 1000:.0f} ms, CPU")

    def detect(rgb):
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))
        t = time.perf_counter()
        res = landmarker.detect(image)
        return res, (time.perf_counter() - t) * 1000

    with landmarker:
        # 4. negative checks: the pipeline runs, and doesn't invent faces
        res, ms = detect(np.zeros((480, 640, 3), dtype=np.uint8))
        report("runs on a blank frame, finds no face", len(res.face_landmarks) == 0, f"{len(res.face_landmarks)} face(s), {ms:.0f} ms")
        bgr = cv2.imread(NO_FACE_IMAGE) if os.path.isfile(NO_FACE_IMAGE) else None
        if bgr is None:
            print(f"skip  no-face picture not found ({NO_FACE_IMAGE})")
        else:
            res, ms = detect(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
            report("runs on a picture with no face (Earth texture), finds none", len(res.face_landmarks) == 0,
                   f"{bgr.shape[1]}x{bgr.shape[0]}, {len(res.face_landmarks)} face(s), {ms:.0f} ms")

        # 5. real faces, only with a real photo
        if not args.image:
            print("UNTESTED  face detection and landmark extraction on a real face: no photo given "
                  "(run again with --image <photo with a face>)")
        for path in args.image:
            bgr = cv2.imread(path)
            if bgr is None:
                report(f"read {path}", False, "OpenCV couldn't read it as an image")
                continue
            res, ms = detect(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
            faces = len(res.face_landmarks)
            detail = f"{bgr.shape[1]}x{bgr.shape[0]}, {faces} face(s), {ms:.0f} ms"
            if faces:
                lm = res.face_landmarks[0]
                bs = res.face_blendshapes[0] if res.face_blendshapes else []
                top = sorted(bs, key=lambda c: c.score, reverse=True)[:3]
                detail += (f"; face 1: {len(lm)} landmarks, {len(bs)} blendshapes"
                           f" (top: {', '.join(f'{c.category_name} {c.score:.2f}' for c in top)})"
                           f", transformation matrix {'yes' if res.facial_transformation_matrixes else 'no'}")
            report(f"finds a face with landmarks in {os.path.basename(path)}", faces > 0 and len(res.face_landmarks[0]) == 478, detail)

    print(f"\n{sum(results)}/{len(results)} checks passed")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
