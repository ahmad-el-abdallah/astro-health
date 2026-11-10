// Face ID: a thin wrapper around the vendored face-api.js (static/vendor/
// face-api.min.js + static/vendor/faceapi-models/), used by both the login
// screen's "Use Face ID" card (login.js) and the Account overlay's
// enrollment flow (account.js). This is a DIFFERENT "face" feature from
// static/js/3d/face_avatar*.js (the Consultation AI's talking avatar) --
// unrelated code, just a naming coincidence.
//
// face-api.js's own upstream (and its best-maintained fork) are both
// frozen projects (no real commits in years) -- still MIT-licensed and
// fully functional, and the only option found that ships a model actually
// trained to produce comparable face-identity descriptors (the actively
// maintained alternative, MediaPipe's Face Landmarker, only outputs
// landmarks/mesh, not identity). See docs/CLAUDE.md.
//
// The identity DECISION always happens server-side (backend/routes/routes.py's
// face_login/face_distance) -- this module only ever produces a raw
// descriptor measurement, never asserts who it belongs to.
const FaceId = (() => {
  let modelsLoaded = false;
  let modelsLoading = null;

  async function ensureModels() {
    if (modelsLoaded) return;
    if (!modelsLoading) {
      const base = "/static/vendor/faceapi-models";
      modelsLoading = Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(base),
        faceapi.nets.faceLandmark68Net.loadFromUri(base),
        faceapi.nets.faceRecognitionNet.loadFromUri(base),
      ]).then(() => { modelsLoaded = true; });
    }
    await modelsLoading;
  }

  async function startCamera(videoEl) {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } });
    videoEl.srcObject = stream;
    await videoEl.play();
    return stream;
  }

  function stopCamera(stream) {
    if (stream) stream.getTracks().forEach((t) => t.stop());
  }

  // Returns a 128-value descriptor array, or null if no single clear face
  // was found (too dark, no face, more than one face in frame).
  async function captureDescriptor(videoEl) {
    await ensureModels();
    const result = await faceapi
      .detectSingleFace(videoEl, new faceapi.TinyFaceDetectorOptions())
      .withFaceLandmarks()
      .withFaceDescriptor();
    return result ? Array.from(result.descriptor) : null;
  }

  return { ensureModels, startCamera, stopCamera, captureDescriptor };
})();
window.FaceId = FaceId;
