import pytest

from backend.services import voice


class _FakeCommunicate:
    def __init__(self, chunks):
        self._chunks = chunks

    def stream(self):
        async def gen():
            for c in self._chunks:
                yield c
        return gen()


def test_synthesize_returns_bytes(monkeypatch):
    chunks = [{"type": "audio", "data": b"abc"}, {"type": "SentenceBoundary"}, {"type": "audio", "data": b"def"}]
    monkeypatch.setattr(voice.edge_tts, "Communicate", lambda text, v, **kw: _FakeCommunicate(chunks))
    assert voice.synthesize("hello") == b"abcdef"


def test_synthesize_raises_when_no_audio_chunks(monkeypatch):
    monkeypatch.setattr(voice.edge_tts, "Communicate", lambda text, v, **kw: _FakeCommunicate([{"type": "SentenceBoundary"}]))
    with pytest.raises(voice.SpeechError):
        voice.synthesize("hello")


def test_synthesize_wraps_unexpected_errors(monkeypatch):
    class _Boom:
        def stream(self):
            raise RuntimeError("network down")
    monkeypatch.setattr(voice.edge_tts, "Communicate", lambda text, v, **kw: _Boom())
    with pytest.raises(voice.SpeechError):
        voice.synthesize("hello")


def test_synthesize_uses_the_requested_voice(monkeypatch):
    seen = []
    monkeypatch.setattr(voice.edge_tts, "Communicate",
                        lambda text, v, **kw: seen.append(v) or _FakeCommunicate([{"type": "audio", "data": b"x"}]))
    voice.synthesize("hello", "en-GB-SoniaNeural")
    assert seen == ["en-GB-SoniaNeural"]


def test_synthesize_passes_speed_and_pitch_to_the_voice_service(monkeypatch):
    seen = {}

    def fake(text, v, **kw):
        seen.update(voice=v, **kw)
        return _FakeCommunicate([{"type": "audio", "data": b"x"}])

    monkeypatch.setattr(voice.edge_tts, "Communicate", fake)
    voice.synthesize("hello", "en-US-AndrewNeural", rate=1.2, pitch="low")
    assert seen == {"voice": "en-US-AndrewNeural", "rate": "+20%", "pitch": "-12Hz"}
    assert voice.edge_rate(0.85) == "-15%" and voice.edge_rate(1.0) == "+0%"
