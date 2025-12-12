// =======================
// K-HATERS: Sentence Universe (vA-3)
// - severity axis (normal → L2)
// - tsne-like dots
// - smooth zoom → big full sentences
// =======================

let table;
let viewShiftX = 0;  // 화면 중심을 world x에서 얼마나 옮길지

let items = [];
let points = [];
let isReady = false;

// Camera (2.5D-ish: yaw/pitch + zoom)
let zoom = 1.0;
let targetZoom = 1.0;
let camYaw = 0.0, targetYaw = 0.0;
let camPitch = 0.0, targetPitch = 0.0;

let dragging = false;
let lastX = 0, lastY = 0;

// BG buffer
let starsG;

// UI
let chipsEl, statusEl;

// ===== Targets & Colors =====
// Disabled / Others 버튼은 제거 (데이터 파싱은 그대로 둠)
const TARGETS = [
  "Age",
  "Gender",
  "Individual",
  "Job",
  "Politics",
  "Region",
  "Religion",
];

// 텍스트 & 도트 하이라이트용 팔레트
const TARGET_COLORS = {
  Age: "#0000ff",
  Gender: "#20ff00",
  Individual: "#ff3333",
  Job: "#9848ff",
  Politics: "#ffa4ff",
  Region: "#00ffff",
  Religion: "#f3ff00",
};

// selected targets (max 3)
let selectedTargets = [];

// ===== CONFIG =====
const CONFIG = {
  CSV_PATH: "data/K-HATERS_train.csv",
  MAX_ROWS: 12000,

  LABEL_ORDER: ["normal", "offensive", "L1_hate", "L2_hate"],
  LABEL_CENTERS: [
    { x: -1.1, y: 0.02 },
    { x: -0.35, y: -0.03 },
    { x: 0.35, y: 0.02 },
    { x: 1.1, y: -0.02 }
  ],

  BASE_SCALE: 520,
  CLUSTER_TIGHTNESS: 0.68,
  BORDER_BLEND: 0.62,

  CAMERA_LERP: 0.18,

  MAX_DOTS_PER_FRAME: 12000,

  // Text caps
  MAX_TEXTS_MAX: 100,   // 중간 줌
  MAX_TEXTS_MIN: 12,     // 풀 줌 근처
  MAX_FULL_TEXTS: 5,    // full sentence 최대 개수

  // Snippet lengths (가까워도 80자까지만)
  FAR_SNIP: 14,
  MID_SNIP: 28,
  NEAR_SNIP: 80,

  TEXT_NEAR_FACTOR_MIN: 0.42,
  TEXT_SELECTED_BONUS: 0.18,
  TEXT_ZOOM_MIN: 1.05,

  // full sentence는 거의 맨 끝에서만
  FULLTEXT_ZOOM_START: 3.4,
  FULLTEXT_ZOOM_END: 3.8,  // 보통 ZOOM_MAX랑 같게 두면 편함

  DEPTH_BUCKETS: 28,

  ZOOM_MIN: 0.85,
  ZOOM_MAX: 3.8,
  ZOOM_FACTOR: 1.14,
  PITCH_MIN: -1.05,
  PITCH_MAX: 1.05,

  YAW_SENSITIVITY: 0.008,
  PITCH_SENSITIVITY: 0.006,

  DOT_CORE_MIN: 1.2,
  DOT_CORE_MAX: 3.0,
  DOT_GLOW_MULT: 3.0,
  DOT_ALPHA_FAR: 18,
  DOT_ALPHA_NEAR: 120,

  SELECT_BOOST_ALPHA: 1.4,
  SELECT_BOOST_SIZE: 1.15,

  TARGET_ATTRACT: 0.32,
  TARGET_ATTRACT_RADIUS: 220,
  POS_LERP: 0.08,
  PAN_SENSITIVITY: 0.9,     // 마우스로 가로로 1px 드래그할 때 world에서 얼마나 이동할지
  VIEW_SHIFT_MAX: 1200,     // 너무 멀리 나가지 않도록 클램프
};


const LABEL_INDEX = Object.fromEntries(
  CONFIG.LABEL_ORDER.map((k, i) => [k, i])
);
let depthBuckets = [];

// occupancy grid for text placement
let occGrid = new Map();
const OCC_CELL = 48;   // 기존 40 → 48 로 키우기


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
  for (const p of points) {
    p.x = p.wx;
    p.y = p.wy;
    p.tx = p.wx;
    p.ty = p.wy;
  }
}

// =======================
// DRAW
// =======================
function draw() {
  if (!isReady) return;

  zoom = lerp(zoom, targetZoom, CONFIG.CAMERA_LERP);
  camYaw = lerp(camYaw, targetYaw, CONFIG.CAMERA_LERP);
  camPitch = lerp(camPitch, targetPitch, CONFIG.CAMERA_LERP);

  updateTargetsMotion();

  background(0);
  occGrid.clear();

  image(starsG, 0, 0);

  blendMode(ADD);
  renderDots();
  blendMode(BLEND);

  renderTexts();

  const sel = selectedTargets.length ? selectedTargets.join(", ") : "(none)";
  if (statusEl) {
    statusEl.textContent =
      `zoom: ${zoom.toFixed(2)}\n` +
      `rows: ${points.length}\n` +
      `selected: ${sel}`;
  }
}

// =======================
// Target-based motion
// =======================
function updateTargetsMotion() {
  if (selectedTargets.length === 0) {
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
        const k =
          CONFIG.TARGET_ATTRACT *
          (0.72 + 0.28 * Math.min(2, hit)); // multi-target = stronger
        p.tx = lerp(p.wx, a.x, k);
        p.ty = lerp(p.wy, a.y, k);
      }
    }
  }

  for (const p of points) {
    p.x += (p.tx - p.x) * CONFIG.POS_LERP;
    p.y += (p.ty - p.y) * CONFIG.POS_LERP;
  }
}

// =======================
// Dots
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

      let core =
        lerp(CONFIG.DOT_CORE_MIN, CONFIG.DOT_CORE_MAX, nearFactor) *
        (0.65 + 0.35 * zoom);
      let alpha = lerp(
        CONFIG.DOT_ALPHA_FAR,
        CONFIG.DOT_ALPHA_NEAR,
        nearFactor
      );

      if (isSelected) {
        core *= CONFIG.SELECT_BOOST_SIZE;
        alpha = Math.min(255, alpha * CONFIG.SELECT_BOOST_ALPHA);
      }

      const col = severityColor(p.li, nearFactor, isSelected);

      noStroke();
      fill(col.r, col.g, col.b, alpha * 0.18);
      circle(s.x, s.y, core * CONFIG.DOT_GLOW_MULT);

      fill(col.r, col.g, col.b, alpha);
      circle(s.x, s.y, core);

      dotsDrawn++;
    }
  }
}

// =======================
// Texts – smooth full-sentence transition
// =======================
function renderTexts() {
  // 너무 멀리서까지는 텍스트 안 보이게
  if (zoom < CONFIG.TEXT_ZOOM_MIN) return;

  // --- 1) 후보 모으기 ---
  const candidates = [];

  for (let b = CONFIG.DEPTH_BUCKETS - 1; b >= 0; b--) {
    const bucket = depthBuckets[b];

    for (const idx of bucket) {
      const p = points[idx];
      const s = projectToScreen(p.x, p.y, p.depth);
      if (!isOnScreen(s.x, s.y, 160)) continue;

      const nearFactor = 1.0 - p.depth;
      const hit = intersectionCount(p.targets, selectedTargets);
      const isSelected = selectedTargets.length > 0 && hit > 0;

      const baseThresh = CONFIG.TEXT_NEAR_FACTOR_MIN;
      const thresh =
        baseThresh - (isSelected ? CONFIG.TEXT_SELECTED_BONUS : 0.0);
      if (nearFactor < thresh) continue;

      candidates.push({ p, s, nearFactor, isSelected });
    }
  }

  // 선택된 타겟 + 더 가까운 애들을 우선
  candidates.sort((a, b) => {
    if (a.isSelected !== b.isSelected) return a.isSelected ? -1 : 1;
    return b.nearFactor - a.nearFactor;
  });

  // 줌에 따라 한 프레임에 허용하는 텍스트 개수 보간
  const maxZoomForCount = CONFIG.FULLTEXT_ZOOM_START;
  const tZoom = constrain(
    (zoom - CONFIG.TEXT_ZOOM_MIN) /
    (maxZoomForCount - CONFIG.TEXT_ZOOM_MIN),
    0,
    1
  );
  const maxTexts = Math.round(
    lerp(CONFIG.MAX_TEXTS_MAX, CONFIG.MAX_TEXTS_MIN, tZoom)
  );

  let shown = 0;

  // ========================
  // A. 풀 문장 모드 (진짜 끝까지 줌했을 때만)
  // ========================
  if (zoom >= CONFIG.FULLTEXT_ZOOM_END) {
    const maxFull = Math.min(CONFIG.MAX_FULL_TEXTS, maxTexts);

    for (let i = 0; i < candidates.length && shown < maxFull; i++) {
      const { p, s, nearFactor, isSelected } = candidates[i];

      if (!canPlaceText(s.x, s.y)) continue;

      // 풀 문장 (… 없이 전부)
      let snippet = (p.text || "").replace(/\s+/g, " ").trim();
      const limit = snippet.length;

      // 더 부드럽게, 살짝 톤 다운 + 거리 따라 투명
      let size =
        lerp(16, 26, nearFactor) *
        (0.9 + 0.35 * (zoom - CONFIG.ZOOM_FULLTEXT_ONLY));

      // nearFactor^0.9 로, 멀리 있는 애는 더 빨리 옅어지게
      const fall = Math.pow(nearFactor, 0.9);
      const baseAlpha = lerp(90, 230, fall);
      const alpha = isSelected ? Math.min(255, baseAlpha * 1.15) : baseAlpha;

      textSize(size);

      if (isSelected) {
        const spans = getSelectedSpansClipped(
          p.spansByTarget,
          p.targets,
          limit
        );
        drawSingleLineColored(snippet, spans, s.x, s.y, alpha);
      } else {
        // 완전 흰색 대신 살짝 톤 다운된 밝은 회색
        fill(230, 232, 240, alpha);
        noStroke();
        text(snippet, s.x, s.y);
      }

      shown++;
    }
    return;
  }

  // ========================
  // B. 일반 모드: 요약 텍스트 (… 유지)
  // ========================
  for (let i = 0; i < candidates.length && shown < maxTexts; i++) {
    const { p, s, nearFactor, isSelected } = candidates[i];

    if (!canPlaceText(s.x, s.y)) continue;

    // 긴 스니펫은 "진짜 많이 가까워지고, 꽤 많이 줌한" 상태에서만
    let snippetLen;
    if (nearFactor > 0.86 && zoom > 3.0) {
      snippetLen = CONFIG.NEAR_SNIP;      // 최대 80자
    } else if (nearFactor > 0.65 && zoom > 2.0) {
      snippetLen = CONFIG.MID_SNIP;       // 28자
    } else {
      snippetLen = CONFIG.FAR_SNIP;       // 14자
    }

    const { snippet, limit } = makeSnippetWithLimit(p.text, snippetLen);

    // 멀수록 더 작고 더 투명
    let size =
      lerp(10, 18, nearFactor) * Math.min(1.15, zoom / 1.35);

    // nearFactor^1.1 로 멀리 있는 놈들 빨리 죽이기
    const fall = Math.pow(nearFactor, 1.1);
    const baseAlpha = lerp(30, 210, fall);
    const alpha = isSelected ? Math.min(255, baseAlpha * 1.25) : baseAlpha;

    textSize(size);

    if (isSelected) {
      const spans = getSelectedSpansClipped(
        p.spansByTarget,
        p.targets,
        limit
      );
      drawSingleLineColored(snippet, spans, s.x, s.y, alpha);
    } else {
      fill(230, 232, 240, alpha); // 살짝 톤 다운
      noStroke();
      text(snippet, s.x, s.y);
    }
    shown++;
  }
}


// =======================
// Point placement (severity axis)
// =======================
function makePoint(it, j) {
  const v = hashTo2D(it.text);
  const li = LABEL_INDEX[it.label] ?? 1;

  const targetCount = it.targets ? it.targets.size : 0;
  const spanCount = countAllSpans(it.spansByTarget);

  let borderish = 0.78 - 0.12 * targetCount - 0.08 * spanCount;
  borderish = constrain(borderish, 0.06, 0.86);

  const toward = v.x > 0 ? +1 : -1;
  const neigh = constrain(
    li + toward,
    0,
    CONFIG.LABEL_ORDER.length - 1
  );

  const c0 = CONFIG.LABEL_CENTERS[li];
  const c1 = CONFIG.LABEL_CENTERS[neigh];

  const mix = CONFIG.BORDER_BLEND * borderish * (0.32 + 0.68 * v.d);

  const cx = lerp(c0.x, c1.x, mix);
  const cy = lerp(c0.y, c1.y, mix);

  const spread =
    (1.0 - CONFIG.CLUSTER_TIGHTNESS) +
    0.1 * (2 - Math.abs(li - 1.5));

  const wx =
    (cx + v.x * spread * 0.7) * CONFIG.BASE_SCALE +
    randFromSeed(j * 17 + 1) * 18;
  const wy =
    (cy + v.y * spread * 1.15) * CONFIG.BASE_SCALE +
    randFromSeed(j * 17 + 2) * 18;

  const depth = constrain(
    0.15 + 0.85 * v.d - 0.06 * li,
    0,
    1
  );

  return {
    text: it.text,
    label: it.label,
    li,
    targets: it.targets,
    spansByTarget: it.spansByTarget,
    wx,
    wy,
    depth,
    x: wx,
    y: wy,
    tx: wx,
    ty: wy
  };
}

// =======================
// Projection
// =======================
function projectToScreen(wx, wy, depth01) {
  const z = Math.max(0.35, zoom);
  const persp = lerp(1.22, 0.26, depth01) * z;

  const cy = Math.cos(camYaw),
    sy = Math.sin(camYaw);
  const cp = Math.cos(camPitch);

  // viewShiftX만큼 화면 중심을 왼/오로 슬라이드
  const wxShifted = wx - viewShiftX;

  let x = wxShifted * cy - wy * sy;
  let y = wxShifted * sy + wy * cy;

  let y2 = y * cp; // fake 3D

  return {
    x: width / 2 + x * persp,
    y: height / 2 + y2 * persp,
  };
}


// =======================
// Buckets
// =======================
function buildDepthBuckets() {
  depthBuckets = Array.from(
    { length: CONFIG.DEPTH_BUCKETS },
    () => []
  );
  for (let i = 0; i < points.length; i++) {
    const d = points[i].depth;
    const bi = Math.max(
      0,
      Math.min(
        CONFIG.DEPTH_BUCKETS - 1,
        Math.floor(d * CONFIG.DEPTH_BUCKETS)
      )
    );
    depthBuckets[bi].push(i);
  }
  for (let b = 0; b < CONFIG.DEPTH_BUCKETS; b++)
    shuffleInPlace(depthBuckets[b]);
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
// Severity color (연한 빨강 ↔ 빨강)
// =======================
function severityColor(li, nearFactor, selected) {
  const bases = [
    { r: 120, g: 80, b: 90 },  // normal
    { r: 150, g: 70, b: 90 },  // offensive
    { r: 190, g: 60, b: 90 },  // L1
    { r: 230, g: 50, b: 80 }   // L2
  ];
  const base = bases[constrain(li, 0, 3)];

  const w = lerp(0.0, 0.25, nearFactor) + (selected ? 0.08 : 0.0);

  return {
    r: Math.round(lerp(base.r, 255, w)),
    g: Math.round(lerp(base.g, 180, w * 0.6)),
    b: Math.round(lerp(base.b, 140, w * 0.4))
  };
}

// =======================
// Text coloring
// =======================
function drawSingleLineColored(txt, spans, x, y, alphaText) {
  if (!spans.length) {
    fill(230, 232, 240, alphaText);  // 약간 회색 톤
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
    const hits = spans
      .filter((sp) => sp.s < b && sp.e > a)
      .map((sp) => sp.t);

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
    (t) => targetSet && targetSet.has(t)
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
    .map((o) => ({
      ...o,
      s: Math.max(0, Math.min(limit, o.s)),
      e: Math.max(0, Math.min(limit, o.e))
    }))
    .filter((o) => o.e > o.s);

  spans.sort((a, b) => a.s - b.s || a.e - b.e);
  return spans;
}

// =======================
// Target rationale parsing (원래 로직 유지)
// =======================
function parseTargetRationale(raw) {
  const m = new Map();
  if (!raw) return m;

  const trimmed = raw.trim();

  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
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
      .filter(
        ([s, e]) =>
          Number.isFinite(s) && Number.isFinite(e) && e > s
      )
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    m.set(k, cleaned);
  }

  return m;
}

function extractPairsFromText(s) {
  const out = [];
  const re = /(\d+)\s*,\s*(\d+)/g;
  let m;
  while ((m = re.exec(s || "")) !== null)
    out.push([parseInt(m[1], 10), parseInt(m[2], 10)]);
  return out;
}

function extractPairsFromAny(obj) {
  const out = [];
  const stack = [obj];
  while (stack.length) {
    const cur = stack.pop();
    if (cur == null) continue;
    if (Array.isArray(cur)) for (const v of cur) stack.push(v);
    else if (typeof cur === "object")
      for (const k of Object.keys(cur)) stack.push(cur[k]);
    else if (typeof cur === "string")
      out.push(...extractPairsFromText(cur));
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
  for (const arr of map.values()) c += arr?.length || 0;
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
  if (s.includes("gender") || s.includes("female") || s.includes("male"))
    set.add("Gender");
  if (s.includes("individual") || s.includes("person"))
    set.add("Individual");
  if (s.includes("job") || s.includes("occupation"))
    set.add("Job");
  if (s.includes("other") || s.includes("oth")) set.add("Others");
  if (s.includes("politic")) set.add("Politics");
  if (s.includes("region") || s.includes("country") || s.includes("nation"))
    set.add("Region");
  if (s.includes("relig")) set.add("Religion");
  return set;
}

// =======================
// Utils
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
  const k = 0.7 + 0.3 / (1 + 2.6 * r);
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
  return (
    x >= -margin &&
    x <= width + margin &&
    y >= -margin &&
    y <= height + margin
  );
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
// UI
// =======================
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
        // ★ 더 이상 개수 제한 없음
        selectedTargets.push(t);
        chip.dataset.on = "1";
      }
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
  const factor =
    event.delta > 0 ? 1 / CONFIG.ZOOM_FACTOR : CONFIG.ZOOM_FACTOR;
  targetZoom = constrain(
    targetZoom * factor,
    CONFIG.ZOOM_MIN,
    CONFIG.ZOOM_MAX
  );
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

  if (keyIsDown(SHIFT)) {
    // --- Shift + 드래그: view를 옆으로 밀기 (pan) ---
    // dx > 0 (오른쪽으로 드래그) → viewShiftX 증가 → 화면은 왼쪽 클러스터로 이동
    viewShiftX = constrain(
      viewShiftX - dx * CONFIG.PAN_SENSITIVITY,
      -CONFIG.VIEW_SHIFT_MAX,
      CONFIG.VIEW_SHIFT_MAX
    );

    // 패닝 모드에서는 pitch는 안 건드리는 편이 깔끔해서 dy는 무시
  } else {
    // --- 기본: 회전 모드 ---
    targetYaw += dx * CONFIG.YAW_SENSITIVITY;
    targetPitch = constrain(
      targetPitch + dy * CONFIG.PITCH_SENSITIVITY,
      CONFIG.PITCH_MIN,
      CONFIG.PITCH_MAX
    );
  }

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
  if (starsG) starsG.remove();
  makeStars();
}

function keyPressed() {
  const step = 250;  // 한 번에 얼마나 옮길지 (필요하면 조정)

  if (key === 'a' || key === 'A') {
    // 왼쪽으로 이동: L2_hate 쪽을 화면 중앙으로
    viewShiftX -= step;
  } else if (key === 'd' || key === 'D') {
    // 오른쪽으로 이동: normal 쪽을 화면 중앙으로
    viewShiftX += step;
  } else if (key === '0') {
    // 초기 위치로 리셋
    viewShiftX = 0;
  }
}
