// Planet3D: a small dependency-free 3D scene for the Mission Health tab.
//
// Each planet is a real shaded sphere drawn pixel by pixel on a canvas:
//   - every pixel on the disc gets a surface normal, so lighting from a
//     fixed sun (upper left) is real: soft day/night line, ocean shine,
//     atmosphere glow at the rim, and city lights on Earth's night side;
//   - the surface is a procedurally generated texture (no image files),
//     wrapped as latitude/longitude; shifting the longitude each frame
//     makes the planet turn, and Earth's clouds turn a little faster;
//   - craters and canyons get bump shading from a height map, so they
//     catch the light as they rotate past.
// All lighting that doesn't change frame to frame is precomputed once per
// size ("baked"), so each frame is just a texture lookup per pixel.
//
// No three.js / CDN: the app has to run offline at the demo.
// Planet3D.mount(canvas) -> scene;  scene.setProfile("mars_transit");
const Planet3D = (() => {
  const TEX_W = 768, TEX_H = 384;
  const textures = {};   // name -> finished texture
  const jobs = [];       // textures still being generated, a few rows per frame

  // ---------- seeded noise ----------
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
    const lerp = (a, b, t) => a + (b - a) * t;
    function n3(x, y, z) {
      const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
      const xf = fade(x - xi), yf = fade(y - yi), zf = fade(z - zi);
      const X0 = xi & 255, X1 = (xi + 1) & 255, Y0 = yi & 255, Y1 = (yi + 1) & 255, Z0 = zi & 255, Z1 = (zi + 1) & 255;
      const h = (a, b, c) => vals[perm[perm[perm[a] + b] + c]];
      return lerp(
        lerp(lerp(h(X0, Y0, Z0), h(X1, Y0, Z0), xf), lerp(h(X0, Y1, Z0), h(X1, Y1, Z0), xf), yf),
        lerp(lerp(h(X0, Y0, Z1), h(X1, Y0, Z1), xf), lerp(h(X0, Y1, Z1), h(X1, Y1, Z1), xf), yf), zf);
    }
    // Fractal noise sampled in 3D on the sphere, so the texture has no seam.
    return (x, y, z, oct = 5) => {
      let v = 0, amp = 0.5, f = 1, norm = 0;
      for (let o = 0; o < oct; o++) { v += amp * n3(x * f + 17.3, y * f + 5.1, z * f + 9.7); norm += amp; amp *= 0.5; f *= 2.03; }
      return v / norm;
    };
  }

  const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
  const smooth = (a, b, t) => { const k = clamp01((t - a) / (b - a)); return k * k * (3 - 2 * k); };
  function mixInto(out, a, b, t) { out[0] = a[0] + (b[0] - a[0]) * t; out[1] = a[1] + (b[1] - a[1]) * t; out[2] = a[2] + (b[2] - a[2]) * t; }

  // ---------- planet surfaces ----------
  // Each recipe fills `o` = [r, g, b, height 0..1, shine 0..1, cityLights 0..1, cloud 0..1].
  const RECIPES = {
    earth: { seed: 7, bump: 1.2, init: () => ({}), sample(n, x, y, z, lat, o) {
      const h = n(x * 1.5, y * 1.5, z * 1.5, 6);
      const lat01 = Math.abs(lat) / (Math.PI / 2);
      // ocean and land colours, blended over a narrow band so coastlines are smooth
      const ocean = [0, 0, 0], land = [0, 0, 0];
      mixInto(ocean, [6, 28, 72], [22, 86, 150], smooth(0.28, 0.52, h));
      const dry = n(x * 3 + 40, y * 3, z * 3, 3) + (lat01 < 0.35 ? 0.12 : 0);
      mixInto(land, [38, 104, 46], [148, 128, 84], smooth(0.5, 0.7, dry));
      if (h > 0.62) mixInto(land, land, [120, 106, 92], smooth(0.62, 0.72, h));
      const isLand = smooth(0.512, 0.528, h);
      mixInto(o, ocean, land, isLand);
      o[3] = 0.3 + Math.max(0, h - 0.52) * 3 * isLand; o[4] = 1 - isLand;
      const city = n(x * 40 + 3, y * 40, z * 40, 2) * n(x * 6 + 8, y * 6, z * 6, 2);
      o[5] = lat01 < 0.7 ? smooth(0.36, 0.5, city) * smooth(0.53, 0.58, h) * 0.55 : 0;
      if (lat01 > 0.86) { mixInto(o, o, [232, 240, 248], smooth(0.86, 0.92, lat01)); o[4] = 0; o[5] = 0; }
      const c = n(x * 2.6 + 11, y * 5.2, z * 2.6, 5);  // stretched along latitude, like weather bands
      o[6] = smooth(0.5, 0.72, c) * 0.95;
    } },
    moon: { seed: 3, bump: 3.2,
      init() {
        const r = rng(42), craters = [];
        for (let i = 0; i < 140; i++) {
          const u = r() * 2 - 1, th = r() * Math.PI * 2, s = Math.sqrt(1 - u * u);
          craters.push({ x: s * Math.cos(th), y: u, z: s * Math.sin(th), rad: 0.025 + Math.pow(r(), 4) * 0.24 });
        }
        return { craters };
      },
      sample(n, x, y, z, lat, o, st) {
        const base = n(x * 2.4, y * 2.4, z * 2.4, 6);
        const mare = smooth(0.46, 0.38, n(x * 0.9 + 5, y * 0.9, z * 0.9, 4)); // dark "seas"
        let h = 0.5 + (base - 0.5) * 0.6 - mare * 0.08;
        for (const c of st.craters) {
          const dot = x * c.x + y * c.y + z * c.z;
          if (dot < 0.9) continue;
          const d = Math.acos(Math.min(1, dot)) / c.rad;
          if (d < 1) h -= 0.22 * (1 - d * d) * Math.min(1, c.rad * 9);
          else if (d < 1.35) h += 0.09 * (1 - (d - 1) / 0.35) * Math.min(1, c.rad * 9);
        }
        const g = 104 + (base - 0.5) * 90 - mare * 46 + (h - 0.5) * 40;
        o[0] = g; o[1] = g; o[2] = g * 1.03; o[3] = h; o[4] = 0; o[5] = 0; o[6] = 0;
      } },
    mars: { seed: 11, bump: 2.4, init: () => ({}), sample(n, x, y, z, lat, o) {
      const h = n(x * 1.7, y * 1.7, z * 1.7, 6);
      const dark = n(x * 1.1 + 9, y * 1.6, z * 1.1, 5);
      mixInto(o, [126, 52, 24], [206, 112, 62], smooth(0.32, 0.72, h));
      mixInto(o, o, [74, 34, 22], smooth(0.5, 0.36, dark) * 0.65);
      let height = 0.5 + (h - 0.5) * 1.2;
      if (Math.abs(lat) > 1.3) { mixInto(o, o, [240, 230, 224], smooth(1.3, 1.38, Math.abs(lat))); height = 0.55; }
      o[3] = height; o[4] = 0; o[5] = 0; o[6] = 0;
    } },
  };

  function startTexture(name) {
    if (textures[name] || jobs.some((j) => j.name === name)) return;
    const rec = RECIPES[name];
    const size = TEX_W * TEX_H;
    jobs.push({
      name, rec, row: 0, noise: makeNoise(rec.seed), state: rec.init(), o: new Float32Array(7),
      tex: { rgb: new Uint8ClampedArray(size * 3), height: new Float32Array(size), shine: new Uint8Array(size),
             city: new Uint8Array(size), cloud: new Uint8Array(size), gx: new Int8Array(size), gy: new Int8Array(size),
             bump: rec.bump, hasClouds: name === "earth" },
    });
  }

  // Spends about `budgetMs` per frame generating textures, so nothing freezes.
  function workJobs(budgetMs) {
    const until = performance.now() + budgetMs;
    while (jobs.length && performance.now() < until) {
      const j = jobs[0], t = j.tex, o = j.o;
      const ty = j.row;
      const lat = Math.PI / 2 - (ty + 0.5) / TEX_H * Math.PI, cl = Math.cos(lat), sl = Math.sin(lat);
      for (let tx = 0; tx < TEX_W; tx++) {
        const lon = (tx + 0.5) / TEX_W * Math.PI * 2;
        j.rec.sample(j.noise, cl * Math.sin(lon), sl, cl * Math.cos(lon), lat, o, j.state);
        const k = ty * TEX_W + tx;
        t.rgb[k * 3] = o[0]; t.rgb[k * 3 + 1] = o[1]; t.rgb[k * 3 + 2] = o[2];
        t.height[k] = o[3]; t.shine[k] = o[4] * 255; t.city[k] = o[5] * 255; t.cloud[k] = o[6] * 255;
      }
      if (++j.row >= TEX_H) { finishGradients(t); textures[j.name] = t; jobs.shift(); }
    }
  }

  // Height-map slope east/west and north/south, used for bump shading.
  function finishGradients(t) {
    for (let ty = 0; ty < TEX_H; ty++) {
      const up = Math.max(0, ty - 1) * TEX_W, dn = Math.min(TEX_H - 1, ty + 1) * TEX_W, row = ty * TEX_W;
      for (let tx = 0; tx < TEX_W; tx++) {
        const e = (tx + 1) % TEX_W, w = (tx - 1 + TEX_W) % TEX_W;
        const gx = (t.height[row + e] - t.height[row + w]) * 160;
        const gy = (t.height[up + tx] - t.height[dn + tx]) * 160;
        t.gx[row + tx] = Math.max(-127, Math.min(127, gx));
        t.gy[row + tx] = Math.max(-127, Math.min(127, gy));
      }
    }
  }

  // ---------- scenes: what each mission profile shows ----------
  // x/y are fractions of canvas width/height, r a fraction of the shorter side.
  const EARTH_GLOW = [110, 180, 255], MOON_GLOW = [190, 196, 210], MARS_GLOW = [255, 150, 100];
  const SCENES = {
    station: { bodies: [{ tex: "earth", x: 0.5, y: 0.54, r: 0.37, spin: 0.1, glow: EARTH_GLOW, atmo: 1 }],
               craft: { kind: "station", orbit: { cx: 0.5, cy: 0.54, rx: 0.46, ry: 0.12, tilt: -0.16, speed: 0.3 } } },
    lunar_base: { bodies: [{ tex: "moon", x: 0.55, y: 0.56, r: 0.37, spin: 0.05, glow: MOON_GLOW, atmo: 0.15 },
                           { tex: "earth", x: 0.13, y: 0.2, r: 0.085, spin: 0.18, glow: EARTH_GLOW, atmo: 1 }],
                  beacon: { body: 0, lon: 0.04, lat: 0.3 } },
    mars_transit: { bodies: [{ tex: "earth", x: 0.14, y: 0.64, r: 0.11, spin: 0.18, glow: EARTH_GLOW, atmo: 1 },
                             { tex: "mars", x: 0.82, y: 0.4, r: 0.21, spin: 0.08, glow: MARS_GLOW, atmo: 0.45 }],
                    craft: { kind: "ship", path: { from: [0.22, 0.6], ctrl: [0.48, 0.08], to: [0.66, 0.4], speed: 0.06 } } },
    mars_base: { bodies: [{ tex: "mars", x: 0.5, y: 0.55, r: 0.38, spin: 0.06, glow: MARS_GLOW, atmo: 0.45 }],
                 beacon: { body: 0, lon: 0.02, lat: 0.22 } },
    rover: { bodies: [{ tex: "mars", x: 0.5, y: 1.62, r: 1.3, spin: 0.02, glow: MARS_GLOW, atmo: 0.6, tilt: 1.15 }],
             craft: { kind: "rover" } },
  };

  // Sun up and to the left, slightly in front; V = straight at the viewer.
  const SUN = (() => { const v = [-0.62, 0.42, 0.66]; const m = Math.hypot(...v); return v.map((a) => a / m); })();
  const HALF = (() => { const v = [SUN[0], SUN[1], SUN[2] + 1]; const m = Math.hypot(...v); return v.map((a) => a / m); })();

  // Precomputes everything about a sphere of this radius that doesn't change
  // as it spins, only for pixels that land inside the visible canvas.
  // tilt (radians) leans the planet's axis toward the viewer, e.g. so a
  // close-up horizon shows the equator instead of the polar cap.
  function bakeSphere(R, cx, cy, W, H, tilt = 0) {
    const ct = Math.cos(tilt), st = Math.sin(tilt);
    const rot = (v) => [v[0], v[1] * ct - v[2] * st, v[1] * st + v[2] * ct];
    const S = rot(SUN);
    const x0 = Math.max(0, Math.floor(cx - R - 1)), x1 = Math.min(W, Math.ceil(cx + R + 1));
    const y0 = Math.max(0, Math.floor(cy - R - 1)), y1 = Math.min(H, Math.ceil(cy + R + 1));
    const bw = Math.max(0, x1 - x0), bh = Math.max(0, y1 - y0);
    const L = { idx: [], row: [], lon: [], diff: [], spec: [], rim: [], night: [], le: [], ln: [], cov: [] };
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const dx = (px + 0.5 - cx) / R, dy = -(py + 0.5 - cy) / R;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const cov = clamp01((1 - dist) * R + 0.5);       // anti-aliased edge
        if (cov <= 0) continue;
        const d2 = Math.min(1, dx * dx + dy * dy), nz = Math.sqrt(1 - d2);
        const lambert = dx * SUN[0] + dy * SUN[1] + nz * SUN[2];
        const nh = Math.max(0, dx * HALF[0] + dy * HALF[1] + nz * HALF[2]);
        const [nx, ny] = rot([dx, dy, nz]);   // normal in the planet's own (tilted) frame
        const pz = dy * st + nz * ct;
        const day = smooth(-0.15, 0.3, lambert);          // soft day/night line
        const diff = 0.025 + day * (0.18 + 0.9 * Math.max(0, lambert));
        const ex = pz, ez = -nx, em = Math.hypot(ex, ez) || 1;           // east tangent
        const nnx = -nx * ny, nny = pz * pz + nx * nx, nnz = -ny * pz;    // north tangent
        const nm = Math.hypot(nnx, nny, nnz) || 1;
        L.idx.push((py - y0) * bw + (px - x0));
        L.row.push(Math.min(TEX_H - 1, Math.floor((Math.PI / 2 - Math.asin(Math.max(-1, Math.min(1, ny)))) / Math.PI * TEX_H)));
        L.lon.push(Math.atan2(nx, pz) / (Math.PI * 2));
        L.diff.push(diff);
        L.spec.push(Math.pow(nh, 60) * day * 1.1 + Math.pow(nh, 12) * day * 0.12);
        L.rim.push(Math.pow(1 - nz, 2.2) * (0.15 + 0.85 * day));
        L.night.push(1 - smooth(-0.2, 0.05, lambert));
        L.le.push((ex * S[0] + ez * S[2]) / em * day);
        L.ln.push((nnx * S[0] + nny * S[1] + nnz * S[2]) / nm * day);
        L.cov.push(cov);
      }
    }
    const f = (a) => Float32Array.from(a);
    return { x0, y0, bw, bh, idx: Int32Array.from(L.idx), row: Int16Array.from(L.row), lon: f(L.lon), diff: f(L.diff),
             spec: f(L.spec), rim: f(L.rim), night: f(L.night), le: f(L.le), ln: f(L.ln), cov: f(L.cov) };
  }

  function mount(canvas) {
    const ctx = canvas.getContext("2d");
    const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const bg = document.createElement("canvas"), bgx = bg.getContext("2d");
    const prev = document.createElement("canvas"), prevx = prev.getContext("2d");
    let profile = null, scene = null, W = 0, H = 0, dpr = 1, unit = 1;
    let twinkle = [], bodies = [], raf = 0, crossfade = 0;
    const t0 = performance.now();

    Object.keys(RECIPES).forEach(startTexture);

    function resize() {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width) return false;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.round(rect.width * dpr), h = Math.round(rect.height * dpr);
      if (w === W && h === H) return true;
      W = canvas.width = bg.width = prev.width = w; H = canvas.height = bg.height = prev.height = h;
      unit = Math.min(W, H);
      paintBackground();
      buildBodies();
      return true;
    }

    // Static backdrop: deep-space gradient, faint nebula, star field, sun glow.
    function paintBackground() {
      const r = rng(99);
      const g = bgx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, "#0d1a2c"); g.addColorStop(1, "#070c14");
      bgx.fillStyle = g; bgx.fillRect(0, 0, W, H);
      [[0.78, 0.25, "rgba(79,209,197,0.07)"], [0.3, 0.85, "rgba(120,90,200,0.06)"], [0.95, 0.9, "rgba(255,140,90,0.04)"]]
        .forEach(([x, y, c]) => {
          const n = bgx.createRadialGradient(x * W, y * H, 0, x * W, y * H, unit * 0.7);
          n.addColorStop(0, c); n.addColorStop(1, "rgba(0,0,0,0)");
          bgx.fillStyle = n; bgx.fillRect(0, 0, W, H);
        });
      const count = Math.round(W * H / 1800);
      twinkle = [];
      for (let i = 0; i < count; i++) {
        const s = { x: r() * W, y: r() * H, size: (r() < 0.92 ? 0.6 + r() * 0.7 : 1.4 + r()) * dpr, a: 0.25 + r() * 0.6, p: r() * 6.28 };
        if (r() < 0.15) twinkle.push(s);
        else { bgx.fillStyle = `rgba(232,238,244,${s.a})`; bgx.fillRect(s.x, s.y, s.size, s.size); }
      }
      const sun = bgx.createRadialGradient(-0.02 * W, 0.02 * H, 0, -0.02 * W, 0.02 * H, unit * 0.75);
      sun.addColorStop(0, "rgba(255,236,200,0.28)"); sun.addColorStop(0.25, "rgba(255,220,170,0.08)"); sun.addColorStop(1, "rgba(255,220,170,0)");
      bgx.fillStyle = sun; bgx.fillRect(0, 0, W, H);
    }

    function buildBodies() {
      if (!scene || !W) return;
      const old = bodies;
      bodies = scene.bodies.map((b, i) => {
        const R = Math.max(6, Math.round(b.r * unit)), cx = b.x * W, cy = b.y * H;
        const bake = bakeSphere(R, cx, cy, W, H, b.tilt || 0);
        const off = document.createElement("canvas");
        off.width = Math.max(1, bake.bw); off.height = Math.max(1, bake.bh);
        const octx = off.getContext("2d");
        return { ...b, R, cx, cy, bake, off, octx, img: bake.bw && bake.bh ? octx.createImageData(bake.bw, bake.bh) : null,
                 // a resize keeps the planet visible; only a new scene fades in
                 shown: old[i] && old[i].tex === b.tex && old[i].scene === scene ? old[i].shown : 0, scene };
      });
    }

    function drawSphere(b, t) {
      const tex = textures[b.tex];
      if (!tex || !b.img) return;
      b.shown = Math.min(1, b.shown + 0.04);                 // fade in once the texture is ready
      const { idx, row, lon, diff, spec, rim, night, le, ln, cov } = b.bake;
      const out = b.img.data, rgb = tex.rgb, rot = (t * b.spin) / (Math.PI * 2), crot = rot * 1.35 + 0.3;
      const [gr, gg, gb] = b.glow, atmo = b.atmo, bump = tex.bump / 127, clouds = tex.hasClouds;
      for (let i = 0; i < idx.length; i++) {
        let u = lon[i] + rot; u -= Math.floor(u);
        const k = row[i] * TEX_W + ((u * TEX_W) | 0);
        let light = diff[i] * (1 + (tex.gx[k] * le[i] + tex.gy[k] * ln[i]) * bump);
        if (light < 0) light = 0;
        let r = rgb[k * 3] * light, g = rgb[k * 3 + 1] * light, bl = rgb[k * 3 + 2] * light;
        const sh = tex.shine[k] * spec[i] * 0.004;
        r += 255 * sh * 0.85; g += 255 * sh * 0.9; bl += 255 * sh;
        let cloud = 0;
        if (clouds) {
          let cu = lon[i] + crot; cu -= Math.floor(cu);
          cloud = tex.cloud[row[i] * TEX_W + ((cu * TEX_W) | 0)] / 255;
          if (cloud) { const cl = 250 * Math.min(1.1, diff[i] * 1.05); r += (cl - r) * cloud; g += (cl - g) * cloud; bl += (cl + 4 - bl) * cloud; }
        }
        const city = tex.city[k] * night[i] * (1 - cloud) * 0.9;
        r += city; g += city * 0.72; bl += city * 0.4;
        const a = rim[i] * atmo;
        r += gr * a; g += gg * a; bl += gb * a;
        const o = idx[i] * 4;
        out[o] = r; out[o + 1] = g; out[o + 2] = bl; out[o + 3] = cov[i] * 255 * b.shown;
      }
      b.octx.putImageData(b.img, 0, 0);
      // thin outer haze, a little brighter toward the sun
      const hx = b.cx + SUN[0] * b.R * 0.05, hy = b.cy - SUN[1] * b.R * 0.05;
      const halo = ctx.createRadialGradient(hx, hy, b.R * 0.96, hx, hy, b.R * (1.06 + 0.1 * atmo));
      halo.addColorStop(0, `rgba(${gr},${gg},${gb},${(0.18 + 0.3 * atmo) * b.shown})`);
      halo.addColorStop(1, `rgba(${gr},${gg},${gb},0)`);
      ctx.fillStyle = halo;
      ctx.beginPath(); ctx.arc(hx, hy, b.R * 1.2, 0, Math.PI * 2); ctx.fill();
      ctx.drawImage(b.off, b.bake.x0, b.bake.y0);
    }

    function drawBeacon(beacon, t) {
      const b = bodies[beacon.body];
      if (!b || !b.shown) return;
      // A point on the surface, so it turns with the planet and hides behind it.
      const lon = beacon.lon * Math.PI * 2 - t * b.spin, lat = beacon.lat;
      const z = Math.cos(lat) * Math.cos(lon);
      if (z < 0.05) return;
      const x = b.cx + Math.cos(lat) * Math.sin(lon) * b.R, y = b.cy - Math.sin(lat) * b.R;
      const pulse = (t * 0.8) % 1;
      ctx.strokeStyle = `rgba(79,209,197,${(1 - pulse) * 0.8 * z})`;
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath(); ctx.ellipse(x, y, (4 + pulse * 16) * dpr, (4 + pulse * 16) * dpr * z, 0, 0, Math.PI * 2); ctx.stroke();
      const core = ctx.createRadialGradient(x, y, 0, x, y, 7 * dpr);
      core.addColorStop(0, "rgba(180,255,245,1)"); core.addColorStop(0.35, "rgba(79,209,197,0.8)"); core.addColorStop(1, "rgba(79,209,197,0)");
      ctx.fillStyle = core; ctx.beginPath(); ctx.arc(x, y, 7 * dpr, 0, Math.PI * 2); ctx.fill();
    }

    function drawStation(x, y, s, alpha) {
      ctx.save(); ctx.translate(x, y); ctx.globalAlpha = alpha;
      ctx.fillStyle = "#3d74b8"; ctx.fillRect(-11 * s, -2.2 * s, 7 * s, 4.4 * s); ctx.fillRect(4 * s, -2.2 * s, 7 * s, 4.4 * s);
      ctx.strokeStyle = "rgba(160,200,255,0.6)"; ctx.lineWidth = 0.5 * s;
      for (let i = -10; i <= 10; i += 2) if (Math.abs(i) > 4) { ctx.beginPath(); ctx.moveTo(i * s, -2.2 * s); ctx.lineTo(i * s, 2.2 * s); ctx.stroke(); }
      ctx.fillStyle = "#d9e1ea"; ctx.fillRect(-4 * s, -0.6 * s, 8 * s, 1.2 * s); ctx.fillRect(-1.6 * s, -1.8 * s, 3.2 * s, 3.6 * s);
      ctx.fillStyle = "rgba(255,90,79,0.9)"; ctx.beginPath(); ctx.arc(0, -2.2 * s, 0.7 * s, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    function drawShip(x, y, angle, s, t) {
      ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
      const len = 16 + Math.sin(t * 20) * 2;
      const flame = ctx.createLinearGradient(-len * s, 0, -4 * s, 0);
      flame.addColorStop(0, "rgba(79,209,197,0)"); flame.addColorStop(1, "rgba(190,255,245,0.95)");
      ctx.fillStyle = flame; ctx.beginPath(); ctx.moveTo(-4 * s, -1.6 * s); ctx.lineTo(-len * s, 0); ctx.lineTo(-4 * s, 1.6 * s); ctx.fill();
      const body = ctx.createLinearGradient(0, -3 * s, 0, 3 * s);
      body.addColorStop(0, "#ffffff"); body.addColorStop(1, "#8fa3b8");
      ctx.fillStyle = body;
      ctx.beginPath(); ctx.moveTo(8 * s, 0); ctx.quadraticCurveTo(2 * s, -3 * s, -4 * s, -2.6 * s); ctx.lineTo(-4 * s, 2.6 * s); ctx.quadraticCurveTo(2 * s, 3 * s, 8 * s, 0); ctx.fill();
      ctx.restore();
    }

    function drawCraft(craft, t) {
      const s = dpr * Math.max(1.1, unit / dpr / 200);
      if (craft.kind === "station") {
        const o = craft.orbit, a = t * o.speed;
        const ex = Math.cos(a) * o.rx * W, ey = Math.sin(a) * o.ry * H;
        const x = o.cx * W + ex * Math.cos(o.tilt) - ey * Math.sin(o.tilt);
        const y = o.cy * H + ex * Math.sin(o.tilt) + ey * Math.cos(o.tilt);
        // behind the planet (top half of the orbit) it's hidden by drawing order
        return { behind: Math.sin(a) < 0, draw: () => drawStation(x, y, s, 1) };
      }
      if (craft.kind === "ship") {
        const p = craft.path, k = (t * p.speed) % 1;
        const q = (u) => [0, 1].map((i) => ((1 - u) ** 2) * p.from[i] + 2 * (1 - u) * u * p.ctrl[i] + u * u * p.to[i]);
        ctx.lineWidth = 1.2 * dpr; ctx.setLineDash([3 * dpr, 7 * dpr]);
        ctx.strokeStyle = "rgba(147,164,181,0.35)";
        ctx.beginPath();
        for (let u = 0; u <= 1.0001; u += 0.02) { const [px, py] = q(u); u === 0 ? ctx.moveTo(px * W, py * H) : ctx.lineTo(px * W, py * H); }
        ctx.stroke();
        ctx.strokeStyle = "rgba(79,209,197,0.75)"; ctx.setLineDash([]);  // the part already flown
        ctx.beginPath();
        for (let u = 0; u <= k; u += 0.01) { const [px, py] = q(u); u === 0 ? ctx.moveTo(px * W, py * H) : ctx.lineTo(px * W, py * H); }
        ctx.stroke();
        const [x, y] = q(k), [x2, y2] = q(Math.min(1, k + 0.01));
        const fadeEnds = Math.min(1, k * 12, (1 - k) * 12);
        ctx.globalAlpha = fadeEnds; drawShip(x * W, y * H, Math.atan2((y2 - y) * H, (x2 - x) * W), s, t); ctx.globalAlpha = 1;
        return null;
      }
      if (craft.kind === "rover") {
        const b = bodies[0];
        if (!b || !b.shown) return null;
        const x = W * 0.5 + Math.sin(t * 0.2) * W * 0.16;
        const y = b.cy - Math.sqrt(Math.max(0, b.R * b.R - (x - b.cx) ** 2));
        const tilt = Math.asin((x - b.cx) / b.R);
        ctx.save(); ctx.translate(x, y); ctx.rotate(tilt); ctx.globalAlpha = b.shown;
        const sh = ctx.createRadialGradient(0, 0, 0, 0, 0, 14 * s); sh.addColorStop(0, "rgba(0,0,0,0.35)"); sh.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = sh; ctx.fillRect(-14 * s, -2 * s, 28 * s, 5 * s);
        ctx.fillStyle = "#4a5866"; ctx.fillRect(-8 * s, -4 * s, 16 * s, 1.4 * s);
        const bodyG = ctx.createLinearGradient(0, -9 * s, 0, -4 * s); bodyG.addColorStop(0, "#f2f5f8"); bodyG.addColorStop(1, "#aab6c3");
        ctx.fillStyle = bodyG; ctx.fillRect(-8 * s, -9 * s, 16 * s, 5 * s);
        ctx.fillStyle = "#4fd1c5"; ctx.fillRect(2 * s, -8 * s, 5 * s, 2.4 * s);
        ctx.strokeStyle = "#aab6c3"; ctx.lineWidth = 0.8 * s; ctx.beginPath(); ctx.moveTo(-6 * s, -9 * s); ctx.lineTo(-6 * s, -14 * s); ctx.stroke();
        ctx.fillStyle = `rgba(79,209,197,${0.5 + 0.5 * Math.sin(t * 4)})`; ctx.beginPath(); ctx.arc(-6 * s, -14 * s, 1.1 * s, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#1c2530";
        [-6, 0, 6].forEach((wx) => { ctx.beginPath(); ctx.arc(wx * s, -2 * s, 2.2 * s, 0, Math.PI * 2); ctx.fill(); });
        ctx.restore(); ctx.globalAlpha = 1;
        return null;
      }
      return null;
    }

    function frame(now) {
      raf = 0;
      if (!canvas.isConnected) return;
      workJobs(jobs.length && !bodies.some((b) => textures[b.tex]) ? 14 : 6);
      const visible = canvas.offsetParent !== null && document.visibilityState === "visible";
      if (visible && resize() && scene) {
        const t = reduceMotion ? 6 : (now - t0) / 1000;
        ctx.drawImage(bg, 0, 0);
        twinkle.forEach((st) => {
          ctx.fillStyle = `rgba(232,238,244,${st.a * (0.35 + 0.65 * Math.sin(t * 1.4 + st.p) ** 2)})`;
          ctx.fillRect(st.x, st.y, st.size, st.size);
        });
        const craft = scene.craft ? drawCraft(scene.craft, t) : null;
        if (craft && craft.behind) craft.draw();
        bodies.forEach((b) => drawSphere(b, t));
        if (craft && !craft.behind) craft.draw();
        if (scene.beacon) drawBeacon(scene.beacon, t);
        if (crossfade > 0) {                                    // old scene dissolving away
          ctx.globalAlpha = crossfade; ctx.drawImage(prev, 0, 0); ctx.globalAlpha = 1;
          crossfade = Math.max(0, crossfade - 0.045);
        }
        const settled = bodies.every((b) => b.shown >= 1) && crossfade === 0;
        if (reduceMotion && settled && !jobs.length) return;   // one still frame is enough
      }
      raf = requestAnimationFrame(frame);
    }

    function kick() { if (!raf) raf = requestAnimationFrame(frame); }
    window.addEventListener("resize", () => { W = 0; kick(); });
    document.addEventListener("visibilitychange", kick);

    return {
      setProfile(id) {
        if (id === profile) { kick(); return; }
        if (profile && W) { prevx.clearRect(0, 0, W, H); prevx.drawImage(canvas, 0, 0); crossfade = 1; }
        profile = id;
        scene = SCENES[id] || SCENES.station;
        // generate the textures this scene needs first
        scene.bodies.slice().reverse().forEach((b) => {
          const i = jobs.findIndex((j) => j.name === b.tex);
          if (i > 0) jobs.unshift(jobs.splice(i, 1)[0]);
        });
        buildBodies();
        kick();
      },
      kick,
    };
  }

  return { mount };
})();
