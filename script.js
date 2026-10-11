// HOLO HAND STUDIO — script.js (ES module)
// Hand tracking: MediaPipe Tasks Vision (HandLandmarker), dimuat via CDN (butuh internet saat pertama kali).
const MP_VERSION = "0.10.14";
const MP_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const video = $("video");
const drawCanvas = $("drawCanvas");
const fxCanvas = $("fxCanvas");
const dctx = drawCanvas.getContext("2d");
const fctx = fxCanvas.getContext("2d");

// ---------- STATE ----------
const state = {
  mode: "normal", // "normal" | "draw"
  stream: null,
  facing: "user",
  canSwitch: false,
  landmarker: null,
  loadingLib: null,
  rafId: 0,
  lastVideoTime: -1,
  running: false,
  hand: false,
  lostFrames: 0,
  cursor: null, // smoothed {x,y} in canvas px
  dpr: Math.min(window.devicePixelRatio || 1, 2),
};

// Drawing system (only used in draw mode)
const draw = {
  strokes: [], // {color,width,points:[{x,y}]} — points normalized 0..1
  current: null,
  color: "#00f0ff",
  width: 6,
  gestureFrames: 0, // consecutive frames of "draw" pose
  idleFrames: 0, // consecutive frames not in draw pose
  penHeld: false, // on-screen button alternative
};
const START_FRAMES = 3; // stability: frames needed to start drawing
const STOP_FRAMES = 4; // frames needed to stop
const LOST_GRACE = 6; // frames hand may be missing before considered lost

// Normal mode FX
const fx = { particles: [], ripple: 0, lastGesture: "" };

// ---------- UI helpers ----------
let toastTimer;
function toast(msg, ms = 2200) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}
function setCam(text, cls) {
  $("camText").textContent = "Kamera: " + text;
  $("camDot").className = "dot " + (cls || "");
}
function setHand(text, cls) {
  $("handText").textContent = "Tangan: " + text;
  $("handDot").className = "dot " + (cls || "");
}
function setGesture(text) { $("gestureText").textContent = "Gesture: " + text; }

// ---------- Canvas sizing ----------
function resize() {
  const r = drawCanvas.getBoundingClientRect();
  for (const c of [drawCanvas, fxCanvas]) {
    c.width = Math.round(r.width * state.dpr);
    c.height = Math.round(r.height * state.dpr);
  }
  redrawAll();
}
window.addEventListener("resize", resize);
window.addEventListener("orientationchange", () => setTimeout(resize, 300));

// Map normalized landmark (video space) to canvas px, accounting for object-fit: cover + mirror
function mapPoint(lm) {
  const cw = fxCanvas.width, ch = fxCanvas.height;
  const vw = video.videoWidth || cw, vh = video.videoHeight || ch;
  const scale = Math.max(cw / vw, ch / vh);
  const dw = vw * scale, dh = vh * scale;
  const ox = (cw - dw) / 2, oy = (ch - dh) / 2;
  let x = lm.x;
  if (state.facing === "user") x = 1 - x;
  return { x: ox + x * dw, y: oy + lm.y * dh };
}

// ---------- Library loading ----------
async function loadLandmarker() {
  if (state.landmarker) return state.landmarker;
  if (state.loadingLib) return state.loadingLib;
  state.loadingLib = (async () => {
    setHand("memuat model...", "warn");
    const vision = await import(`${MP_URL}/vision_bundle.mjs`);
    const fileset = await vision.FilesetResolver.forVisionTasks(`${MP_URL}/wasm`);
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: "VIDEO",
      numHands: 1,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.5,
    });
    let lm;
    try { lm = await vision.HandLandmarker.createFromOptions(fileset, opts("GPU")); }
    catch { lm = await vision.HandLandmarker.createFromOptions(fileset, opts("CPU")); }
    state.landmarker = lm;
    setHand("siap", "warn");
    return lm;
  })();
  try { return await state.loadingLib; }
  catch (e) {
    state.loadingLib = null;
    throw e;
  }
}

// ---------- Camera ----------
async function startCamera() {
  if (!window.isSecureContext) {
    toast("Kamera butuh HTTPS atau localhost.", 4000);
    setCam("butuh HTTPS", "err");
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    setCam("tidak didukung", "err");
    toast("Browser tidak mendukung akses kamera.");
    return;
  }
  stopCamera(true);
  setCam("meminta izin...", "warn");
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: state.facing, width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
  } catch (e) {
    setCam("gagal", "err");
    const msg = e.name === "NotAllowedError" ? "Izin kamera ditolak. Izinkan di pengaturan browser."
      : e.name === "NotFoundError" ? "Kamera tidak ditemukan."
      : e.name === "NotReadableError" ? "Kamera sedang dipakai aplikasi lain."
      : "Gagal membuka kamera: " + e.message;
    toast(msg, 4000);
    return;
  }
  video.srcObject = state.stream;
  video.classList.toggle("mirror", state.facing === "user");
  await video.play().catch(() => {});
  await new Promise((r) => (video.readyState >= 2 ? r() : (video.onloadeddata = r)));
  resize();
  setCam("aktif (" + (state.facing === "user" ? "depan" : "belakang") + ")", "on");
  $("intro").classList.add("hidden");
  $("btnCam").textContent = "Matikan Kamera";
  $("btnCam").classList.remove("primary");

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    state.canSwitch = devices.filter((d) => d.kind === "videoinput").length > 1;
  } catch { state.canSwitch = false; }
  $("btnSwitch").disabled = !state.canSwitch;

  try { await loadLandmarker(); }
  catch (e) {
    console.error(e);
    setHand("library gagal dimuat", "err");
    toast("Gagal memuat MediaPipe. Periksa koneksi internet.", 4500);
    return;
  }
  state.running = true;
  state.lastVideoTime = -1;
  cancelAnimationFrame(state.rafId);
  state.rafId = requestAnimationFrame(loop);
}

function stopCamera(silent) {
  state.running = false;
  cancelAnimationFrame(state.rafId);
  state.rafId = 0;
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.stream = null;
  video.srcObject = null;
  endStroke();
  handLost(true);
  fctx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);
  if (!silent) {
    setCam("mati");
    setHand("-");
    $("btnCam").textContent = "Aktifkan Kamera";
    $("btnCam").classList.add("primary");
    $("btnSwitch").disabled = true;
  }
}

// ---------- Gesture recognition ----------
// Finger "extended" if tip is farther from wrist than PIP joint (rotation tolerant)
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function fingerUp(lm, tip, pip) { return dist(lm[tip], lm[0]) > dist(lm[pip], lm[0]) * 1.12; }
function classify(lm) {
  const index = fingerUp(lm, 8, 6);
  const middle = fingerUp(lm, 12, 10);
  const ring = fingerUp(lm, 16, 14);
  const pinky = fingerUp(lm, 20, 18);
  const up = [index, middle, ring, pinky].filter(Boolean).length;
  if (index && !middle && !ring && !pinky) return "point"; // telunjuk saja = siap gambar
  if (up === 0) return "fist";
  if (up >= 4) return "open";
  return "other";
}

// ---------- Main loop ----------
function loop() {
  if (!state.running) return;
  state.rafId = requestAnimationFrame(loop);
  if (video.readyState < 2 || !state.landmarker) return;
  if (video.currentTime === state.lastVideoTime) { renderFx(); return; }
  state.lastVideoTime = video.currentTime;

  let res;
  try { res = state.landmarker.detectForVideo(video, performance.now()); }
  catch (e) { console.error(e); return; }

  const lm = res?.landmarks?.[0];
  if (lm) {
    state.lostFrames = 0;
    onHand(lm);
  } else {
    state.lostFrames++;
    if (state.lostFrames > LOST_GRACE) handLost(false);
  }
  renderFx(lm);
}

function onHand(lm) {
  if (!state.hand) {
    state.hand = true;
    fx.ripple = 1;
    setHand("terdeteksi", "on");
  }
  const raw = mapPoint(lm[8]);
  // Adaptive smoothing: more smoothing for small movement (reduce jitter), less for big
  if (!state.cursor) state.cursor = { ...raw };
  else {
    const d = Math.hypot(raw.x - state.cursor.x, raw.y - state.cursor.y);
    const a = Math.min(0.85, Math.max(0.25, d / (40 * state.dpr)));
    state.cursor.x += (raw.x - state.cursor.x) * a;
    state.cursor.y += (raw.y - state.cursor.y) * a;
  }
  const g = classify(lm);
  state.gesture = g;
  state.landmarks = lm;
  $("coordText").textContent =
    `x:${(state.cursor.x / fxCanvas.width).toFixed(2)} y:${(state.cursor.y / fxCanvas.height).toFixed(2)}`;

  if (state.mode === "draw") drawModeUpdate(g);
  else normalModeUpdate(g);
}

function handLost(force) {
  if (!state.hand && !force) return;
  state.hand = false;
  state.cursor = null;
  state.landmarks = null;
  endStroke(); // akhiri stroke, JANGAN hapus gambar
  draw.gestureFrames = 0;
  if (state.running) setHand("tidak terlihat", "warn");
  setGesture("-");
  $("coordText").textContent = "x: - y: -";
}

// ---------- MODE A: DRAW ----------
function drawModeUpdate(g) {
  const wantDraw = draw.penHeld || g === "point";
  if (wantDraw) { draw.gestureFrames++; draw.idleFrames = 0; }
  else { draw.idleFrames++; draw.gestureFrames = 0; }

  if (!draw.current && (draw.penHeld || draw.gestureFrames >= START_FRAMES)) beginStroke();
  else if (draw.current && !draw.penHeld && draw.idleFrames >= STOP_FRAMES) endStroke();

  if (draw.current) {
    addPoint();
    setGesture("MENGGAMBAR ✍");
  } else {
    setGesture(g === "point" ? "siap..." : "berhenti (angkat telunjuk saja untuk gambar)");
  }
}
function beginStroke() {
  if (!state.cursor || state.mode !== "draw") return;
  draw.current = { color: draw.color, width: draw.width, points: [] };
  draw.strokes.push(draw.current);
  addPoint();
}
function addPoint() {
  const c = state.cursor;
  if (!c || !draw.current) return;
  const p = { x: c.x / drawCanvas.width, y: c.y / drawCanvas.height };
  const pts = draw.current.points;
  const last = pts[pts.length - 1];
  if (last && Math.hypot((p.x - last.x) * drawCanvas.width, (p.y - last.y) * drawCanvas.height) < 1.5 * state.dpr) return;
  pts.push(p);
  // incremental render of the latest segment only
  renderStroke(draw.current, Math.max(0, pts.length - 2));
}
function endStroke() {
  if (!draw.current) return;
  if (draw.current.points.length < 2) {
    // single dot is still valid; keep it
  }
  draw.current = null;
}
function renderStroke(s, from = 0) {
  const W = drawCanvas.width, H = drawCanvas.height;
  const pts = s.points;
  dctx.lineCap = "round";
  dctx.lineJoin = "round";
  dctx.strokeStyle = s.color;
  dctx.shadowColor = s.color;
  dctx.shadowBlur = s.width * 2 * state.dpr;
  dctx.lineWidth = s.width * state.dpr;
  dctx.beginPath();
  if (pts.length === 1) {
    dctx.arc(pts[0].x * W, pts[0].y * H, (s.width * state.dpr) / 2, 0, Math.PI * 2);
    dctx.fillStyle = s.color;
    dctx.fill();
  } else {
    dctx.moveTo(pts[from].x * W, pts[from].y * H);
    for (let i = from + 1; i < pts.length; i++) dctx.lineTo(pts[i].x * W, pts[i].y * H);
    dctx.stroke();
  }
  // bright core
  if (pts.length > 1) {
    dctx.shadowBlur = 0;
    dctx.strokeStyle = "rgba(255,255,255,0.75)";
    dctx.lineWidth = Math.max(1, s.width * 0.3) * state.dpr;
    dctx.stroke();
  }
}
function redrawAll() {
  dctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  for (const s of draw.strokes) renderStroke(s, 0);
}
function undo() {
  if (draw.current) endStroke();
  if (!draw.strokes.length) return toast("Tidak ada yang bisa di-undo");
  draw.strokes.pop();
  redrawAll();
}
function clearAll() {
  if (!draw.strokes.length) return toast("Kanvas sudah kosong");
  if (!confirm("Hapus semua gambar?")) return;
  endStroke();
  draw.strokes = [];
  redrawAll();
  toast("Semua gambar dihapus");
}

// ---------- MODE B: NORMAL ----------
function normalModeUpdate(g) {
  const label = { point: "menunjuk ☝", open: "telapak terbuka ✋ (gelombang)", fist: "kepal ✊ (pulse)", other: "tangan" }[g];
  setGesture(label);
  if (g !== fx.lastGesture && (g === "fist" || g === "open")) fx.ripple = 1;
  fx.lastGesture = g;
  // spawn a few particles (capped)
  if (state.cursor && fx.particles.length < 60) {
    for (let i = 0; i < 2; i++) {
      fx.particles.push({
        x: state.cursor.x, y: state.cursor.y,
        vx: (Math.random() - 0.5) * 2 * state.dpr, vy: (Math.random() - 0.5) * 2 * state.dpr,
        life: 1,
      });
    }
  }
}

// ---------- FX render (cursor, skeleton, particles) — cleared every frame, never leaves lines ----------
const BONES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
function renderFx() {
  const W = fxCanvas.width, H = fxCanvas.height, dpr = state.dpr;
  fctx.clearRect(0, 0, W, H);
  const lm = state.landmarks;
  const color = state.mode === "draw" ? draw.color : "#00f0ff";

  // faint hand skeleton (holographic), only in normal mode to keep drawing view clean
  if (lm && state.mode === "normal") {
    fctx.strokeStyle = "rgba(0,240,255,0.35)";
    fctx.lineWidth = 1.5 * dpr;
    fctx.beginPath();
    for (const [a, b] of BONES) {
      const p = mapPoint(lm[a]), q = mapPoint(lm[b]);
      fctx.moveTo(p.x, p.y); fctx.lineTo(q.x, q.y);
    }
    fctx.stroke();
    fctx.fillStyle = "rgba(0,240,255,0.8)";
    for (const pt of lm) { const p = mapPoint(pt); fctx.fillRect(p.x - 2 * dpr, p.y - 2 * dpr, 4 * dpr, 4 * dpr); }
  }

  // particles (normal mode)
  if (state.mode === "normal" && fx.particles.length) {
    fctx.fillStyle = "#00f0ff";
    for (let i = fx.particles.length - 1; i >= 0; i--) {
      const p = fx.particles[i];
      p.x += p.vx; p.y += p.vy; p.life -= 0.035;
      if (p.life <= 0) { fx.particles.splice(i, 1); continue; }
      fctx.globalAlpha = p.life;
      fctx.fillRect(p.x, p.y, 2.5 * dpr, 2.5 * dpr);
    }
    fctx.globalAlpha = 1;
  }

  const c = state.cursor;
  if (!c) return;
  const t = performance.now() / 1000;
  const drawing = !!draw.current;
  const r = (drawing ? 10 : 16) * dpr;

  // ripple animation on detection / gesture change
  if (fx.ripple > 0) {
    fctx.strokeStyle = `rgba(0,240,255,${fx.ripple})`;
    fctx.lineWidth = 2 * dpr;
    fctx.beginPath();
    fctx.arc(c.x, c.y, r + (1 - fx.ripple) * 70 * dpr, 0, Math.PI * 2);
    fctx.stroke();
    fx.ripple = Math.max(0, fx.ripple - 0.04);
  }
  // reticle
  fctx.save();
  fctx.translate(c.x, c.y);
  fctx.shadowColor = color;
  fctx.shadowBlur = 12 * dpr;
  fctx.strokeStyle = color;
  fctx.lineWidth = 2 * dpr;
  fctx.rotate(t * 1.5);
  for (let i = 0; i < 4; i++) {
    fctx.beginPath();
    fctx.arc(0, 0, r, i * Math.PI / 2 + 0.2, i * Math.PI / 2 + 1.2);
    fctx.stroke();
  }
  fctx.rotate(-t * 1.5);
  fctx.fillStyle = drawing ? color : "rgba(255,255,255,0.9)";
  fctx.beginPath();
  fctx.arc(0, 0, (drawing ? draw.width / 2 + 2 : 3) * dpr, 0, Math.PI * 2);
  fctx.fill();
  fctx.restore();
}

// ---------- Mode switching ----------
function setMode(m) {
  if (state.mode === m) return;
  endStroke(); // stop any active stroke so nothing connects across modes
  draw.gestureFrames = 0;
  draw.idleFrames = 0;
  draw.penHeld = false;
  $("btnPen").classList.remove("pressing");
  fx.particles.length = 0;
  state.mode = m;
  document.body.classList.toggle("draw-mode", m === "draw");
  $("btnDraw").classList.toggle("active", m === "draw");
  $("btnNormal").classList.toggle("active", m === "normal");
  $("modeText").textContent = "MODE: " + (m === "draw" ? "GAMBAR" : "NORMAL");
  toast(m === "draw" ? "Mode Gambar: angkat telunjuk saja, tekuk jari lain" : "Mode Normal: tanpa garis");
  requestAnimationFrame(resize);
}

// ---------- Events ----------
$("btnStartBig").addEventListener("click", startCamera);
$("btnCam").addEventListener("click", () => (state.stream ? stopCamera() : startCamera()));
$("btnSwitch").addEventListener("click", () => {
  state.facing = state.facing === "user" ? "environment" : "user";
  startCamera();
});
$("btnFull").addEventListener("click", async () => {
  const el = document.documentElement;
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (el.requestFullscreen) await el.requestFullscreen();
    else toast("Fullscreen tidak didukung");
  } catch { toast("Fullscreen tidak diizinkan di sini"); }
});
document.addEventListener("fullscreenchange", () => setTimeout(resize, 200));
$("btnDraw").addEventListener("click", () => setMode("draw"));
$("btnNormal").addEventListener("click", () => setMode("normal"));
$("btnUndo").addEventListener("click", undo);
$("btnClear").addEventListener("click", clearAll);

const pen = $("btnPen");
const penDown = (e) => { e.preventDefault(); if (state.mode !== "draw") return; draw.penHeld = true; pen.classList.add("pressing"); if (state.cursor && !draw.current) beginStroke(); };
const penUp = () => { draw.penHeld = false; pen.classList.remove("pressing"); endStroke(); };
pen.addEventListener("pointerdown", penDown);
pen.addEventListener("pointerup", penUp);
pen.addEventListener("pointercancel", penUp);
pen.addEventListener("pointerleave", penUp);

document.querySelectorAll(".swatch").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".swatch").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    endStroke(); // new color starts a new stroke
    draw.color = b.dataset.color;
  })
);
$("widthRange").addEventListener("input", (e) => {
  draw.width = +e.target.value;
  $("widthVal").textContent = draw.width;
  endStroke();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && state.stream) { stopCamera(); toast("Kamera dimatikan (tab disembunyikan)"); }
});
window.addEventListener("pagehide", () => stopCamera(true));

// init
resize();
if (!window.isSecureContext) setCam("butuh HTTPS", "err");
