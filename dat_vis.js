// ===== 기본 설정 =====
const labelOrder = ['normal', 'offensive', 'L1_hate', 'L2_hate'];

let table;
let allRows = [];          // { text, label }
let samples = [];          // { text, label, x, y, layer, idxInLabel }
let labelColor = {};       // 라벨별 색상 (p5 color)
let labelCounts = {};      // 라벨별 샘플 개수

// Google Fonts에서 가져온 메인 폰트
let mainFont;

// 뷰(카메라) 회전/줌
let rotX = -0.5;           // 위에서 살짝 내려다보는 각도
let rotY = 0.7;            // 약간 회전
let zoom3D = 1.0;

// 마우스 회전 제어
let lastMouseX = 0;
let lastMouseY = 0;
let isDragging = false;

// ===== 레이아웃 파라미터 (X 선 + 3D 깊이) =====
let MAX_PER_LABEL = 1500;      // 라벨당 최대 샘플 수

const BAND_SIZE    = 4;        // 한 "층(layer)"에 몇 줄씩 둘지
const BASE_DIST    = 90;       // 중심에서 첫 층까지 거리
const STEP_DIST    = 95;       // 층이 바깥으로 퍼지는 정도
const PERP_SPACING = 45;       // 선에 수직한 방향으로 퍼지는 폭

const DEPTH_STEP   = 40;       // layer 당 z축 간격 (깊이감)

// 각 라벨이 차지하는 X 방향 각도 (라디안)
const labelAngles = {
  normal:    5 * Math.PI / 4,  // 225도 ↖
  offensive: 7 * Math.PI / 4,  // 315도 ↗
  L1_hate:   3 * Math.PI / 4,  // 135도 ↙
  L2_hate:   Math.PI / 4       // 45도 ↘
};

function preload() {
  // 🔥 Google Fonts에서 직접 폰트 파일 로드 (Regular 400)
  // 다른 weight 쓰고 싶으면 URL만 바꿔주면 됨.
  mainFont = loadFont(
    'https://fonts.gstatic.com/s/notosanskr/v25/Pby6FmXiEBPT4ITbgNA5CgmOelzY7GDt.ttf'
  );

  // CSV 로드
  table = loadTable('data/K-HATERS_train.csv', 'csv', 'header');
}

function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL); // WEBGL 모드
  colorMode(HSB, 360, 100, 100, 100);

  // preload에서 로드된 폰트 적용
  textFont(mainFont);
  textSize(12);
  textAlign(LEFT, TOP);
  textWrap(WORD);
  noLoop();

  // CSV 읽기
  const n = table.getRowCount();
  for (let i = 0; i < n; i++) {
    const t = table.getString(i, 'text') || '';
    let l = table.getString(i, 'label') || 'unknown';
    if (!labelOrder.includes(l)) l = 'L2_hate'; // fallback
    allRows.push({ text: t, label: l });
  }

  // 색상: normal 파랑, offensive 보라, L1 자주, L2 빨강
  labelColor['normal']    = color(210, 80, 100, 95); // 파랑
  labelColor['offensive'] = color(270, 80, 100, 95); // 보라
  labelColor['L1_hate']   = color(305, 80, 100, 95); // 자주색
  labelColor['L2_hate']   = color(0,   90, 100, 95); // 빨강

  labelOrder.forEach(l => { labelCounts[l] = 0; });

  // 샘플 위치 미리 계산
  prelayoutSamples();

  redraw();
}

function draw() {
  background(0);

  // ===== 3D 공간 그리기 =====
  push();

  scale(zoom3D);
  rotateX(rotX);
  rotateY(rotY);

  // 축(X 모양) 비워둠: drawXGrid3D는 아무것도 안 그림
  drawXGrid3D();
  drawSamples3D();

  pop();
}

// ===== 샘플 사전 배치 =====

function prelayoutSamples() {
  samples = [];
  labelOrder.forEach(l => { labelCounts[l] = 0; });

  labelOrder.forEach(label => {
    const pool = allRows.filter(r => r.label === label);
    shuffleArray(pool); // 라벨 내부 랜덤 순서

    const count = min(pool.length, MAX_PER_LABEL);
    for (let i = 0; i < count; i++) {
      const row = pool[i];
      const idx = labelCounts[label];
      labelCounts[label]++;

      const pos = computeWorldPosFor(label, idx);
      const layer = Math.floor(idx / BAND_SIZE);

      samples.push({
        text: row.text,
        label,
        x: pos.x,
        y: pos.y,
        layer,
        idxInLabel: idx
      });
    }
  });
}

// ===== X-선 위 좌표 배치 =====

function computeWorldPosFor(label, idx) {
  const angle = labelAngles[label] || 0;

  const dir = { x: Math.cos(angle), y: Math.sin(angle) };

  const layer = Math.floor(idx / BAND_SIZE);
  const withinBand = idx % BAND_SIZE;

  const dist = BASE_DIST + layer * STEP_DIST;

  const mainX = dir.x * dist;
  const mainY = dir.y * dist;

  const perp = { x: -dir.y, y: dir.x };
  const centerIdx = (BAND_SIZE - 1) / 2;
  const offset = (withinBand - centerIdx) * PERP_SPACING;

  const jitterX = random(-5, 5);
  const jitterY = random(-4, 4);

  return {
    x: mainX + perp.x * offset + jitterX,
    y: mainY + perp.y * offset + jitterY
  };
}

// ===== 3D 그리기 =====

function drawXGrid3D() {
  // 축(흰 X 라인) 숨김 — 필요하면 여기서 다시 그려도 됨
}

function drawSamples3D() {
  const visiblePerLabel = visibleCountForZoom(zoom3D);
  const drawnPerLabel = {};
  labelOrder.forEach(l => drawnPerLabel[l] = 0);

  const textBlockWidth = 150;

  for (let s of samples) {
    if (drawnPerLabel[s.label] >= visiblePerLabel) continue;

    const layer = s.layer;
    const z = -layer * DEPTH_STEP;

    push();
    translate(s.x, s.y, z);

    // 텍스트를 카메라 쪽으로 대략 바라보게
    rotateY(-rotY);
    rotateX(-rotX);

    let col = color(labelColor[s.label]);

    // 🔥 layer별 투명도 15% 감소
    let alpha = 100 - 15 * layer;
    if (alpha < 20) alpha = 20;
    col.setAlpha(alpha);

    fill(col);
    noStroke();

    let snippet = s.text.replace(/\s+/g, ' ');
    if (snippet.length > 120) snippet = snippet.slice(0, 120) + '…';

    text(snippet, 0, 0, textBlockWidth, 999);

    pop();
    drawnPerLabel[s.label]++;
  }
}

// ===== 유틸 =====

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random(i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function visibleCountForZoom(z) {
  if (z <= 0.7) return 1;
  if (z <= 0.9) return 3;
  if (z <= 1.2) return 5;
  if (z <= 1.6) return 10;
  if (z <= 2.0) return 20;
  if (z <= 2.6) return 40;
  if (z <= 3.2) return 80;
  return 150;
}

// ===== 인터랙션 =====

function mouseWheel(event) {
  const factor = event.delta > 0 ? 0.95 : 1.05;
  zoom3D = constrain(zoom3D * factor, 0.4, 4);

  redraw();
  return false;
}

function mousePressed() {
  isDragging = true;
  lastMouseX = mouseX;
  lastMouseY = mouseY;
}

function mouseReleased() {
  isDragging = false;
}

function mouseDragged() {
  if (!isDragging) return;

  const dx = mouseX - lastMouseX;
  const dy = mouseY - lastMouseY;

  rotY += dx * 0.005;
  rotX += dy * 0.005;

  lastMouseX = mouseX;
  lastMouseY = mouseY;

  redraw();
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight, WEBGL);
  redraw();
}
