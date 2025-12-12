let table;

let items = [];
let points = [];
let isReady = false;

// camera (2.5D)
let zoom = 1.0;
let targetZoom = 1.0;
let camYaw = 0.0;
let targetYaw = 0.0;
let camPitch = 0.0;
let targetPitch = 0.0;

let dragging = false;
let lastX = 0, lastY = 0;

// buffers
let baseG, hiG, starsG;

// progressive state
let renderQueue = [];
let currentRenderIndex = 0;

// ===== Targets & Colors =====
const TARGETS = ["Age", "Disabled", "Gender", "Individual", "Job", "Others", "Politics", "Region", "Religion"];

const TARGET_COLORS = {
  Age: "#1f77b4",
  Disabled: "#ff7f0e",
  Gender: "#2ca02c",
  Individual: "#d62728",
  Job: "#9467bd",
  Others: "#8c564b",
  Politics: "#e377c2",
  Region: "#17becf",
  Religion: "#bcbd22"
};

// selected targets (max 3)
let selectedTargets = [];

// occupancy grid for text placement
let occGrid = new Map();
const OCC_CELL = 20;

function canPlaceText(x, y) {
  const gx = Math.floor(x / OCC_CELL);
  const gy = Math.floor(y / OCC_CELL);

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (occGrid.has(`${gx + dx},${gy + dy}`)) return false;
    }
  }
  occGrid.set(`${gx},${gy}`, true);
  return true;
}

// ===== CONFIG =====
const CONFIG = {
  CSV_PATH: "data/K-HATERS_train.csv",
  MAX_ROWS: 20000,

  // Label clustering
  LABEL_ORDER: ["normal", "offensive", "L1_hate", "L2_hate"],
  LABEL_CENTERS: [
    { x: -0.55, y: 0.05 },
    { x: -0.15, y: -0.05 },
    { x: 0.20, y: 0.05 },
    { x: 0.55, y: -0.03 }
  ],

  BASE_SCALE: 520,
  CLUSTER_TIGHTNESS: 0.55,
  BORDER_BLEND: 0.55,

  // Camera smoothing (1.0 = instant)
  CAMERA_LERP: 1.0,

  // Performance caps (lower = smoother interaction)
  MAX_DOTS_PER_FRAME: 5000,
  MAX_TEXTS_PER_FRAME: 150,
  TEXTS_PER_BATCH: 20,

  // Snippets
  FAR_SNIP: 14,
  MID_SNIP: 25,
  NEAR_SNIP: 120,

  // Depth
  DEPTH_BUCKETS: 30,

  // Camera
  ZOOM_MIN: 1.0,
  ZOOM_MAX: 4.0,
  ZOOM_FACTOR: 1.15,
  PITCH_MIN: -1.2,
  PITCH_MAX: 1.2,

  // Rotation sensitivity
  YAW_SENSITIVITY: 0.01,
  PITCH_SENSITIVITY: 0.007
};

const LABEL_INDEX = Object.fromEntries(
  CONFIG.LABEL_ORDER.map((k, i) => [k, i])
);

let depthBuckets = [];

// UI
let chipsEl, statusEl;

function preload() {
  table = loadTable(CONFIG.CSV_PATH, "csv", "header");
}

function setup() {
  createCanvas(windowWidth, windowHeight);
  textFont("Noto Sans KR");
  textAlign(LEFT, TOP);

  chipsEl = document.getElementById("chips");
  statusEl = document.getElementById("status");

  if (!chipsEl || !statusEl) {
    console.error("Required DOM elements not found");
    return;
  }

  initChips();

  if (!table) {
    updateStatus("error: CSV load failed");
    return;
  }

  const n = table.getRowCount();
  if (n === 0) {
    updateStatus(`error: CSV has 0 rows (${CONFIG.CSV_PATH})`);
    return;
  }

  // Parse with error handling
  try {
    parseData();
  } catch (e) {
    console.error("Parse error:", e);
    updateStatus(`error: ${e.message}`);
    return;
  }

  points = items.map((it, j) => makePoint(it, j));
  buildDepthBuckets();
  makeBuffers();

  isReady = true;

  loop();
}

function parseData() {
  const n = table.getRowCount();

  for (let i = 0; i < n; i++) {
    const text = table.getString(i, "text") || "";
    if (!text.trim()) continue;

    const label = table.getString(i, "label") || "offensive";
    const targetLabelRaw = table.getString(i, "target_label") || "";
    const targetRationaleRaw = table.getString(i, "target_rationale") || "";

    items.push({
      text,
      label,
      targets: normalizeTargets(targetLabelRaw),
      spansByTarget: parseTargetRationale(targetRationaleRaw),
    });
  }

  items = sampleArray(items, CONFIG.MAX_ROWS);
}

function draw() {
  if (!isReady) return;

  // Zoom is instant, rotation is smooth
  zoom = targetZoom;
  camYaw = lerp(camYaw, targetYaw, CONFIG.CAMERA_LERP);
  camPitch = lerp(camPitch, targetPitch, CONFIG.CAMERA_LERP);

  // Clear and prepare
  background(0);
  occGrid.clear();

  // Draw stars
  image(starsG, 0, 0);

  // Render all points in one pass
  renderAllPoints();

  // Update status
  const sel = selectedTargets.length ? selectedTargets.join(", ") : "(none)";
  if (statusEl) {
    statusEl.textContent =
      `zoom: ${zoom.toFixed(2)} | ` +
      `rotation: ${(camYaw * 180 / PI).toFixed(0)}° | ` +
      `pitch: ${(camPitch * 180 / PI).toFixed(0)}° | ` +
      `selected: ${sel}`;
  }
}

function renderAllPoints() {
  let dotsDrawn = 0;
  let textsDrawn = 0;

  // Draw from far to near for proper depth
  for (let b = CONFIG.DEPTH_BUCKETS - 1; b >= 0; b--) {
    const bucket = depthBuckets[b];

    for (let idx of bucket) {
      if (dotsDrawn >= CONFIG.MAX_DOTS_PER_FRAME &&
        textsDrawn >= CONFIG.MAX_TEXTS_PER_FRAME) {
        return;
      }

      const p = points[idx];
      const s = projectToScreen(p.wx, p.wy, p.depth);

      if (!isOnScreen(s.x, s.y, 300)) continue;

      const nearFactor = 1.0 - p.depth;
      const isSelected = selectedTargets.length > 0 &&
        selectedTargets.some(t => p.targets && p.targets.has(t));

      // Draw dot with depth-based coloring (cool blue far → warm white near)
      if (dotsDrawn < CONFIG.MAX_DOTS_PER_FRAME) {
        const baseSize = lerp(0.8, 3.5, nearFactor);
        const r = baseSize * (0.6 + 0.4 * zoom);
        const baseAlpha = lerp(15, 100, nearFactor);
        const a = isSelected ? Math.min(255, baseAlpha * 1.8) : baseAlpha;

        // Depth-based color: cool blue (far) → warm white (near)
        const colorR = lerp(100, 255, nearFactor);
        const colorG = lerp(140, 250, nearFactor);
        const colorB = lerp(220, 240, nearFactor);

        noStroke();

        // Subtle glow for nearer dots
        if (nearFactor > 0.6) {
          fill(colorR, colorG, colorB, a * 0.15);
          circle(s.x, s.y, r * 2.5);
        }

        fill(colorR, colorG, colorB, a);
        circle(s.x, s.y, r);
        dotsDrawn++;
      }

      // Draw text based on zoom and distance
      const shouldShowText = determineTextVisibility(nearFactor, isSelected);

      if (shouldShowText && textsDrawn < CONFIG.MAX_TEXTS_PER_FRAME) {
        if (!canPlaceText(s.x, s.y)) continue;

        const size = lerp(9, 17, nearFactor) * Math.min(1.2, zoom / 1.5);
        const baseAlpha = lerp(30, 200, nearFactor);
        const alpha = isSelected ? Math.min(255, baseAlpha * 1.8) : baseAlpha;

        // Choose snippet length based on distance and zoom
        let snippetLen;
        if (nearFactor > 0.75 && zoom > 1.5) {
          snippetLen = CONFIG.NEAR_SNIP;
        } else if (nearFactor > 0.5 && zoom > 1.0) {
          snippetLen = CONFIG.MID_SNIP;
        } else {
          snippetLen = CONFIG.FAR_SNIP;
        }

        const { snippet, limit } = makeSnippetWithLimit(p.text, snippetLen);

        textSize(size);

        if (isSelected) {
          // Draw with color highlighting when target is selected
          const spans = getSelectedSpansClipped(p.spansByTarget, p.targets, limit);
          drawSingleLineColored(snippet, spans, s.x, s.y, alpha);
        } else {
          // Simple white text
          noStroke();
          fill(255, alpha);
          text(snippet, s.x, s.y);
        }

        textsDrawn++;
      }
    }
  }
}

function determineTextVisibility(nearFactor, isSelected) {
  if (isSelected) {
    // Selected items show text more readily
    return zoom > 0.8 && nearFactor > 0.35;
  } else {
    // Non-selected items need more zoom to show text
    return zoom > 1.0 && nearFactor > 0.45;
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);

  // Clean up old buffers
  if (baseG) baseG.remove();
  if (hiG) hiG.remove();
  if (starsG) starsG.remove();

  makeBuffers();
}

// ---------- Buffers ----------
function makeBuffers() {
  starsG = createGraphics(width, height);
  starsG.background(5, 5, 16);
  starsG.noStroke();
  randomSeed(42);

  // Deep background layer - very dim, cool tones
  for (let i = 0; i < 200; i++) {
    const hue = random() > 0.6 ? random(200, 240) : random(0, 360); // mostly blue
    const rgb = hslToRgb(hue / 360, 0.3, 0.5);
    starsG.fill(rgb.r, rgb.g, rgb.b, random(5, 15));
    starsG.circle(random(width), random(height), random(0.5, 1.5));
  }

  // Mid layer - varied colors
  for (let i = 0; i < 150; i++) {
    const hue = random() > 0.5 ? random(200, 280) : random(20, 60); // blue-purple or warm
    const rgb = hslToRgb(hue / 360, 0.4, 0.7);
    starsG.fill(rgb.r, rgb.g, rgb.b, random(15, 35));
    starsG.circle(random(width), random(height), random(1.0, 2.0));
  }

  // Foreground bright stars with glow
  for (let i = 0; i < 40; i++) {
    const x = random(width);
    const y = random(height);
    const size = random(2.0, 3.5);
    const hue = random([210, 230, 40, 30]); // blue or warm
    const rgb = hslToRgb(hue / 360, 0.5, 0.85);

    // Subtle glow
    starsG.fill(rgb.r, rgb.g, rgb.b, 15);
    starsG.circle(x, y, size * 3);
    starsG.fill(rgb.r, rgb.g, rgb.b, 30);
    starsG.circle(x, y, size * 1.8);
    // Core
    starsG.fill(255, 255, 255, random(50, 90));
    starsG.circle(x, y, size * 0.8);
  }

  // Add subtle vignette effect
  const vignette = starsG.drawingContext;
  const gradient = vignette.createRadialGradient(
    width / 2, height / 2, height * 0.3,
    width / 2, height / 2, height * 0.9
  );
  gradient.addColorStop(0, 'rgba(0,0,0,0)');
  gradient.addColorStop(1, 'rgba(0,0,0,0.4)');
  vignette.fillStyle = gradient;
  vignette.fillRect(0, 0, width, height);
}

// HSL to RGB helper
function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

// ---------- Colored Text Rendering ----------
function drawSingleLineColored(txtContent, spans, x, y, alphaText) {
  if (!spans.length) {
    fill(255, alphaText);
    noStroke();
    text(txtContent, x, y);
    return;
  }

  const boundaries = new Set([0, txtContent.length]);
  for (const sp of spans) {
    boundaries.add(sp.s);
    boundaries.add(sp.e);
  }
  const cuts = Array.from(boundaries).sort((a, b) => a - b);

  let cursorX = x;

  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i];
    const b = cuts[i + 1];
    if (b <= a) continue;

    const seg = txtContent.slice(a, b);
    const hits = spans.filter(sp => sp.s < b && sp.e > a).map(sp => sp.t);

    let col = "#ffffff";
    if (hits.length >= 1) {
      // Use the first matching target's color
      col = TARGET_COLORS[hits[0]] || "#ffffff";
    }

    noStroke();
    const { r, g, b: blue } = hexToRgb(col);
    fill(r, g, blue, Math.min(255, alphaText));
    text(seg, cursorX, y);


    cursorX += textWidth(seg);
  }
}

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}


// ---------- Helper Functions ----------
function isOnScreen(x, y, margin = 200) {
  return x >= -margin && x <= width + margin &&
    y >= -margin && y <= height + margin;
}

function getSelectedSpansClipped(spansByTarget, targetSet, limit) {
  if (!selectedTargets.length) return [];

  const validSelected = selectedTargets.filter(t =>
    targetSet && targetSet.has(t)
  );
  if (!validSelected.length) return [];

  let spans = [];

  for (const t of validSelected) {
    const arr = spansByTarget?.get(t);
    if (arr && arr.length) {
      for (const [s, e] of arr) {
        spans.push({ s, e, t });
      }
    }
  }

  // Fallback to _all
  if (!spans.length) {
    const all = spansByTarget?.get("_all");
    if (all && all.length) {
      const t = validSelected[0];
      for (const [s, e] of all) {
        spans.push({ s, e, t });
      }
    }
  }

  spans = spans
    .map(o => ({
      ...o,
      s: Math.max(0, Math.min(limit, o.s)),
      e: Math.max(0, Math.min(limit, o.e))
    }))
    .filter(o => o.e > o.s);

  spans.sort((a, b) => a.s - b.s || a.e - b.e);
  return spans;
}

// ---------- Depth Buckets ----------
function buildDepthBuckets() {
  depthBuckets = Array.from({ length: CONFIG.DEPTH_BUCKETS }, () => []);

  for (let i = 0; i < points.length; i++) {
    const d = points[i].depth;
    const bi = Math.max(0, Math.min(
      CONFIG.DEPTH_BUCKETS - 1,
      Math.floor(d * CONFIG.DEPTH_BUCKETS)
    ));
    depthBuckets[bi].push(i);
  }

  for (let b = 0; b < CONFIG.DEPTH_BUCKETS; b++) {
    shuffleInPlace(depthBuckets[b]);
  }
}

// ---------- Projection ----------
function projectToScreen(wx, wy, depth01) {
  const z = Math.max(0.3, zoom);
  const persp = lerp(1.2, 0.25, depth01) * z;

  const cy = Math.cos(camYaw);
  const sy = Math.sin(camYaw);
  const cp = Math.cos(camPitch);
  const sp = Math.sin(camPitch);

  // Rotate around Y axis (yaw)
  let x = wx * cy - wy * sy;
  let y = wx * sy + wy * cy;

  // Rotate around X axis (pitch)
  let z_depth = 0;
  let y_rotated = y * cp - z_depth * sp;

  return {
    x: width / 2 + x * persp,
    y: height / 2 + y_rotated * persp
  };
}

// ---------- Point Placement ----------
function makePoint(it, j) {
  const v = hashTo2D(it.text);
  const li = LABEL_INDEX[it.label] ?? 1;

  const targetCount = it.targets ? it.targets.size : 0;
  const spanCount = countAllSpans(it.spansByTarget);

  let borderish = 0.75 - 0.10 * targetCount - 0.08 * spanCount;
  borderish = constrain(borderish, 0.05, 0.85);

  const toward = v.x > 0 ? +1 : -1;
  const neigh = constrain(li + toward, 0, CONFIG.LABEL_ORDER.length - 1);

  const c0 = CONFIG.LABEL_CENTERS[li];
  const c1 = CONFIG.LABEL_CENTERS[neigh];

  const mix = CONFIG.BORDER_BLEND * borderish * (0.35 + 0.65 * v.d);

  const cx = lerp(c0.x, c1.x, mix);
  const cy = lerp(c0.y, c1.y, mix);

  const spread = (1.0 - CONFIG.CLUSTER_TIGHTNESS) +
    0.12 * (2 - Math.abs(li - 1.5));

  const wx = (cx + v.x * spread) * CONFIG.BASE_SCALE +
    randFromSeed(j * 17 + 1) * 14;
  const wy = (cy + v.y * spread) * CONFIG.BASE_SCALE +
    randFromSeed(j * 17 + 2) * 14;

  const depth = constrain(0.15 + 0.85 * v.d - 0.06 * li, 0, 1);

  return {
    text: it.text,
    label: it.label,
    targets: it.targets,
    spansByTarget: it.spansByTarget,
    wx, wy, depth
  };
}

// ---------- Target Rationale Parsing ----------
function parseTargetRationale(raw) {
  const m = new Map();
  if (!raw) return m;

  const trimmed = raw.trim();

  // Try JSON parsing
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      const j = JSON.parse(trimmed.replaceAll("'", '"'));
      const pairs = extractPairsFromAny(j);
      if (pairs.length) m.set("_all", pairs);
      return m;
    } catch (e) {
      // Continue with text parsing
    }
  }

  const targetsRegex = new RegExp(`\\b(${TARGETS.join("|")})\\b`, "gi");
  const parts = raw.split(/[\n|]+/g);

  for (const part of parts) {
    const tmatch = part.match(targetsRegex);
    const pairs = extractPairsFromText(part);
    if (!pairs.length) continue;

    if (tmatch && tmatch.length) {
      const t = normalizeTargetName(tmatch[0]);
      if (!m.has(t)) m.set(t, []);
      m.get(t).push(...pairs);
    } else {
      if (!m.has("_all")) m.set("_all", []);
      m.get("_all").push(...pairs);
    }
  }

  // Fallback
  if (m.size === 0) {
    const pairs = extractPairsFromText(raw);
    if (pairs.length) m.set("_all", pairs);
  }

  // Clean up spans
  for (const [k, arr] of m.entries()) {
    const cleaned = arr
      .map(([s, e]) => [Number(s), Number(e)])
      .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    m.set(k, cleaned);
  }

  return m;
}

function extractPairsFromText(s) {
  const out = [];
  const re = /(\d+)\s*,\s*(\d+)/g;
  let m;
  while ((m = re.exec(s || "")) !== null) {
    out.push([parseInt(m[1], 10), parseInt(m[2], 10)]);
  }
  return out;
}

function extractPairsFromAny(obj) {
  const out = [];
  const stack = [obj];

  while (stack.length) {
    const cur = stack.pop();
    if (cur == null) continue;

    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
    } else if (typeof cur === "object") {
      for (const k of Object.keys(cur)) stack.push(cur[k]);
    } else if (typeof cur === "string") {
      out.push(...extractPairsFromText(cur));
    }
  }

  return out;
}

function normalizeTargetName(s) {
  const t = (s || "").toLowerCase();
  if (t.includes("age")) return "Age";
  if (t.includes("disab")) return "Disabled";
  if (t.includes("gender")) return "Gender";
  if (t.includes("individual")) return "Individual";
  if (t.includes("job")) return "Job";
  if (t.includes("others") || t === "oth") return "Others";
  if (t.includes("politic")) return "Politics";
  if (t.includes("region")) return "Region";
  if (t.includes("relig")) return "Religion";
  return s;
}

function countAllSpans(map) {
  if (!map) return 0;
  let c = 0;
  for (const arr of map.values()) {
    c += (arr?.length || 0);
  }
  return c;
}

// ---------- Parsing Target Label ----------
function normalizeTargets(raw) {
  const s = (raw || "").toLowerCase();
  const set = new Set();

  if (s.includes("age")) set.add("Age");
  if (s.includes("disab")) set.add("Disabled");
  if (s.includes("gender") || s.includes("female") || s.includes("male")) {
    set.add("Gender");
  }
  if (s.includes("individual") || s.includes("person")) {
    set.add("Individual");
  }
  if (s.includes("job") || s.includes("occupation")) set.add("Job");
  if (s.includes("other") || s.includes("oth")) set.add("Others");
  if (s.includes("politic")) set.add("Politics");
  if (s.includes("region") || s.includes("country") || s.includes("nation")) {
    set.add("Region");
  }
  if (s.includes("relig")) set.add("Religion");

  return set;
}

// ---------- Snippets ----------
function makeSnippet(t, maxLen) {
  let s = (t || "").replace(/\s+/g, " ").trim();
  if (s.length > maxLen) s = s.slice(0, maxLen) + "…";
  return s;
}

function makeSnippetWithLimit(t, maxLen) {
  let s = (t || "").replace(/\s+/g, " ").trim();
  const limit = Math.min(maxLen, s.length);
  if (s.length > maxLen) s = s.slice(0, maxLen) + "…";
  return { snippet: s, limit };
}

// ---------- Sampling / Hashing ----------
function sampleArray(arr, n) {
  if (arr.length <= n) return arr;

  // Random sampling using Fisher-Yates partial shuffle
  const copy = [...arr];
  const out = [];

  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (copy.length - i));
    // Swap
    [copy[i], copy[j]] = [copy[j], copy[i]];
    out.push(copy[i]);
  }

  return out;
}

function randFromSeed(seed) {
  let x = seed >>> 0;
  x = (1664525 * x + 1013904223) >>> 0;
  return (x % 100000) / 100000 - 0.5;
}

function hashTo2D(text) {
  let a = 0, b = 0, c = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a = (a + code * 131) >>> 0;
    b = (b ^ (code * 31 + i * 17)) >>> 0;
    c = (c + (code * code + i * 13)) >>> 0;
  }

  const x01 = (a % 100000) / 100000;
  const y01 = (b % 100000) / 100000;
  const d01 = (c % 100000) / 100000;

  let x = x01 * 2 - 1;
  let y = y01 * 2 - 1;

  const r = Math.sqrt(x * x + y * y) + 1e-6;
  const k = 0.72 + 0.28 / (1 + 2.8 * r);
  x *= k;
  y *= k;

  return { x, y, d: d01 };
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ---------- UI ----------
function initChips() {
  if (!chipsEl) return;
  chipsEl.innerHTML = "";

  for (const t of TARGETS) {
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.dataset.on = "0";

    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = TARGET_COLORS[t];

    const label = document.createElement("span");
    label.textContent = t;

    chip.appendChild(dot);
    chip.appendChild(label);

    chip.addEventListener("click", () => {
      const idx = selectedTargets.indexOf(t);
      if (idx >= 0) {
        selectedTargets.splice(idx, 1);
        chip.dataset.on = "0";
      } else {
        if (selectedTargets.length >= 3) return;
        selectedTargets.push(t);
        chip.dataset.on = "1";
      }
    });

    chipsEl.appendChild(chip);
  }
}

function updateStatus(msg) {
  if (statusEl) statusEl.textContent = msg;
}

// ---------- Interaction ----------
function mouseWheel(event) {
  const factor = event.delta > 0 ? 1 / CONFIG.ZOOM_FACTOR : CONFIG.ZOOM_FACTOR;
  targetZoom = constrain(targetZoom * factor, CONFIG.ZOOM_MIN, CONFIG.ZOOM_MAX);
  return false;
}

function mousePressed() {
  dragging = true;
  lastX = mouseX;
  lastY = mouseY;
}

function mouseReleased() {
  dragging = false;
}

function mouseDragged() {
  if (!dragging) return;

  const dx = mouseX - lastX;
  const dy = mouseY - lastY;

  targetYaw += dx * CONFIG.YAW_SENSITIVITY;
  targetPitch = constrain(
    targetPitch + dy * CONFIG.PITCH_SENSITIVITY,
    CONFIG.PITCH_MIN,
    CONFIG.PITCH_MAX
  );

  lastX = mouseX;
  lastY = mouseY;
}

// Touch support for mobile
function touchStarted() {
  if (touches.length === 1) {
    dragging = true;
    lastX = touches[0].x;
    lastY = touches[0].y;
  }
  return false;
}

function touchMoved() {
  if (touches.length === 1 && dragging) {
    const dx = touches[0].x - lastX;
    const dy = touches[0].y - lastY;

    targetYaw += dx * CONFIG.YAW_SENSITIVITY;
    targetPitch = constrain(
      targetPitch + dy * CONFIG.PITCH_SENSITIVITY,
      CONFIG.PITCH_MIN,
      CONFIG.PITCH_MAX
    );

    lastX = touches[0].x;
    lastY = touches[0].y;
  }
  return false;
}

function touchEnded() {
  dragging = false;
  return false;
}