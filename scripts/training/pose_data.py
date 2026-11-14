"""Pose data: a small, license-filtered COCO 2017 val subset with human keypoint annotations.

    .venv/Scripts/python scripts/training/pose_data.py

* Annotations: person_keypoints_{val,train}2017.json, pulled out of the official
  annotations_trainval2017.zip with HTTP Range requests (only that one member is fetched,
  not the whole 241 MB archive). COCO annotations: CC BY 4.0 (COCO Consortium).
* Images: downloaded one by one from images.cocodataset.org. COCO does not own the images;
  each carries its Flickr license id. Only these are used: 4 CC BY, 5 CC BY-SA,
  7 "No known copyright restrictions", 8 "United States Government Work". Local evaluation
  only -- never redistributed, never part of the app.
* COCO's 17 keypoints are the same body points as 17 of MediaPipe Pose's 33 landmarks (same
  left/right convention: the person's own side). The other 16 MediaPipe points (mouth, eye
  corners, hands, feet) have no ground truth and aren't evaluated.
* Positives: images with exactly ONE annotated person (no crowd region), large enough to look
  like a webcam framing (person box >= 12% of the image), with >= 5 labelled keypoints.
  Negatives: images with no person annotation at all (COCO labels every person instance), to
  measure false "body found" detections.
* Val2017 alone leaves only ~150 eligible images after the license filter, so train2017 is
  used too. MediaPipe's own training data is not fully published, so an overlap with COCO
  images cannot be ruled out: treat the baseline numbers as possibly optimistic.
* COCO has no subject identities, so splits are by image (different people in almost all images).
"""
import concurrent.futures as cf
import json
import os
import sys
import zipfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

ZIP_URL = "http://images.cocodataset.org/annotations/annotations_trainval2017.zip"
SPLITS = ("val2017", "train2017")  # val alone has only ~150 eligible single-person images after the license filter
MEMBER = "annotations/person_keypoints_{}.json"
IMG_URL = "http://images.cocodataset.org/{}/{}"
RAW = os.path.join(common.TRAINING, "pose", "raw")
PROC = os.path.join(common.TRAINING, "pose", "processed")
ALLOWED_LICENSES = {4, 5, 7, 8}
N_POS, N_NEG = 600, 200
# COCO keypoint index -> MediaPipe Pose landmark index
COCO_TO_MP = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]


def fetch_annotations(split):
    out = os.path.join(RAW, f"person_keypoints_{split}.json")
    if os.path.isfile(out):
        return out
    rf = common.RemoteFile(ZIP_URL)
    with zipfile.ZipFile(rf) as z:
        info = z.getinfo(MEMBER.format(split))
        data = z.read(MEMBER.format(split))  # zipfile checks the member's CRC-32 here
    assert len(data) == info.file_size
    with open(out, "wb") as f:
        f.write(data)
    print(f"annotations: {len(data):,} bytes (fetched {rf.fetched:,} of the {rf.size:,}-byte archive), CRC ok")
    return out


def main():
    os.makedirs(os.path.join(RAW, "images"), exist_ok=True)
    os.makedirs(PROC, exist_ok=True)
    by_img, images, licenses = {}, {}, {}
    for split in SPLITS:
        with open(fetch_annotations(split), encoding="utf-8") as f:
            coco = json.load(f)
        licenses.update({l["id"]: l["name"] for l in coco["licenses"]})
        for a in coco["annotations"]:
            by_img.setdefault(a["image_id"], []).append(a)
        for im in coco["images"]:
            images[im["id"]] = {**im, "coco_split": split}  # image ids are unique across 2017 splits
        del coco
    pos, neg = [], []
    for iid, im in images.items():
        if im["license"] not in ALLOWED_LICENSES:
            continue
        anns = by_img.get(iid, [])
        if not anns:
            neg.append(iid)
            continue
        if len(anns) != 1 or anns[0]["iscrowd"]:
            continue
        a = anns[0]
        if a["num_keypoints"] < 5 or a["bbox"][2] * a["bbox"][3] < 0.12 * im["width"] * im["height"]:
            continue
        pos.append(iid)
    rng = np.random.default_rng(common.SEED)
    pos = sorted(rng.choice(sorted(pos), size=min(N_POS, len(pos)), replace=False).tolist())
    neg = sorted(rng.choice(sorted(neg), size=min(N_NEG, len(neg)), replace=False).tolist())
    print(f"eligible after license filter: {len(pos)} positives, {len(neg)} negatives chosen")

    def download(iid):
        im = images[iid]
        path = os.path.join(RAW, "images", im["file_name"])
        if not os.path.isfile(path) or os.path.getsize(path) < 1000:
            data = common.http_get(IMG_URL.format(im["coco_split"], im["file_name"]), timeout=60)
            with open(path, "wb") as f:
                f.write(data)
        return iid, path

    with cf.ThreadPoolExecutor(8) as ex:
        paths = dict(ex.map(download, pos + neg))

    samples, bad, seen = [], [], {}
    import cv2
    for iid in pos + neg:
        im = images[iid]
        path = paths[iid]
        img = cv2.imread(path)
        if img is None or img.shape[0] != im["height"] or img.shape[1] != im["width"]:
            bad.append(im["file_name"])
            continue
        digest = common.md5_of(path)
        if digest in seen:
            bad.append(im["file_name"] + " (duplicate of " + seen[digest] + ")")
            continue
        seen[digest] = im["file_name"]
        s = {"image_id": iid, "file": im["file_name"], "w": im["width"], "h": im["height"], "license": im["license"],
             "license_name": licenses[im["license"]], "flickr_url": im.get("flickr_url"), "person": iid in pos, "coco_split": im["coco_split"]}
        if s["person"]:
            a = by_img[iid][0]
            kp = np.array(a["keypoints"], dtype=float).reshape(17, 3)
            gt = np.zeros((33, 3))  # x_norm, y_norm, v (0 = no ground truth, 1 = occluded, 2 = visible)
            for ci, mi in enumerate(COCO_TO_MP):
                gt[mi] = (kp[ci, 0] / im["width"], kp[ci, 1] / im["height"], kp[ci, 2])
            s["gt"] = gt.round(5).tolist()
            s["bbox"] = a["bbox"]
            s["num_keypoints"] = a["num_keypoints"]
        samples.append(s)
    # split by image: 60% calibration/train, 20% validation, 20% untouched test
    order = rng.permutation(len(samples))
    n = len(samples)
    for rank, i in enumerate(order):
        samples[i]["split"] = "train" if rank < 0.6 * n else "val" if rank < 0.8 * n else "test"
    with open(os.path.join(PROC, "subset.json"), "w", encoding="utf-8") as f:
        json.dump({"samples": samples, "rejected": bad}, f)
    lic_counts = {}
    for s in samples:
        lic_counts[s["license_name"]] = lic_counts.get(s["license_name"], 0) + 1
    common.record("pose_coco2017_val_keypoints", {
        "name": "COCO 2017 train+val, person keypoints (license-filtered subset)",
        "source": "https://cocodataset.org (annotations_trainval2017.zip members person_keypoints_val2017.json + person_keypoints_train2017.json, fetched by HTTP range; images from images.cocodataset.org)",
        "publication": "Lin et al., 'Microsoft COCO: Common Objects in Context', ECCV 2014",
        "license": "Annotations: CC BY 4.0 (COCO Consortium). Images: owned by their Flickr authors; only license ids 4 (CC BY), 5 (CC BY-SA), 7 (no known copyright restrictions), 8 (US Government Work) kept. Local evaluation only, not redistributed.",
        "commercial_or_demo_use": "Annotations: yes with attribution. Images: CC BY / BY-SA allow it with attribution; not redistributed here.",
        "version": "2017 (train + val)",
        "downloaded": common.now_iso(),
        "samples_downloaded": len(pos) + len(neg),
        "samples_usable": len(samples),
        "positives_single_person": sum(1 for s in samples if s["person"]),
        "negatives_no_person": sum(1 for s in samples if not s["person"]),
        "rejected": bad,
        "image_licenses": lic_counts,
        "subject_ids": "none in COCO; split by image",
        "label_notes": "17 keypoints per person with visibility flag (0 not labelled, 1 labelled but occluded, 2 visible). No posture labels exist in COCO, so none are used.",
    })
    print(f"usable: {len(samples)} ({sum(1 for s in samples if s['person'])} with a person), rejected {len(bad)}")


if __name__ == "__main__":
    main()
