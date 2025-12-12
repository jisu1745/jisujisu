// =======================
// K-HATERS: Sentence Universe (vA-2)
// focus: (1) severity clustering axis (normal->L2)
//        (2) crisp points (tsne-like)
//        (3) target filter 스르륵 모핑
// =======================

let table;

let items = [];
let points = [];
let isReady = false;

// Camera (2.5D-ish: yaw/pitch + zoom; no auto-spin)
let zoom = 1.0;
let targetZoom = 1.0;
let camYaw = 0.0, targetYaw = 0.0;
let camPitch = 0.0, targetPitch = 0.0;

let dragging = false;
let lastX = 0, lastY = 0;

// filter animation (0~1)
let filterAnim = 0;
let filterAnimTarget = 0;

// BG buffer
let starsG;

// UI
let chipsEl, statusEl;

// ===== Targets & Colors =====
const TARGETS = ["Age", "Disabled", "Gender", "Individual", "Job", "Others", "Politics", "Region", "Religion"];
const CHIP_TARGETS = ["Age", "Gender", "Individual", "Job", "Politics", "Region", "Religion"];


// 타겟 컬러 (chip + 텍스트 하이라이트 공유)
const TARGET_COLORS = {
  Age: "#0000ff",  // 파란
  Disabled: "#666666",  // UI에서는 안 쓰지만, 데이터용으로 무난하게
  Gender: "#20ff00",  // 연두
  Individual: "#ff3333",  // 강한 빨강
  Job: "#9848ff",  // 보라
  Others: "#666666",  // UI X, fallback용
  Politics: "#ffa4ff",  // 핑크
  Region: "#00ffff",  // 시안
  Religion: "#f3ff00"   // 노랑
};

// selected targets (max 3)
let selectedTargets = [];

// ===== CONFIG =====
const CONFIG = {
  CSV_PATH: "data/K-HATERS_train.csv",
  MAX_ROWS: 12000,

  // Severity axis
  LABEL_ORDER: ["normal", "offensive", "L1_hate", "L2_hate"],
  LABEL_CENTERS: [
    { x: -1.10, y: 0.02 }, // normal
    { x: -0.35, y: -0.03 }, // offensive
    { x: 0.35, y: 0.02 }, // L1
    { x: 1.10, y: -0.02 }  // L2
  ],

  BASE_SCALE: 520,
  CLUSTER_TIGHTNESS: 0.68,
  BORDER_BLEND: 0.62,

  // Camera smoothing
  CAMERA_LERP: 0.18,

  // Render caps
  MAX_DOTS_PER_FRAME: 12000,
  MAX_TEXTS_PER_FRAME: 120,

  // Snippet lengths
  FAR_SNIP: 14,
  MID_SNIP: 28,
  NEAR_SNIP: 120,

  // Text visibility thresholds
  TEXT_NEAR_FACTOR_MIN: 0.42,
  TEXT_SELECTED_BONUS: 0.18,
  TEXT_ZOOM_MIN: 1.05,

  // Depth / ordering
  DEPTH_BUCKETS: 28,

  // Camera
  ZOOM_MIN: 0.85,
  ZOOM_MAX: 4.2,
  ZOOM_FACTOR: 1.14,
  PITCH_MIN: -1.05,
  PITCH_MAX: 1.05,

  // Rotation sensitivity
  YAW_SENSITIVITY: 0.008,
  PITCH_SENSITIVITY: 0.006,

  // Point look (tsne-like)
  // (2) Point look (tsne-like)
  DOT_CORE_MIN: 1.0,
  DOT_CORE_MAX: 2.4,
  DOT_GLOW_MULT: 2.2,
  DOT_ALPHA_FAR: 12,
  DOT_ALPHA_NEAR: 110,

  // Selected boosting
  SELECT_BOOST_ALPHA: 1.55,
  SELECT_BOOST_SIZE: 1.20,

  // Target filter 모핑
  TARGET_ATTRACT: 0.32,
  TARGET_ATTRACT_RADIUS: 220,
  POS_LERP: 0.08
};

const LABEL_INDEX = Object.fromEntries(
  CONFIG.LABEL_ORDER.map((k, i) => [k, i])
);

let depthBuckets = [];

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

// =======================
// p5 lifecycle
// =======================
function preload() {
  table = loadTable(CONFIG.CSV_PATH, "csv", "header");
}

function setup() {
  createCanvas(windowWidth, windowHeight);
  textFont("Noto Sans KR");
  textAlign(LEFT, TOP);

  chipsEl = document.getElementById("chips");
  statusEl = document.getElementById("status");

  initChips();

  if (!table) {
    setStatus("error: CSV load failed");
    return;
  }
  if (table.getRowCount() === 0) {
    setStatus(`error: CSV 0 rows (${CONFIG.CSV_PATH})`);
    return;
  }

  parseData();
  buildPoints();
  buildDepthBuckets();
  makeStars();

  isReady = true;
  setStatus(`rows: ${items.length}\nselected: (none)`);
}

function draw() {
  if (!isReady) return;

  // smooth camera
  zoom = lerp(zoom, targetZoom, CONFIG.CAMERA_LERP);
  camYaw = lerp(camYaw, targetYaw, CONFIG.CAMERA_LERP);
  camPitch = lerp(camPitch, targetPitch, CONFIG.CAMERA_LERP);

  // filter animation 0~1
  filterAnim += (filterAnimTarget - filterAnim) * 0.18;

  // target 선택에 따른 포인트 모션
  updateTargetsMotion();

  background(0);
  occGrid.clear();

  image(starsG, 0, 0);

  // Dots: additive for tsne glow
  blendMode(ADD);
  renderDots();
  blendMode(BLEND);

  // Text overlay
  renderTexts();

  const sel = selectedTargets.length ? selectedTargets.join(", ") : "(none)";
  if (statusEl) {
    statusEl.textContent =
      `zoom: ${zoom.toFixed(2)}\n` +
      `rows: ${points.length}\n` +
      `selected (max 3): ${sel}`;
  }
}

// =======================
// Data
// =======================
function parseData() {
  items = [];
  const n = table.getRowCount();

  for (let i = 0; i < n; i++) {
    const text = (table.getString(i, "text") || "").trim();
    if (!text) continue;

    const label = (table.getString(i, "label") || "offensive").trim();
    const targetLabelRaw = table.getString(i, "target_label") || "";
    const targetRationaleRaw = table.getString(i, "target_rationale") || "";

    items.push({
      text,
      label,
      targets: normalizeTargets(targetLabelRaw),
      spansByTarget: parseTargetRationale(targetRationaleRaw)
    });
  }

  items = sampleArray(items, CONFIG.MAX_ROWS);
}

function buildPoints() {
  points = items.map((it, j) => makePoint(it, j));

  // init animated pos
  for (const p of points) {
    p.x = p.wx;
    p.y = p.wy;
    p.tx = p.wx;
    p.ty = p.wy;
  }
}

// =======================
// Target-driven motion
// =======================
function updateTargetsMotion() {
  if (selectedTargets.length === 0) {
    // 필터 꺼졌을 때는 원래 위치로 회귀
    for (const p of points) {
      p.tx = p.wx;
      p.ty = p.wy;
    }
  } else {
    const anchors = getTargetAnchors(selectedTargets);

    for (const p of points) {
      const hit = intersectionCount(p.targets, selectedTargets);
      if (hit === 0) {
        p.tx = p.wx;
        p.ty = p.wy;
      } else {
        const a = avgAnchorsForPoint(p.targets, selectedTargets, anchors);

        // 기본 attract 강도 × filterAnim (0→1로 올라가면서 서서히 끌려감)
        const baseK = CONFIG.TARGET_ATTRACT *
          (0.72 + 0.28 * Math.min(2, hit));
        const k = baseK * filterAnim;

        p.tx = lerp(p.wx, a.x, k);
        p.ty = lerp(p.wy, a.y, k);
      }
    }
  }

  // tx,ty 로 슬금슬금 이동
  for (const p of points) {
    p.x += (p.tx - p.x) * CONFIG.POS_LERP;
    p.y += (p.ty - p.y) * CONFIG.POS_LERP;
  }
}

// =======================
// Rendering
// =======================
function renderDots() {
  let dotsDrawn = 0;

  for (let b = CONFIG.DEPTH_BUCKETS - 1; b >= 0; b--) {
    const bucket = depthBuckets[b];

    for (const idx of bucket) {
      if (dotsDrawn >= CONFIG.MAX_DOTS_PER_FRAME) return;

      const p = points[idx];
      const s = projectToScreen(p.x, p.y, p.depth);
      if (!isOnScreen(s.x, s.y, 250)) continue;

      const nearFactor = 1.0 - p.depth;
      const hit = intersectionCount(p.targets, selectedTargets);
      const isSelected = selectedTargets.length > 0 && hit > 0;

      let core = lerp(CONFIG.DOT_CORE_MIN, CONFIG.DOT_CORE_MAX, nearFactor) *
        (0.65 + 0.35 * zoom);
      let alpha = lerp(CONFIG.DOT_ALPHA_FAR, CONFIG.DOT_ALPHA_NEAR, nearFactor);

      if (isSelected) {
        core *= CONFIG.SELECT_BOOST_SIZE;
        alpha = Math.min(255, alpha * CONFIG.SELECT_BOOST_ALPHA);
      }

      const col = severityColor(p.li, nearFactor, isSelected);

      noStroke();

      // glow
      fill(col.r, col.g, col.b, alpha * 0.16);
      circle(s.x, s.y, core * CONFIG.DOT_GLOW_MULT);

      // core
      fill(col.r, col.g, col.b, alpha);
      circle(s.x, s.y, core);

      dotsDrawn++;
    }
  }
}

function renderTexts() {
  if (zoom < CONFIG.TEXT_ZOOM_MIN) return;

  let shown = 0;

  for (let b = CONFIG.DEPTH_BUCKETS - 1; b >= 0; b--) {
    const bucket = depthBuckets[b];

    for (const idx of bucket) {
      if (shown >= CONFIG.MAX_TEXTS_PER_FRAME) return;

      const p = points[idx];
      const s = projectToScreen(p.x, p.y, p.depth);
      if (!isOnScreen(s.x, s.y, 160)) continue;

      const nearFactor = 1.0 - p.depth;
      const hit = intersectionCount(p.targets, selectedTargets);
      const isSelected = selectedTargets.length > 0 && hit > 0;

      const thresh = CONFIG.TEXT_NEAR_FACTOR_MIN -
        (isSelected ? CONFIG.TEXT_SELECTED_BONUS : 0.0);
      if (nearFactor < thresh) continue;

      if (!canPlaceText(s.x, s.y)) continue;

      let snippetLen;
      if (nearFactor > 0.78 && zoom > 1.55) snippetLen = CONFIG.NEAR_SNIP;
      else if (nearFactor > 0.55 && zoom > 1.15) snippetLen = CONFIG.MID_SNIP;
      else snippetLen = CONFIG.FAR_SNIP;

      const { snippet, limit } = makeSnippetWithLimit(p.text, snippetLen);

      const size = lerp(10, 18, nearFactor) *
        Math.min(1.25, zoom / 1.4);
      const baseAlpha = lerp(90, 255, nearFactor);
      const alpha = isSelected ? Math.min(255, baseAlpha * 1.35) : baseAlpha;

      textSize(size);

      if (isSelected) {
        const spans = getSelectedSpansClipped(p.spansByTarget, p.targets, limit);
        drawSingleLineColored(snippet, spans, s.x, s.y, alpha);
      } else {
        fill(255, alpha);
        noStroke();
        text(snippet, s.x, s.y);
      }

      shown++;
    }
  }
}

// =======================
// Point placement
// =======================
function makePoint(it, j) {
  const v = hashTo2D(it.text);
  const li = LABEL_INDEX[it.label] ?? 1;

  const targetCount = it.targets ? it.targets.size : 0;
  const spanCount = countAllSpans(it.spansByTarget);

  let borderish = 0.78 - 0.12 * targetCount - 0.08 * spanCount;
  borderish = constrain(borderish, 0.06, 0.86);

  const toward = v.x > 0 ? +1 : -1;
  const neigh = constrain(li + toward, 0, CONFIG.LABEL_ORDER.length - 1);

  const c0 = CONFIG.LABEL_CENTERS[li];
  const c1 = CONFIG.LABEL_CENTERS[neigh];

  const mix = CONFIG.BORDER_BLEND * borderish * (0.32 + 0.68 * v.d);

  const cx = lerp(c0.x, c1.x, mix);
  const cy = lerp(c0.y, c1.y, mix);

  const spread =
    (1.0 - CONFIG.CLUSTER_TIGHTNESS) +
    0.10 * (2 - Math.abs(li - 1.5));

  const wx = (cx + v.x * spread * 0.70) * CONFIG.BASE_SCALE +
    randFromSeed(j * 17 + 1) * 18;
  const wy = (cy + v.y * spread * 1.15) * CONFIG.BASE_SCALE +
    randFromSeed(j * 17 + 2) * 18;

  const depth = constrain(0.15 + 0.85 * v.d - 0.06 * li, 0, 1);

  return {
    text: it.text,
    label: it.label,
    li,
    targets: it.targets,
    spansByTarget: it.spansByTarget,
    wx, wy, depth,
    x: wx, y: wy, tx: wx, ty: wy
  };
}

// =======================
// Projection
// =======================
function projectToScreen(wx, wy, depth01) {
  const z = Math.max(0.35, zoom);
  const persp = lerp(1.22, 0.26, depth01) * z;

  const cy = Math.cos(camYaw), sy = Math.sin(camYaw);
  const cp = Math.cos(camPitch), sp = Math.sin(camPitch);

  // yaw
  let x = wx * cy - wy * sy;
  let y = wx * sy + wy * cy;

  // pitch (fake Z)
  let y2 = y * cp;

  return {
    x: width / 2 + x * persp,
    y: height / 2 + y2 * persp
  };
}

// =======================
// Depth buckets
// =======================
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

// =======================
// Background stars
// =======================
function makeStars() {
  starsG = createGraphics(width, height);
  starsG.background(2, 2, 10);
  starsG.noStroke();
  randomSeed(42);

  for (let i = 0; i < 240; i++) {
    starsG.fill(255, random(6, 18));
    starsG.circle(random(width), random(height), random(0.6, 1.8));
  }
  for (let i = 0; i < 60; i++) {
    const x = random(width), y = random(height);
    starsG.fill(255, random(18, 40));
    starsG.circle(x, y, random(1.6, 2.8));
  }
}

// =======================
// Colors (severity gradient)
// =======================
// =======================
// Colors (very soft red -> strong red)
// =======================
function severityColor(li, nearFactor, selected) {
  // li: 0 = normal, 1 = offensive, 2 = L1_hate, 3 = L2_hate
  const base = [
    { r: 110, g: 80, b: 80 },  // normal  : 아주 약한 붉은 톤
    { r: 140, g: 70, b: 70 },  // offensive: 조금 더 붉게
    { r: 185, g: 65, b: 65 },  // L1_hate : 꽤 붉은
    { r: 230, g: 55, b: 55 }   // L2_hate : 강한 빨강
  ][constrain(li, 0, 3)];

  // 가까울수록 살짝만 더 밝게 (화이트 섞기)
  const wBase = lerp(0.02, 0.12, nearFactor);
  const w = wBase + (selected ? 0.05 : 0); // 선택된 점이면 아주 조금 더 강조

  return {
    r: Math.round(lerp(base.r, 255, w)),
    g: Math.round(lerp(base.g, 255, w)),
    b: Math.round(lerp(base.b, 255, w))
  };
}


// =======================
// Text helpers
// =======================
function drawSingleLineColored(txt, spans, x, y, alphaText) {
  if (!spans.length) {
    fill(255, alphaText);
    noStroke();
    text(txt, x, y);
    return;
  }

  const boundaries = new Set([0, txt.length]);
  for (const sp of spans) {
    boundaries.add(sp.s);
    boundaries.add(sp.e);
  }
  const cuts = Array.from(boundaries).sort((a, b) => a - b);

  let cursorX = x;

  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i], b = cuts[i + 1];
    if (b <= a) continue;

    const seg = txt.slice(a, b);
    const hits = spans.filter(sp => sp.s < b && sp.e > a).map(sp => sp.t);

    let col = "#ffffff";
    if (hits.length >= 1) col = TARGET_COLORS[hits[0]] || "#ffffff";

    const rgb = hexToRgb(col);
    fill(rgb.r, rgb.g, rgb.b, Math.min(255, alphaText));
    noStroke();
    text(seg, cursorX, y);
    cursorX += textWidth(seg);
  }
}

function getSelectedSpansClipped(spansByTarget, targetSet, limit) {
  if (!selectedTargets.length) return [];

  const validSelected = selectedTargets.filter(
    t => targetSet && targetSet.has(t)
  );
  if (!validSelected.length) return [];

  let spans = [];

  for (const t of validSelected) {
    const arr = spansByTarget?.get(t);
    if (arr && arr.length) {
      for (const [s, e] of arr) spans.push({ s, e, t });
    }
  }

  if (!spans.length) {
    const all = spansByTarget?.get("_all");
    if (all && all.length) {
      const t = validSelected[0];
      for (const [s, e] of all) spans.push({ s, e, t });
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

// =======================
// Target rationale parsing
// =======================
function parseTargetRationale(raw) {
  const m = new Map();
  if (!raw) return m;

  const trimmed = raw.trim();

  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      const j = JSON.parse(trimmed.replaceAll("'", '"'));
      const pairs = extractPairsFromAny(j);
      if (pairs.length) m.set("_all", pairs);
      return m;
    } catch (e) { }
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

  if (m.size === 0) {
    const pairs = extractPairsFromText(raw);
    if (pairs.length) m.set("_all", pairs);
  }

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
  for (const arr of map.values()) c += (arr?.length || 0);
  return c;
}

// =======================
// Target label parsing
// =======================
function normalizeTargets(raw) {
  const s = (raw || "").toLowerCase();
  const set = new Set();
  if (s.includes("age")) set.add("Age");
  if (s.includes("disab")) set.add("Disabled");
  if (s.includes("gender") || s.includes("female") || s.includes("male")) set.add("Gender");
  if (s.includes("individual") || s.includes("person")) set.add("Individual");
  if (s.includes("job") || s.includes("occupation")) set.add("Job");
  if (s.includes("other") || s.includes("oth")) set.add("Others");
  if (s.includes("politic")) set.add("Politics");
  if (s.includes("region") || s.includes("country") || s.includes("nation")) set.add("Region");
  if (s.includes("relig")) set.add("Religion");
  return set;
}

// =======================
// Misc helpers
// =======================
function makeSnippetWithLimit(t, maxLen) {
  let s = (t || "").replace(/\s+/g, " ").trim();
  const limit = Math.min(maxLen, s.length);
  if (s.length > maxLen) s = s.slice(0, maxLen) + "…";
  return { snippet: s, limit };
}

function sampleArray(arr, n) {
  if (arr.length <= n) return arr;
  const copy = [...arr];
  const out = [];
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (copy.length - i));
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
  const k = 0.70 + 0.30 / (1 + 2.6 * r);
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
function isOnScreen(x, y, margin = 200) {
  return x >= -margin && x <= width + margin &&
    y >= -margin && y <= height + margin;
}
function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16)
  };
}

// =======================
// Target anchors + matching
// =======================
function intersectionCount(setA, selectedArr) {
  if (!setA || selectedArr.length === 0) return 0;
  let c = 0;
  for (const t of selectedArr) if (setA.has(t)) c++;
  return c;
}

function getTargetAnchors(sel) {
  const anchors = {};
  const n = sel.length;
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2.0 - Math.PI / 2;
    anchors[sel[i]] = {
      x: Math.cos(ang) * CONFIG.TARGET_ATTRACT_RADIUS,
      y: Math.sin(ang) * CONFIG.TARGET_ATTRACT_RADIUS * 0.65
    };
  }
  return anchors;
}

function avgAnchorsForPoint(targetSet, sel, anchors) {
  let sx = 0, sy = 0, k = 0;
  for (const t of sel) {
    if (targetSet && targetSet.has(t)) {
      sx += anchors[t].x;
      sy += anchors[t].y;
      k++;
    }
  }
  if (k === 0) return { x: 0, y: 0 };
  return { x: sx / k, y: sy / k };
}

// =======================
// selection change hook
// =======================
function onSelectionChanged() {
  if (selectedTargets.length > 0) {
    // 새 필터 적용될 때마다 0→1로 다시 모핑
    filterAnim = 0;
    filterAnimTarget = 1;
  } else {
    // 필터 다 풀면 천천히 원래 상태로
    filterAnimTarget = 0;
  }
}

// =======================
// UI
// =======================
function initChips() {
  if (!chipsEl) return;
  chipsEl.innerHTML = "";

  for (const t of CHIP_TARGETS) {
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
      onSelectionChanged();   // ★ 선택 변경 시 모핑 트리거
    });

    chipsEl.appendChild(chip);
  }
}

function setStatus(msg) {
  if (statusEl) statusEl.textContent = msg;
}

// =======================
// Interaction
// =======================
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

// Touch support
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

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  makeStars();
}
