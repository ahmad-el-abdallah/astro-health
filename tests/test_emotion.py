"""Voice tone estimates ("Wanna talk?"): backend/services/emotion.py and the /voice-tone routes.

Most tests use a fake predictor, so they run without torch/transformers or the model files.
test_real_model_* load the real pinned model and are skipped when it isn't installed.
"""
import argparse
import io
import json
import math
import os
import subprocess
import sys
import wave

import pytest

from backend import db
from backend.services import emotion

AHMAD_UID = "9B:25:0F:54"     # astronaut 1 (backend/seed.py)
SAMEER_UID = "2B:ED:20:54"    # astronaut 2
SURGEON_UID = "D1000001"


def make_wav(seconds=2.0, rate=16000, channels=1, width=2, freq=220.0):
    frames = int(seconds * rate)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(width)
        w.setframerate(rate)
        peak = 2 ** (8 * width - 1) - 1
        data = bytearray()
        for i in range(frames):
            v = int(0.3 * peak * math.sin(2 * math.pi * freq * i / rate))
            sample = (v + 128 if width == 1 else v).to_bytes(width, "little", signed=width != 1)
            data += sample * channels
        w.writeframes(bytes(data))
    return buf.getvalue()


FAKE_SCORES = {"angry": 0.02, "calm": 0.71, "disgust": 0.01, "fearful": 0.03, "happy": 0.15, "sad": 0.06, "surprised": 0.02}


@pytest.fixture()
def fake_model(monkeypatch):
    """The model 'loaded', with a fixed answer -- no torch needed."""
    calls = []

    def fake_predict(samples):
        calls.append(len(samples))
        return dict(FAKE_SCORES)

    monkeypatch.setattr(emotion, "_predict_samples", fake_predict)
    monkeypatch.setitem(emotion._state, "state", "ready")
    monkeypatch.setitem(emotion._state, "reason", "")
    return calls


# ---------------------------------------------------------------- the WAV gate (no model)

def test_decode_wav_accepts_16k_mono_16bit():
    samples = emotion.decode_wav(make_wav(2.0))
    assert len(samples) == 32000
    assert max(samples) <= 1.0 and min(samples) >= -1.0
    assert max(samples) > 0.25  # 0.3 amplitude survived the int16 round trip


@pytest.mark.parametrize("kwargs, msg", [
    ({"rate": 48000}, "48000 Hz"),
    ({"channels": 2}, "2 channel"),
    ({"width": 1}, "8-bit"),
    ({"seconds": 0.5}, "too short"),
    ({"seconds": 16.0}, "too long"),
])
def test_decode_wav_rejects_other_formats_and_lengths(kwargs, msg):
    with pytest.raises(emotion.ToneError, match=msg):
        emotion.decode_wav(make_wav(**kwargs))


def test_decode_wav_rejects_garbage_and_empty():
    with pytest.raises(emotion.ToneError):
        emotion.decode_wav(b"RIFF....not a wav")
    with pytest.raises(emotion.ToneError):
        emotion.decode_wav(b"")
    with pytest.raises(emotion.ToneError, match="too large"):
        emotion.decode_wav(b"0" * (emotion.MAX_WAV_BYTES + 1))


# ---------------------------------------------------------------- availability

def test_not_ready_raises_unavailable(monkeypatch):
    monkeypatch.setitem(emotion._state, "state", "missing-model")
    monkeypatch.setitem(emotion._state, "reason", "run: python -m backend.services.emotion download")
    with pytest.raises(emotion.Unavailable):
        emotion.analyze_wav(make_wav(2.0))


def test_missing_dependencies_are_reported_not_raised(monkeypatch):
    import builtins
    real_import = builtins.__import__

    def no_torch(name, *a, **k):
        if name == "torch" or name.startswith("transformers"):
            raise ImportError(name=name)
        return real_import(name, *a, **k)

    monkeypatch.setattr(builtins, "__import__", no_torch)
    monkeypatch.setitem(emotion._state, "state", "idle")
    st = emotion.load()
    assert st["state"] == "missing-deps"
    assert "requirements-emotion.txt" in st["reason"]


def test_missing_model_files_are_reported(monkeypatch, tmp_path):
    pytest.importorskip("torch")
    pytest.importorskip("transformers")
    monkeypatch.setitem(emotion._state, "state", "idle")
    st = emotion.load(str(tmp_path))
    assert st["state"] == "missing-model"


def test_start_loading_respects_the_off_switch(monkeypatch):
    monkeypatch.setenv("ASTRO_NO_EMOTION", "1")
    monkeypatch.setitem(emotion._state, "state", "idle")
    emotion.start_loading()
    assert emotion.status()["state"] == "disabled"


def test_predict_picks_the_top_score(fake_model):
    r = emotion.analyze_wav(make_wav(3.0))
    assert r["label"] == "calm" and r["confidence"] == 0.71
    assert set(r["scores"]) == set(emotion.LABELS)
    assert r["duration_s"] == 3.0
    assert fake_model == [48000]


# ---------------------------------------------------------------- the API

@pytest.fixture(scope="module")
def client(tmp_path_factory):
    from _pytest.monkeypatch import MonkeyPatch
    mp = MonkeyPatch()
    mp.setattr(db, "DB_PATH", str(tmp_path_factory.mktemp("emotion_api") / "test.db"))
    import app as app_module
    args = argparse.Namespace(port=None, simulate=True, wifi=False, wifi_host=None, wifi_port=None,
                              host="0.0.0.0", web_port=5000)
    flask_app, _socketio, _bridge = app_module.create_app(args)
    flask_app.config["TESTING"] = True
    yield flask_app.test_client()
    mp.undo()


def login_as(client, uid):
    assert client.post("/api/auth/nfc_login", json={"uid": uid}).status_code == 200


def open_talk(client, astro_id=1):
    """A real conversation (the phrase route only accepts phrases for one)."""
    res = client.post(f"/api/astronauts/{astro_id}/voice-talks", json={})
    assert res.status_code == 201, res.get_json()
    return res.get_json()["talk_id"]


def post_clip(client, astro_id=1, talk="t1", seconds=2.0, **kw):
    return client.post(f"/api/astronauts/{astro_id}/voice-tone?talk={talk}", data=make_wav(seconds, **kw),
                       content_type="audio/wav")


def counts(astro_id=1):
    conn = db.get_conn()
    try:
        return (
            conn.execute("SELECT COUNT(*) FROM voice_tone WHERE astronaut_id = ?", (astro_id,)).fetchone()[0],
            conn.execute("SELECT COUNT(*) FROM readings WHERE astronaut_id = ?", (astro_id,)).fetchone()[0],
            conn.execute("SELECT COUNT(*) FROM readings WHERE astronaut_id = ? AND indicator = 'mood'", (astro_id,)).fetchone()[0],
        )
    finally:
        conn.close()


def test_status_route_is_open_and_says_disabled_in_tests(client):
    st = client.get("/api/voice-tone/status").get_json()
    assert st["state"] == "disabled"
    assert st["model"] == emotion.MODEL_ID


def test_post_needs_login_and_only_for_yourself(client, fake_model):
    client.post("/api/auth/logout")
    assert post_clip(client).status_code == 401
    login_as(client, SAMEER_UID)          # astronaut 2 posting as astronaut 1
    assert post_clip(client, astro_id=1).status_code == 403
    login_as(client, SURGEON_UID)         # the surgeon can't record for a crew member
    assert post_clip(client, astro_id=1).status_code == 403
    assert fake_model == []               # nothing was analysed


def test_post_unavailable_is_503_and_saves_nothing(client, fake_model, monkeypatch):
    login_as(client, AHMAD_UID)
    talk = open_talk(client)  # opened while the model was ready...
    monkeypatch.setitem(emotion._state, "state", "missing-model")  # ...then it went away
    before = counts()
    res = post_clip(client, talk=talk)
    assert res.status_code == 503
    assert client.post("/api/astronauts/1/voice-talks", json={}).status_code == 503  # and no new conversation
    assert counts() == before


def test_post_bad_audio_or_talk_id_is_400(client, fake_model):
    login_as(client, AHMAD_UID)
    talk = open_talk(client)
    assert post_clip(client, talk=talk, rate=48000).status_code == 400
    assert post_clip(client, talk=talk, seconds=0.4).status_code == 400
    assert post_clip(client, talk="").status_code == 400
    assert post_clip(client, talk="bad id!").status_code == 400
    assert fake_model == []


def test_post_saves_scores_only_and_never_touches_mood(client, fake_model):
    login_as(client, AHMAD_UID)
    tone_before, readings_before, mood_before = counts()
    talk = open_talk(client)
    res = post_clip(client, talk=talk, seconds=2.5)
    assert res.status_code == 200
    body = res.get_json()
    assert body["label"] == "calm" and body["talk_id"] == talk and body["duration_s"] == 2.5
    tone_after, readings_after, mood_after = counts()
    assert tone_after == tone_before + 1
    assert (readings_after, mood_after) == (readings_before, mood_before)  # self-reported mood untouched
    conn = db.get_conn()
    try:
        row = conn.execute("SELECT * FROM voice_tone WHERE id = ?", (body["id"],)).fetchone()
        cols = row.keys()
    finally:
        conn.close()
    assert json.loads(row["scores_json"]) == FAKE_SCORES
    assert row["model"].startswith(emotion.MODEL_ID + "@")
    assert not any("audio" in c or "wav" in c for c in cols)  # no column could hold a recording


def test_list_is_for_the_astronaut_and_the_surgeon_only(client, fake_model):
    login_as(client, AHMAD_UID)
    talk = open_talk(client)
    post_clip(client, talk=talk)
    mine = client.get("/api/astronauts/1/voice-tone?days=7").get_json()
    assert any(r["talk_id"] == talk for r in mine)
    assert set(mine[-1]["scores"]) == set(emotion.LABELS)
    login_as(client, SURGEON_UID)
    assert client.get("/api/astronauts/1/voice-tone").status_code == 200
    login_as(client, SAMEER_UID)
    assert client.get("/api/astronauts/1/voice-tone").status_code == 403
    client.post("/api/auth/logout")
    assert client.get("/api/astronauts/1/voice-tone").status_code == 401


def test_reset_demo_data_clears_voice_tone(client, fake_model):
    login_as(client, AHMAD_UID)
    post_clip(client, talk=open_talk(client))
    login_as(client, SURGEON_UID)
    assert client.post("/api/reset-demo").status_code == 200
    assert counts()[0] == 0


# ---------------------------------------------------------------- the real model (optional)

def _real_model_or_skip():
    pytest.importorskip("torch")
    pytest.importorskip("transformers")
    if emotion.missing_files():
        pytest.skip("model not downloaded (python -m backend.services.emotion download)")


@pytest.fixture()
def real_model():
    _real_model_or_skip()
    saved = (dict(emotion._state), emotion._model, emotion._extractor)
    st = emotion.load()
    assert st["state"] == "ready", st
    yield
    emotion._state.clear()
    emotion._state.update(saved[0])
    emotion._model, emotion._extractor = saved[1], saved[2]


def test_real_model_weights_match_the_pinned_hash():
    _real_model_or_skip()
    assert emotion.sha256_of(f"{emotion.MODEL_DIR}/model.safetensors") == emotion.WEIGHTS_SHA256


def test_real_model_gives_seven_scores_that_sum_to_one(real_model):
    r = emotion.analyze_wav(make_wav(3.0, freq=180.0))
    assert set(r["scores"]) == set(emotion.LABELS)
    assert abs(sum(r["scores"].values()) - 1.0) < 1e-3
    assert r["label"] in emotion.LABELS


FIXTURE_WAV = os.path.join(os.path.dirname(__file__), "fixtures", "voice_phrase.wav")  # 4.3 s of speech, 16 kHz


def test_real_model_loads_offline_in_a_fresh_process():
    """A brand-new Python process (nothing imported yet, no offline settings in the
    environment) loads the model from models/wav2vec2-emotion/ with every network call
    blocked -- and never even tries to connect."""
    _real_model_or_skip()
    code = (
        "import socket, json, os\n"
        "tries = []\n"
        "def no(*a, **k):\n"
        "    tries.append(repr(a[:2])); raise OSError('network blocked')\n"
        "socket.socket.connect = no; socket.socket.connect_ex = no\n"
        "socket.create_connection = no; socket.getaddrinfo = no\n"
        "from backend.services import emotion\n"
        "st = emotion.load()\n"
        "r = emotion.analyze_wav(open(os.environ['WAV'], 'rb').read())\n"
        "print(json.dumps({'state': st['state'], 'tries': tries, 'dir': emotion.MODEL_DIR, 'scores': r['scores']}))\n"
    )
    env = {k: v for k, v in os.environ.items() if k not in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "ASTRO_EMOTION_MODEL_DIR")}
    env["WAV"] = FIXTURE_WAV
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = subprocess.run([sys.executable, "-c", code], cwd=repo, env=env, capture_output=True, text=True, timeout=180)
    assert out.returncode == 0, out.stderr[-2000:]
    res = json.loads(out.stdout.strip().splitlines()[-1])
    assert res["state"] == "ready"
    assert res["tries"] == []
    assert os.path.normcase(res["dir"]) == os.path.normcase(os.path.join(repo, "models", "wav2vec2-emotion"))
    assert set(res["scores"]) == set(emotion.LABELS)


@pytest.fixture()
def no_network(monkeypatch):
    import socket
    tries = []

    def no(*a, **k):
        tries.append(repr(a[:2]))
        raise OSError("network blocked")

    for name in ("create_connection", "getaddrinfo"):
        monkeypatch.setattr(socket, name, no)
    monkeypatch.setattr(socket.socket, "connect", no)
    monkeypatch.setattr(socket.socket, "connect_ex", no)
    return tries


def test_real_model_full_api_flow_offline(client, real_model, no_network):
    """The whole backend path with the real model: a speech WAV is POSTed like the browser
    does -> the local model -> a voice_tone row with 7 probabilities -> the list route.
    Self-reported mood is untouched, no audio is kept, and nothing goes online."""
    login_as(client, AHMAD_UID)
    assert client.post("/api/astronauts/1/mood", json={"mood": "okay", "note": "before the talk"}).status_code == 200
    tone_before, readings_before, mood_before = counts()
    wav = open(FIXTURE_WAV, "rb").read()

    talk = open_talk(client)
    res = client.post(f"/api/astronauts/1/voice-tone?talk={talk}", data=wav, content_type="audio/wav")
    assert res.status_code == 200, res.get_json()
    body = res.get_json()
    assert body["label"] in emotion.LABELS
    assert set(body["scores"]) == set(emotion.LABELS)
    assert abs(sum(body["scores"].values()) - 1.0) < 2e-3  # rounded to 4 places each
    assert body["confidence"] == max(body["scores"].values())
    assert body["duration_s"] == pytest.approx(4.32, abs=0.01)

    listed = [r for r in client.get("/api/astronauts/1/voice-tone?days=1").get_json() if r["talk_id"] == talk]
    assert len(listed) == 1 and listed[0]["scores"] == body["scores"] and listed[0]["label"] == body["label"]

    tone_after, readings_after, mood_after = counts()
    assert tone_after == tone_before + 1
    assert (readings_after, mood_after) == (readings_before, mood_before)
    conn = db.get_conn()
    try:
        row = dict(conn.execute("SELECT * FROM voice_tone WHERE id = ?", (body["id"],)).fetchone())
    finally:
        conn.close()
    stored = sum(len(str(v)) for v in row.values())
    assert stored < 2000 < len(wav)  # only scores and metadata: a recording couldn't fit
    assert no_network == []


def test_real_model_is_unaffected_by_the_browsers_volume_normalisation(real_model):
    """The browser raises a quiet voice to a normal level before 16-bit WAV (lib/toneClip.js
    normalizeGain): the model's own feature extractor normalises every input to zero mean /
    unit variance, so the volume change itself must not move the seven probabilities. Measured
    on real speech, including the user's measured mic level (speech peaking at -54 dBFS)."""
    import numpy as np

    x = np.asarray(emotion.decode_wav(open(FIXTURE_WAV, "rb").read()), dtype=np.float64)
    frame = 320
    peak_frame = max(np.sqrt(np.mean(x[i:i + frame] ** 2)) for i in range(0, len(x) - frame, frame))
    ref = emotion.predict(x.tolist())["scores"]
    for target_peak in (0.0021, 0.02, 0.2):  # quiet laptop mic ... loud
        quiet = x * (target_peak / peak_frame)
        raised = quiet * (0.1 / np.sqrt(np.mean(quiet ** 2)))  # what normalizeGain does (RMS 0.1)
        got = emotion.predict(raised.tolist())["scores"]
        assert max(abs(got[k] - ref[k]) for k in emotion.LABELS) < 0.01, (target_peak, got, ref)


def test_real_model_matches_the_standard_transformers_pipeline(real_model):
    """Same files, same preprocessing as a plain notebook pipeline call."""
    import numpy as np
    from transformers import pipeline

    samples = np.asarray(emotion.decode_wav(make_wav(2.0, freq=300.0)), dtype=np.float32)
    clf = pipeline("audio-classification", model=emotion.MODEL_DIR, feature_extractor=emotion.MODEL_DIR,
                   top_k=7, device="cpu")
    ref = {d["label"]: d["score"] for d in clf({"raw": samples, "sampling_rate": 16000})}
    mine = emotion.predict(samples.tolist())["scores"]
    assert max(abs(ref[k] - mine[k]) for k in emotion.LABELS) < 1e-3
