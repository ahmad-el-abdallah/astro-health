// One camera, several Mind-page sections that use it (Face Analysis, Pose Analysis). Whoever
// opens the camera claims it first; the section that held it before is told to release it
// (its own Stop), so two sections never fight over the webcam and no stream is left running.
let current = null; // { owner, release }

/** Take the camera for `owner`; the previous owner's `release()` runs first. */
export function claimCamera(owner, release) {
  if (current && current.owner !== owner) {
    const prev = current;
    current = null;
    try { prev.release(); } catch { /* a section that already unmounted */ }
  }
  current = { owner, release };
}

/** `owner` is done with the camera (stopped, finished, or left the page). */
export function releaseCamera(owner) {
  if (current?.owner === owner) current = null;
}

/** Who holds the camera now ("" = nobody). */
export function cameraOwner() {
  return current?.owner || "";
}
