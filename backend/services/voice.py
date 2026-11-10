"""edge-tts speech synthesis for the Body tab's Face to Face mode -- the
Consultation AI's spoken voice. Optional in the sense that failure degrades
gracefully (the caller still has the text reply and just skips playback),
but needs real internet same as backend/services/consult.py's NVIDIA call -- both are
the deliberate, already-accepted exceptions to this app's "fully offline"
rule (see docs/CLAUDE.md).

edge-tts's own streaming API was checked directly before building this: it
only ever yields "audio" and "SentenceBoundary" chunks, no word/viseme
timing -- so there is no data here to drive frame-accurate lip-sync from.
The Face to Face avatar's mouth animation is driven by the played-back
audio's own amplitude instead (static/js/3d/face_avatar.js), not by anything
this module returns.
"""
import asyncio
import os

import edge_tts

# Same override pattern as backend/services/consult.py's NVIDIA_CHAT_MODEL -- a
# one-line env var change, not a real design decision baked into code.
# en-US-JennyNeural (female) -- matches the Face to Face avatar itself
# (static/avatars/brunette.glb, loaded with body: 'F' in face_avatar_rpm.js),
# and verified directly to synthesize just as fast as the previous default
# (en-US-AndrewNeural, male) on this account, so switching voices isn't
# trading speed for the requested gender.
VOICE = os.environ.get("CONSULT_VOICE", "en-US-JennyNeural")

# edge-tts talks to an undocumented, reverse-engineered Microsoft Edge
# "Read Aloud" endpoint, not a stable public API -- observed directly
# (2026-11-05) failing intermittently with "No audio was received" on an
# otherwise-healthy connection, with an immediate retry succeeding seconds
# later. TIMEOUT_S mirrors backend/services/consult.py's own NVIDIA call timeout
# (same "cap one external cloud call" shape); MAX_ATTEMPTS retries once on
# any failure, the same "retry once on a known-transient external failure"
# pattern consult.py already uses for NVIDIA's malformed-output case,
# applied here to this service's own transient-failure signature instead.
TIMEOUT_S = 12
MAX_ATTEMPTS = 2


class SpeechError(Exception):
    """Raised for any failure synthesizing speech -- callers (routes.py)
    catch this and degrade gracefully rather than leaking a raw exception."""


async def _synthesize(text):
    chunks = bytearray()
    async for chunk in edge_tts.Communicate(text, VOICE).stream():
        if chunk["type"] == "audio":
            chunks.extend(chunk["data"])
    if not chunks:
        raise SpeechError("no audio returned")
    return bytes(chunks)


def synthesize(text):
    """Returns raw MP3 bytes, or raises SpeechError. See MAX_ATTEMPTS above
    for why this retries once before giving up."""
    last_exc = None
    for _ in range(MAX_ATTEMPTS):
        try:
            return asyncio.run(asyncio.wait_for(_synthesize(text), timeout=TIMEOUT_S))
        except Exception as exc:
            last_exc = exc
    raise SpeechError(str(last_exc)) from last_exc
