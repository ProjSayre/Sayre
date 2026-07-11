// Hero animation — braided bare tree → the exact filetree graph, < 10 seconds.
// Ported from the claude.ai/design project's hero-tree-scene.jsx (v5):
//  • trunk = thin strands swirling up together, diverging at a shared waist
//  • nearly-collinear nodes are threaded onto one continuous chain branch
//  • side limbs leave low on a branch; dead space filled with thick forked fillers
//  • node pulses ride the growth front and lock in as bright open circles
//  • the graph then wires itself child-by-child while the camera pulls back
//  • organic tree dissolves; labels and badges settle into the production look
// Under reduced motion the scene renders its final frame statically.

import { useEffect, useMemo, useRef, useState } from "react";
import { prefersReducedMotion } from "../demo/canvas/useCamera";
import { HERO_BADGES, HERO_EDGES, HERO_LABELS, HERO_NODES } from "./heroTreeData";
import type { HeroNode } from "./heroTreeData";

const BG = "#060706";
export const HERO_SCENE_DURATION = 9.8;
const DUR = HERO_SCENE_DURATION;

function rnd(i: number): number {
  const s = Math.sin(i * 127.1 + 13.7) * 43758.5453;
  return s - Math.floor(s);
}
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
const eo = (p: number): number => 1 - Math.pow(1 - p, 3);
const eio = (p: number): number => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

// ---- timing (whole piece < 10s) ----
const GROW_T0 = 0.4;
const GROW_T1 = 4.6;
const SPAN = GROW_T1 - GROW_T0;
const EDGE_T0 = 4.75;
const FADE0 = 6.9;
const FADE1 = 8.4;
const CAM_T1 = GROW_T1 + 0.4;

// ---- ground + crown anchor ----
const GROUND_Y = 892;
const BASE_X = 958;
const CROWN_BASE = { x: 958, y: 690 };
const WAIST_Y = 700;
const WT = 26;
const WMIN = 1.5;
const N_STRANDS = 5;
const L = HERO_NODES.length;
const wOf = (c: number): number => Math.max(WMIN, WT * Math.pow(Math.max(c, 1) / L, 0.8));

const isOutlier = (n: HeroNode): boolean => n.cx < 340 || n.cx > 1450;

// ------------------------------------------------------------------ geometry
interface Pt {
  x: number;
  y: number;
}
interface ArcPt extends Pt {
  s: number;
  w?: number;
}
interface Seg {
  id: number;
  B: Pt | null;
  pts: ArcPt[];
  len: number;
  leafCount: number;
  level: number;
  path: string | null;
  decoy: boolean;
  children: Seg[];
  distStart: number;
  wStart?: number;
  wEnd?: number;
  waistS?: number;
  fullD?: string | null;
}

function sampleCubic(A: Pt, c1: Pt, c2: Pt, B: Pt, n: number): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const mu = 1 - u;
    pts.push({
      x: mu * mu * mu * A.x + 3 * mu * mu * u * c1.x + 3 * mu * u * u * c2.x + u * u * u * B.x,
      y: mu * mu * mu * A.y + 3 * mu * mu * u * c1.y + 3 * mu * u * u * c2.y + u * u * u * B.y,
    });
  }
  return pts;
}

function toArc(raw: Pt[], len: number): { pts: ArcPt[]; len: number } {
  let s = 0;
  const pts: ArcPt[] = [{ x: raw[0].x, y: raw[0].y, s: 0 }];
  for (let i = 1; i < raw.length; i++) {
    s += Math.hypot(raw[i].x - raw[i - 1].x, raw[i].y - raw[i - 1].y);
    pts.push({ x: raw[i].x, y: raw[i].y, s });
  }
  return { pts, len: s || len || 1 };
}

function branchCenterline(A: Pt, B: Pt, dirIn: Pt | null, bow: number, seed: number): { pts: ArcPt[]; len: number } {
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;
  let tix = ux;
  let tiy = uy;
  if (dirIn) {
    const dl = Math.hypot(dirIn.x, dirIn.y) || 1;
    tix = dirIn.x / dl;
    tiy = dirIn.y / dl;
  }
  const c1 = { x: A.x + (tix * 0.7 + ux * 0.3) * len * 0.42, y: A.y + (tiy * 0.7 + uy * 0.3) * len * 0.42 };
  const c2 = { x: B.x - ux * len * 0.3 + nx * bow * len, y: B.y - uy * len * 0.3 + ny * bow * len };
  const n = clamp(Math.round(len / 18), 4, 18);
  const raw = sampleCubic(A, c1, c2, B, n);
  const mAmp = Math.min(7, len * 0.028);
  const ph = (seed || 0) * 6.283;
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const off = Math.sin(Math.PI * u) * Math.sin(ph + u * Math.PI * 2.4) * mAmp;
    raw[i].x += nx * off;
    raw[i].y += ny * off;
  }
  return toArc(raw, len);
}

function strandCenterline(
  A: Pt,
  W: Pt,
  B: Pt,
  phase: number,
  amp: number,
  turns: number,
): { pts: ArcPt[]; len: number; waistS: number } {
  const hLow = Math.max(A.y - W.y, 8);
  const n1 = clamp(Math.round(hLow / 11), 8, 24);
  const c1a = { x: A.x, y: A.y - hLow * 0.38 };
  const c1b = { x: W.x, y: W.y + hLow * 0.34 };
  const lower = sampleCubic(A, c1a, c1b, W, n1);
  for (let i = 0; i <= n1; i++) {
    const u = i / n1;
    lower[i].x += Math.sin(Math.PI * u) * Math.sin(phase + u * Math.PI * turns * 2) * amp;
  }
  const dx = B.x - W.x;
  const dy = B.y - W.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const c2a = { x: W.x, y: W.y - len * 0.32 };
  const c2b = { x: B.x - ux * len * 0.3, y: B.y - uy * len * 0.3 };
  const n2 = clamp(Math.round(len / 16), 6, 20);
  const upper = sampleCubic(W, c2a, c2b, B, n2);
  const arc = toArc(lower.concat(upper.slice(1)), hLow + len);
  return { pts: arc.pts, len: arc.len, waistS: arc.pts[n1] ? arc.pts[n1].s : arc.len * 0.4 };
}

function assignWidths(seg: Seg): void {
  const { pts, len } = seg;
  const wStart = seg.wStart ?? WMIN;
  const wEnd = seg.wEnd ?? WMIN;
  for (const p of pts) p.w = wStart + (wEnd - wStart) * (p.s / (len || 1));
}

function pointAt(seg: Seg, frac: number): { x: number; y: number; tx: number; ty: number; w: number } {
  const target = frac * seg.len;
  const pts = seg.pts;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].s >= target) {
      const a = pts[i - 1];
      const b = pts[i];
      const f = (target - a.s) / (b.s - a.s || 1);
      const tx = b.x - a.x;
      const ty = b.y - a.y;
      const tl = Math.hypot(tx, ty) || 1;
      return {
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        tx: tx / tl,
        ty: ty / tl,
        w: (a.w ?? 0) + ((b.w ?? 0) - (a.w ?? 0)) * f || seg.wEnd || WMIN,
      };
    }
  }
  const p = pts[pts.length - 1];
  return { x: p.x, y: p.y, tx: 0, ty: -1, w: seg.wEnd ?? WMIN };
}

function outlinePath(seg: Seg, revealLen: number): string | null {
  const pts = seg.pts;
  if (revealLen <= 0.2) return null;
  const rl = Math.min(revealLen, seg.len);
  const growing = revealLen < seg.len;
  const list: ArcPt[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (pts[i].s <= rl) list.push(pts[i]);
    else {
      const b = pts[i - 1];
      const a = pts[i];
      const f = (rl - b.s) / (a.s - b.s || 1);
      list.push({ x: b.x + (a.x - b.x) * f, y: b.y + (a.y - b.y) * f, w: (b.w ?? 0) + ((a.w ?? 0) - (b.w ?? 0)) * f, s: rl });
      break;
    }
  }
  if (list.length < 2) return null;
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const a = list[Math.max(0, i - 1)];
    const b = list[Math.min(list.length - 1, i + 1)];
    let tx = b.x - a.x;
    let ty = b.y - a.y;
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    const nx = -ty;
    const ny = tx;
    let w = p.w ?? WMIN;
    if (growing) {
      const dTip = rl - p.s;
      if (dTip < 7) w *= Math.max(0.12, dTip / 7);
    }
    left.push([p.x + (nx * w) / 2, p.y + (ny * w) / 2]);
    right.push([p.x - (nx * w) / 2, p.y - (ny * w) / 2]);
  }
  let d = "M " + left[0][0].toFixed(1) + " " + left[0][1].toFixed(1);
  for (let i = 1; i < left.length; i++) d += " L " + left[i][0].toFixed(1) + " " + left[i][1].toFixed(1);
  for (let i = right.length - 1; i >= 0; i--) d += " L " + right[i][0].toFixed(1) + " " + right[i][1].toFixed(1);
  return d + " Z";
}

const RAMP_A = 0.12;
function ramp(x: number): number {
  x = clamp01(x);
  const area = 1 - RAMP_A;
  let p: number;
  if (x < RAMP_A) p = (x * x) / (2 * RAMP_A);
  else if (x > 1 - RAMP_A) {
    const y = 1 - x;
    p = area - (y * y) / (2 * RAMP_A);
  } else p = x - RAMP_A / 2;
  return p / area;
}

// ------------------------------------------------------------------ schedule
interface SchedNode extends HeroNode {
  mote: boolean;
  seg?: Seg | null;
  sOff?: number;
  ignite: number;
  ringT?: number;
  driftStop?: number;
  ph?: number;
  amp?: number;
}
interface SchedEdge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  ghost: boolean;
  path: string;
  depth: number;
  t0: number;
  t1: number;
}

function buildSchedule() {
  const segs: Seg[] = [];
  let sid = 0;
  const leafSeg = new Map<string, { seg: Seg; sOff: number }>();
  const joints: { x: number; y: number; seg: Seg; dist?: number; r?: number }[] = [];
  const fillerTips: { x: number; y: number; dist: number }[] = [];

  function push(seg: Seg): Seg {
    segs.push(seg);
    if (seg.path) leafSeg.set(seg.path, { seg, sOff: seg.len });
    return seg;
  }
  function mkBranch(A: Pt, B: Pt, dirIn: Pt | null, leafCount: number, path: string | null, level: number): Seg {
    sid++;
    const cl = branchCenterline(A, B, dirIn, (rnd(sid * 3.1) - 0.5) * 0.24, rnd(sid * 1.9));
    return push({ id: sid, B, pts: cl.pts, len: cl.len, leafCount, level, path: path || null, decoy: false, children: [], distStart: 0 });
  }
  function mkStrand(A: Pt, W: Pt, B: Pt, phase: number, amp: number, turns: number, wStart: number, wEnd: number, path: string | null): Seg {
    sid++;
    const cl = strandCenterline(A, W, B, phase, amp, turns);
    const seg: Seg = {
      id: sid,
      B,
      pts: cl.pts,
      len: cl.len,
      leafCount: 0,
      level: 0,
      path: path || null,
      decoy: false,
      children: [],
      distStart: 0,
      wStart,
      wEnd,
      waistS: cl.waistS,
    };
    assignWidths(seg);
    return push(seg);
  }
  function mkChain(J: Pt, order: HeroNode[], dirIn: Pt, level: number): Seg {
    sid++;
    let prev: Pt = J;
    let dir: Pt = dirIn;
    const raw: Pt[] = [{ x: J.x, y: J.y }];
    const wpIdx: number[] = [];
    const seed = sid;
    for (let k = 0; k < order.length; k++) {
      const B = { x: order[k].cx, y: order[k].cy };
      const cl = branchCenterline(prev, B, dir, (rnd(seed * 3.7 + k * 7.3) - 0.5) * 0.2, rnd(seed * 2.1 + k));
      for (let q = 1; q < cl.pts.length; q++) raw.push({ x: cl.pts[q].x, y: cl.pts[q].y });
      wpIdx.push(raw.length - 1);
      const n2 = raw[raw.length - 1];
      const n1 = raw[raw.length - 2];
      dir = { x: n2.x - n1.x, y: n2.y - n1.y };
      prev = B;
    }
    const arc = toArc(raw, 0);
    const seg: Seg = { id: sid, B: prev, pts: arc.pts, len: arc.len, leafCount: order.length, level, path: null, decoy: false, children: [], distStart: 0 };
    segs.push(seg);
    order.forEach((tn, k) => leafSeg.set(tn.path, { seg, sOff: arc.pts[wpIdx[k]] ? arc.pts[wpIdx[k]].s : arc.len }));
    return seg;
  }
  function tryChain(J: Pt, targets: HeroNode[], dirIn: Pt, level: number): Seg | null {
    if (targets.length < 2 || targets.length > 4) return null;
    const rem = targets.slice();
    const order: HeroNode[] = [];
    let cur = { x: J.x, y: J.y };
    while (rem.length) {
      let bi = 0;
      let bd = 1e18;
      for (let i = 0; i < rem.length; i++) {
        const dd = (rem[i].cx - cur.x) * (rem[i].cx - cur.x) + (rem[i].cy - cur.y) * (rem[i].cy - cur.y);
        if (dd < bd) {
          bd = dd;
          bi = i;
        }
      }
      const nx = rem.splice(bi, 1)[0];
      order.push(nx);
      cur = { x: nx.cx, y: nx.cy };
    }
    let px = J.x;
    let py = J.y;
    let pdx = dirIn.x;
    let pdy = dirIn.y;
    for (const tn of order) {
      const dx = tn.cx - px;
      const dy = tn.cy - py;
      const dl = Math.hypot(dx, dy) || 1;
      const pl = Math.hypot(pdx, pdy) || 1;
      if ((dx * pdx + dy * pdy) / (dl * pl) < 0.42) return null;
      px = tn.cx;
      py = tn.cy;
      pdx = dx;
      pdy = dy;
    }
    return mkChain(J, order, dirIn, level);
  }

  const centroid = (g: HeroNode[]): Pt => ({
    x: g.reduce((s, t) => s + t.cx, 0) / g.length,
    y: g.reduce((s, t) => s + t.cy, 0) / g.length,
  });
  function splitGroup(targets: HeroNode[]): [HeroNode[], HeroNode[]] {
    const xs = targets.map((t) => t.cx);
    const ys = targets.map((t) => t.cy);
    const axis: "cx" | "cy" = Math.max(...xs) - Math.min(...xs) >= (Math.max(...ys) - Math.min(...ys)) * 0.75 ? "cx" : "cy";
    const sorted = targets.slice().sort((a, b) => a[axis] - b[axis]);
    let bi = Math.floor(sorted.length / 2);
    let bg = -1;
    const lo = Math.max(1, Math.floor(sorted.length * 0.28));
    const hi = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.72));
    for (let k = lo; k <= hi; k++) {
      const g = sorted[k][axis] - sorted[k - 1][axis];
      if (g > bg) {
        bg = g;
        bi = k;
      }
    }
    return [sorted.slice(0, bi), sorted.slice(bi)];
  }
  function junction(base: Pt, cen: Pt, targets: HeroNode[], level: number): Pt {
    const f = clamp(0.46 - level * 0.03, 0.3, 0.5);
    const minY = Math.min(...targets.map((t) => t.cy));
    const jx = base.x + (cen.x - base.x) * f + (rnd(sid + level * 7 + targets.length) - 0.5) * 24;
    const jy = clamp(base.y + (cen.y - base.y) * f, minY + 34, base.y - 10);
    return { x: jx, y: jy };
  }
  function spreadFrom(J: Pt, targets: HeroNode[], dirIn: Pt, level: number): Seg[] {
    if (targets.length === 1) return [mkBranch(J, { x: targets[0].cx, y: targets[0].cy }, dirIn, 1, targets[0].path, level)];
    const whole = tryChain(J, targets, dirIn, level);
    if (whole) return [whole];
    const kids: Seg[] = [];
    for (const g of splitGroup(targets)) {
      if (g.length === 1) {
        kids.push(mkBranch(J, { x: g[0].cx, y: g[0].cy }, dirIn, 1, g[0].path, level));
        continue;
      }
      const chained = tryChain(J, g, dirIn, level);
      if (chained) {
        kids.push(chained);
        continue;
      }
      const J2 = junction(J, centroid(g), g, level);
      const seg = mkBranch(J, J2, dirIn, g.length, null, level);
      seg.children = spreadFrom(J2, g, { x: J2.x - J.x, y: J2.y - J.y }, level + 1);
      joints.push({ x: J2.x, y: J2.y, seg });
      kids.push(seg);
    }
    return kids;
  }

  // ---- top-level groups → one swirling strand each ----
  const treeTargets = HERO_NODES.filter((n) => !isOutlier(n));
  let groups: HeroNode[][] = [treeTargets];
  while (groups.length < N_STRANDS) {
    groups.sort((a, b) => b.length - a.length);
    const big = groups.shift()!;
    if (big.length < 2) {
      groups.unshift(big);
      break;
    }
    const [g1, g2] = splitGroup(big);
    groups.push(g1, g2);
  }
  groups.sort((a, b) => centroid(a).x - centroid(b).x);

  groups.forEach((g, k) => {
    const cen = centroid(g);
    const spread = k - (groups.length - 1) / 2;
    const A = { x: BASE_X + spread * 9 + (rnd(k * 3) - 0.5) * 5, y: GROUND_Y };
    const W = { x: BASE_X + spread * 4.5 + (rnd(k * 7) - 0.5) * 4, y: WAIST_Y + (rnd(k * 11) - 0.5) * 12 };
    const count = g.length;
    let B: Pt;
    let path: string | null = null;
    if (count === 1) {
      B = { x: g[0].cx, y: g[0].cy };
      path = g[0].path;
    } else {
      B = {
        x: CROWN_BASE.x + (cen.x - CROWN_BASE.x) * 0.42,
        y: Math.min(WAIST_Y - 64, CROWN_BASE.y + (cen.y - CROWN_BASE.y) * 0.42),
      };
    }
    const wS = Math.max(7.5, wOf(count) * 1.15);
    const wE = Math.max(4, wOf(count) * 0.9);
    const strand = mkStrand(A, W, B, k * 1.7 + 0.5, 9, 1.15, wS, wE, path);
    if (count > 1) {
      const p0 = strand.pts[strand.pts.length - 2];
      const p1 = strand.pts[strand.pts.length - 1];
      strand.children = spreadFrom(B, g, { x: p1.x - p0.x, y: p1.y - p0.y }, 1);
      joints.push({ x: B.x, y: B.y, seg: strand });
    }
  });

  // decorative filler cords in the bundle
  for (let i = 0; i < 3; i++) {
    const spread = (i - 1) * 6;
    const A = { x: BASE_X + spread, y: GROUND_Y };
    const B = { x: BASE_X + spread * 1.5 + (rnd(i + 9) - 0.5) * 14, y: GROUND_Y - 130 - rnd(i) * 44 };
    const W = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
    const s = mkStrand(A, W, B, i * 2.1 + 1, 7, 1.2, 5.5, 1.8, null);
    s.decoy = true;
  }

  // ---- widths ----
  function setWidths(seg: Seg): void {
    for (const c of seg.children) setWidths(c);
    if (seg.waistS != null) {
      assignWidths(seg);
      return;
    }
    if (seg.children.length === 0) {
      seg.wStart = seg.wStart ?? wOf(seg.leafCount);
      seg.wEnd = seg.wEnd ?? Math.max(WMIN, seg.wStart * 0.62);
    } else {
      seg.wStart = seg.wStart ?? wOf(seg.leafCount);
      let mx = 0;
      for (const c of seg.children) mx = Math.max(mx, c.wStart ?? wOf(c.leafCount));
      seg.wEnd = seg.wEnd ?? Math.max(mx, seg.wStart * 0.8);
    }
    assignWidths(seg);
  }
  for (const s of segs) if (s.waistS != null) setWidths(s);
  for (const s of segs) if (s.wStart == null) setWidths(s);

  // ---- distances ----
  function setDist(seg: Seg, d0: number): void {
    seg.distStart = d0;
    for (const c of seg.children) setDist(c, d0 + seg.len);
  }
  const childIds = new Set<number>();
  for (const s of segs) for (const c of s.children) childIds.add(c.id);
  for (const s of segs) if (!childIds.has(s.id)) setDist(s, 0);

  // ---- decoy branches ----
  let decoyCount = 0;
  const DECOY_MAX = 120;
  function decoy(base: Pt, dir: Pt, w: number, lenT: number, level: number, distBase: number): void {
    if (decoyCount >= DECOY_MAX || lenT < 12 || w < WMIN * 0.9) return;
    decoyCount++;
    const dl = Math.hypot(dir.x, dir.y) || 1;
    const dx = dir.x / dl;
    const dy = dir.y / dl;
    const turn = (rnd(sid * 1.7 + decoyCount * 5.3) - 0.5) * 0.9;
    const ca = Math.cos(turn);
    const sa = Math.sin(turn);
    let rx = dx * ca - dy * sa;
    let ry = dx * sa + dy * ca;
    ry -= 0.35;
    const rl = Math.hypot(rx, ry) || 1;
    rx /= rl;
    ry /= rl;
    sid++;
    const cl = branchCenterline(base, { x: base.x + rx * lenT, y: base.y + ry * lenT }, dir, (rnd(decoyCount * 2.3) - 0.5) * 0.26, rnd(decoyCount * 4.1));
    const seg: Seg = {
      id: sid,
      B: null,
      pts: cl.pts,
      len: cl.len,
      leafCount: 0,
      level: 9,
      path: null,
      decoy: true,
      children: [],
      distStart: distBase,
      wStart: w,
      wEnd: Math.max(WMIN * 0.7, w * 0.45),
    };
    assignWidths(seg);
    segs.push(seg);
    const forks = rnd(decoyCount * 9.1) < 0.5 ? 2 : 1;
    for (let i = 0; i < forks; i++) {
      const spr = (i - (forks - 1) / 2) * 0.6 + (rnd(decoyCount * 3.1 + i) - 0.5) * 0.4;
      const cca = Math.cos(spr);
      const csa = Math.sin(spr);
      decoy(
        { x: cl.pts[cl.pts.length - 1].x, y: cl.pts[cl.pts.length - 1].y },
        { x: rx * cca - ry * csa, y: rx * csa + ry * cca },
        seg.wEnd ?? WMIN,
        lenT * (0.62 + rnd(decoyCount + i) * 0.16),
        level + 1,
        distBase + seg.len,
      );
    }
  }
  const skeleton = segs.slice();
  for (const seg of skeleton) {
    if (seg.decoy || (seg.leafCount === 0 && (seg.wStart ?? 0) > 6)) continue;
    const thick = ((seg.wStart ?? 0) + (seg.wEnd ?? 0)) / 2;
    if (thick < 2.4 || thick > 13) continue;
    const spots = thick > 8 ? [0.16, 0.42, 0.7] : [0.22, 0.55];
    for (const frac of spots) {
      if (rnd(seg.id * 4.7 + frac * 31) > 0.75) continue;
      const P = pointAt(seg, frac);
      const side = rnd(seg.id + frac * 13) < 0.5 ? 1 : -1;
      const perpX = -P.ty * side;
      const perpY = P.tx * side;
      decoy(
        { x: P.x, y: P.y },
        { x: P.tx * 0.55 + perpX * 0.75, y: P.ty * 0.55 + perpY * 0.75 },
        clamp(P.w * 0.7, 2.4, 7.5),
        56 + thick * 8,
        0,
        seg.distStart + seg.len * frac,
      );
    }
  }
  // mask limbs above the waist
  const mains = segs.filter((s) => s.waistS != null && !s.decoy);
  for (let i = 0; i < 5 && mains.length; i++) {
    const st = mains[(i * 2 + 1) % mains.length];
    const frac = clamp(((st.waistS ?? 0) + 14 + rnd(i * 12.4) * 46) / st.len, 0.25, 0.8);
    const P = pointAt(st, frac);
    const ang = -Math.PI / 2 + (i - 2) * 0.45 + (rnd(i * 12.4) - 0.5) * 0.3;
    decoy({ x: P.x, y: P.y }, { x: Math.cos(ang), y: Math.sin(ang) }, Math.max(2.6, P.w * 0.5), 120 + rnd(i * 5) * 70, 0, st.len * frac);
  }
  // even-silhouette fillers
  function fillerLimb(P: { x: number; y: number; tx: number; ty: number }, T: Pt, w: number, distBase: number, seed: number): void {
    sid++;
    const cl = branchCenterline({ x: P.x, y: P.y }, T, { x: P.tx, y: P.ty }, (rnd(seed * 7.7) - 0.5) * 0.3, rnd(seed * 3.3));
    const seg: Seg = {
      id: sid,
      B: T,
      pts: cl.pts,
      len: cl.len,
      leafCount: 0,
      level: 8,
      path: null,
      decoy: true,
      children: [],
      distStart: distBase,
      wStart: w,
      wEnd: Math.max(WMIN, w * 0.42),
    };
    assignWidths(seg);
    segs.push(seg);
    fillerTips.push({ x: T.x, y: T.y, dist: distBase + seg.len });
    const M = pointAt(seg, 0.38);
    const sideM = rnd(seed * 5.9) < 0.5 ? 1 : -1;
    decoy(
      { x: M.x, y: M.y },
      { x: M.tx * 0.6 - M.ty * 0.7 * sideM, y: M.ty * 0.6 + M.tx * 0.7 * sideM },
      Math.max(2.2, w * 0.55),
      46 + rnd(seed + 8) * 40,
      0,
      distBase + seg.len * 0.38,
    );
    const tp = cl.pts[cl.pts.length - 1];
    const tq = cl.pts[cl.pts.length - 2];
    decoy({ x: tp.x, y: tp.y }, { x: tp.x - tq.x, y: tp.y - tq.y }, Math.max(WMIN, (seg.wEnd ?? WMIN) * 1.3), 30 + rnd(seed + 4) * 26, 1, distBase + seg.len);
  }
  const envC = { x: 958, y: 660 };
  const RINGS = [
    { n: 20, s: 1 },
    { n: 10, s: 0.6 },
  ];
  let fi = 0;
  for (const ring of RINGS)
    for (let i = 0; i < ring.n; i++) {
      fi++;
      const th = Math.PI * (0.08 + 0.84 * ((i + 0.5) / ring.n));
      const jit = (0.82 + rnd(fi * 31) * 0.26) * ring.s;
      const T = { x: clamp(envC.x + Math.cos(th) * 530 * jit, -30, 1840), y: Math.max(envC.y - Math.sin(th) * 620 * jit, -130) };
      let best: { seg: Seg; q: number } | null = null;
      let bd = 1e9;
      for (const seg of skeleton) {
        if (seg.decoy) continue;
        for (let q = 1; q < seg.pts.length - 1; q++) {
          const p = seg.pts[q];
          const pw = p.w ?? 0;
          if (pw > 13 || pw < 1.9 || p.y > 665) continue;
          let dd = (p.x - T.x) * (p.x - T.x) + (p.y - T.y) * (p.y - T.y);
          dd *= 0.55 + p.s / seg.len;
          if (dd < bd) {
            bd = dd;
            best = { seg, q };
          }
        }
      }
      if (!best) continue;
      const p = best.seg.pts[best.q];
      const p2 = best.seg.pts[best.q + 1];
      const dlen = Math.hypot(p.x - T.x, p.y - T.y);
      if (dlen < 55 || dlen > 700) continue;
      const tl = Math.hypot(p2.x - p.x, p2.y - p.y) || 1;
      fillerLimb(
        { x: p.x, y: p.y, tx: (p2.x - p.x) / tl, ty: (p2.y - p.y) / tl },
        T,
        clamp((p.w ?? 4) * 0.75, 3.5, 8),
        best.seg.distStart + p.s,
        fi + 3,
      );
    }
  // root flares
  for (let i = 0; i < 5; i++) {
    const s = i < 2 ? -1 : i > 2 ? 1 : rnd(i) < 0.5 ? -1 : 1;
    decoy({ x: BASE_X + s * (6 + rnd(i) * 8), y: GROUND_Y - 4 }, { x: s * (0.7 + rnd(i) * 0.3), y: 0.5 + rnd(i + 3) * 0.3 }, 5.5, 30 + rnd(i) * 22, 1, 2);
  }

  // ---- caches, ordering, totals ----
  let totalDist = 0;
  for (const seg of segs) {
    totalDist = Math.max(totalDist, seg.distStart + seg.len);
    seg.fullD = outlinePath(seg, seg.len);
  }
  segs.sort((a, b) => (b.wStart ?? 0) + (b.wEnd ?? 0) - ((a.wStart ?? 0) + (a.wEnd ?? 0)));
  for (const j of joints) {
    j.dist = j.seg.distStart + j.seg.len;
    j.r = Math.max(1.4, ((j.seg.wEnd ?? WMIN) / 2) * 1.12);
  }

  function timeForDist(d: number): number {
    const target = clamp01(d / totalDist);
    let lo = 0;
    let hi = 1;
    for (let k = 0; k < 22; k++) {
      const m = (lo + hi) / 2;
      if (ramp(m) < target) lo = m;
      else hi = m;
    }
    return GROW_T0 + (SPAN * (lo + hi)) / 2;
  }

  const nodes: SchedNode[] = HERO_NODES.map((n, i) => {
    if (isOutlier(n)) return { ...n, mote: true, ignite: 0, ph: rnd(i + 5) * 6.283, amp: 7 + rnd(i + 9) * 5 };
    const ls = leafSeg.get(n.path);
    const d = ls ? ls.seg.distStart + ls.sOff : totalDist;
    return { ...n, mote: false, seg: ls ? ls.seg : null, sOff: ls ? ls.sOff : 0, ignite: timeForDist(d) };
  });

  // ---- graph edges: self-building cascade ----
  const sortedE = HERO_EDGES.slice().sort((a, b) => a.depth - b.depth);
  const sibIdx = new Map<(typeof sortedE)[number], number>();
  {
    const byParent = new Map<string, typeof sortedE>();
    for (const e of sortedE) {
      const k = e.x1 + "," + e.y1;
      if (!byParent.has(k)) byParent.set(k, []);
      byParent.get(k)!.push(e);
    }
    for (const list of byParent.values()) {
      const shuffled = list.slice().sort((a, b) => rnd(a.x2 * 0.37 + a.y2 * 0.11) - rnd(b.x2 * 0.37 + b.y2 * 0.11));
      shuffled.forEach((e, i) => sibIdx.set(e, i));
    }
  }
  const readyAt = new Map<string, number>();
  const rootN = HERO_NODES.find((n) => n.type === "root")!;
  readyAt.set(rootN.cx + "," + rootN.cy, EDGE_T0);
  const edges: SchedEdge[] = sortedE.map((e, i) => {
    const pt = readyAt.get(e.x1 + "," + e.y1);
    const base = pt != null ? pt : EDGE_T0 + (e.depth - 1) * 0.35;
    const t0 = base + 0.06 + Math.min((sibIdx.get(e) ?? 0) * 0.06, 0.3) + rnd(i + 200) * 0.04;
    const t1 = t0 + 0.18 + rnd(i + 260) * 0.12;
    readyAt.set(e.x2 + "," + e.y2, t1);
    return { ...e, t0, t1 };
  });
  for (const n of nodes) {
    const inc = edges.find((e) => e.path === n.path);
    n.ringT = n.type === "root" ? EDGE_T0 : inc ? inc.t1 : EDGE_T0 + 1.6;
    if (n.mote) n.driftStop = inc ? inc.t0 : EDGE_T0;
  }
  const badges = HERO_BADGES.map((b, i) => ({ ...b, t0: 7.7 + i * 0.08 }));
  const labels = HERO_LABELS.map((l, i) => ({ ...l, t0: 8.0 + i * 0.022 }));
  const dust = Array.from({ length: 16 }, (_, i) => ({
    x: -40 + rnd(i + 300) * 1880,
    y: -150 + rnd(i + 340) * 1040,
    r: 1 + rnd(i + 380) * 1.8,
    base: 0.05 + rnd(i + 420) * 0.13,
    w1: 0.25 + rnd(i + 460) * 0.4,
    ph: rnd(i + 500) * 6.283,
    vx: (rnd(i + 540) - 0.5) * 7,
    vy: (rnd(i + 580) - 0.5) * 5,
    blur: i % 2,
  }));
  const motes = Array.from({ length: 28 }, (_, i) => ({
    x: 60 + rnd(i + 700) * 1700,
    y: -100 + rnd(i + 740) * 940,
    r: 1.3 + rnd(i + 780) * 2.3,
    ph: rnd(i + 820) * 6.283,
    w1: 0.3 + rnd(i + 860) * 0.5,
    ax: 12 + rnd(i + 900) * 22,
    ay: 9 + rnd(i + 940) * 16,
    base: 0.3 + rnd(i + 980) * 0.42,
  }));

  return { segs, joints, fillerTips, totalDist, nodes, edges, badges, labels, dust, motes };
}

function badgeOp(u: number): number {
  if (u < 0) return 0;
  if (u < 0.09) return 1;
  if (u < 0.16) return 0.15;
  if (u < 0.24) return 1;
  if (u < 0.3) return 0.45;
  return 1;
}

// ------------------------------------------------------------------ render
export function TreeSceneAt({ t }: { t: number }): JSX.Element {
  const S = useMemo(buildSchedule, []);

  const camP = eio(clamp01(t / CAM_T1));
  const cs = 1.22 - 0.22 * camP;
  const ccx = 958 + (897 - 958) * camP;
  const ccy = 706 + (371 - 706) * camP;
  const cam = "translate(" + (897 - cs * ccx).toFixed(2) + " " + (371 - cs * ccy).toFixed(2) + ") scale(" + cs.toFixed(4) + ")";
  const organicOp = 1 - eio(clamp01((t - FADE0) / (FADE1 - FADE0)));
  const dustFade = clamp01(t / 1.6) * (1 - clamp01((t - 5.6) / 0.9));
  const moteFade = clamp01(t / 1.2) * (1 - clamp01((t - 7.2) / 1.3));
  const els: JSX.Element[] = [];

  if (dustFade > 0.001) {
    const a: JSX.Element[] = [];
    for (let i = 0; i < S.dust.length; i++) {
      const d = S.dust[i];
      const op = d.base * dustFade * (0.65 + 0.35 * Math.sin(t * d.w1 * 2 + d.ph));
      a.push(
        <circle
          key={i}
          cx={d.x + Math.sin(t * d.w1 + d.ph) * 26 + t * d.vx}
          cy={d.y + Math.cos(t * d.w1 * 0.8 + d.ph) * 18 + t * d.vy}
          r={d.r}
          fill="#D9D8D1"
          opacity={op}
          filter={d.blur ? "url(#dustblur)" : undefined}
        />,
      );
    }
    els.push(<g key="dust">{a}</g>);
  }

  if (moteFade > 0.001) {
    const glow: JSX.Element[] = [];
    const core: JSX.Element[] = [];
    for (let i = 0; i < S.motes.length; i++) {
      const m = S.motes[i];
      const op = m.base * moteFade * (0.55 + 0.45 * Math.sin(t * m.w1 * 1.7 + m.ph));
      const x = m.x + Math.sin(t * m.w1 + m.ph) * m.ax;
      const y = m.y + Math.cos(t * m.w1 * 0.85 + m.ph) * m.ay;
      glow.push(<circle key={"mg" + i} cx={x} cy={y} r={m.r + 2.5} fill="#EFEEE7" opacity={op * 0.5} />);
      core.push(<circle key={"mc" + i} cx={x} cy={y} r={m.r} fill="#F2F1EA" opacity={op} />);
    }
    els.push(
      <g key="moteGlow" filter="url(#glow)">
        {glow}
      </g>,
    );
    els.push(<g key="moteCore">{core}</g>);
  }

  if (organicOp > 0.001) {
    const front = S.totalDist * ramp(clamp01((t - GROW_T0) / SPAN));
    const glow: JSX.Element[] = [];
    const crisp: JSX.Element[] = [];
    if (front > 1)
      els.push(
        <ellipse key="ground" cx={BASE_X} cy={GROUND_Y + 4} rx={86} ry={9} fill="#D8D7CF" filter="url(#glowBig)" opacity={0.3 * clamp01(front / 40) * organicOp} />,
      );
    for (let i = 0; i < S.segs.length; i++) {
      const seg = S.segs[i];
      const rl = front - seg.distStart;
      if (rl <= 0.2) continue;
      const d = rl >= seg.len ? seg.fullD : outlinePath(seg, rl);
      if (!d) continue;
      const op = seg.decoy ? 0.8 : 0.9;
      glow.push(<path key={"g" + seg.id} d={d} fill="#EBEAE3" opacity={0.24 * op} />);
      crisp.push(
        <path key={"c" + seg.id} d={d} fill={seg.decoy ? "#C4C3BC" : "#CFCEC7"} stroke={seg.decoy ? "#C4C3BC" : "#CFCEC7"} strokeWidth="0.8" strokeLinejoin="round" opacity={op} />,
      );
    }
    for (let i = 0; i < S.joints.length; i++) {
      const j = S.joints[i];
      if (front < (j.dist ?? 0) - 0.5) continue;
      glow.push(<circle key={"jg" + i} cx={j.x} cy={j.y} r={(j.r ?? 2) + 1} fill="#EBEAE3" opacity={0.24 * 0.9} />);
      crisp.push(<circle key={"jc" + i} cx={j.x} cy={j.y} r={j.r ?? 2} fill="#CFCEC7" />);
    }
    for (let i = 0; i < S.fillerTips.length; i++) {
      const f = S.fillerTips[i];
      if (front < f.dist) continue;
      glow.push(<circle key={"fg" + i} cx={f.x} cy={f.y} r={2.8} fill="#F2F1EA" opacity={0.32} />);
      crisp.push(<circle key={"ff" + i} cx={f.x} cy={f.y} r={1.3} fill="#EFEEE7" opacity={0.5} />);
    }
    els.push(
      <g key="organic" opacity={organicOp}>
        <g filter="url(#glow)">{glow}</g>
        {crisp}
      </g>,
    );
    const pgl: JSX.Element[] = [];
    const pcr: JSX.Element[] = [];
    for (let i = 0; i < S.nodes.length; i++) {
      const n = S.nodes[i];
      if (n.mote || !n.seg) continue;
      const rl = front - n.seg.distStart;
      if (rl <= 0 || rl >= (n.sOff ?? 0)) continue;
      const P = pointAt(n.seg, rl / n.seg.len);
      pgl.push(<circle key={"pg" + i} cx={P.x} cy={P.y} r={6} fill="#FFFFFF" opacity={0.55} />);
      pcr.push(<circle key={"pp" + i} cx={P.x} cy={P.y} r={2.6} fill="#F6F5EF" opacity={0.95} />);
    }
    if (pgl.length) {
      els.push(
        <g key="pulseGlow" filter="url(#glow)">
          {pgl}
        </g>,
      );
      els.push(<g key="pulses">{pcr}</g>);
    }
  }

  const calm = 1 - organicOp;
  const glowLines: JSX.Element[] = [];
  const crispLines: JSX.Element[] = [];
  const heads: JSX.Element[] = [];
  for (let i = 0; i < S.edges.length; i++) {
    const e = S.edges[i];
    const p = clamp01((t - e.t0) / (e.t1 - e.t0));
    if (p <= 0) continue;
    const g = eo(p);
    const x2 = e.x1 + (e.x2 - e.x1) * g;
    const y2 = e.y1 + (e.y2 - e.y1) * g;
    const alpha = Math.min(1, p * 3);
    if (e.ghost) {
      crispLines.push(<line key={"e" + i} x1={e.x1} y1={e.y1} x2={x2} y2={y2} stroke="#3B3B35" strokeWidth="1" opacity={(0.55 + 0.25 * (1 - calm)) * alpha} />);
    } else {
      glowLines.push(<line key={"ge" + i} x1={e.x1} y1={e.y1} x2={x2} y2={y2} stroke="#E4E3DC" strokeWidth={4.5 - 1.7 * calm} opacity={(0.32 - 0.12 * calm) * alpha} />);
      crispLines.push(<line key={"e" + i} x1={e.x1} y1={e.y1} x2={x2} y2={y2} stroke="#7B7B73" strokeWidth={1.6 - 0.5 * calm} opacity={alpha} />);
      if (calm < 0.999) crispLines.push(<line key={"eb" + i} x1={e.x1} y1={e.y1} x2={x2} y2={y2} stroke="#C9C8C0" strokeWidth="1.2" opacity={alpha * 0.75 * (1 - calm)} />);
      if (p < 1) heads.push(<circle key={"h" + i} cx={x2} cy={y2} r={3} fill="#FFFFFF" opacity={0.95} />);
    }
  }
  els.push(
    <g key="glowEdges" filter="url(#glow)">
      {glowLines}
    </g>,
  );
  els.push(<g key="edges">{crispLines}</g>);
  els.push(
    <g key="edgeHeads" filter="url(#glow)">
      {heads}
    </g>,
  );

  const nodeGlow: JSX.Element[] = [];
  const lights: JSX.Element[] = [];
  const rings: JSX.Element[] = [];
  for (let i = 0; i < S.nodes.length; i++) {
    const n = S.nodes[i];
    if (t <= n.ignite && !n.mote) continue;
    const settle = eo(clamp01((t - (n.ringT ?? 0)) / 0.45));
    let cx = n.cx;
    let cy = n.cy;
    let appear = 1;
    let flash = 0;
    if (n.mote) {
      const rest = eio(clamp01(t / (n.driftStop || EDGE_T0)));
      const damp = 1 - rest;
      cx = n.cx + Math.sin(t * 0.7 + (n.ph ?? 0)) * (n.amp ?? 0) * damp;
      cy = n.cy + Math.cos(t * 0.6 + (n.ph ?? 0) * 1.3) * (n.amp ?? 0) * 0.7 * damp;
      appear = clamp01(t / 0.8);
    } else {
      const u = t - n.ignite;
      flash = eo(clamp01(u / 0.2)) * (1 - 0.5 * eio(clamp01((u - 0.2) / 1.1)));
    }
    const pop = eo(clamp01((t - (n.ringT ?? 0)) / 0.16)) * (1 - eio(clamp01((t - (n.ringT ?? 0) - 0.16) / 0.55)));
    const pulse = 0.06 * Math.sin(t * 2.2 + i) * (1 - settle);
    const lightR = n.type === "root" ? 5 : n.type === "folder" ? 4 : 3;
    const finalGlow = n.type === "file" ? 0.09 : n.type === "root" ? 0.2 : 0.15;
    const gop = (n.mote ? 0.32 * appear : 0.85 * flash) * (1 - settle) + pulse * (1 - settle) + finalGlow * settle + 0.65 * pop;
    nodeGlow.push(<circle key={"gn" + i} cx={cx} cy={cy} r={n.r + 3 + 4 * pop} fill="#FFFFFF" opacity={Math.max(0, gop)} />);
    if (settle < 1) {
      if (n.mote) lights.push(<circle key={"li" + i} cx={cx} cy={cy} r={2.5} fill="#F2F1EA" opacity={0.7 * appear * (1 - settle)} />);
      else lights.push(<circle key={"li" + i} cx={cx} cy={cy} r={lightR} fill="none" stroke="#F6F5EF" strokeWidth={1.8} opacity={(0.6 + 0.4 * flash) * (1 - settle)} />);
    }
    if (settle > 0) {
      if (n.type === "file") rings.push(<circle key={"n" + i} cx={n.cx} cy={n.cy} r={n.r} fill="#A6A59D" opacity={settle} />);
      else
        rings.push(
          <circle key={"n" + i} cx={n.cx} cy={n.cy} r={n.r} fill={BG} stroke={n.type === "root" ? "#E8E6E1" : "#C7C6BF"} strokeWidth={n.type === "root" ? 1.75 : 1.5} opacity={settle} />,
        );
    }
  }
  els.push(
    <g key="nodeGlow" filter="url(#glow)">
      {nodeGlow}
    </g>,
  );
  els.push(<g key="rings">{rings}</g>);
  els.push(<g key="lights">{lights}</g>);

  const badgeEls: JSX.Element[] = [];
  for (let i = 0; i < S.badges.length; i++) {
    const b = S.badges[i];
    const op = badgeOp(t - b.t0);
    if (op <= 0) continue;
    const c = b.kind === "pass" ? "#5FA876" : "#D2953F";
    badgeEls.push(<circle key={"gb" + i} cx={b.cx} cy={b.cy} r={b.r + 2} fill={c} opacity={0.4 * op} filter="url(#glow)" />);
    badgeEls.push(<circle key={"b" + i} cx={b.cx} cy={b.cy} r={b.r} fill={c} opacity={op} />);
  }
  els.push(<g key="badges">{badgeEls}</g>);

  const labelEls: JSX.Element[] = [];
  for (let i = 0; i < S.labels.length; i++) {
    const l = S.labels[i];
    const p = clamp01((t - l.t0) / 0.7);
    if (p <= 0) continue;
    const ep = eo(p);
    const fill = l.depth === 0 ? "#E8E6E1" : l.cls === "ghost" ? "#64645C" : l.cls === "file" ? "#8B8B82" : "#A9A9A0";
    labelEls.push(
      <text key={"l" + i} x={l.x} y={l.y + 3 * (1 - ep)} fontSize={l.fs} fill={fill} opacity={ep}>
        {l.text}
      </text>,
    );
  }
  els.push(<g key="labels">{labelEls}</g>);

  return (
    <div style={{ position: "absolute", inset: 0, background: BG }}>
      <svg
        width="100%"
        height="100%"
        viewBox="-63 -169 1920 1080"
        preserveAspectRatio="xMidYMid slice"
        style={{ position: "absolute", inset: 0, display: "block" }}
        fontFamily="'Fragment Mono', ui-monospace, monospace"
        aria-hidden="true"
      >
        <defs>
          <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="2.4" />
          </filter>
          <filter id="glowBig" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="7" />
          </filter>
          <filter id="dustblur" x="-120%" y="-120%" width="340%" height="340%">
            <feGaussianBlur stdDeviation="1.6" />
          </filter>
        </defs>
        <g transform={cam}>{els}</g>
      </svg>
    </div>
  );
}

/** chrome-free, self-clocked: plays once on mount and holds the finished graph */
export function HeroTreeAmbient(): JSX.Element {
  const reduced = prefersReducedMotion();
  const [t, setT] = useState(reduced ? DUR : 0);
  const rafRef = useRef(0);

  useEffect(() => {
    if (reduced) return;
    const t0 = performance.now();
    const loop = (ts: number): void => {
      const el = (ts - t0) / 1000;
      setT(Math.min(el, DUR));
      if (el < DUR) rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [reduced]);

  return <TreeSceneAt t={t} />;
}
