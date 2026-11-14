"""Face data: a balanced random subset of 'Open and Closed Eyes Dataset' (ODC-BY).

    .venv/Scripts/python scripts/training/face_data.py

Why this dataset: the app's Face Analysis does not classify expressions; its main per-frame
decision is whether the eyes are closed (eye closures / blinks, from Face Landmarker's eyelid
landmarks). This dataset labels whole-face images as open_eyes / closed_eyes, which is that
exact decision, and its license (Open Data Commons Attribution) is clear.

FER-2013 (the suggested starting point) was NOT used: it has no clear license (web-scraped
images; secondary sources disagree), and expression classification is deliberately not part of
Face Analysis (backend/logic/face_metrics.py never infers mood).

Big caveat, carried into every report: the images are AI-generated, so results may not transfer
to real webcam frames, and the labels come from the generator, not human annotation (checked:
a sample is reviewed, and every image the model can't find a face in is counted).

Rows are fetched from Hugging Face's public datasets-server (no login, no gated access), at
random offsets across the whole dataset, then balanced. Images are kept local only.
"""
import concurrent.futures as cf
import json
import os
import sys
import urllib.parse

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

DATASET = "MichalMlodawski/closed-open-eyes"
ROWS_API = "https://datasets-server.huggingface.co/rows?dataset={}&config=default&split=train&offset={}&length=100"
RAW = os.path.join(common.TRAINING, "face", "raw")
PROC = os.path.join(common.TRAINING, "face", "processed")
TOTAL_ROWS = 126560
N_OFFSETS = 40
PER_CLASS = 800


def dhash(gray):
    import cv2
    small = cv2.resize(gray, (9, 8), interpolation=cv2.INTER_AREA)
    bits = (small[:, 1:] > small[:, :-1]).flatten()
    return int("".join("1" if b else "0" for b in bits), 2)


def main():
    import cv2
    os.makedirs(os.path.join(RAW, "images"), exist_ok=True)
    os.makedirs(PROC, exist_ok=True)
    rng = np.random.default_rng(common.SEED)
    offsets = sorted(rng.choice(TOTAL_ROWS // 100, size=N_OFFSETS, replace=False) * 100)
    meta = []
    import time
    skipped = []
    for off in offsets:
        d = None
        for attempt in range(3):  # the public API sometimes answers 500; retry gently, then skip
            try:
                d = json.loads(common.http_get(ROWS_API.format(urllib.parse.quote(DATASET, safe=""), int(off)), timeout=60))
                break
            except Exception:  # noqa: BLE001
                time.sleep(3 * (attempt + 1))
        if d is None:
            skipped.append(int(off))
            continue
        for r in d["rows"]:
            row = r["row"]
            meta.append({"row": r["row_idx"], "label": row["Label"], "left_eye": row["Left_eye_react"], "right_eye": row["Right_eye_react"],
                         "url": row["Image_data"]["file"]["src"], "filename": row["Image_data"].get("filename")})
    by = {"open_eyes": [m for m in meta if m["label"] == "open_eyes"], "closed_eyes": [m for m in meta if m["label"] == "closed_eyes"]}
    print({k: len(v) for k, v in by.items()}, "rows fetched from", len(offsets) - len(skipped), "offsets; skipped", skipped)
    chosen = []
    for k, v in by.items():
        idx = rng.choice(len(v), size=min(PER_CLASS, len(v)), replace=False)
        chosen += [v[i] for i in sorted(idx)]

    def download(m):
        path = os.path.join(RAW, "images", f"{m['row']:06d}.jpg")
        if not os.path.isfile(path):
            data = common.http_get(m["url"], timeout=60)
            with open(path, "wb") as f:
                f.write(data)
        return m["row"], path

    with cf.ThreadPoolExecutor(8) as ex:
        paths = dict(ex.map(download, chosen))
    samples, rejected, exact, hashes = [], [], {}, []
    for m in chosen:
        path = paths[m["row"]]
        img = cv2.imread(path)
        if img is None:
            rejected.append({"row": m["row"], "reason": "unreadable"})
            continue
        md5 = common.md5_of(path)
        if md5 in exact:
            rejected.append({"row": m["row"], "reason": f"exact duplicate of row {exact[md5]}"})
            continue
        exact[md5] = m["row"]
        h = dhash(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY))
        samples.append({"row": m["row"], "file": os.path.basename(path), "label": m["label"], "w": img.shape[1], "h": img.shape[0],
                        "left_eye": m["left_eye"], "right_eye": m["right_eye"], "dhash": h})
        hashes.append(h)
    # near-duplicate groups (Hamming distance <= 4 on a 64-bit dHash) stay in one split
    parent = list(range(len(samples)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    near_pairs = 0
    for i in range(len(samples)):
        for j in range(i + 1, len(samples)):
            if bin(hashes[i] ^ hashes[j]).count("1") <= 4:
                near_pairs += 1
                parent[find(i)] = find(j)
    groups = {}
    for i in range(len(samples)):
        groups.setdefault(find(i), []).append(i)
    group_ids = list(groups)
    order = rng.permutation(len(group_ids))
    n = len(samples)
    count = 0
    for rank in order:
        members = groups[group_ids[rank]]
        split = "train" if count < 0.6 * n else "val" if count < 0.8 * n else "test"
        for i in members:
            samples[i]["split"] = split
            samples[i]["group"] = int(group_ids[rank])
        count += len(members)
    with open(os.path.join(PROC, "subset.json"), "w", encoding="utf-8") as f:
        json.dump({"samples": samples, "rejected": rejected}, f)
    from collections import Counter
    per_split = {s: dict(Counter(x["label"] for x in samples if x["split"] == s)) for s in ("train", "val", "test")}
    common.record("face_open_closed_eyes", {
        "name": "Open and Closed Eyes Dataset (balanced random subset)",
        "source": f"https://huggingface.co/datasets/{DATASET} (rows via datasets-server.huggingface.co)",
        "publication": "Dataset card only (Michał Młodawski, HF DOI 10.57967/hf/2745); no paper",
        "license": "ODC-BY (Open Data Commons Attribution License), per the dataset card",
        "commercial_or_demo_use": "allowed with attribution",
        "version": "HF main revision 2ce8f332f80203a7b7d6a9b5323cd21d8a510b15 (datasets-server cache)",
        "downloaded": common.now_iso(),
        "samples_downloaded": len(chosen),
        "samples_usable": len(samples),
        "rejected": rejected,
        "near_duplicate_pairs": near_pairs,
        "per_split": per_split,
        "subject_ids": "none: AI-generated faces; near-duplicates (dHash <= 4 bits) grouped so they never cross splits",
        "label_notes": "open_eyes / closed_eyes from the generator, with eye bounding boxes; not human-verified",
        "caveats": ["AI-generated images, not real webcam frames", "labels not human-annotated"],
        "not_used": {"FER-2013": "no clear license; expression classification is outside Face Analysis by design"},
    })
    print(f"usable {len(samples)}, rejected {len(rejected)}, near-duplicate pairs {near_pairs}", per_split)


if __name__ == "__main__":
    main()
