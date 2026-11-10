// Face to Face mode's talking-head avatar: a procedural 3D head built the
// same way the Body tab's digital twin is (plain three.js primitives, no
// asset/rigging pipeline -- static/js/tabs/body.js). The mouth's openness is
// driven by the real-time amplitude of whatever audio is actually playing,
// not true phoneme lip-sync -- edge-tts (backend/services/voice.py) exposes no
// word/viseme timing to sync against, so this is the honest achievable
// substitute (see docs/CLAUDE.md for the full reasoning).
const FaceAvatar = (() => {
  let renderer, scene, camera, head, eyeGroup, mouth;
  let audioEl, audioCtx, analyser, dataArray;
  let speaking = false;
  let externalAudioCtx = null;
  let mouthOpen = 0; // smoothed 0-1, read every frame
  let blinkStartSec = null;
  let nextBlinkAt = 2 + Math.random() * 3;

  function init(container, sharedAudioCtx) {
    externalAudioCtx = sharedAudioCtx || null;
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(32, 1, 0.1, 10);
    camera.position.set(0, 0, 2.5);
    camera.lookAt(0, 0.05, 0);
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    // Softer, warmer lighting than the body viewer's -- that scene colors
    // meshes by health level and wants punchy, saturated light; a face
    // reads as a face (not a blown-out pale egg) only with gentler,
    // more diffuse light and a more saturated, rougher (less shiny) skin.
    scene.add(new THREE.HemisphereLight(0xfff4e8, 0x1a2638, 0.65));
    const dl = new THREE.DirectionalLight(0xfff0e0, 0.85);
    dl.position.set(1, 1.5, 2.5);
    scene.add(dl);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.22);
    fill.position.set(-2, 0.5, 1);
    scene.add(fill);

    const sph = (r, ws = 24, hs = 18) => new THREE.SphereGeometry(r, ws, hs);
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xc98f66, roughness: 0.75 });

    head = new THREE.Group();
    scene.add(head);

    const face = new THREE.Mesh(sph(0.62, 32, 32), skinMat);
    face.scale.set(0.92, 1.08, 0.95);
    head.add(face);

    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.3, 16), skinMat);
    neck.position.set(0, -0.78, 0);
    head.add(neck);
    const shoulders = new THREE.Mesh(sph(0.95, 24, 16), new THREE.MeshStandardMaterial({ color: 0x1c3156, roughness: 0.7 }));
    shoulders.scale.set(1, 0.4, 0.65);
    shoulders.position.set(0, -1.18, -0.1);
    head.add(shoulders);

    eyeGroup = new THREE.Group();
    head.add(eyeGroup);
    const scleraMat = new THREE.MeshStandardMaterial({ color: 0xf5f3ee, roughness: 0.4 });
    const irisMat = new THREE.MeshStandardMaterial({ color: 0x3b2a20, roughness: 0.3 });
    const browMat = new THREE.MeshStandardMaterial({ color: 0x3b2a20, roughness: 0.6 });
    [-1, 1].forEach((s) => {
      const sclera = new THREE.Mesh(sph(0.1, 16, 16), scleraMat);
      sclera.position.set(s * 0.22, 0.08, 0.52);
      eyeGroup.add(sclera);
      const iris = new THREE.Mesh(sph(0.05, 12, 12), irisMat);
      iris.position.set(s * 0.22, 0.08, 0.6);
      eyeGroup.add(iris);
      const brow = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.035, 0.04), browMat);
      brow.position.set(s * 0.22, 0.22, 0.56);
      brow.rotation.z = s * -0.08;
      head.add(brow);
    });

    mouth = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.05, 0.05), new THREE.MeshStandardMaterial({ color: 0x5a2a28, roughness: 0.5 }));
    mouth.position.set(0, -0.3, 0.58);
    head.add(mouth);

    function resize() {
      const w = container.clientWidth, h = container.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    new ResizeObserver(resize).observe(container);
    resize();

    // A single, persistent <audio> element -- createMediaElementSource()
    // can only ever be attached once per element, so every turn reuses
    // this one (just swapping .src) rather than creating a fresh element
    // each time, which would throw on the second turn.
    audioEl = new Audio();
    audioEl.addEventListener("ended", () => { speaking = false; });
    audioEl.addEventListener("pause", () => { speaking = false; });

    requestAnimationFrame(tick);
  }

  function updateBlink(tSec) {
    let eyeScale = 1;
    if (blinkStartSec === null && tSec >= nextBlinkAt) {
      blinkStartSec = tSec;
    }
    if (blinkStartSec !== null) {
      const BLINK_DURATION = 0.14;
      const p = (tSec - blinkStartSec) / BLINK_DURATION;
      if (p >= 1) {
        blinkStartSec = null;
        nextBlinkAt = tSec + 2.5 + Math.random() * 3.5;
      } else {
        eyeScale = 1 - Math.sin(p * Math.PI); // open -> closed -> open, one cycle
      }
    }
    eyeGroup.scale.y = Math.max(0.05, eyeScale);
  }

  function updateMouth() {
    let target = 0;
    if (speaking && analyser) {
      analyser.getByteTimeDomainData(dataArray);
      let sumSquares = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const v = (dataArray[i] - 128) / 128;
        sumSquares += v * v;
      }
      const rms = Math.sqrt(sumSquares / dataArray.length);
      target = Math.min(1, rms * 4.5);
    }
    // fast attack, slower decay so it doesn't flicker frame-to-frame
    mouthOpen += (target - mouthOpen) * (target > mouthOpen ? 0.5 : 0.15);
    mouth.scale.y = 1 + mouthOpen * 5;
    mouth.position.y = -0.3 - mouthOpen * 0.05;
  }

  function tick(t) {
    requestAnimationFrame(tick);
    if (!renderer) return;
    const tSec = t / 1000;
    head.position.y = Math.sin(tSec * 0.7) * 0.015; // idle breathing bob
    updateBlink(tSec);
    updateMouth();
    renderer.render(scene, camera);
  }

  // Builds the Web Audio graph on first use and plays the given audio URL
  // (an object URL from the /speak response), driving the mouth from its
  // real playback amplitude until it ends. Reuses the AudioContext body.js
  // created synchronously inside the mic-button click (externalAudioCtx,
  // passed in via init()) rather than creating its own here -- by the time
  // speak() runs we're several awaits removed from the original click
  // (recognition result -> /consult -> /speak -> this), and a fresh
  // AudioContext created that late can end up "suspended" and never
  // resume, playing no sound with no error (see docs/CLAUDE.md).
  function speak(audioUrl) {
    if (!audioCtx) {
      audioCtx = externalAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaElementSource(audioEl);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      dataArray = new Uint8Array(analyser.fftSize);
      source.connect(analyser);
      analyser.connect(audioCtx.destination);
    }
    if (audioCtx.state === "suspended") audioCtx.resume();
    audioEl.src = audioUrl;
    speaking = true;
    audioEl.play();
  }

  function stopSpeaking() {
    speaking = false;
    if (audioEl) audioEl.pause();
  }

  return { init, speak, stopSpeaking };
})();
