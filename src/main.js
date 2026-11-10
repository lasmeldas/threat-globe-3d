import * as THREE from 'three';
import { LAND_W, LAND_H, LAND_B64 } from './land.js';

/* ---------- configuration ---------- */
const R = 2; // globe radius
const LOOP = 12; // seconds; every arc period divides this, so captures loop seamlessly
const SPIN_PERIOD = 80; // seconds per full turn when running live
const SLOTS = 16; // simultaneous attack streams
const TRAVEL = 0.5; // fraction of an arc's cycle spent travelling
const SEG = 56; // tube segments per arc
const RAD = 5; // tube radial segments
const PERIODS = [3, 4, 6, 12];
const ATTACKS = ['port scan', 'brute force', 'phishing', 'DDoS', 'malware beacon', 'SQL injection'];

// Major cities used as endpoints. Traffic between them is simulated.
const CITIES = [
  ['San Francisco', 37.77, -122.42], ['New York', 40.71, -74.0], ['Sao Paulo', -23.55, -46.63],
  ['London', 51.5, -0.12], ['Frankfurt', 50.11, 8.68], ['Moscow', 55.75, 37.62],
  ['Cairo', 30.04, 31.24], ['Lagos', 6.52, 3.38], ['Nairobi', -1.29, 36.82],
  ['Dubai', 25.2, 55.27], ['Mumbai', 19.07, 72.88], ['Singapore', 1.35, 103.82],
  ['Seoul', 37.57, 126.98], ['Tokyo', 35.68, 139.69], ['Sydney', -33.87, 151.2],
  ['Johannesburg', -26.2, 28.05],
];

const params = new URLSearchParams(location.search);
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if (params.get('hud') === '0') document.body.classList.add('no-hud');

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function latLon(lat, lon, r = 1) {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((lon + 180) * Math.PI) / 180;
  return new THREE.Vector3(-r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
}

/* ---------- land mask ---------- */
const maskBytes = Uint8Array.from(atob(LAND_B64), (c) => c.charCodeAt(0));
function isLand(lat, lon) {
  const col = clamp(Math.floor(lon + 180), 0, LAND_W - 1);
  const row = clamp(Math.floor(90 - lat), 0, LAND_H - 1);
  const idx = row * LAND_W + col;
  return (maskBytes[idx >> 3] >> (idx & 7)) & 1;
}

/* ---------- renderer & scene ---------- */
const canvas = document.getElementById('scene');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
} catch (err) {
  document.body.classList.add('no-webgl');
}

if (renderer) start();

function start() {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
  camera.position.set(0, 0, 7.4);

  const tilt = new THREE.Group();
  const spin = new THREE.Group();
  tilt.add(spin);
  scene.add(tilt);

  // soft dot sprite so points are round
  const dot = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.55, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();

  // opaque core hides the dots on the far side
  spin.add(
    new THREE.Mesh(
      new THREE.SphereGeometry(R * 0.995, 64, 48),
      new THREE.ShaderMaterial({
        vertexShader: 'varying vec3 vN; void main(){ vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'varying vec3 vN; void main(){ float rim = pow(1.0 - abs(vN.z), 3.0); gl_FragColor = vec4(vec3(0.024, 0.047, 0.098) + vec3(0.10, 0.42, 0.78) * rim * 0.65, 1.0); }',
      })
    )
  );

  // graticule
  const lines = [];
  const ring = (fn) => {
    for (let i = 0; i < 96; i++) lines.push(fn(i / 96), fn((i + 1) / 96));
  };
  for (let lat = -60; lat <= 60; lat += 30) ring((s) => latLon(lat, s * 360 - 180, R * 1.001));
  for (let lon = -180; lon < 180; lon += 30) ring((s) => latLon(s * 180 - 90, lon, R * 1.001));
  spin.add(
    new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(lines),
      new THREE.LineBasicMaterial({ color: 0x1d3b5f, transparent: true, opacity: 0.45 })
    )
  );

  // land as a dot matrix: even Fibonacci-sphere samples kept only where the mask says land
  const landPos = [];
  const N = 30000;
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) {
    const y = 1 - (2 * (i + 0.5)) / N;
    const rr = Math.sqrt(1 - y * y);
    const th = golden * i;
    const x = Math.cos(th) * rr;
    const z = Math.sin(th) * rr;
    const lat = (Math.asin(y) * 180) / Math.PI;
    let lon = (Math.atan2(z, -x) * 180) / Math.PI - 180;
    if (lon < -180) lon += 360;
    if (isLand(lat, lon)) landPos.push(x * R * 1.003, y * R * 1.003, z * R * 1.003);
  }
  const landGeo = new THREE.BufferGeometry();
  landGeo.setAttribute('position', new THREE.Float32BufferAttribute(landPos, 3));
  spin.add(
    new THREE.Points(landGeo, new THREE.PointsMaterial({ color: 0x6fd3ff, size: 0.046, map: dot, transparent: true, alphaTest: 0.05, depthWrite: false, opacity: 1 }))
  );

  // city nodes
  const cityVecs = CITIES.map(([, lat, lon]) => latLon(lat, lon, 1));
  const cityGeo = new THREE.BufferGeometry().setFromPoints(cityVecs.map((v) => v.clone().multiplyScalar(R * 1.008)));
  spin.add(new THREE.Points(cityGeo, new THREE.PointsMaterial({ color: 0x00ffa3, size: 0.075, map: dot, transparent: true, alphaTest: 0.05, depthWrite: false })));

  // atmosphere glow
  tilt.add(
    new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.16, 64, 48),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        vertexShader: 'varying vec3 vN; void main(){ vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'varying vec3 vN; void main(){ float d = clamp(-dot(vN, vec3(0.0, 0.0, 1.0)) / 0.5, 0.0, 1.0); float i = pow(d, 3.0); gl_FragColor = vec4(0.18, 0.66, 1.0, 1.0) * i * 0.85; }',
      })
    )
  );

  // starfield
  const starPos = new Float32Array(900 * 3);
  const sr = rng(7);
  for (let i = 0; i < 900; i++) {
    const v = new THREE.Vector3(sr() - 0.5, sr() - 0.5, sr() - 0.5).normalize().multiplyScalar(40 + sr() * 40);
    starPos.set([v.x, v.y, v.z], i * 3);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0x8aa0b8, size: 0.12, map: dot, transparent: true, opacity: 0.55, depthWrite: false })));

  /* ---------- attack streams ---------- */
  const arcMat = new THREE.MeshBasicMaterial({ color: 0xff5470, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
  const headMat = new THREE.MeshBasicMaterial({ color: 0xffd0c2, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
  const ringMat = () => new THREE.MeshBasicMaterial({ color: 0x00ffa3, transparent: true, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
  const headGeo = new THREE.SphereGeometry(0.03, 12, 12);
  const ringGeo = new THREE.RingGeometry(0.86, 1, 56);
  const zAxis = new THREE.Vector3(0, 0, 1);

  const slots = Array.from({ length: SLOTS }, (_, i) => {
    const period = PERIODS[i % PERIODS.length];
    const s = {
      i,
      period,
      phase: rng(i * 977 + 13)() * period,
      cycle: null,
      curve: null,
      tube: new THREE.Mesh(new THREE.BufferGeometry(), arcMat),
      head: new THREE.Mesh(headGeo, headMat),
      ring: new THREE.Mesh(ringGeo, ringMat()),
    };
    s.tube.frustumCulled = false;
    s.ring.visible = s.head.visible = s.tube.visible = false;
    spin.add(s.tube, s.head, s.ring);
    return s;
  });

  const feed = [];
  let warm = false;
  let feedDirty = false;

  function startCycle(s, cycle, live) {
    s.cycle = cycle;
    const per = LOOP / s.period;
    const kk = ((cycle % per) + per) % per; // repeats every LOOP seconds
    const r = rng(s.i * 7919 + kk * 104729 + 17);
    let a = 0;
    let b = 0;
    let ang = 0;
    for (let tries = 0; tries < 30; tries++) {
      a = Math.floor(r() * CITIES.length);
      b = Math.floor(r() * CITIES.length);
      ang = a === b ? 0 : cityVecs[a].angleTo(cityVecs[b]);
      if (ang > 0.55) break;
    }
    const A = cityVecs[a];
    const B = cityVecs[b];
    const lift = 0.1 + 0.22 * (ang / Math.PI);
    const pts = [];
    const sinW = Math.sin(ang) || 1;
    for (let j = 0; j <= 24; j++) {
      const t = j / 24;
      const p = A.clone().multiplyScalar(Math.sin((1 - t) * ang) / sinW).add(B.clone().multiplyScalar(Math.sin(t * ang) / sinW));
      p.normalize().multiplyScalar(R * (1.008 + lift * Math.sin(Math.PI * t)));
      pts.push(p);
    }
    s.curve = new THREE.CatmullRomCurve3(pts);
    s.tube.geometry.dispose();
    s.tube.geometry = new THREE.TubeGeometry(s.curve, SEG, 0.0058, RAD, false);
    s.ring.quaternion.setFromUnitVectors(zAxis, B);
    s.ring.position.copy(B).multiplyScalar(R * 1.012);
    if (live && warm) {
      feed.unshift({ from: CITIES[a][0], to: CITIES[b][0], kind: ATTACKS[Math.floor(r() * ATTACKS.length)] });
      feed.length = Math.min(feed.length, 6);
      feedDirty = true;
    }
  }

  /* ---------- time-driven update (a pure function of t) ---------- */
  let yaw = 0;
  let pitch = 0;
  function setTime(t, loop, live) {
    const turns = loop ? t / LOOP : t / SPIN_PERIOD;
    spin.rotation.y = turns * Math.PI * 2 + yaw + 2.3;
    tilt.rotation.x = 0.3 + pitch;
    tilt.rotation.z = 0.2;
    let inFlight = 0;
    let arrived = 0;
    for (const s of slots) {
      const x = (t + s.phase) / s.period;
      const cycle = Math.floor(x);
      const u = x - cycle;
      if (cycle !== s.cycle) startCycle(s, cycle, live);
      arrived += Math.max(0, Math.floor((t + s.phase) / s.period - TRAVEL) + 1);
      const head = clamp(u / TRAVEL, 0, 1);
      const tail = clamp((u - 0.2) / TRAVEL, 0, 1);
      const a = Math.floor(tail * SEG);
      const b = Math.floor(head * SEG);
      s.tube.visible = b > a;
      if (b > a) s.tube.geometry.setDrawRange(a * RAD * 6, (b - a) * RAD * 6);
      s.head.visible = u <= TRAVEL;
      if (s.head.visible) {
        inFlight++;
        s.head.position.copy(s.curve.getPoint(head));
        s.head.scale.setScalar(1 + 0.4 * Math.sin(t * 9 + s.i));
      }
      const e = clamp((u - TRAVEL) / 0.32, 0, 1);
      s.ring.visible = u > TRAVEL && u < TRAVEL + 0.32;
      if (s.ring.visible) {
        s.ring.scale.setScalar(0.03 + 0.26 * e);
        s.ring.material.opacity = (1 - e) * 0.9;
      }
    }
    return { inFlight, arrived };
  }

  /* ---------- sizing ---------- */
  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // keep the whole globe (plus its arcs) in view whatever the screen shape
    const fitWidth = 3.0 / (Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect);
    camera.position.z = clamp(Math.max(8 * (h < 480 ? 1.2 : 1), fitWidth), 6, 18);
    tilt.position.y = w < h ? -0.55 : 0;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  /* ---------- interaction ---------- */
  let dragging = false;
  let lx = 0;
  let ly = 0;
  let vel = 0;
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    lx = e.clientX;
    ly = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lx;
    yaw += dx * 0.006;
    vel = dx * 0.006;
    pitch = clamp(pitch + (e.clientY - ly) * 0.003, -0.5, 0.5);
    lx = e.clientX;
    ly = e.clientY;
  });
  const release = () => (dragging = false);
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      camera.position.z = clamp(camera.position.z + e.deltaY * 0.004, 5, 18);
    },
    { passive: false }
  );

  /* ---------- HUD ---------- */
  const el = (id) => document.getElementById(id);
  const blockedEl = el('blocked');
  const activeEl = el('active');
  const feedEl = el('feed');
  const motionBtn = el('motion');
  let paused = reduceMotion;
  function syncMotion() {
    motionBtn.textContent = paused ? 'Motion: off' : 'Motion: on';
    motionBtn.setAttribute('aria-pressed', String(paused));
  }
  motionBtn.addEventListener('click', () => {
    paused = !paused;
    syncMotion();
  });
  syncMotion();

  function drawFeed() {
    feedEl.replaceChildren(
      ...feed.map((f) => {
        const li = document.createElement('li');
        const route = document.createElement('span');
        route.textContent = `${f.from} → ${f.to}`;
        const kind = document.createElement('em');
        kind.textContent = f.kind;
        li.append(route, kind);
        return li;
      })
    );
  }

  /* ---------- loop ---------- */
  let tNow = 3;
  let last = performance.now();
  let hudAt = 0;
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!paused) tNow += dt;
    if (!dragging) {
      yaw += vel;
      vel *= 0.94;
    }
    const stats = setTime(tNow, false, true);
    warm = true;
    renderer.render(scene, camera);
    if (now - hudAt > 120) {
      hudAt = now;
      blockedEl.textContent = stats.arrived.toLocaleString('en-US');
      activeEl.textContent = String(stats.inFlight);
      if (feedDirty) {
        drawFeed();
        feedDirty = false;
      }
    }
    requestAnimationFrame(frame);
  }
  if (!params.has('capture')) requestAnimationFrame(frame);

  // Deterministic hook used to render the README preview animation frame by frame.
  window.__render = (t, loop = true) => {
    setTime(t, loop, false);
    renderer.render(scene, camera);
  };
}

document.getElementById('year').textContent = new Date().getFullYear();
