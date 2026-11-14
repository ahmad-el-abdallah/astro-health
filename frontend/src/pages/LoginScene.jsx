// The login page's backdrop: the user's "Cinematic Space Background" clip, looping -- a
// slow drift through a nebula to Earth's sunrise edge -- with a soft dark fade from the
// left so the sign-in card stays readable over it. (Before 2026-11-13 it was 3wrf's 4K
// clip of Earth turning; before that a hand-built animated scene -- both in git history.)
//
// public/media/login-bg.mp4 is the 4K, 20 s original re-encoded to 1080p, no audio, CRF 26,
// "faststart" so it plays before it has fully downloaded (~2.6 MB, from 16.8 MB):
//   ffmpeg -i "Cinematic Space Background.mp4" -an -vf "scale=1920:1080:flags=lanczos,format=yuv420p" \
//          -c:v libx264 -preset slow -crf 26 -movflags +faststart login-bg.mp4
// login-bg.jpg is its first frame: shown while the video loads, and used on its own for
// anyone with "reduce motion" switched on in their system settings.
//
// Smoothness: a <video> is decoded by the browser's media pipeline and composited like an
// image, so it costs far less than the old per-frame CSS animations. Nothing on top of it
// uses backdrop-filter (the login card is .ah-glass-flat), per docs/CLAUDE.md.
import { memo } from "react";
import { useReducedMotion } from "motion/react";

const VIDEO = "/media/login-bg.mp4";
const POSTER = "/media/login-bg.jpg";

function LoginSceneImpl() {
  const reduceMotion = useReducedMotion();
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden bg-[#05080f]" aria-hidden="true">
      {reduceMotion ? (
        <img src={POSTER} alt="" className="absolute inset-0 h-full w-full object-cover" />
      ) : (
        <video
          className="absolute inset-0 h-full w-full object-cover"
          src={VIDEO}
          poster={POSTER}
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          disablePictureInPicture
        />
      )}
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(5,8,15,.7)_0%,rgba(5,8,15,.3)_40%,rgba(5,8,15,0)_62%)]" />
      <div className="absolute inset-x-0 bottom-0 h-1/3 bg-[linear-gradient(0deg,rgba(5,8,15,.6),transparent)]" />
    </div>
  );
}

// Memoized: typing in the sign-in fields must never re-render (and restart) the video.
export const LoginScene = memo(LoginSceneImpl);
