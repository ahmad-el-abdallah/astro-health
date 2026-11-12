"""The "Microsoft neural voice" engine for Doctor AI's spoken replies (edge-tts: free, no
key, needs internet). The page plays the returned MP3 through Web Audio so it can add the
station's reverb/echo (frontend/src/lib/stationAudio.js) -- something the browser's own
speechSynthesis voice can never get, since the page never receives that sound.

Which engine is used is chosen on /admin (backend/voice_settings.py). If this fails, the
page falls back to the browser voice, so a failure here never silences the AI.

Restored (and given a voice parameter) from the Face to Face feature removed earlier --
see docs/CLAUDE.md.
"""
import asyncio

import edge_tts

DEFAULT_VOICE = "en-US-AriaNeural"

# edge-tts talks to an undocumented Microsoft Edge "Read Aloud" endpoint, not a stable
# public API -- observed (2026-11-05) failing intermittently with "No audio was received"
# while an immediate retry succeeded. So: cap each attempt, retry once.
TIMEOUT_S = 12
MAX_ATTEMPTS = 2


class SpeechError(Exception):
    """Any failure synthesizing speech; the route turns it into a 502."""


async def _synthesize(text, voice):
    chunks = bytearray()
    async for chunk in edge_tts.Communicate(text, voice).stream():
        if chunk["type"] == "audio":
            chunks.extend(chunk["data"])
    if not chunks:
        raise SpeechError("no audio returned")
    return bytes(chunks)


def synthesize(text, voice=DEFAULT_VOICE):
    """Returns raw MP3 bytes, or raises SpeechError (after one retry)."""
    last_exc = None
    for _ in range(MAX_ATTEMPTS):
        try:
            return asyncio.run(asyncio.wait_for(_synthesize(text, voice), timeout=TIMEOUT_S))
        except Exception as exc:
            last_exc = exc
    raise SpeechError(str(last_exc)) from last_exc
