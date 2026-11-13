// The login page's backdrop: a looping space video (Earth turning on the right), with a
// dark gradient from the left so the sign-in card stays readable over it.
//
// Replaced the hand-built animated scene (nebulas, star layers, SVG Earth) that used to
// live here -- that version is in git history if it's ever wanted back.
//
// The video file (public/media/login-bg.mp4) is the user's 4K clip re-encoded to 1080p,
// no audio track, ~1.8 MB, "faststart" so it plays before it has fully downloaded.
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
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(5,8,15,.82)_0%,rgba(5,8,15,.45)_45%,rgba(5,8,15,0)_70%)]" />
      <div className="absolute inset-x-0 bottom-0 h-1/3 bg-[linear-gradient(0deg,rgba(5,8,15,.6),transparent)]" />
    </div>
  );
}

// Memoized: typing in the sign-in fields must never re-render (and restart) the video.
export const LoginScene = memo(LoginSceneImpl);
