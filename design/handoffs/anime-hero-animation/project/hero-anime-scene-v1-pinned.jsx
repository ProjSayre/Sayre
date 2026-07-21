// hero-anime-scene.jsx — the "Roots" hero animation re-drawn as deliberate 2D anime:
//  • cels step at a coarse frame rate (default 8 fps, "on threes"); the CAMERA stays
//    smooth — classic anime: painted background glides, characters are choppy
//  • line boil: three pre-drawn variants of every organic stroke cycle every frame
//  • flat cel shading: no gaussian glows — hard-edged halos, 4-point sparkles,
//    spike bursts, an impact frame + screen shake when the star lands
//  • same palette and identical choreography/topology as the original
const { SceneStage, useScene } = window;

const D0 = () => window.FILETREE_DATA;
const BG = '#060706';
const DUR = 10.2;

function rnd(i) { const s = Math.sin(i * 127.1 + 13.7) * 43758.5453; return s - Math.floor(s); }
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const eo = (p) => 1 - Math.pow(1 - p, 3);
const eio = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const mix = (a, b, m) => a + (b - a) * m;
const post = (o) => Math.round(clamp01(o) * 5) / 5; // posterized opacity (cel steps)

// ---- timing (identical to the original choreography) ----
const GROW_T0 = 1.15, GROW_T1 = 5.35, SPAN = GROW_T1 - GROW_T0;
const STAR_T0 = 0.15, STAR_T1 = 1.2;
const IMPACT_T = STAR_T1;
const ST0 = 5.55;
const ST_STEP = 0.14, ST_DUR = 0.8, ST_JIT = 0.55;
const DECO_F0 = 5.55, DECO_F1 = 6.9;
const CALM0 = 7.0, CALM1 = 8.2;
const CAM_T0 = 0.55, CAM_T1 = 5.4;

// ---- world ----
const GROUND_Y = -60;
const BASE_X = 958;
const CROWN = { x: 958, y: -470 };
const TRUNK_WAIST_Y = -248;
const WMIN = 1.5;

let BOIL = 0; // current line-boil variant seed (0/1/2), set by buildScene

// ------------------------------------------------------------------ geometry
function sampleCubic(A, c1, c2, B, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n, mu = 1 - u;
    pts.push({
      x: mu * mu * mu * A.x + 3 * mu * mu * u * c1.x + 3 * mu * u * u * c2.x + u * u * u * B.x,
      y: mu * mu * mu * A.y + 3 * mu * mu * u * c1.y + 3 * mu * u * u * c2.y + u * u * u * B.y,
    });
  }
  return pts;
}
function toArc(raw, len) {
  let s = 0; const pts = [{ x: raw[0].x, y: raw[0].y, s: 0 }];
  for (let i = 1; i < raw.length; i++) { s += Math.hypot(raw[i].x - raw[i - 1].x, raw[i].y - raw[i - 1].y); pts.push({ x: raw[i].x, y: raw[i].y, s }); }
  return { pts, len: s || len || 1 };
}
function branchCenterline(A, B, dirIn, bow, seed) {
  const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
  let tix = ux, tiy = uy;
  if (dirIn) { const dl = Math.hypot(dirIn.x, dirIn.y) || 1; tix = dirIn.x / dl; tiy = dirIn.y / dl; }
  const c1 = { x: A.x + (tix * 0.78 + ux * 0.22) * len * 0.5, y: A.y + (tiy * 0.78 + uy * 0.22) * len * 0.5 };
  const c2 = { x: B.x - ux * len * 0.42 + nx * bow * len * 0.7, y: B.y - uy * len * 0.42 + ny * bow * len * 0.7 };
  const n = clamp(Math.round(len / 15), 5, 22);
  const raw = sampleCubic(A, c1, c2, B, n);
  // boil: phase + amplitude wobble per variant (endpoints pinned, structure stable)
  const mAmp = Math.min(7, len * 0.035) * (1 + 0.18 * Math.sin(BOIL * 2.4 + (seed || 0) * 12.3));
  const ph = (seed || 0) * 6.283 + BOIL * 2.1;
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const off = Math.sin(Math.PI * u) * Math.sin(ph + u * Math.PI * 1.7) * mAmp;
    raw[i].x += nx * off; raw[i].y += ny * off;
  }
  return toArc(raw, len);
}
function strandCenterline(A, W, B, phase, amp, turns, leaveSign) {
  phase = phase + BOIL * 1.3;
  amp = amp * (1 + 0.14 * Math.sin(BOIL * 3.1 + phase));
  const hLow = Math.max(Math.abs(W.y - A.y), 8);
  const dirY = W.y > A.y ? 1 : -1;
  const n1 = clamp(Math.round(hLow / 11), 8, 24);
  const c1a = { x: A.x, y: A.y + dirY * hLow * 0.38 };
  const c1b = { x: W.x, y: W.y - dirY * hLow * 0.34 };
  const lower = sampleCubic(A, c1a, c1b, W, n1);
  for (let i = 0; i <= n1; i++) {
    const u = i / n1;
    lower[i].x += Math.sin(Math.PI * u) * Math.sin(phase + u * Math.PI * turns * 2) * amp;
  }
  const dx = B.x - W.x, dy = B.y - W.y, len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const c2a = { x: W.x, y: W.y + (leaveSign != null ? leaveSign : dirY) * len * 0.32 };
  const c2b = { x: B.x - ux * len * 0.3, y: B.y - uy * len * 0.3 };
  const n2 = clamp(Math.round(len / 16), 6, 20);
  const upper = sampleCubic(W, c2a, c2b, B, n2);
  return toArc(lower.concat(upper.slice(1)), hLow + len);
}
function assignWidths(seg) {
  const { pts, len, wStart, wEnd } = seg;
  for (const p of pts) p.w = wStart + (wEnd - wStart) * (p.s / (len || 1));
}
function pointAt(seg, frac) {
  const target = frac * seg.len, pts = seg.pts;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].s >= target) {
      const a = pts[i - 1], b = pts[i], f = (target - a.s) / ((b.s - a.s) || 1);
      let tx = b.x - a.x, ty = b.y - a.y; const tl = Math.hypot(tx, ty) || 1;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, tx: tx / tl, ty: ty / tl, w: (a.w + (b.w - a.w) * f) || seg.wEnd };
    }
  }
  const p = pts[pts.length - 1];
  return { x: p.x, y: p.y, tx: 0, ty: 1, w: seg.wEnd };
}
function outlineFromList(list, growing, rl) {
  if (list.length < 2) return null;
  const left = [], right = [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i], a = list[Math.max(0, i - 1)], b = list[Math.min(list.length - 1, i + 1)];
    let tx = b.x - a.x, ty = b.y - a.y; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    const nx = -ty, ny = tx;
    let w = p.w;
    if (growing) { const dTip = rl - p.s; if (dTip < 7) w *= Math.max(0.12, dTip / 7); }
    left.push([p.x + nx * w / 2, p.y + ny * w / 2]);
    right.push([p.x - nx * w / 2, p.y - ny * w / 2]);
  }
  let d = 'M ' + left[0][0].toFixed(1) + ' ' + left[0][1].toFixed(1);
  for (let i = 1; i < left.length; i++) d += ' L ' + left[i][0].toFixed(1) + ' ' + left[i][1].toFixed(1);
  for (let i = right.length - 1; i >= 0; i--) d += ' L ' + right[i][0].toFixed(1) + ' ' + right[i][1].toFixed(1);
  return d + ' Z';
}
function outlinePath(seg, revealLen) {
  const pts = seg.pts;
  if (revealLen <= 0.2) return null;
  const rl = Math.min(revealLen, seg.len);
  const list = [];
  for (let i = 0; i < pts.length; i++) {
    if (pts[i].s <= rl) list.push(pts[i]);
    else { const b = pts[i - 1], a = pts[i], f = (rl - b.s) / ((a.s - b.s) || 1); list.push({ x: b.x + (a.x - b.x) * f, y: b.y + (a.y - b.y) * f, w: b.w + (a.w - b.w) * f, s: rl }); break; }
  }
  return outlineFromList(list, revealLen < seg.len, rl);
}
function morphedOutline(seg, m) {
  const A = seg.tA || seg.pts[0], B = seg.tB || seg.pts[seg.pts.length - 1];
  const list = seg.pts.map((p) => {
    const u = p.s / (seg.len || 1);
    return { x: mix(p.x, A.x + (B.x - A.x) * u, m), y: mix(p.y, A.y + (B.y - A.y) * u, m), w: mix(p.w, 1.4, m), s: p.s };
  });
  return outlineFromList(list, false, seg.len);
}
const RAMP_A = 0.12;
function ramp(x) {
  x = clamp01(x); const area = 1 - RAMP_A; let p;
  if (x < RAMP_A) p = (x * x) / (2 * RAMP_A);
  else if (x > 1 - RAMP_A) { const y = 1 - x; p = area - (y * y) / (2 * RAMP_A); }
  else p = x - RAMP_A / 2;
  return p / area;
}
function canopyPath(cx, cy, R, sx, sy, seed) {
  const N = 26, pts = [];
  const a1 = rnd(seed) * 6.283 + BOIL * 0.55, a2 = rnd(seed + 1) * 6.283 + BOIL * 0.95, a3 = rnd(seed + 2) * 6.283 + BOIL * 1.7;
  for (let i = 0; i < N; i++) {
    const th = (i / N) * Math.PI * 2;
    const r = R * (1 + 0.2 * Math.sin(2 * th + a1) + 0.13 * Math.sin(5 * th + a2) + 0.07 * Math.sin(9 * th + a3));
    pts.push([cx + Math.cos(th) * r * sx, cy + Math.sin(th) * r * sy]);
  }
  let d = '';
  for (let i = 0; i < N; i++) {
    const p = pts[i], q = pts[(i + 1) % N];
    const mxp = (p[0] + q[0]) / 2, myp = (p[1] + q[1]) / 2;
    if (i === 0) d = 'M ' + mxp.toFixed(1) + ' ' + myp.toFixed(1);
    else d += ' Q ' + p[0].toFixed(1) + ' ' + p[1].toFixed(1) + ' ' + mxp.toFixed(1) + ' ' + myp.toFixed(1);
  }
  const p0 = pts[0];
  return d + ' Q ' + pts[N - 1][0].toFixed(1) + ' ' + pts[N - 1][1].toFixed(1) + ' ' + ((pts[N - 1][0] + p0[0]) / 2).toFixed(1) + ' ' + ((pts[N - 1][1] + p0[1]) / 2).toFixed(1) + ' Z';
}
// 4-point anime sparkle
function sparklePath(x, y, r, k) {
  k = k != null ? k : r * 0.3;
  return 'M ' + (x).toFixed(1) + ' ' + (y - r).toFixed(1) +
    ' L ' + (x + k).toFixed(1) + ' ' + (y - k).toFixed(1) +
    ' L ' + (x + r).toFixed(1) + ' ' + (y).toFixed(1) +
    ' L ' + (x + k).toFixed(1) + ' ' + (y + k).toFixed(1) +
    ' L ' + (x).toFixed(1) + ' ' + (y + r).toFixed(1) +
    ' L ' + (x - k).toFixed(1) + ' ' + (y + k).toFixed(1) +
    ' L ' + (x - r).toFixed(1) + ' ' + (y).toFixed(1) +
    ' L ' + (x - k).toFixed(1) + ' ' + (y - k).toFixed(1) + ' Z';
}

// ------------------------------------------------------------------ scene build
function buildScene(boilSeed) {
  BOIL = boilSeed;
  const D = D0();
  let sid = 0;

  const treeSegs = [];
  function treeStrand(A, W, B, phase, amp, turns, wS, wE) {
    sid++;
    const cl = strandCenterline(A, W, B, phase, amp, turns, -1);
    const seg = { id: 'T' + sid, pts: cl.pts, len: cl.len, wStart: wS, wEnd: wE };
    assignWidths(seg);
    seg.d = outlinePath(seg, seg.len);
    treeSegs.push(seg);
    return seg;
  }
  function treeLimb(A, B, dirIn, wS, wE, seed) {
    sid++;
    const cl = branchCenterline(A, B, dirIn, (rnd(seed * 3.1) - 0.5) * 0.2, rnd(seed * 1.9));
    const seg = { id: 'T' + sid, pts: cl.pts, len: cl.len, wStart: wS, wEnd: wE };
    assignWidths(seg);
    seg.d = outlinePath(seg, seg.len);
    treeSegs.push(seg);
    return seg;
  }
  const limbTips = [
    { x: 775, y: -455 }, { x: 870, y: -535 }, { x: 968, y: -560 }, { x: 1078, y: -525 }, { x: 1158, y: -445 },
  ];
  let centerStrand = null;
  limbTips.forEach((tip, k) => {
    const spread = k - 2;
    const A = { x: BASE_X + spread * 8 + (rnd(k * 3) - 0.5) * 5, y: GROUND_Y };
    const W = { x: BASE_X + spread * 4 + (rnd(k * 7) - 0.5) * 4, y: TRUNK_WAIST_Y + (rnd(k * 11) - 0.5) * 10 };
    const s = treeStrand(A, W, tip, k * 1.7 + 0.5, 8, 1.15, 9, 3.2);
    if (k === 2) centerStrand = s;
    const M = pointAt(s, 0.6 + rnd(k * 5) * 0.12);
    const side = k < 2 ? -1 : k > 2 ? 1 : (rnd(k) < 0.5 ? -1 : 1);
    treeLimb({ x: M.x, y: M.y }, { x: M.x + side * (55 + rnd(k * 9) * 45), y: M.y - 55 - rnd(k * 13) * 45 }, { x: M.tx, y: M.ty }, Math.max(2.2, M.w * 0.5), 1.4, k * 7 + 2);
    if (k === 0 || k === 4) {
      const M2 = pointAt(s, 0.85);
      treeLimb({ x: M2.x, y: M2.y }, { x: M2.x + (k === 0 ? -1 : 1) * (65 + rnd(k * 21) * 40), y: M2.y - 30 - rnd(k * 23) * 30 }, { x: M2.tx, y: M2.ty }, Math.max(1.8, M2.w * 0.55), 1.2, k * 9 + 5);
    }
  });
  for (let i = 0; i < 4; i++) {
    const s = i < 2 ? -1 : 1;
    treeLimb({ x: BASE_X + s * 7, y: GROUND_Y - 4 }, { x: BASE_X + s * (34 + rnd(i) * 22), y: GROUND_Y - 1 }, { x: s, y: 0.35 }, 5, 1.2, i + 40);
  }
  const canopy = [
    { d: canopyPath(880, -455, 150, 1.5, 0.92, 11), c: '#1B3325', o: 0.96, ph: 0.6 },
    { d: canopyPath(1075, -430, 112, 1.35, 0.9, 23), c: '#1C3527', o: 0.95, ph: 2.3 },
    { d: canopyPath(935, -545, 108, 1.4, 0.88, 37), c: '#213D2C', o: 0.95, ph: 4.1 },
    { d: canopyPath(1070, -540, 82, 1.25, 0.9, 49), c: '#213D2C', o: 0.94, ph: 1.4 },
    { d: canopyPath(760, -405, 88, 1.35, 0.85, 103), c: '#1B3325', o: 0.95, ph: 5.4 },
    { d: canopyPath(1175, -480, 70, 1.2, 0.85, 109), c: '#1C3527', o: 0.94, ph: 3.7 },
  ];
  const canopyFront = [
    { d: canopyPath(985, -455, 96, 1.5, 0.9, 61), c: '#28492F', o: 0.93, ph: 3.2 },
    { d: canopyPath(852, -520, 74, 1.3, 0.88, 73), c: '#2C5039', o: 0.9, ph: 5.0 },
    { d: canopyPath(1005, -585, 66, 1.3, 0.85, 85), c: '#33604A', o: 0.82, ph: 0.2 },
    { d: canopyPath(910, -600, 52, 1.25, 0.85, 97), c: '#2C5039', o: 0.85, ph: 2.8 },
    { d: canopyPath(795, -475, 56, 1.3, 0.85, 115), c: '#2C5039', o: 0.86, ph: 1.1 },
    { d: canopyPath(1120, -545, 48, 1.2, 0.85, 121), c: '#33604A', o: 0.78, ph: 4.4 },
  ];
  const glints = Array.from({ length: 12 }, (_, i) => ({
    x: 770 + rnd(i * 17) * 400, y: -620 + rnd(i * 23) * 210,
    r: 1.3 + rnd(i * 29) * 1.2, ph: rnd(i * 31) * 6.283, w: 0.5 + rnd(i * 37) * 0.6,
  }));
  const grass = Array.from({ length: 30 }, (_, i) => {
    const x = 180 + rnd(i * 7 + 1) * 1560;
    const near = Math.exp(-Math.abs(x - BASE_X) / 500);
    return { x, h: 7 + rnd(i * 13) * 9 + near * 6, lean: (rnd(i * 19) - 0.5) * 8, c: rnd(i * 23) < 0.4 ? '#2E5540' : '#26462F', ph: rnd(i * 29) * 6.283, o: 0.4 + rnd(i * 31) * 0.35 };
  });
  const leaves = Array.from({ length: 6 }, (_, i) => ({
    x0: 770 + rnd(i * 41) * 400, y0: -560 + rnd(i * 43) * 150,
    ph: rnd(i * 47) * 6.283, sp: 30 + rnd(i * 53) * 20, sw: 12 + rnd(i * 59) * 12, w: 0.8 + rnd(i * 61) * 0.5,
  }));

  // ---- roots = graph edges ----
  const rootN = D.nodes.find((n) => n.type === 'root');
  const outEdges = new Map();
  for (const e of D.edges) {
    const k = e.x1.toFixed(1) + ',' + e.y1.toFixed(1);
    if (!outEdges.has(k)) outEdges.set(k, []);
    outEdges.get(k).push(e);
  }
  function subSize(e) {
    if (e.__size) return e.__size;
    const kids = outEdges.get(e.x2.toFixed(1) + ',' + e.y2.toFixed(1)) || [];
    let s = 1;
    for (const k of kids) s += subSize(k);
    e.__size = s;
    return s;
  }
  const totalSize = (outEdges.get(rootN.cx.toFixed(1) + ',' + rootN.cy.toFixed(1)) || []).reduce((s, e) => s + subSize(e), 0) || 1;
  const wOf = (c) => Math.max(1.7, 10 * Math.pow(c / totalSize, 0.6));

  const taproots = [];
  for (let k = 0; k < 4; k++) {
    sid++;
    const spread = k - 1.5;
    const A = { x: BASE_X + spread * 7 + (rnd(k * 3) - 0.5) * 4, y: GROUND_Y };
    const W = { x: mix(BASE_X, rootN.cx, 0.5) + spread * 3, y: mix(GROUND_Y, rootN.cy, 0.55) };
    const cl = strandCenterline(A, W, { x: rootN.cx, y: rootN.cy }, k * 1.9 + 0.6, 6.5, 1.1, 1);
    const seg = { id: sid, pts: cl.pts, len: cl.len, wStart: 6.8 - k * 0.4, wEnd: 2.6, distStart: 0 };
    assignWidths(seg);
    seg.fullD = outlinePath(seg, seg.len);
    taproots.push(seg);
  }
  const taprootLen = Math.max(...taproots.map((s) => s.len));

  const rootSegs = [];
  const rootJoints = [];
  const arrivalDir = new Map();
  const shifted = new Map();
  const tk = (x, y) => x.toFixed(1) + ',' + y.toFixed(1);
  arrivalDir.set(tk(rootN.cx, rootN.cy), { x: 0, y: 1 });
  shifted.set(tk(rootN.cx, rootN.cy), { x: rootN.cx, y: rootN.cy });
  const queue = (outEdges.get(tk(rootN.cx, rootN.cy)) || []).map((e) => ({ e, dist: taprootLen, depth: 1 }));
  let totalDist = taprootLen;
  while (queue.length) {
    const { e, dist, depth } = queue.shift();
    sid++;
    const kA = tk(e.x1, e.y1), kB = tk(e.x2, e.y2);
    const A = shifted.get(kA) || { x: e.x1, y: e.y1 };
    let B = shifted.get(kB);
    if (!B) {
      B = {
        x: e.x2 + (rnd(sid * 3.7) - 0.5) * (26 + depth * 9),
        y: e.y2 + (rnd(sid * 7.1) - 0.5) * (36 + depth * 15),
      };
      shifted.set(kB, B);
    }
    const dirIn = arrivalDir.get(kA) || { x: 0, y: 1 };
    const cl = branchCenterline(A, B, dirIn, (rnd(sid * 3.1) - 0.5) * 0.22, rnd(sid * 1.9));
    const size = subSize(e);
    const seg = {
      id: sid, edge: e, pts: cl.pts, len: cl.len, distStart: dist, depth,
      tA: { x: e.x1, y: e.y1 }, tB: { x: e.x2, y: e.y2 },
      wStart: e.ghost ? 1.9 : wOf(size), wEnd: e.ghost ? WMIN : Math.max(WMIN, wOf(size) * 0.6),
      ghost: !!e.ghost, path: e.path,
      stT0: ST0 + (depth - 1) * ST_STEP + rnd(sid + 90) * ST_JIT,
    };
    const kids = outEdges.get(kB) || [];
    if (!e.ghost && kids.length) seg.wEnd = Math.max(seg.wEnd, Math.max(...kids.map((k2) => (k2.ghost ? 1.9 : wOf(subSize(k2))))));
    assignWidths(seg);
    seg.fullD = outlinePath(seg, seg.len);
    rootSegs.push(seg);
    totalDist = Math.max(totalDist, dist + seg.len);
    const p1 = seg.pts[seg.pts.length - 1], p0 = seg.pts[seg.pts.length - 2];
    arrivalDir.set(kB, { x: p1.x - p0.x, y: p1.y - p0.y });
    if (kids.length) rootJoints.push({ x: B.x, y: B.y, r: Math.max(1.6, seg.wEnd / 2 * 1.15), dist: dist + seg.len, stT0: seg.stT0 });
    for (const k2 of kids) queue.push({ e: k2, dist: dist + seg.len, depth: depth + 1 });
  }
  rootJoints.push({ x: rootN.cx, y: rootN.cy, r: 3.4, dist: taprootLen, stT0: ST0 });
  rootSegs.sort((a, b) => (b.wStart + b.wEnd) - (a.wStart + a.wEnd));

  const decoys = [];
  let decoyCount = 0; const DECOY_MAX = 100;
  function decoy(base, dir, w, lenT, level, distBase) {
    if (decoyCount >= DECOY_MAX || lenT < 12 || w < WMIN * 0.9) return;
    decoyCount++;
    const dl = Math.hypot(dir.x, dir.y) || 1; let dx = dir.x / dl, dy = dir.y / dl;
    const turn = (rnd(sid * 1.7 + decoyCount * 5.3) - 0.5) * 0.9, ca = Math.cos(turn), sa = Math.sin(turn);
    let rx = dx * ca - dy * sa, ry = dx * sa + dy * ca; ry += 0.3;
    const rl = Math.hypot(rx, ry) || 1; rx /= rl; ry /= rl;
    sid++;
    const cl = branchCenterline(base, { x: base.x + rx * lenT, y: base.y + ry * lenT }, dir, (rnd(decoyCount * 2.3) - 0.5) * 0.3, rnd(decoyCount * 4.1));
    const seg = { id: sid, pts: cl.pts, len: cl.len, distStart: distBase, wStart: w, wEnd: Math.max(WMIN * 0.7, w * 0.45) };
    assignWidths(seg);
    seg.fullD = outlinePath(seg, seg.len);
    decoys.push(seg);
    totalDist = Math.max(totalDist, distBase + seg.len);
    const forks = rnd(decoyCount * 9.1) < 0.45 ? 2 : 1;
    for (let i = 0; i < forks; i++) {
      const spr = (i - (forks - 1) / 2) * 0.6 + (rnd(decoyCount * 3.1 + i) - 0.5) * 0.4, cca = Math.cos(spr), csa = Math.sin(spr);
      decoy({ x: cl.pts[cl.pts.length - 1].x, y: cl.pts[cl.pts.length - 1].y }, { x: rx * cca - ry * csa, y: rx * csa + ry * cca }, seg.wEnd, lenT * (0.6 + rnd(decoyCount + i) * 0.16), level + 1, distBase + seg.len);
    }
  }
  for (const seg of rootSegs.slice()) {
    if (seg.ghost) continue;
    const thick = (seg.wStart + seg.wEnd) / 2;
    if (thick < 2.2) continue;
    const spots = thick > 6 ? [0.18, 0.45, 0.72] : [0.28, 0.6];
    for (const frac of spots) {
      if (rnd(seg.id * 4.7 + frac * 31) > 0.78) continue;
      const P = pointAt(seg, frac), side = rnd(seg.id + frac * 13) < 0.5 ? 1 : -1;
      const perpX = -P.ty * side, perpY = P.tx * side;
      decoy({ x: P.x, y: P.y }, { x: P.tx * 0.55 + perpX * 0.75, y: P.ty * 0.55 + perpY * 0.75 }, clamp(P.w * 0.6, 2, 5), 40 + thick * 6, 0, seg.distStart + seg.len * frac);
    }
  }
  for (let i = 0; i < 9; i++) {
    const tp = taproots[i % taproots.length];
    const frac = 0.18 + rnd(i * 7) * 0.55;
    const P = pointAt(tp, frac);
    const side = i % 2 === 0 ? -1 : 1;
    decoy({ x: P.x, y: P.y }, { x: side * (0.8 + rnd(i * 11) * 0.2), y: 0.18 + rnd(i * 13) * 0.3 }, clamp(P.w * 0.7, 2, 4.5), 70 + rnd(i * 17) * 110, 0, tp.len * frac);
  }

  function timeForDist(d) {
    const target = clamp01(d / totalDist); let lo = 0, hi = 1;
    for (let k = 0; k < 22; k++) { const m = (lo + hi) / 2; if (ramp(m) < target) lo = m; else hi = m; }
    return GROW_T0 + SPAN * (lo + hi) / 2;
  }
  const segByChild = new Map();
  for (const s of rootSegs) segByChild.set(s.edge.x2.toFixed(1) + ',' + s.edge.y2.toFixed(1), s);
  const nodes = D.nodes.map((n) => {
    const key = n.cx.toFixed(1) + ',' + n.cy.toFixed(1);
    if (n.type === 'root') return { ...n, ignite: timeForDist(taprootLen), ringT: ST0 + 0.35 };
    const seg = segByChild.get(key);
    const sh = seg ? seg.pts[seg.pts.length - 1] : null;
    return {
      ...n,
      seg: seg || null,
      shx: sh ? sh.x : n.cx, shy: sh ? sh.y : n.cy,
      stT0: seg ? seg.stT0 : ST0,
      ignite: seg ? timeForDist(seg.distStart + seg.len) : timeForDist(totalDist),
      ringT: seg ? seg.stT0 + ST_DUR * 0.9 : ST0 + 1.4,
    };
  });

  const badges = D.badges.map((b, i) => ({ ...b, t0: 7.5 + i * 0.08 }));
  const labels = D.labels.map((l, i) => ({ ...l, t0: 7.8 + i * 0.022 }));
  const soil = Array.from({ length: 52 }, (_, i) => ({
    x: -40 + rnd(i + 30) * 1880, y: GROUND_Y + 30 + rnd(i + 70) * 820,
    r: 0.8 + rnd(i + 110) * 1.3, o: 0.04 + rnd(i + 150) * 0.07,
  }));
  const motes = Array.from({ length: 30 }, (_, i) => {
    const sky = i < 20;
    return {
      x: 60 + rnd(i + 700) * 1740,
      y: sky ? -740 + rnd(i + 740) * 620 : 40 + rnd(i + 740) * 760,
      r: 2 + rnd(i + 780) * 2.6, ph: rnd(i + 820) * 6.283,
      w1: 0.3 + rnd(i + 860) * 0.5, ax: 12 + rnd(i + 900) * 20, ay: 8 + rnd(i + 940) * 14,
      base: (sky ? 0.4 : 0.24) + rnd(i + 980) * 0.34, sky,
    };
  });
  const dust = Array.from({ length: 12 }, (_, i) => ({
    x: -40 + rnd(i + 300) * 1880, y: -760 + rnd(i + 340) * 700,
    r: 1 + rnd(i + 380) * 1.8, base: 0.05 + rnd(i + 420) * 0.11,
    w1: 0.25 + rnd(i + 460) * 0.4, ph: rnd(i + 500) * 6.283,
    vx: (rnd(i + 540) - 0.5) * 7, vy: (rnd(i + 580) - 0.5) * 4,
  }));

  return { treeSegs, centerStrand, canopy, canopyFront, glints, grass, leaves, taproots, taprootLen, rootSegs, rootJoints, decoys, totalDist, nodes, badges, labels, soil, motes, dust };
}

let VARIANTS = null;
function getVariants() {
  if (!VARIANTS) VARIANTS = [buildScene(0), buildScene(1), buildScene(2)];
  return VARIANTS;
}

function badgeOp(u) {
  if (u < 0) return 0; if (u < 0.09) return 1; if (u < 0.16) return 0.15;
  if (u < 0.24) return 1; if (u < 0.3) return 0.45; return 1;
}

// ------------------------------------------------------------------ frame
function AnimeFrame({ t, tS, fi, boil }) {
  const S = getVariants()[boil ? fi % 3 : 0];

  // camera glides smoothly (painted-background pan) while the cels step
  const camP = eio(clamp01((tS - CAM_T0) / (CAM_T1 - CAM_T0)));
  const cs = 1.42 - 0.42 * camP;
  const ccx = 958 + (897 - 958) * camP, ccy = -430 + (371 + 430) * camP;
  let camX = 897 - cs * ccx, camY = 371 - cs * ccy;
  const iu = t - IMPACT_T;
  if (iu >= 0 && iu < 0.32) { const sh = (1 - iu / 0.32) * 10; camX += (rnd(fi * 3.3) - 0.5) * sh; camY += (rnd(fi * 7.7) - 0.5) * sh; }
  const cam = 'translate(' + camX.toFixed(2) + ' ' + camY.toFixed(2) + ') scale(' + cs.toFixed(4) + ')';

  const decoOp = 1 - eio(clamp01((t - DECO_F0) / (DECO_F1 - DECO_F0)));
  const aboveOp = 1 - 0.72 * eio(clamp01((t - DECO_F0) / (DECO_F1 - DECO_F0)));
  const calm = eio(clamp01((t - CALM0) / (CALM1 - CALM0)));
  const front = S.totalDist * ramp(clamp01((t - GROW_T0) / SPAN));
  const els = [];

  // painted sky glow (soft gradient = background painting; everything else is flat cel)
  els.push(<ellipse key="skyglow" cx={CROWN.x} cy={CROWN.y - 40} rx={460} ry={340} fill="url(#skyGrad)" opacity={0.75 * aboveOp} />);
  {
    const a = [];
    for (let i = 0; i < S.dust.length; i++) {
      const d = S.dust[i];
      const tw = Math.sin(t * d.w1 * 2 + d.ph);
      const op = post(d.base * (tw > 0 ? 1 : 0.4)) * aboveOp;
      if (op > 0.01) a.push(<circle key={i} cx={d.x + Math.sin(t * d.w1 + d.ph) * 26 + t * d.vx} cy={d.y + Math.cos(t * d.w1 * 0.8 + d.ph) * 18 + t * d.vy} r={d.r} fill="#D9D8D1" opacity={op} />);
    }
    els.push(<g key="dust">{a}</g>);
  }
  {
    // motes as blinking 4-point sparkles
    const a = [];
    for (let i = 0; i < S.motes.length; i++) {
      const m = S.motes[i];
      const twk = Math.sin(t * m.w1 * 1.7 + m.ph);
      const env = m.sky ? aboveOp : clamp01(t / 1.2) * (1 - clamp01((t - 7.0) / 1.2));
      if (twk < -0.25 || env < 0.02) continue;
      const big = twk > 0.55;
      const op = post(m.base * (big ? 1 : 0.5)) * env;
      const x = m.x + Math.sin(t * m.w1 + m.ph) * m.ax, y = m.y + Math.cos(t * m.w1 * 0.85 + m.ph) * m.ay;
      a.push(<path key={'m' + i} d={sparklePath(x, y, m.r * (big ? 1.7 : 1.05))} fill="#F2F1EA" opacity={op} />);
    }
    els.push(<g key="motes">{a}</g>);
  }

  // ---- above-ground tree (flat cels + dark rim on canopy) ----
  const treeEls = [];
  const drift = (ph, s) => 'translate(' + (Math.sin(t * 0.45 + ph) * s).toFixed(1) + ' ' + (Math.cos(t * 0.36 + ph) * s * 0.45).toFixed(1) + ')';
  for (let i = 0; i < S.canopy.length; i++) {
    const b = S.canopy[i];
    treeEls.push(<path key={'cb' + i} d={b.d} fill={b.c} stroke="#0C160F" strokeWidth="3" strokeLinejoin="round" opacity={b.o} transform={drift(b.ph, 3)} />);
  }
  for (let i = 0; i < S.treeSegs.length; i++) {
    const seg = S.treeSegs[i];
    treeEls.push(<path key={'tc' + i} d={seg.d} fill="#CFCEC7" stroke="#CFCEC7" strokeWidth="0.8" strokeLinejoin="round" opacity={0.92} />);
  }
  for (let i = 0; i < S.canopyFront.length; i++) {
    const b = S.canopyFront[i];
    treeEls.push(<path key={'cf' + i} d={b.d} fill={b.c} stroke="#101E14" strokeWidth="2.5" strokeLinejoin="round" opacity={b.o} transform={drift(b.ph, 3.4)} />);
  }
  for (let i = 0; i < S.glints.length; i++) {
    const g = S.glints[i];
    const twk = Math.sin(t * g.w * 2 + g.ph);
    if (twk < 0.3) continue;
    treeEls.push(<path key={'gl' + i} d={sparklePath(g.x, g.y, g.r * (twk > 0.75 ? 3.4 : 2.2))} fill="#74A583" opacity={post(twk > 0.75 ? 0.9 : 0.55)} />);
  }
  for (let i = 0; i < S.grass.length; i++) {
    const g = S.grass[i];
    const sway = Math.sin(t * 0.9 + g.ph) * 1.6;
    treeEls.push(<path key={'gr' + i} d={'M ' + g.x + ' ' + GROUND_Y + ' q ' + (g.lean * 0.4) + ' ' + (-g.h * 0.6) + ' ' + (g.lean + sway) + ' ' + (-g.h)} stroke={g.c} strokeWidth="1.3" fill="none" opacity={g.o} strokeLinecap="round" />);
  }
  for (let i = 0; i < S.leaves.length; i++) {
    const l = S.leaves[i];
    const span = GROUND_Y - l.y0 + 30;
    const fall = (t * l.sp + l.ph * 90) % span;
    const y = l.y0 + fall;
    const x = l.x0 + Math.sin(t * l.w + l.ph) * l.sw;
    const op = 0.55 * clamp01((GROUND_Y - y) / 50) * clamp01(fall / 40);
    const rot = Math.round(Math.sin(t * 1.3 + l.ph) * 3) / 3 * 50; // 3 held tilt poses
    if (op > 0.02) treeEls.push(<ellipse key={'lv' + i} cx={x} cy={y} rx={3.2} ry={1.6} fill="#3A6B4C" opacity={post(op)} transform={'rotate(' + rot.toFixed(0) + ' ' + x.toFixed(1) + ' ' + y.toFixed(1) + ')'} />);
  }
  treeEls.push(<line key="gline" x1={-63} y1={GROUND_Y} x2={1857} y2={GROUND_Y} stroke="#3A3B35" strokeWidth="1.4" opacity={0.55} />);
  treeEls.push(<line key="gline2" x1={BASE_X - 320} y1={GROUND_Y} x2={BASE_X + 320} y2={GROUND_Y} stroke="#8B8B82" strokeWidth="1.2" opacity={0.3} />);
  treeEls.push(<ellipse key="gglow" cx={BASE_X} cy={GROUND_Y + 3} rx={95} ry={9} fill="url(#groundGrad)" opacity={0.5} />);

  // ---- falling star: sparkle cel + frame-echo trail + speed lines ----
  if (t > STAR_T0 && t < STAR_T1 + 0.15 && S.centerStrand) {
    const strand = S.centerStrand;
    const tip = pointAt(strand, 1);
    const skyA = { x: tip.x + 105, y: -760 };
    const skyLen = Math.hypot(tip.x - skyA.x, tip.y - skyA.y);
    const total = skyLen + strand.len;
    const starAt = (tt) => {
      const p = clamp01((tt - STAR_T0) / (STAR_T1 - STAR_T0));
      const ei = p * p * p * (1 + 2 * p);
      const dist = clamp01(ei) * total;
      if (dist <= skyLen) {
        const u = dist / skyLen;
        return { x: skyA.x + (tip.x - skyA.x) * u, y: skyA.y + (tip.y - skyA.y) * u };
      }
      return pointAt(strand, 1 - (dist - skyLen) / strand.len);
    };
    const P = starAt(t);
    const fade = 1 - clamp01((t - STAR_T1) / 0.15);
    const slow = 1 - clamp01((t - STAR_T0) / (STAR_T1 - STAR_T0));
    const flick = fi % 2 === 0 ? 1.22 : 0.92; // hard 2-frame twinkle
    // echo trail: the star's previous held frames
    const step = 0.125;
    for (let k = 2; k >= 1; k--) {
      const Q = starAt(t - k * step);
      const dd = Math.hypot(P.x - Q.x, P.y - Q.y);
      if (dd < 6) continue;
      treeEls.push(<path key={'tt' + k} d={sparklePath(Q.x, Q.y, Math.max(2.5, 7 - k * 2.4))} fill="#F6F5EF" opacity={post(0.45 * fade * (1 - k / 3))} />);
    }
    // speed lines once it accelerates
    const Pp = starAt(t - step);
    const vx = P.x - Pp.x, vy = P.y - Pp.y, vl = Math.hypot(vx, vy);
    if (vl > 40 && fade > 0.3) {
      const ux = vx / vl, uy = vy / vl, nx = -uy, ny = ux;
      for (let k = -1; k <= 1; k++) {
        const off = k * 11;
        const bx = P.x + nx * off - ux * (18 + Math.abs(k) * 10), by = P.y + ny * off - uy * (18 + Math.abs(k) * 10);
        treeEls.push(<line key={'sl' + k} x1={bx} y1={by} x2={bx - ux * (vl * 0.55)} y2={by - uy * (vl * 0.55)} stroke="#F6F5EF" strokeWidth={k === 0 ? 2.4 : 1.6} strokeLinecap="round" opacity={post(0.55 * fade)} />);
      }
    }
    // flat cel halo (hard edges, no blur)
    treeEls.push(<circle key="tp0" cx={P.x} cy={P.y} r={(15 + 9 * slow) * flick} fill="#FFFFFF" opacity={post(0.14 + 0.08 * slow) * fade} />);
    treeEls.push(<circle key="tp1" cx={P.x} cy={P.y} r={(8 + 4 * slow) * flick} fill="#FFFFFF" opacity={post(0.3) * fade} />);
    treeEls.push(<path key="tp2" d={sparklePath(P.x, P.y, (9 + 5 * slow) * flick)} fill="#F6F5EF" opacity={fade} />);
  }
  // ---- impact frame: spike burst + ground shockwave ring ----
  if (iu >= 0 && iu < 0.42) {
    const k = iu / 0.42;
    const bx = BASE_X, by = GROUND_Y - 6;
    const r0 = 12 + eo(k) * 120, r1 = r0 + 34 * (1 - k);
    const spikes = [];
    for (let s = 0; s < 8; s++) {
      const a = s * Math.PI / 4 + 0.32;
      spikes.push(<line key={'sp' + s} x1={bx + Math.cos(a) * r0} y1={by + Math.sin(a) * r0 * 0.7} x2={bx + Math.cos(a) * r1} y2={by + Math.sin(a) * r1 * 0.7} stroke="#F6F5EF" strokeWidth={2.6 * (1 - k) + 0.6} strokeLinecap="round" opacity={post(1 - k)} />);
    }
    treeEls.push(<g key="impact">{spikes}</g>);
    treeEls.push(<ellipse key="shock" cx={bx} cy={GROUND_Y} rx={18 + eo(k) * 250} ry={(18 + eo(k) * 250) * 0.16} fill="none" stroke="#F6F5EF" strokeWidth={2.2 * (1 - k) + 0.4} opacity={post(0.85 * (1 - k))} />);
    if (iu < 0.13) treeEls.push(<circle key="iflash" cx={bx} cy={by} r={30} fill="#FFFFFF" opacity={post(iu < 0.07 ? 0.95 : 0.5)} />);
  }
  els.push(<g key="tree" opacity={aboveOp}>{treeEls}</g>);

  // ---- soil ----
  if (decoOp > 0.001 && front > 1) {
    const specks = [];
    const soilOp = clamp01(front / (S.totalDist * 0.25)) * decoOp;
    for (let i = 0; i < S.soil.length; i++) { const sp = S.soil[i]; specks.push(<circle key={i} cx={sp.x} cy={sp.y} r={sp.r} fill="#C9C8C0" opacity={sp.o * soilOp} />); }
    els.push(<g key="soil">{specks}</g>);
  }

  // ---- taproot + decoys (flat, boiling) ----
  if (decoOp > 0.001) {
    const crisp = [];
    for (let i = 0; i < S.taproots.length; i++) {
      const seg = S.taproots[i]; const rl = front - seg.distStart;
      if (rl <= 0.2) continue;
      const d = rl >= seg.len ? seg.fullD : outlinePath(seg, rl);
      if (!d) continue;
      crisp.push(<path key={'tpc' + i} d={d} fill="#CBCAC1" stroke="#CBCAC1" strokeWidth="0.8" strokeLinejoin="round" opacity={0.9} />);
    }
    for (let i = 0; i < S.decoys.length; i++) {
      const seg = S.decoys[i]; const rl = front - seg.distStart;
      if (rl <= 0.2) continue;
      const d = rl >= seg.len ? seg.fullD : outlinePath(seg, rl);
      if (!d) continue;
      crisp.push(<path key={'dc' + i} d={d} fill="#BDBCB3" stroke="#BDBCB3" strokeWidth="0.8" strokeLinejoin="round" opacity={0.78} />);
    }
    els.push(<g key="organicDeco" opacity={decoOp}>{crisp}</g>);
  }

  // ---- roots that ARE the graph edges ----
  const orgCrisp = [], prodUnder = [], prodLines = [], brightLines = [];
  for (let i = 0; i < S.rootSegs.length; i++) {
    const seg = S.rootSegs[i];
    const rl = front - seg.distStart;
    if (rl <= 0.2) continue;
    const m = eio(clamp01((t - seg.stT0) / ST_DUR));
    if (m >= 1) {
      const e = seg.edge;
      if (seg.ghost) {
        prodLines.push(<line key={'pe' + i} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} stroke="#3B3B35" strokeWidth="1" opacity={0.55 + 0.25 * (1 - calm)} />);
      } else {
        prodUnder.push(<line key={'pg' + i} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} stroke="#D8D7CF" strokeWidth={3} opacity={post(0.14 + 0.08 * (1 - calm))} />);
        prodLines.push(<line key={'pe' + i} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} stroke="#7B7B73" strokeWidth={1.1} opacity={1} />);
        if (calm < 0.999) brightLines.push(<line key={'pb' + i} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} stroke="#C9C8C0" strokeWidth="1.1" opacity={post(0.7 * (1 - calm))} />);
      }
      continue;
    }
    const growing = rl < seg.len;
    let d;
    if (m <= 0.001) d = growing ? outlinePath(seg, rl) : seg.fullD;
    else d = morphedOutline(seg, m);
    if (!d) continue;
    const baseOp = seg.ghost ? 0.6 : 0.9;
    const fillC = seg.ghost ? mix(0.7, 0.28, m) : 1;
    const col = seg.ghost ? '#8F8E86' : '#CBCAC1';
    orgCrisp.push(<path key={'oc' + i} d={d} fill={col} stroke={col} strokeWidth="0.6" strokeLinejoin="round" opacity={baseOp * (seg.ghost ? fillC : 1)} />);
  }
  els.push(<g key="orgCrisp">{orgCrisp}</g>);
  {
    const welds = [];
    for (let i = 0; i < S.rootJoints.length; i++) {
      const j = S.rootJoints[i];
      if (front < j.dist - 0.5) continue;
      const jm = eio(clamp01((t - j.stT0) / ST_DUR));
      if (jm >= 1) continue;
      welds.push(<circle key={'w' + i} cx={j.x} cy={j.y} r={j.r * (1 - jm * 0.5)} fill="#CBCAC1" opacity={0.9 * (1 - jm)} />);
    }
    els.push(<g key="welds">{welds}</g>);
  }
  els.push(<g key="prodUnder">{prodUnder}</g>);
  els.push(<g key="prodLines">{prodLines}</g>);
  els.push(<g key="brightLines">{brightLines}</g>);

  // ---- pulses riding the roots: flat ring + core ----
  if (front > 0.5) {
    const pcr = [];
    for (let i = 0; i < S.nodes.length; i++) {
      const n = S.nodes[i];
      if (!n.seg) continue;
      const rl = front - n.seg.distStart;
      if (rl <= 0 || rl >= n.seg.len) continue;
      const P = pointAt(n.seg, rl / n.seg.len);
      pcr.push(<circle key={'ph' + i} cx={P.x} cy={P.y} r={fi % 2 === 0 ? 6.5 : 5.2} fill="none" stroke="#FFFFFF" strokeWidth="1.4" opacity={0.5} />);
      pcr.push(<circle key={'pp' + i} cx={P.x} cy={P.y} r={2.6} fill="#F6F5EF" opacity={0.95} />);
    }
    if (pcr.length) els.push(<g key="pulses">{pcr}</g>);
  }

  // ---- nodes: flat halo + 4-spike burst on arrival ----
  const halos = [], bursts = [], lights = [], rings = [];
  for (let i = 0; i < S.nodes.length; i++) {
    const n = S.nodes[i];
    if (t <= n.ignite) continue;
    const settle = eo(clamp01((t - n.ringT) / 0.45));
    const nm = n.seg ? eio(clamp01((t - n.stT0) / ST_DUR)) : 1;
    const cx = n.seg ? mix(n.shx, n.cx, nm) : n.cx;
    const cy = n.seg ? mix(n.shy, n.cy, nm) : n.cy;
    const u = t - n.ignite;
    const flash = eo(clamp01(u / 0.2)) * (1 - 0.5 * eio(clamp01((u - 0.2) / 1.1)));
    const pop = eo(clamp01((t - n.ringT) / 0.16)) * (1 - eio(clamp01((t - n.ringT - 0.16) / 0.55)));
    const lightR = n.type === 'root' ? 5 : n.type === 'folder' ? 4 : 3;
    const finalGlow = n.type === 'file' ? 0.07 : n.type === 'root' ? 0.14 : 0.1;
    const gop = post((0.5 * flash) * (1 - settle) + finalGlow * settle + 0.4 * pop);
    if (gop > 0.01) halos.push(<circle key={'gn' + i} cx={cx} cy={cy} r={n.r + 3.5 + 5 * pop} fill="#FFFFFF" opacity={gop} />);
    // ignition burst: 4 diagonal spikes for the first beats
    if (u < 0.32) {
      const bk = u / 0.32;
      const br0 = n.r + 4 + eo(bk) * 10, br1 = br0 + 7 * (1 - bk);
      for (let s = 0; s < 4; s++) {
        const a = s * Math.PI / 2 + Math.PI / 4;
        bursts.push(<line key={'bu' + i + '_' + s} x1={cx + Math.cos(a) * br0} y1={cy + Math.sin(a) * br0} x2={cx + Math.cos(a) * br1} y2={cy + Math.sin(a) * br1} stroke="#F6F5EF" strokeWidth="1.7" strokeLinecap="round" opacity={post(1 - bk)} />);
      }
    }
    if (settle < 1) lights.push(<circle key={'li' + i} cx={cx} cy={cy} r={lightR} fill="none" stroke="#F6F5EF" strokeWidth={1.8} opacity={post(0.6 + 0.4 * flash) * (1 - settle)} />);
    if (settle > 0) {
      if (n.type === 'file') rings.push(<circle key={'n' + i} cx={cx} cy={cy} r={n.r} fill="#A6A59D" opacity={settle} />);
      else rings.push(<circle key={'n' + i} cx={cx} cy={cy} r={n.r} fill={BG} stroke={n.type === 'root' ? '#E8E6E1' : '#C7C6BF'} strokeWidth={n.type === 'root' ? 1.75 : 1.5} opacity={settle} />);
    }
  }
  els.push(<g key="halos">{halos}</g>);
  els.push(<g key="rings">{rings}</g>);
  els.push(<g key="lights">{lights}</g>);
  els.push(<g key="bursts">{bursts}</g>);

  const badgeEls = [];
  for (let i = 0; i < S.badges.length; i++) {
    const b = S.badges[i]; const op = badgeOp(t - b.t0); if (op <= 0) continue;
    const c = b.kind === 'pass' ? '#5FA876' : '#D2953F';
    badgeEls.push(<circle key={'gb' + i} cx={b.cx} cy={b.cy} r={b.r + 2} fill={c} opacity={post(0.3 * op)} />);
    badgeEls.push(<circle key={'b' + i} cx={b.cx} cy={b.cy} r={b.r} fill={c} opacity={op} />);
  }
  els.push(<g key="badges">{badgeEls}</g>);

  const labelEls = [];
  for (let i = 0; i < S.labels.length; i++) {
    const l = S.labels[i]; const p = clamp01((t - l.t0) / 0.7); if (p <= 0) continue;
    const ep = eo(p), fill = l.depth === 0 ? '#E8E6E1' : l.cls === 'ghost' ? '#64645C' : l.cls === 'file' ? '#8B8B82' : '#A9A9A0';
    labelEls.push(<text key={'l' + i} x={l.x} y={l.y + 3 * (1 - ep)} fontSize={l.fs} fill={fill} opacity={post(ep)}>{l.text}</text>);
  }
  els.push(<g key="labels">{labelEls}</g>);

  return (
    <div style={{ position: 'absolute', inset: 0, background: BG }} data-screen-label={'t=' + Math.floor(tS) + 's'}>
      <svg width="100%" height="100%" viewBox="-63 -169 1920 1080" preserveAspectRatio="xMidYMid slice" style={{ position: 'absolute', inset: 0, display: 'block' }} fontFamily="'Fragment Mono', ui-monospace, monospace">
        <defs>
          <radialGradient id="skyGrad"><stop offset="0%" stopColor="#EFEEE7" stopOpacity="0.06" /><stop offset="70%" stopColor="#EFEEE7" stopOpacity="0.02" /><stop offset="100%" stopColor="#EFEEE7" stopOpacity="0" /></radialGradient>
          <radialGradient id="groundGrad"><stop offset="0%" stopColor="#D8D7CF" stopOpacity="0.5" /><stop offset="100%" stopColor="#D8D7CF" stopOpacity="0" /></radialGradient>
        </defs>
        <g transform={cam}>{els}</g>
      </svg>
    </div>
  );
}

// ------------------------------------------------------------------ scenes
// Each scene renders a fixed band of the ONE continuous choreography; stretching a
// scene on the timeline stretches just that band (t is continuous across cuts).
const BANDS = { 'Star Falls': [0, 1.45], 'Roots Grow': [1.45, 5.55], 'Blueprint': [5.55, DUR] };
const BAND_LIST = [[0, 1.45], [1.45, 5.55], [5.55, DUR]];
const TweakCtx = React.createContext({ fps: 8, boil: true });

function BandScene() {
  const { scene, localTime, dur, index } = useScene();
  const tw = React.useContext(TweakCtx);
  const fps = Number(tw.fps) || 8;
  const band = BANDS[scene.name] || BAND_LIST[Math.min(index, BAND_LIST.length - 1)];
  const lt = clamp(localTime, 0, dur);
  const q = Math.min(Math.floor(lt * fps) / fps, dur);
  const t = clamp(band[0] + (q / dur) * (band[1] - band[0]), band[0], band[1]);
  const tS = band[0] + (lt / dur) * (band[1] - band[0]);
  const fi = Math.floor(lt * fps) + index * 997;
  return <AnimeFrame t={t} tS={tS} fi={fi} boil={tw.boil !== false} />;
}

function HeroAnimeAnimation() {
  const [tw, setTweak] = window.useTweaks(window.TWEAK_DEFAULTS || { motionEditor: true, fps: 8, boil: true });
  const { TweaksPanel, TweakSection, TweakRadio, TweakToggle } = window;
  return (
    <TweakCtx.Provider value={tw}>
      <div style={{ position: 'absolute', inset: 0, background: BG }}>
        <SceneStage width={1920} height={1080} bg={BG} scenes={window.OM_SCENES} playback={window.OM_PLAYBACK}>
          {{ 'Star Falls': BandScene, 'Roots Grow': BandScene, 'Blueprint': BandScene }}
        </SceneStage>
        <TweaksPanel>
          <TweakSection label="Anime feel" />
          <TweakRadio label="Frame rate" value={String(tw.fps)} options={['6', '8', '12']}
            onChange={(v) => setTweak('fps', Number(v))} />
          <TweakToggle label="Line boil" value={tw.boil !== false} onChange={(v) => setTweak('boil', v)} />
          <TweakSection label="Editor" />
          <TweakToggle label="Motion editor" value={!!tw.motionEditor} onChange={(v) => setTweak('motionEditor', v)} />
        </TweaksPanel>
      </div>
    </TweakCtx.Provider>
  );
}
window.HeroAnimeAnimation = HeroAnimeAnimation;
