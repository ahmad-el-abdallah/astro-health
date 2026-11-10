// 3D safety net. Some browsers have WebGL switched off (hardware acceleration disabled,
// GPU blocklisted, sandboxed/remote sessions): three.js then throws while creating its
// renderer, which would take the whole page down. hasWebGL() checks up front, and
// <WebGLBoundary> catches anything that still fails (e.g. a lost GPU context), so the
// rest of the page keeps working and the user sees how to turn 3D on.
import { Component } from "react";

let cached = null;
export function hasWebGL() {
  if (cached !== null) return cached;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    cached = !!gl;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    cached = false;
  }
  return cached;
}

export function NoWebGL({ title = "3D view unavailable" }) {
  return (
    <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 p-6 text-center">
      <span className="rounded-full border border-check-edge bg-check-bg px-3 py-1 text-xs font-bold text-check-fg">{title}</span>
      <p className="m-0 max-w-sm text-sm text-ink-2">
        This browser has 3D graphics (WebGL) turned off, so the digital twin can't be drawn. Everything else on this page still works —
        use the region chips above to pick a body part.
      </p>
      <p className="m-0 max-w-sm text-xs text-muted">
        To turn it on in Chrome: Settings → System → enable “Use graphics acceleration when available”, then restart Chrome.
        Check chrome://gpu — “WebGL” should say “Hardware accelerated”.
      </p>
    </div>
  );
}

export class WebGLBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err) {
    console.error("3D view failed, showing the fallback instead:", err);
  }
  render() {
    if (this.state.failed || !hasWebGL()) return this.props.fallback ?? <NoWebGL />;
    return this.props.children;
  }
}
