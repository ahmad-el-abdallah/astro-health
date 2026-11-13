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
// Planet3D.mount(canvas) -> scene;  scene.setProfile("artemis2");
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

  // ---------- scenes: one per real mission (config/missions.json) ----------
  // x/y are fractions of canvas width/height, r a fraction of the shorter side.
  // Each scene's objects match its mission: the ISS + a Crew Dragon for Crew-13,
  // the ISS, an Earth marker and a turning DNA helix for the Twin Study, Orion on
  // a figure-8 free-return path through the Van Allen belts for Artemis II, the
  // sealed Mars-520 habitat dreaming of a Mars it never reached, and an astronaut
  // tethered to the ISS truss above Earth's horizon for spacewalks.
  const EARTH_GLOW = [110, 180, 255], MOON_GLOW = [190, 196, 210], MARS_GLOW = [255, 150, 100];
  const SCENES = {
    crew13_iss: {
      bodies: [{ tex: "earth", x: 0.5, y: 0.6, r: 0.4, spin: 0.08, glow: EARTH_GLOW, atmo: 1 }],
      craft: { kind: "iss", dragon: true, orbit: { cx: 0.5, cy: 0.6, rx: 0.44, ry: 0.13, tilt: -0.14, speed: 0.22 } },
    },
    twin_study: {
      bodies: [{ tex: "earth", x: 0.34, y: 0.56, r: 0.32, spin: 0.08, glow: EARTH_GLOW, atmo: 1 }],
      craft: { kind: "iss", orbit: { cx: 0.34, cy: 0.56, rx: 0.3, ry: 0.11, tilt: -0.16, speed: 0.26 } },
      beacon: { body: 0, lon: 0.06, lat: 0.5, link: true },
      helix: { x: 0.82, y: 0.5, h: 0.78, w: 0.07 },
    },
    artemis2: {
      bodies: [{ tex: "earth", x: 0.2, y: 0.58, r: 0.13, spin: 0.14, glow: EARTH_GLOW, atmo: 1 },
               { tex: "moon", x: 0.8, y: 0.42, r: 0.11, spin: 0.04, glow: MOON_GLOW, atmo: 0.15 }],
      belts: { body: 0, rings: [1.9, 2.9] },
      craft: { kind: "orion", speed: 0.045,
               pts: [[0.29, 0.55], [0.46, 0.66], [0.66, 0.58], [0.86, 0.5], [0.9, 0.36], [0.8, 0.27], [0.66, 0.29], [0.46, 0.44], [0.3, 0.6], [0.2, 0.74], [0.11, 0.6], [0.17, 0.45]] },
    },
    mars520: {
      bodies: [{ tex: "earth", x: 0.13, y: 0.26, r: 0.075, spin: 0.16, glow: EARTH_GLOW, atmo: 1 },
               { tex: "mars", x: 0.86, y: 0.28, r: 0.12, spin: 0.07, glow: MARS_GLOW, atmo: 0.45 }],
      craft: { kind: "habitat", loop: { from: [0.2, 0.28], to: [0.78, 0.3], up: 0.04, down: 0.5, speed: 0.05 } },
    },
    spacewalk: {
      bodies: [{ tex: "earth", x: 0.5, y: 2.05, r: 1.55, spin: 0.012, glow: EARTH_GLOW, atmo: 1.2, tilt: 1.05 }],
      craft: { kind: "eva" },
    },
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

    // ---- small drawing helpers ----
    const lin = (x0, y0, x1, y1, stops) => {
      const g = ctx.createLinearGradient(x0, y0, x1, y1);
      stops.forEach(([o, c]) => g.addColorStop(o, c));
      return g;
    };
    function rrect(x, y, w, h, r) {
      ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
    }
    // A shaded cylinder lying along x (from x0 to x1), radius r: body + lit end cap.
    function cylinder(x0, x1, cy, r, light, dark) {
      ctx.fillStyle = lin(0, cy - r, 0, cy + r, [[0, dark], [0.28, light], [0.55, light], [1, dark]]);
      ctx.fillRect(x0, cy - r, x1 - x0, 2 * r);
      ctx.fillStyle = lin(x1 - r * 0.35, 0, x1 + r * 0.35, 0, [[0, light], [1, dark]]);
      ctx.beginPath(); ctx.ellipse(x1, cy, r * 0.35, r, 0, 0, Math.PI * 2); ctx.fill();
    }

    // Where a point on a planet's surface is on screen (null when it's on the far side).
    function surfacePoint(beacon, t) {
      const b = bodies[beacon.body];
      if (!b || !b.shown) return null;
      const lon = beacon.lon * Math.PI * 2 - t * b.spin, lat = beacon.lat;
      const z = Math.cos(lat) * Math.cos(lon);
      return { x: b.cx + Math.cos(lat) * Math.sin(lon) * b.R, y: b.cy - Math.sin(lat) * b.R, z };
    }

    function drawBeacon(beacon, t) {
      const p = surfacePoint(beacon, t);
      if (!p || p.z < 0.05) return null;
      const { x, y, z } = p, pulse = (t * 0.8) % 1;
      ctx.strokeStyle = `rgba(79,209,197,${(1 - pulse) * 0.8 * z})`;
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath(); ctx.ellipse(x, y, (4 + pulse * 16) * dpr, (4 + pulse * 16) * dpr * z, 0, 0, Math.PI * 2); ctx.stroke();
      const core = ctx.createRadialGradient(x, y, 0, x, y, 7 * dpr);
      core.addColorStop(0, "rgba(180,255,245,1)"); core.addColorStop(0.35, "rgba(79,209,197,0.8)"); core.addColorStop(1, "rgba(79,209,197,0)");
      ctx.fillStyle = core; ctx.beginPath(); ctx.arc(x, y, 7 * dpr, 0, Math.PI * 2); ctx.fill();
      return p;
    }

    // ISS: long truss, four pairs of solar wings that slowly turn (so they catch
    // the light in 3D), white radiators and the pressurised modules in the middle.
    function drawISS(x, y, s, t, alpha = 1) {
      ctx.save(); ctx.translate(x, y); ctx.globalAlpha *= alpha;
      const turn = 0.55 + 0.45 * Math.cos(t * 0.35);              // wing angle to the viewer
      ctx.fillStyle = lin(0, -0.9 * s, 0, 0.9 * s, [[0, "#c9d3de"], [0.5, "#8996a6"], [1, "#4d5866"]]);
      ctx.fillRect(-16 * s, -0.7 * s, 32 * s, 1.4 * s);           // main truss
      [-14, -10.5, 10.5, 14].forEach((wx) => {                     // solar wings above and below
        [-1, 1].forEach((side) => {
          const h = 6.2 * s * turn, yy = side < 0 ? -0.7 * s - h : 0.7 * s;
          ctx.fillStyle = lin(0, yy, 0, yy + h, side < 0
            ? [[0, "#2a4f8a"], [1, `rgba(${120 + 100 * turn | 0},${150 + 70 * turn | 0},230,1)`]]
            : [[0, `rgba(${120 + 100 * turn | 0},${150 + 70 * turn | 0},230,1)`], [1, "#22416f"]]);
          ctx.fillRect((wx - 1.3) * s, yy, 2.6 * s, h);
          ctx.strokeStyle = "rgba(255,214,140,0.55)"; ctx.lineWidth = 0.25 * s;
          for (let k = 1; k < 4; k++) { ctx.beginPath(); ctx.moveTo((wx - 1.3) * s, yy + h * k / 4); ctx.lineTo((wx + 1.3) * s, yy + h * k / 4); ctx.stroke(); }
        });
      });
      ctx.fillStyle = "rgba(236,242,248,0.9)";                      // radiators
      ctx.fillRect(-6.5 * s, 0.7 * s, 1.6 * s, 3.2 * s); ctx.fillRect(4.9 * s, 0.7 * s, 1.6 * s, 3.2 * s);
      ctx.save(); ctx.rotate(Math.PI / 2);                          // modules run across the truss
      cylinder(-3.2 * s, 3.4 * s, 0, 1.05 * s, "#f4f7fa", "#8e9aa8");
      ctx.restore();
      cylinder(-2.6 * s, 2.6 * s, -0.1 * s, 0.75 * s, "#eef2f6", "#97a3b1");
      ctx.fillStyle = `rgba(255,90,79,${0.6 + 0.4 * Math.sin(t * 3)})`;
      ctx.beginPath(); ctx.arc(0, -3.6 * s, 0.45 * s, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // Crew Dragon: white capsule with a dark nose band, its trunk behind it.
    function drawDragon(x, y, s, angle) {
      ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
      ctx.fillStyle = lin(0, -2 * s, 0, 2 * s, [[0, "#3b4552"], [0.5, "#79879a"], [1, "#2a323c"]]);
      ctx.fillRect(-4.2 * s, -1.9 * s, 2.4 * s, 3.8 * s);           // trunk
      ctx.fillStyle = lin(0, -2.2 * s, 0, 2.2 * s, [[0, "#9aa6b4"], [0.35, "#ffffff"], [1, "#8592a2"]]);
      ctx.beginPath(); ctx.moveTo(-1.8 * s, -2.2 * s); ctx.lineTo(1.6 * s, -1.1 * s); ctx.quadraticCurveTo(2.6 * s, 0, 1.6 * s, 1.1 * s); ctx.lineTo(-1.8 * s, 2.2 * s); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#1d2530"; ctx.fillRect(0.9 * s, -1.25 * s, 0.6 * s, 2.5 * s);
      ctx.restore();
    }

    // Orion: grey capsule on a service module with four solar wings in an X.
    function drawOrion(x, y, angle, s, t) {
      ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
      const wing = 0.6 + 0.4 * Math.cos(t * 0.8);
      [[-1, -1], [-1, 1]].forEach(([, sd]) => {
        ctx.fillStyle = lin(0, 0, 0, sd * 7 * s * wing, [[0, "#2f5a98"], [1, "#7aa6e8"]]);
        ctx.beginPath(); ctx.moveTo(-3.4 * s, 0); ctx.lineTo(-6.8 * s, sd * 6.6 * s * wing); ctx.lineTo(-4.8 * s, sd * 7.2 * s * wing); ctx.lineTo(-2 * s, 0); ctx.fill();
      });
      ctx.fillStyle = lin(0, -2 * s, 0, 2 * s, [[0, "#5d6977"], [0.45, "#dfe5ec"], [1, "#4a5562"]]);
      rrect(-5 * s, -1.9 * s, 4 * s, 3.8 * s, 0.6 * s); ctx.fill();   // service module
      ctx.fillStyle = lin(0, -2.6 * s, 0, 2.6 * s, [[0, "#8c96a3"], [0.35, "#f6f8fa"], [1, "#77818e"]]);
      ctx.beginPath(); ctx.moveTo(-1 * s, -2.6 * s); ctx.lineTo(3.4 * s, -0.7 * s); ctx.lineTo(3.4 * s, 0.7 * s); ctx.lineTo(-1 * s, 2.6 * s); ctx.closePath(); ctx.fill();
      const glow = ctx.createRadialGradient(-5.4 * s, 0, 0, -5.4 * s, 0, 3 * s);
      glow.addColorStop(0, "rgba(190,255,245,0.55)"); glow.addColorStop(1, "rgba(79,209,197,0)");
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(-5.4 * s, 0, 3 * s, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // Closed Catmull-Rom curve through the free-return points (fractions of W/H).
    function loopPoint(pts, u) {
      const n = pts.length, f = ((u % 1) + 1) % 1 * n, i = Math.floor(f), k = f - i;
      const P = (j) => pts[(j + n) % n];
      const [p0, p1, p2, p3] = [P(i - 1), P(i), P(i + 1), P(i + 2)];
      return [0, 1].map((d) => 0.5 * ((2 * p1[d]) + (-p0[d] + p2[d]) * k + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * k * k + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * k * k * k));
    }

    // Van Allen belts: soft rings around Earth, back half drawn behind the planet.
    function drawBelts(belts, front, t) {
      const b = bodies[belts.body];
      if (!b || !b.shown) return;
      belts.rings.forEach((k, i) => {
        const rx = b.R * k, ry = b.R * k * 0.34, a = (0.16 + 0.06 * Math.sin(t * 1.2 + i)) * b.shown;
        ctx.lineWidth = b.R * (0.22 - i * 0.05);
        ctx.strokeStyle = i ? `rgba(255,170,110,${a})` : `rgba(140,200,255,${a})`;
        ctx.beginPath(); ctx.ellipse(b.cx, b.cy, rx, ry, -0.2, front ? 0 : Math.PI, front ? Math.PI : Math.PI * 2); ctx.stroke();
      });
    }

    // Mars-520 habitat: the real facility was 5 sealed, connected modules.
    function drawHabitat(cx, cy, s, t) {
      const sh = ctx.createRadialGradient(cx, cy + 9 * s, 0, cx, cy + 9 * s, 34 * s);
      sh.addColorStop(0, "rgba(79,209,197,0.12)"); sh.addColorStop(1, "rgba(79,209,197,0)");
      ctx.fillStyle = sh; ctx.beginPath(); ctx.ellipse(cx, cy + 9 * s, 34 * s, 7 * s, 0, 0, Math.PI * 2); ctx.fill();
      cylinder(cx - 26 * s, cx - 12 * s, cy + 2 * s, 3.2 * s, "#e7ecf2", "#6f7c8b");   // living module
      cylinder(cx - 12 * s, cx + 8 * s, cy, 5.2 * s, "#f1f4f8", "#788596");            // main ship module
      cylinder(cx + 8 * s, cx + 18 * s, cy + 2.6 * s, 2.6 * s, "#e3e9ef", "#6c7988");   // storage / greenhouse
      cylinder(cx + 18 * s, cx + 24 * s, cy + 3.2 * s, 2 * s, "#d7dee6", "#647181");     // lander
      ctx.fillStyle = lin(cx + 22 * s, cy - 4 * s, cx + 34 * s, cy + 6 * s, [[0, "#c8693a"], [1, "#6e2e18"]]);
      ctx.beginPath(); ctx.moveTo(cx + 25 * s, cy + 6 * s); ctx.quadraticCurveTo(cx + 30 * s, cy - 2 * s, cx + 36 * s, cy + 6 * s); ctx.closePath(); ctx.fill(); // 'Mars surface' module
      for (let i = 0; i < 6; i++) {                                      // lit windows
        const on = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 0.6 + i * 1.7));
        ctx.fillStyle = `rgba(255,214,140,${on})`;
        ctx.beginPath(); ctx.arc(cx - 9 * s + i * 3 * s, cy - 1.4 * s, 0.7 * s, 0, Math.PI * 2); ctx.fill();
      }
      ctx.font = `${Math.round(10 * dpr)}px Inter, system-ui, sans-serif`;
      ctx.fillStyle = "rgba(200,212,226,0.75)"; ctx.textAlign = "center";
      ctx.fillText("GROUND SIMULATION · MOSCOW", cx + 5 * s, cy + 13 * s);
      ctx.textAlign = "start";
    }

    // Astronaut in a white EMU suit with a gold visor, floating on a tether.
    function drawAstronaut(x, y, s, t) {
      ctx.save(); ctx.translate(x, y); ctx.rotate(Math.sin(t * 0.4) * 0.22);
      ctx.fillStyle = lin(-6 * s, 0, 6 * s, 0, [[0, "#8c97a4"], [1, "#d6dde5"]]);   // backpack
      rrect(-6 * s, -6.5 * s, 12 * s, 13 * s, 2 * s); ctx.fill();
      ctx.lineCap = "round";
      const limb = (x0, y0, x1, y1, w) => {
        ctx.strokeStyle = lin(x0, y0, x1, y1, [[0, "#f5f7fa"], [1, "#b9c3ce"]]); ctx.lineWidth = w * s;
        ctx.beginPath(); ctx.moveTo(x0 * s, y0 * s); ctx.lineTo(x1 * s, y1 * s); ctx.stroke();
      };
      const wave = Math.sin(t * 0.9) * 1.5;
      limb(-4.5, -2, -9, 3 + wave, 3.2); limb(4.5, -2, 8.5, -6 - wave, 3.2);         // arms
      limb(-2.4, 6, -4, 13 + wave * 0.5, 3.6); limb(2.4, 6, 4.6, 12.5 - wave * 0.5, 3.6); // legs
      ctx.fillStyle = "#e9eef3"; [[-9, 3 + wave], [8.5, -6 - wave]].forEach(([gx, gy]) => { ctx.beginPath(); ctx.arc(gx * s, gy * s, 1.6 * s, 0, Math.PI * 2); ctx.fill(); });
      ctx.fillStyle = lin(-5 * s, -5 * s, 5 * s, 7 * s, [[0, "#ffffff"], [0.6, "#dbe2e9"], [1, "#9fabb8"]]);
      rrect(-4.8 * s, -5 * s, 9.6 * s, 12 * s, 3 * s); ctx.fill();                   // torso
      ctx.fillStyle = "#c0392b"; ctx.fillRect(-4.8 * s, 1 * s, 9.6 * s, 0.9 * s);     // suit stripe
      ctx.fillStyle = "#5b6878"; rrect(-2.6 * s, -2.4 * s, 5.2 * s, 2.6 * s, 0.6 * s); ctx.fill(); // chest controls
      const helm = ctx.createRadialGradient(-1.6 * s, -10.5 * s, 0.5 * s, 0, -9 * s, 5 * s);
      helm.addColorStop(0, "#ffffff"); helm.addColorStop(1, "#a9b4c0");
      ctx.fillStyle = helm; ctx.beginPath(); ctx.arc(0, -9 * s, 4.6 * s, 0, Math.PI * 2); ctx.fill();
      const visor = ctx.createLinearGradient(-3 * s, -11 * s, 3 * s, -7 * s);
      visor.addColorStop(0, "#ffe7a3"); visor.addColorStop(0.45, "#d29a2c"); visor.addColorStop(1, "#5a3c0c");
      ctx.fillStyle = visor; ctx.beginPath(); ctx.ellipse(0.4 * s, -8.8 * s, 3.3 * s, 2.7 * s, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(160,210,255,0.5)"; ctx.beginPath(); ctx.ellipse(-0.8 * s, -9.8 * s, 1.3 * s, 0.6 * s, -0.5, 0, Math.PI * 2); ctx.fill(); // Earth glint
      ctx.restore();
    }

    // DNA double helix turning in 3D: depth sorts the beads, so strands pass in front and behind.
    function drawHelix(hx, t) {
      const n = 22, cx = hx.x * W, top = (hx.y - hx.h / 2) * H, step = hx.h * H / (n - 1), w = hx.w * W;
      const beads = [];
      for (let i = 0; i < n; i++) {
        const a = i * 0.52 + t * 0.9, y = top + i * step;
        const p = [[Math.sin(a), Math.cos(a)], [Math.sin(a + Math.PI), Math.cos(a + Math.PI)]];
        const za = p[0][1], zb = p[1][1];
        ctx.strokeStyle = `rgba(200,212,226,${0.18 + 0.12 * Math.abs(za)})`; ctx.lineWidth = 1.6 * dpr;
        ctx.beginPath(); ctx.moveTo(cx + p[0][0] * w, y); ctx.lineTo(cx + p[1][0] * w, y); ctx.stroke();
        beads.push({ x: cx + p[0][0] * w, y, z: za, c: [79, 209, 197] }, { x: cx + p[1][0] * w, y, z: zb, c: [167, 139, 250] });
      }
      beads.sort((a, b) => a.z - b.z).forEach((b) => {
        const r = (2.4 + 1.6 * (b.z + 1) / 2) * dpr, a = 0.45 + 0.55 * (b.z + 1) / 2;
        const g = ctx.createRadialGradient(b.x - r * 0.35, b.y - r * 0.35, 0, b.x, b.y, r);
        g.addColorStop(0, `rgba(255,255,255,${a})`); g.addColorStop(0.4, `rgba(${b.c[0]},${b.c[1]},${b.c[2]},${a})`); g.addColorStop(1, `rgba(${b.c[0] * 0.4 | 0},${b.c[1] * 0.4 | 0},${b.c[2] * 0.5 | 0},${a})`);
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, Math.PI * 2); ctx.fill();
      });
      ctx.font = `${Math.round(10 * dpr)}px Inter, system-ui, sans-serif`;
      ctx.fillStyle = "rgba(200,212,226,0.75)"; ctx.textAlign = "center";
      ctx.fillText("1,000+ GENES CHANGED IN SPACE", cx, top + hx.h * H + 16 * dpr);
      ctx.textAlign = "start";
    }

    function drawCraft(craft, t) {
      const s = dpr * Math.max(1.1, unit / dpr / 200);
      if (craft.kind === "iss") {
        const o = craft.orbit, a = t * o.speed;
        const pos = (ang) => {
          const ex = Math.cos(ang) * o.rx * W, ey = Math.sin(ang) * o.ry * H;
          return [o.cx * W + ex * Math.cos(o.tilt) - ey * Math.sin(o.tilt), o.cy * H + ex * Math.sin(o.tilt) + ey * Math.cos(o.tilt)];
        };
        const [x, y] = pos(a), depth = 0.85 + 0.25 * Math.sin(a);       // nearer = bigger: reads as 3D
        // faint orbit line so the path around Earth is visible
        ctx.strokeStyle = "rgba(147,164,181,0.16)"; ctx.lineWidth = 1 * dpr; ctx.setLineDash([2 * dpr, 6 * dpr]);
        ctx.beginPath(); for (let u = 0; u <= 6.3; u += 0.05) { const [px, py] = pos(u); u === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py); } ctx.stroke(); ctx.setLineDash([]);
        const draw = () => {
          drawISS(x, y, s * 1.7 * depth, t);
          if (craft.dragon) {                                            // Dragon docked at the front port
            const [dx, dy] = pos(a + 0.012);
            drawDragon(x + 9.2 * s * depth, y - 6.8 * s * depth, s * 1.25 * depth, Math.atan2(dy - y, dx - x) - Math.PI / 2);
          }
        };
        return { behind: Math.sin(a) < 0, draw, x, y };
      }
      if (craft.kind === "orion") {
        const k = (t * craft.speed) % 1, P = (u) => { const [px, py] = loopPoint(craft.pts, u); return [px * W, py * H]; };
        ctx.lineWidth = 1.2 * dpr; ctx.setLineDash([3 * dpr, 7 * dpr]); ctx.strokeStyle = "rgba(147,164,181,0.35)";
        ctx.beginPath(); for (let u = 0; u <= 1.0001; u += 0.005) { const [px, py] = P(u); u === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py); } ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = "rgba(79,209,197,0.8)"; ctx.lineWidth = 1.6 * dpr;   // the last stretch flown
        ctx.beginPath(); for (let i = 0; i <= 30; i++) { const [px, py] = P(k - 0.12 + i * 0.004); i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py); } ctx.stroke();
        const [x, y] = P(k), [x2, y2] = P(k + 0.003);
        return { behind: false, draw: () => drawOrion(x, y, Math.atan2(y2 - y, x2 - x), s * 1.6, t) };
      }
      if (craft.kind === "habitat") {
        const L = craft.loop, k = (t * L.speed) % 1;
        // simulated round trip: out along the top arc, back along the bottom arc
        const arc = (u, out) => {
          const mx = (L.from[0] + L.to[0]) / 2, my = out ? L.up : L.down;
          const a = out ? u : 1 - u;
          const px = (1 - a) ** 2 * L.from[0] + 2 * (1 - a) * a * mx + a * a * L.to[0];
          const py = (1 - a) ** 2 * L.from[1] + 2 * (1 - a) * a * my + a * a * L.to[1];
          return [px * W, py * H];
        };
        ctx.lineWidth = 1.2 * dpr; ctx.setLineDash([3 * dpr, 7 * dpr]); ctx.strokeStyle = "rgba(147,164,181,0.3)";
        [true, false].forEach((out) => { ctx.beginPath(); for (let u = 0; u <= 1.0001; u += 0.02) { const [px, py] = arc(u, out); u === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py); } ctx.stroke(); });
        ctx.setLineDash([]);
        const out = k < 0.5, u = out ? k * 2 : (k - 0.5) * 2;
        const [gx, gy] = arc(u, out);
        const ghost = ctx.createRadialGradient(gx, gy, 0, gx, gy, 6 * s);
        ghost.addColorStop(0, "rgba(190,255,245,0.9)"); ghost.addColorStop(1, "rgba(79,209,197,0)");
        ctx.fillStyle = ghost; ctx.beginPath(); ctx.arc(gx, gy, 6 * s, 0, Math.PI * 2); ctx.fill();
        return { behind: false, draw: () => drawHabitat(W * 0.47, H * 0.68, s * 2.1, t) };
      }
      if (craft.kind === "eva") {
        const ax = W * 0.62 + Math.sin(t * 0.3) * W * 0.02, ay = H * 0.4 + Math.sin(t * 0.5) * H * 0.03;
        const draw = () => {
          // ISS truss running in from the top-left, with a handrail and solar wing
          ctx.save(); ctx.translate(W * 0.18, H * 0.2); ctx.rotate(0.16);
          ctx.fillStyle = lin(0, -5 * s, 0, 5 * s, [[0, "#d3dbe4"], [0.5, "#8c98a7"], [1, "#4b5563"]]);
          ctx.fillRect(-W * 0.3, -4 * s, W * 0.42, 8 * s);
          ctx.strokeStyle = "rgba(40,48,60,0.7)"; ctx.lineWidth = 0.8 * s;
          for (let i = -W * 0.3; i < W * 0.12; i += 8 * s) { ctx.beginPath(); ctx.moveTo(i, -4 * s); ctx.lineTo(i + 8 * s, 4 * s); ctx.stroke(); }
          ctx.fillStyle = "#f3c244"; ctx.fillRect(-W * 0.2, 4 * s, W * 0.26, 1.2 * s);   // yellow handrail
          ctx.fillStyle = lin(0, 5 * s, 0, 31 * s, [[0, "#6d99dc"], [1, "#1f3c6b"]]);
          ctx.fillRect(-W * 0.26, 5.2 * s, 18 * s, 26 * s);                                // solar wing
          ctx.restore();
          // tether: a soft curve from the handrail to the suit's waist
          const hx = W * 0.18 + Math.cos(0.16) * W * 0.04, hy = H * 0.2 + 6 * s;
          ctx.strokeStyle = "rgba(255,255,255,0.75)"; ctx.lineWidth = 1.1 * dpr;
          ctx.beginPath(); ctx.moveTo(hx, hy); ctx.quadraticCurveTo((hx + ax) / 2, ay + 26 * s, ax - 3 * s, ay + 2 * s); ctx.stroke();
          drawAstronaut(ax, ay, s * 2, t);
        };
        return { behind: false, draw };
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
        if (scene.belts) drawBelts(scene.belts, false, t);
        const craft = scene.craft ? drawCraft(scene.craft, t) : null;
        if (craft && craft.behind) craft.draw();
        bodies.forEach((b) => drawSphere(b, t));
        if (scene.belts) drawBelts(scene.belts, true, t);
        if (craft && !craft.behind) craft.draw();
        const mark = scene.beacon ? drawBeacon(scene.beacon, t) : null;
        if (scene.beacon && scene.beacon.link && mark && craft && craft.x !== undefined) {
          // Twin Study: the twin in space and the twin on Earth, compared all year
          const pulse = (t * 0.6) % 1;
          ctx.strokeStyle = "rgba(167,139,250,0.45)"; ctx.lineWidth = 1.2 * dpr; ctx.setLineDash([2 * dpr, 5 * dpr]);
          ctx.lineDashOffset = -pulse * 14 * dpr;
          ctx.beginPath(); ctx.moveTo(mark.x, mark.y); ctx.lineTo(craft.x, craft.y); ctx.stroke();
          ctx.setLineDash([]); ctx.lineDashOffset = 0;
        }
        if (scene.helix) drawHelix(scene.helix, t);
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
        scene = SCENES[id] || SCENES.crew13_iss;
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

// ES module export for the React app (pages/crew/Mission.jsx). The loop stops by
// itself once the canvas leaves the page (canvas.isConnected), so unmounting is enough.
export { Planet3D };
