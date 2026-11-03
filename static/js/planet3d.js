// Planet3D: a small dependency-free "3D" scene for the Mission Health tab.
// Each planet is a real shaded sphere: every pixel gets a surface normal,
// a lat/long lookup into a procedurally generated texture, and lighting
// from a fixed sun, so turning the texture's longitude each frame makes the
// planet rotate. No three.js / CDN needed (the app must run offline).
//
// Planet3D.mount(canvas) -> scene;  scene.setProfile("mars_transit");
// The loop only draws while the canvas is actually on screen.
const Planet3D = (() => {
  const TEX_W = 512, TEX_H = 256;
  const textures = {};

  // ---------- seeded value noise for textures ----------
  function rng(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  }
  function makeNoise(seed) {
    const r = rng(seed), N = 256, perm = new Uint8Array(512), vals = new Float32Array(N);
    for (let i = 0; i < N; i++) { perm[i] = i; vals[i] = r(); }
    for (let i = N - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
    for (let i = 0; i < N; i++) perm[i + N] = perm[i];
    const fade = (t) => t * t * (3 - 2 * t);
    // 3D value noise sampled on the sphere, so the texture has no seam.
    function n3(x, y, z) {
      const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
      const xf = fade(x - xi), yf = fade(y - yi), zf = fade(z - zi);
      const h = (a, b, c) => vals[perm[(perm[(perm[a & 255] + b) & 255] + c) & 255]];
      const lerp = (a, b, t) => a + (b - a) * t;
      const x0 = lerp(h(xi, yi, zi), h(xi + 1, yi, zi), xf), x1 = lerp(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), xf);
      const x2 = lerp(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), xf), x3 = lerp(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), xf);
      return lerp(lerp(x0, x1, yf), lerp(x2, x3, yf), zf);
    }
    return (x, y, z, oct = 5) => {
      let v = 0, amp = 0.5, f = 1, norm = 0;
      for (let o = 0; o < oct; o++) { v += amp * n3(x * f, y * f, z * f); norm += amp; amp *= 0.5; f *= 2.05; }
      return v / norm;
    };
  }

  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const clamp01 = (t) => Math.max(0, Math.min(1, t));

  // Builds an equirectangular RGB texture by sampling colorAt(x,y,z,lat) on the unit sphere.
  function buildTexture(seed, colorAt) {
    const noise = makeNoise(seed);
    const data = new Uint8ClampedArray(TEX_W * TEX_H * 3);
    for (let ty = 0; ty < TEX_H; ty++) {
      const lat = Math.PI / 2 - (ty + 0.5) / TEX_H * Math.PI;
      const cl = Math.cos(lat), sl = Math.sin(lat);
      for (let tx = 0; tx < TEX_W; tx++) {
        const lon = (tx + 0.5) / TEX_W * Math.PI * 2;
        const c = colorAt(noise, cl * Math.cos(lon), sl, cl * Math.sin(lon), lat);
        const k = (ty * TEX_W + tx) * 3;
        data[k] = c[0]; data[k + 1] = c[1]; data[k + 2] = c[2];
      }
    }
    return data;
  }

  const TEXTURE_RECIPES = {
    earth: () => buildTexture(7, (n, x, y, z, lat) => {
      const h = n(x * 1.6 + 3, y * 1.6, z * 1.6);
      const cloud = n(x * 3 + 11, y * 3, z * 3, 4);
      let c = h < 0.52
        ? mix([12, 40, 92], [28, 92, 160], clamp01((h - 0.3) / 0.22))
        : mix([46, 120, 58], [150, 128, 80], clamp01((h - 0.55) / 0.18));
      if (Math.abs(lat) > 1.2) c = mix(c, [236, 242, 248], 0.9);
      if (cloud > 0.56) c = mix(c, [245, 248, 252], clamp01((cloud - 0.56) * 4.5));
      return c;
    }),
    moon: () => {
      const craters = [];
      const r = rng(42);
      for (let i = 0; i < 70; i++) {
        const u = r() * 2 - 1, th = r() * Math.PI * 2, s = Math.sqrt(1 - u * u);
        craters.push({ x: s * Math.cos(th), y: u, z: s * Math.sin(th), rad: 0.03 + Math.pow(r(), 3) * 0.22 });
      }
      return buildTexture(3, (n, x, y, z) => {
        const base = n(x * 2.2, y * 2.2, z * 2.2);
        let g = 120 + (base - 0.5) * 120;
        if (n(x * 0.9 + 5, y * 0.9, z * 0.9, 3) < 0.42) g -= 38; // dark "seas"
        for (const c of craters) {
          const d = Math.acos(Math.max(-1, Math.min(1, x * c.x + y * c.y + z * c.z))) / c.rad;
          if (d < 1) g -= 22 * (1 - d * d);
          else if (d < 1.25) g += 18 * (1 - (d - 1) / 0.25);
        }
        return [g, g, g * 1.02];
      });
    },
    mars: () => buildTexture(11, (n, x, y, z, lat) => {
      const h = n(x * 1.8, y * 1.8, z * 1.8);
      const d = n(x * 4 + 9, y * 4, z * 4, 4);
      let c = mix([120, 48, 22], [205, 104, 56], clamp01((h - 0.3) / 0.45));
      c = mix(c, [86, 36, 20], clamp01((0.45 - d) * 3) * 0.6);
      if (Math.abs(lat) > 1.32) c = mix(c, [240, 228, 220], 0.85);
      return c;
    }),
  };

  function texture(name) {
    if (!textures[name]) textures[name] = TEXTURE_RECIPES[name]();
    return textures[name];
  }

  // ---------- what each mission profile shows ----------
  // x/y/r are fractions of the canvas width/height; spin = radians per second.
  const SCENES = {
    station: { bodies: [{ tex: "earth", x: 0.5, y: 0.55, r: 0.36, spin: 0.12, glow: [90, 170, 255] }],
               craft: { kind: "station", orbit: { cx: 0.5, cy: 0.55, rx: 0.47, ry: 0.13, tilt: -0.18, speed: 0.35 } } },
    lunar_base: { bodies: [{ tex: "moon", x: 0.52, y: 0.56, r: 0.36, spin: 0.06, glow: [200, 205, 220] },
                           { tex: "earth", x: 0.12, y: 0.18, r: 0.08, spin: 0.2, glow: [90, 170, 255] }],
                  beacon: { body: 0, lon: 0.4, lat: 0.35 } },
    mars_transit: { bodies: [{ tex: "earth", x: 0.13, y: 0.62, r: 0.1, spin: 0.2, glow: [90, 170, 255] },
                             { tex: "mars", x: 0.83, y: 0.42, r: 0.2, spin: 0.1, glow: [255, 140, 90] }],
                    craft: { kind: "ship", path: { from: [0.22, 0.58], ctrl: [0.5, 0.05], to: [0.66, 0.42], speed: 0.07 } } },
    mars_base: { bodies: [{ tex: "mars", x: 0.5, y: 0.56, r: 0.37, spin: 0.08, glow: [255, 140, 90] }],
                 beacon: { body: 0, lon: 0.5, lat: 0.2 } },
    rover: { bodies: [{ tex: "mars", x: 0.5, y: 0.98, r: 0.75, spin: 0.03, glow: [255, 140, 90] }],
             craft: { kind: "rover", ride: { body: 0 } } },
  };

  const SUN = (() => { const v = [-0.55, 0.45, 0.7]; const m = Math.hypot(...v); return v.map((a) => a / m); })();

  // Precomputes, for one sphere size, each disc pixel's latitude row,
  // starting longitude and light amount; per frame only the longitude shifts.
  function bakeSphere(radiusPx) {
    const size = radiusPx * 2;
    const idx = [], row = [], lon0 = [], light = [];
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const nx = (px + 0.5 - radiusPx) / radiusPx, ny = -(py + 0.5 - radiusPx) / radiusPx;
        const d2 = nx * nx + ny * ny;
        if (d2 > 1) continue;
        const nz = Math.sqrt(1 - d2);
        const lat = Math.asin(ny);
        idx.push(py * size + px);
        row.push(Math.min(TEX_H - 1, Math.floor((Math.PI / 2 - lat) / Math.PI * TEX_H)));
        lon0.push(Math.atan2(nx, nz));
        const lambert = nx * SUN[0] + ny * SUN[1] + nz * SUN[2];
        const edge = Math.pow(nz, 0.35); // limb darkening
        light.push(Math.max(0.07, Math.min(1.15, 0.07 + Math.max(0, lambert) * 1.05)) * (0.55 + 0.45 * edge));
      }
    }
    return { size, idx: Int32Array.from(idx), row: Int16Array.from(row), lon0: Float32Array.from(lon0), light: Float32Array.from(light) };
  }

  function mount(canvas) {
    const ctx = canvas.getContext("2d");
    const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let profile = null, scene = null, W = 0, H = 0, dpr = 1;
    let stars = [], bodies = [], start = performance.now(), raf = 0, fade = 1;

    function resize() {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width) return false;
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const w = Math.round(rect.width * dpr), h = Math.round(rect.height * dpr);
      if (w === W && h === H) return true;
      W = canvas.width = w; H = canvas.height = h;
      const r = rng(99);
      stars = Array.from({ length: Math.round(W * H / 2600) }, () => ({ x: r() * W, y: r() * H, s: r() * 1.3 + 0.3, p: r() * 6.28 }));
      buildBodies();
      return true;
    }

    function buildBodies() {
      if (!scene || !W) return;
      const unit = Math.min(W, H);
      bodies = scene.bodies.map((b) => {
        const radiusPx = Math.max(6, Math.round(b.r * unit));
        const off = document.createElement("canvas");
        off.width = off.height = radiusPx * 2;
        return { ...b, radiusPx, bake: bakeSphere(radiusPx), tex: texture(b.tex), off, octx: off.getContext("2d"),
                 img: null, cx: b.x * W, cy: b.y * H };
      });
    }

    function drawSphere(b, t) {
      const { size, idx, row, lon0, light } = b.bake;
      if (!b.img) b.img = b.octx.createImageData(size, size);
      const out = b.img.data, tex = b.tex, rot = t * b.spin;
      for (let i = 0; i < idx.length; i++) {
        let u = (lon0[i] + rot) / (Math.PI * 2);
        u -= Math.floor(u);
        const k = (row[i] * TEX_W + Math.floor(u * TEX_W)) * 3, o = idx[i] * 4, l = light[i];
        out[o] = tex[k] * l; out[o + 1] = tex[k + 1] * l; out[o + 2] = tex[k + 2] * l; out[o + 3] = 255;
      }
      b.octx.putImageData(b.img, 0, 0);
      const [gr, gg, gb] = b.glow;
      const glow = ctx.createRadialGradient(b.cx, b.cy, b.radiusPx * 0.9, b.cx, b.cy, b.radiusPx * 1.35);
      glow.addColorStop(0, `rgba(${gr},${gg},${gb},0.35)`);
      glow.addColorStop(1, `rgba(${gr},${gg},${gb},0)`);
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(b.cx, b.cy, b.radiusPx * 1.35, 0, Math.PI * 2); ctx.fill();
      ctx.drawImage(b.off, b.cx - b.radiusPx, b.cy - b.radiusPx);
    }

    function drawBeacon(beacon, t) {
      const b = bodies[beacon.body];
      if (!b) return;
      // Point fixed on the planet surface, so it turns with the planet.
      const lon = beacon.lon * Math.PI * 2 - t * b.spin, lat = beacon.lat;
      const z = Math.cos(lat) * Math.cos(lon);
      if (z < 0.1) return; // on the far side
      const x = b.cx + Math.cos(lat) * Math.sin(lon) * b.radiusPx, y = b.cy - Math.sin(lat) * b.radiusPx;
      const pulse = (Math.sin(t * 3) + 1) / 2;
      ctx.fillStyle = `rgba(79,209,197,${0.25 + pulse * 0.25})`;
      ctx.beginPath(); ctx.arc(x, y, (5 + pulse * 7) * dpr * z, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#4fd1c5";
      ctx.beginPath(); ctx.arc(x, y, 2.6 * dpr, 0, Math.PI * 2); ctx.fill();
    }

    function drawStation(x, y, s, behind) {
      ctx.save(); ctx.translate(x, y); ctx.globalAlpha = behind ? 0.35 : 1;
      ctx.fillStyle = "#cfd8e3"; ctx.fillRect(-2 * s, -1.2 * s, 4 * s, 2.4 * s);
      ctx.fillStyle = "#3a6fb0";
      ctx.fillRect(-9 * s, -1.6 * s, 5.5 * s, 3.2 * s); ctx.fillRect(3.5 * s, -1.6 * s, 5.5 * s, 3.2 * s);
      ctx.restore();
    }

    function drawShip(x, y, angle, s) {
      ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
      const flame = ctx.createLinearGradient(-14 * s, 0, -4 * s, 0);
      flame.addColorStop(0, "rgba(79,209,197,0)"); flame.addColorStop(1, "rgba(150,240,230,0.9)");
      ctx.fillStyle = flame; ctx.beginPath(); ctx.moveTo(-4 * s, -1.5 * s); ctx.lineTo(-14 * s, 0); ctx.lineTo(-4 * s, 1.5 * s); ctx.fill();
      ctx.fillStyle = "#e8eef4";
      ctx.beginPath(); ctx.moveTo(7 * s, 0); ctx.lineTo(-4 * s, -2.6 * s); ctx.lineTo(-4 * s, 2.6 * s); ctx.closePath(); ctx.fill();
      ctx.restore();
    }

    function drawCraft(craft, t) {
      const s = dpr * 1.6;
      if (craft.kind === "station") {
        const o = craft.orbit, a = t * o.speed;
        const ex = Math.cos(a) * o.rx * W, ey = Math.sin(a) * o.ry * H;
        const x = o.cx * W + ex * Math.cos(o.tilt) - ey * Math.sin(o.tilt);
        const y = o.cy * H + ex * Math.sin(o.tilt) + ey * Math.cos(o.tilt);
        return { x, y, behind: Math.sin(a) < 0, draw: (beh) => drawStation(x, y, s, beh) };
      }
      if (craft.kind === "ship") {
        const p = craft.path, k = (t * p.speed) % 1;
        const q = (u) => [0, 1].map((i) => ((1 - u) ** 2) * p.from[i] + 2 * (1 - u) * u * p.ctrl[i] + u * u * p.to[i]);
        // dashed trajectory
        ctx.setLineDash([4 * dpr, 6 * dpr]); ctx.strokeStyle = "rgba(147,164,181,0.45)"; ctx.lineWidth = dpr;
        ctx.beginPath();
        for (let u = 0; u <= 1.0001; u += 0.02) { const [px, py] = q(u); u === 0 ? ctx.moveTo(px * W, py * H) : ctx.lineTo(px * W, py * H); }
        ctx.stroke(); ctx.setLineDash([]);
        const [x, y] = q(k), [x2, y2] = q(Math.min(1, k + 0.01));
        drawShip(x * W, y * H, Math.atan2((y2 - y) * H, (x2 - x) * W), s);
        return null;
      }
      if (craft.kind === "rover") {
        const b = bodies[craft.ride.body];
        const x = W * 0.5 + Math.sin(t * 0.25) * W * 0.08, y = b.cy - Math.sqrt(Math.max(0, b.radiusPx ** 2 - (x - b.cx) ** 2));
        ctx.save(); ctx.translate(x, y - 5 * s);
        ctx.fillStyle = "#e8eef4"; ctx.fillRect(-7 * s, -3 * s, 14 * s, 5 * s);
        ctx.fillStyle = "#4fd1c5"; ctx.fillRect(1 * s, -6 * s, 4 * s, 3 * s);
        ctx.fillStyle = "#93a4b5";
        [-5, 0, 5].forEach((wx) => { ctx.beginPath(); ctx.arc(wx * s, 3 * s, 1.8 * s, 0, Math.PI * 2); ctx.fill(); });
        ctx.restore();
        return null;
      }
      return null;
    }

    function frame(now) {
      raf = 0;
      if (!canvas.isConnected) return;
      const visible = canvas.offsetParent !== null && document.visibilityState === "visible";
      if (visible && resize() && scene) {
        const t = reduceMotion ? 8 : (now - start) / 1000;
        ctx.clearRect(0, 0, W, H);
        stars.forEach((st) => {
          ctx.fillStyle = `rgba(232,238,244,${0.35 + 0.35 * Math.sin(t * 1.3 + st.p) ** 2})`;
          ctx.fillRect(st.x, st.y, st.s * dpr, st.s * dpr);
        });
        const craft = scene.craft ? drawCraft(scene.craft, t) : null;
        if (craft && craft.behind) craft.draw(true);
        bodies.forEach((b) => drawSphere(b, t));
        if (craft && !craft.behind) craft.draw(false);
        if (scene.beacon) drawBeacon(scene.beacon, t);
        if (fade < 1) { ctx.fillStyle = `rgba(11,17,24,${1 - fade})`; ctx.fillRect(0, 0, W, H); fade = Math.min(1, fade + 0.06); }
        if (reduceMotion) return; // one still frame is enough
      }
      raf = requestAnimationFrame(frame);
    }

    function kick() { if (!raf) raf = requestAnimationFrame(frame); }
    window.addEventListener("resize", () => { W = 0; kick(); });
    document.addEventListener("visibilitychange", kick);

    return {
      setProfile(id) {
        if (id === profile) { kick(); return; }
        profile = id;
        scene = SCENES[id] || SCENES.station;
        fade = 0; buildBodies(); kick();
      },
      kick,
    };
  }

  return { mount };
})();
