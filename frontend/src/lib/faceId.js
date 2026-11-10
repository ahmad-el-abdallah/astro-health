// Face ID: thin wrapper around the vendored face-api.js (public/vendor/face-api.min.js +
// public/vendor/faceapi-models/). Port of static/js/core/face_id.js, with one change:
// the 660 KB library is only fetched the first time Face ID is actually used, instead of
// on every page load.
//
// The identity DECISION always happens server-side (POST /auth/face_login compares the
// descriptor); this module only ever produces a raw 128-number measurement.
let loading = null;

function loadLibrary() {
  if (window.faceapi) return Promise.resolve(window.faceapi);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "/vendor/face-api.min.js";
      s.onload = () => resolve(window.faceapi);
      s.onerror = () => { loading = null; reject(new Error("couldn't load face-api.js")); };
      document.head.appendChild(s);
    }).then(async (faceapi) => {
      const base = "/vendor/faceapi-models";
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(base),
        faceapi.nets.faceLandmark68Net.loadFromUri(base),
        faceapi.nets.faceRecognitionNet.loadFromUri(base),
      ]);
      return faceapi;
    });
  }
  return loading;
}

export async function startCamera(videoEl) {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } });
  videoEl.srcObject = stream;
  await videoEl.play();
  return stream;
}

export function stopCamera(stream) {
  if (stream) stream.getTracks().forEach((t) => t.stop());
}

// 128-number descriptor, or null if there isn't exactly one clear face in frame.
export async function captureDescriptor(videoEl) {
  const faceapi = await loadLibrary();
  const result = await faceapi
    .detectSingleFace(videoEl, new faceapi.TinyFaceDetectorOptions())
    .withFaceLandmarks()
    .withFaceDescriptor();
  return result ? Array.from(result.descriptor) : null;
}
