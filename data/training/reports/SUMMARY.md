# Astro Health — dataset research and CPU training: results (2026-11-14)

Everything ran locally on the CPU (Intel Core 7 240H, 4 torch threads). No recording or photo
of the user was read, nothing was uploaded, and the three production models are byte-identical
before and after (SHA-256 in `../MANIFEST.json`). **Nothing was deployed into the app.**
Scripts: `scripts/training/`. Datasets, sources and licenses: `../MANIFEST.json`. Detailed
numbers (confusion matrices, per-class tables, failure cases, training logs): the JSON files in
this folder. Trained candidates: `models/candidates/` (gitignored, plain numpy weights).

Every metric below is on an untouched test split. A "trained additional classifier" is a new
small model on top of a frozen production model; the production models themselves were never
fine-tuned or changed.

## Voice — candidate improves Italian, **regresses English: not ready**

| | |
|---|---|
| Dataset | Emozionalmente (Zenodo 10.5281/zenodo.12616095), CC BY 4.0, Italian, 431 amateur actors |
| Why | The production model was trained on RAVDESS, TESS, CREMA-D and SAVEE (its model card), so none of those can test it fairly |
| Downloaded / usable | 6,902 clips (559 MB, MD5 matches Zenodo) / 6,900 (2 outside 1–15 s); 4,985 selected |
| Splits | Official speaker-independent split, verified: no speaker in two splits. Train 2,450 (350/class subset, 249 speakers), dev 1,201 (69), test 1,334 (88) |
| Label quality | 5 human raters per clip; mean agreement with the intended emotion 66% (disgust 52%, fear 54%, neutral 84%) |
| Preprocessing | WAV read from the verified zip in memory; format/duration/silence/duplicate checks; the production feature extractor; one forward pass saves the 7 production logits and frozen features (23.9 min, 288 ms/clip) |
| Training | Logistic regression on the model's layer-8 average (768-d), class-weighted, batch 32, early stopping on dev macro-F1 (30 epochs, 0.9 s). 4 heads compared; selected on dev only |

Six shared labels (angry, disgust, fearful, happy, sad, surprised):

| Test set | Production model (6 labels) | New head | Gain, 95% CI by speaker |
|---|---|---|---|
| Emozionalmente, all test speakers (1,131 clips, 84 speakers) | macro-F1 0.500, acc 0.508 | **0.638**, acc 0.640 | +0.098 … +0.187 |
| Same, clips 3+ of 5 raters agreed on (746) | 0.541 | **0.714** | +0.128 … +0.225 |
| **English regression check**: CREMA-D, 10 actors (699 clips) | 0.844* | **0.744** | **−0.138 … −0.064** |

\* Optimistic: CREMA-D was in the production model's training data. The head never saw it.

- Per speaker on Emozionalmente: 51 speakers better, 14 worse; median per-speaker accuracy
  0.44 → 0.60.
- The production model mostly mislabels anger as happy (64 of 199) and disgust or fear as sad;
  it said "calm" for 66 of these test clips and for 95 of 203 neutral ones.
- **Verdict: not ready for integration.** The head learned Italian acted speech and made English
  worse in every emotion. A fair English test set with a clear license, one the production model
  never saw, wasn't found without registration; that is what's needed before any voice change.
- Limits: acted emotions, not real feelings; nothing here says anything about health or mood.

## Face — eyeBlink score beats the app's eye-closure rule on this data; **trial only**

| | |
|---|---|
| Dataset | Open and Closed Eyes Dataset (huggingface.co/datasets/MichalMlodawski/closed-open-eyes), ODC-BY |
| Why | Face Analysis's per-frame decision is "eyes closed?"; this labels whole faces open/closed. FER-2013 rejected: unclear license, and Face Analysis deliberately does not classify expressions |
| Downloaded / usable | 1,600 (balanced random sample from 36 of 40 random offsets; 4 skipped after API errors) / 1,599 with a face found |
| Quality checks | No exact or near duplicates (dHash ≤ 4 bits, grouped across splits anyway); 24-image visual check: all labels right, ~3 "closed" are downcast eyes |
| Splits | 60/20/20 by near-duplicate group (no subject ids: AI-generated faces). Test 320 |
| Training | Thresholds tuned on train; logistic and 16-unit MLP on 13 Face Landmarker outputs (EAR + 8 eye blendshapes + pitch/yaw), early stopping on val; 1–3 s |

| Method (test, 320 images) | macro-F1 | closed recall | closed precision | Gain vs baseline, 95% CI |
|---|---|---|---|---|
| App's rule: EAR < 0.55 × 0.31 (user's measured open level) | 0.952 | 0.895 | 1.000 | — |
| A. tuned EAR threshold (0.216) | 0.962 | 0.930 | 0.985 | −0.006 … +0.029 |
| **B. MediaPipe's eyeBlink score ≥ 0.216 (selected on val; no training)** | **0.991** | **0.979** | **1.000** | **+0.019 … +0.063** |
| C. logistic on landmarker outputs | 0.987 | 0.979 | 0.993 | +0.016 … +0.058 |
| D. MLP-16 | 0.978 | 0.951 | 1.000 | +0.010 … +0.045 |

- Baseline failures: 15 closed-eye images with EAR 0.17–0.32 (partly closed or downcast); B fixes
  12 of them and adds no false "closed".
- The eyeBlink score comes from the same `face_landmarker.task`; the app turns blendshapes off
  today, so using it means switching them on (no new model).
- **Verdict: promising, not ready to replace the rule.** The images are AI-generated stills; the
  app's rule is relative to each person's own open level over 12 s of video, which this test
  can't reproduce. Next: add eyeBlink as a second signal behind a flag and compare on real webcam
  sessions.

## Pose — no trained candidate passes; a precision finding instead

| | |
|---|---|
| Dataset | COCO 2017 person keypoints: annotations CC BY 4.0; images kept only with CC BY, CC BY-SA, "no known copyright" or US Gov licenses |
| Download | Only the two keypoint JSON members, pulled from the 241 MB zip by HTTP range (72 MB fetched, CRC checked) + 800 images (400 MB incl. JSON) |
| Usable | 800: 600 single-person (person box ≥ 12% of the image), 200 with no person |
| Conversion | COCO's 17 keypoints = 17 of MediaPipe's 33 landmarks (same left/right convention); the other 16 have no ground truth |
| Splits | By image (no subject ids), 60/20/20; test 104 people with a body found |
| Candidates | Tuned visibility threshold and a logistic gate for "both shoulders/hips in view" |

- **Body found** (app's model, 640 px): 87.7% of single-person images; a body was wrongly found in
  7.0% of person-free images (14/200).
- **Shoulder gate**: 102 of 104 test people had both shoulders in view, so the test can't
  separate gates; no candidate is better than the baseline.
- **Hip gate**: baseline accepts hips that aren't in view in 9 of 86 accepted images; logistic gate
  macro-F1 0.856 → 0.876, but CI −0.027 … +0.073 includes zero: **not an improvement**.
- **Tilt precision** (no training): MediaPipe vs COCO shoulder tilt, per frame — front-facing
  people median error 3.5° (30% within 2°, 61% within 5°); angled people 6.2°. MediaPipe's
  visibility doesn't predict it. The app's "about level" wording uses 2°, finer than one frame can
  support; the 12 s median helps with jitter but not bias. **Suggested:** treat under ~5° as level
  and present tilt as approximate (not applied).
- No posture labels exist in COCO, and none were invented. Limits: stills in IMAGE mode (the app
  uses VIDEO mode); MediaPipe's training data isn't fully published, so overlap with COCO can't be
  ruled out.

## Rollback

Nothing in the app was changed by this work. To discard it: delete `scripts/training/`,
`data/training/` and `models/candidates/`.
