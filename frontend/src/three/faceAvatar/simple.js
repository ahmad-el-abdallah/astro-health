// Face to Face's fallback avatar: a simple procedural head whose mouth follows the real
// loudness of the playing reply (no phoneme timing exists for edge-tts). Used only when
// the realistic avatar fails to load. Port of static/js/3d/face_avatar.js onto the
// app's bundled three.js; its render loop stops on dispose().
import * as THREE from "three";

export function createSimpleAvatar(container, audioCtx) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 10);
  camera.position.set(0, 0, 2.5);
  camera.lookAt(0, 0.05, 0);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  container.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xfff4e8, 0x1a2638, 0.65));
  const key = new THREE.DirectionalLight(0xfff0e0, 0.85);
  key.position.set(1, 1.5, 2.5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x88aaff, 0.22);
  fill.position.set(-2, 0.5, 1);
  scene.add(fill);

  const sph = (r, ws = 24, hs = 18) => new THREE.SphereGeometry(r, ws, hs);
  const skin = new THREE.MeshStandardMaterial({ color: 0xc98f66, roughness: 0.75 });
  const head = new THREE.Group();
  scene.add(head);
  const face = new THREE.Mesh(sph(0.62, 32, 32), skin);
  face.scale.set(0.92, 1.08, 0.95);
  head.add(face);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.3, 16), skin);
  neck.position.set(0, -0.78, 0);
  head.add(neck);
  const shoulders = new THREE.Mesh(sph(0.95, 24, 16), new THREE.MeshStandardMaterial({ color: 0x1c3156, roughness: 0.7 }));
  shoulders.scale.set(1, 0.4, 0.65);
  shoulders.position.set(0, -1.18, -0.1);
  head.add(shoulders);

  const eyes = new THREE.Group();
  head.add(eyes);
  const sclera = new THREE.MeshStandardMaterial({ color: 0xf5f3ee, roughness: 0.4 });
  const iris = new THREE.MeshStandardMaterial({ color: 0x3b2a20, roughness: 0.3 });
  [-1, 1].forEach((s) => {
    const e = new THREE.Mesh(sph(0.1, 16, 16), sclera);
    e.position.set(s * 0.22, 0.08, 0.52);
    eyes.add(e);
    const i = new THREE.Mesh(sph(0.05, 12, 12), iris);
    i.position.set(s * 0.22, 0.08, 0.6);
    eyes.add(i);
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.035, 0.04), iris);
    brow.position.set(s * 0.22, 0.22, 0.56);
    brow.rotation.z = s * -0.08;
    head.add(brow);
  });
  const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.05, 0.05), new THREE.MeshStandardMaterial({ color: 0x5a2a28, roughness: 0.5 }));
  mouth.position.set(0, -0.3, 0.58);
  head.add(mouth);

  const resize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  // One persistent <audio>: createMediaElementSource() can only attach once per element.
  const audioEl = new Audio();
  let analyser = null;
  let data = null;
  let speaking = false;
  audioEl.addEventListener("ended", () => { speaking = false; });
  audioEl.addEventListener("pause", () => { speaking = false; });

  let mouthOpen = 0;
  let blinkStart = null;
  let nextBlink = 2 + Math.random() * 3;
  let raf = 0;
  const tick = (t) => {
    raf = requestAnimationFrame(tick);
    const s = t / 1000;
    head.position.y = Math.sin(s * 0.7) * 0.015;
    let eyeScale = 1;
    if (blinkStart === null && s >= nextBlink) blinkStart = s;
    if (blinkStart !== null) {
      const p = (s - blinkStart) / 0.14;
      if (p >= 1) { blinkStart = null; nextBlink = s + 2.5 + Math.random() * 3.5; } else eyeScale = 1 - Math.sin(p * Math.PI);
    }
    eyes.scale.y = Math.max(0.05, eyeScale);
    let target = 0;
    if (speaking && analyser) {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
      target = Math.min(1, Math.sqrt(sum / data.length) * 4.5);
    }
    mouthOpen += (target - mouthOpen) * (target > mouthOpen ? 0.5 : 0.15);
    mouth.scale.y = 1 + mouthOpen * 5;
    mouth.position.y = -0.3 - mouthOpen * 0.05;
    renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(tick);

  return {
    kind: "simple",
    async speak(blob) {
      if (!analyser) {
        const src = audioCtx.createMediaElementSource(audioEl);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        data = new Uint8Array(analyser.fftSize);
        src.connect(analyser);
        analyser.connect(audioCtx.destination);
      }
      if (audioCtx.state === "suspended") await audioCtx.resume();
      audioEl.src = URL.createObjectURL(blob);
      speaking = true;
      await audioEl.play();
    },
    stop() { speaking = false; audioEl.pause(); },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      audioEl.pause();
      renderer.dispose();
      container.innerHTML = "";
    },
  };
}
