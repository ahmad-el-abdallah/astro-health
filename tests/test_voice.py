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
    monkeypatch.setattr(voice.edge_tts, "Communicate", lambda text, v: _FakeCommunicate(chunks))
    assert voice.synthesize("hello") == b"abcdef"


def test_synthesize_raises_when_no_audio_chunks(monkeypatch):
    monkeypatch.setattr(voice.edge_tts, "Communicate", lambda text, v: _FakeCommunicate([{"type": "SentenceBoundary"}]))
    with pytest.raises(voice.SpeechError):
        voice.synthesize("hello")


def test_synthesize_wraps_unexpected_errors(monkeypatch):
    class _Boom:
        def stream(self):
            raise RuntimeError("network down")
    monkeypatch.setattr(voice.edge_tts, "Communicate", lambda text, v: _Boom())
    with pytest.raises(voice.SpeechError):
        voice.synthesize("hello")
