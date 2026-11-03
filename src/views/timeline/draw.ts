// Canvas renderer for the timeline. Everything here runs once per animation frame,
// so it allocates little, culls to the visible window and caches text widths.
import type { Message } from '../../types';
import { toolColor } from '../../lib/theme';
import { fmtToolName } from '../../lib/format';
import { AXIS_H, ROW_H, firstVisibleRow, type AgentRow, type AgentSpan, type Bar, type Layout, type SessionRow } from './model';

export interface Palette {
  bg0: string; bg1: string; bg2: string; bg3: string;
  fg: string; fg2: string; fg3: string; fg4: string;
  line: string; line2: string; line3: string;
  live: string; blocked: string; waiting: string; idle: string; ok: string;
  font: string; mono: string;
}

/** Colors come from tokens.css so the canvas matches the rest of the app */
export function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    bg0: v('--bg-0'), bg1: v('--bg-1'), bg2: v('--bg-2'), bg3: v('--bg-3'),
    fg: v('--fg'), fg2: v('--fg-2'), fg3: v('--fg-3'), fg4: v('--fg-4'),
    line: v('--line'), line2: v('--line-2'), line3: v('--line-3'),
    live: v('--live'), blocked: v('--blocked'), waiting: v('--waiting'), idle: v('--idle'), ok: v('--ok'),
    font: v('--font'), mono: v('--mono'),
  };
}

/** #rrggbb + alpha → rgba(), cached */
const rgbaCache = new Map<string, string>();
export function rgba(hex: string, a: number): string {
  const k = hex + a.toFixed(3);
  let s = rgbaCache.get(k);
  if (!s) {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const n = parseInt(full.slice(0, 6), 16);
    s = `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
    if (rgbaCache.size > 4000) rgbaCache.clear();
    rgbaCache.set(k, s);
  }
  return s;
}

const widthCache = new Map<string, number>();
if (typeof document !== 'undefined') document.fonts?.ready.then(() => widthCache.clear());
function textW(ctx: CanvasRenderingContext2D, text: string): number {
  const k = ctx.font + '|' + text;
  let w = widthCache.get(k);
  if (w == null) {
    w = ctx.measureText(text).width;
    if (widthCache.size > 3000) widthCache.clear();
    widthCache.set(k, w);
  }
  return w;
}

// ───────────── Time axis ─────────────

const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200].map((s) => s * 1000);
const SUBS: Record<number, number> = { 1: 4, 2: 4, 5: 5, 10: 5, 15: 3, 30: 3, 60: 4, 120: 4, 300: 5, 600: 5, 900: 3, 1800: 3, 3600: 4, 7200: 4, 10800: 3, 21600: 6, 43200: 4 };

function pickStep(ppm: number, minPx: number): number {
  for (const s of STEPS) if (s * ppm >= minPx) return s;
  return STEPS[STEPS.length - 1];
}

const fmtHM = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
const fmtHMS = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const fmtDay = new Intl.DateTimeFormat([], { weekday: 'short', day: 'numeric' });
const labelCache = new Map<string, string>();
function tickLabel(t: number, step: number): string {
  const k = `${t}|${step < 60000 ? 's' : 'm'}`;
  let s = labelCache.get(k);
  if (!s) {
    const d = new Date(t);
    if (step >= 3600_000 && d.getHours() === 0 && d.getMinutes() === 0) s = fmtDay.format(d);
    else s = (step < 60000 ? fmtHMS : fmtHM).format(d);
    if (labelCache.size > 500) labelCache.clear();
    labelCache.set(k, s);
  }
  return s;
}

/** Align to local wall-clock multiples of `step` */
function alignLocal(t: number, step: number): number {
  const off = new Date(t).getTimezoneOffset() * 60000;
  return Math.ceil((t - off) / step) * step + off;
}

// ───────────── Concurrency strip ─────────────

export interface Conc { bucket: number; origin: number; counts: Float32Array; at: number; layout: Layout | null }

const BUCKETS = [2, 5, 10, 15, 30, 60, 120, 300, 600].map((s) => s * 1000);
export function bucketFor(span: number): number {
  const target = span / 220;
  for (const b of BUCKETS) if (b >= target) return b;
  return BUCKETS[BUCKETS.length - 1];
}

/** Tool calls closer than this count as one working stretch (Claude thinks between calls) */
const STRETCH_GAP = 20_000;

/**
 * How many sessions were working at once, per time bucket. A session is working from
 * its first tool call to its last one in a stretch, including sub-agents; the value is
 * the average over the bucket, so the strip reads smoothly at any zoom.
 */
export function computeConc(layout: Layout, bucket: number, now: number): Conc {
  let origin = Math.floor(layout.first / bucket) * bucket;
  const maxN = 60_000;
  if ((now - origin) / bucket > maxN) origin = Math.floor((now - maxN * bucket) / bucket) * bucket;
  const counts = new Float32Array(Math.ceil((now - origin) / bucket) + 2);
  const gap = Math.max(STRETCH_GAP, bucket);
  let iv: [number, number][] = [];
  const mark = (s: number, e: number) => {
    let b = Math.max(0, Math.floor((s - origin) / bucket));
    while (b < counts.length) {
      const bs = origin + b * bucket;
      if (bs >= e) break;
      const seg = Math.min(e, bs + bucket) - Math.max(s, bs);
      if (seg > 0) counts[b] += seg / bucket;
      b++;
    }
  };
  const flush = () => {
    if (!iv.length) return;
    iv.sort((a, b) => a[0] - b[0]);
    let [cs, ce] = iv[0];
    for (let i = 1; i < iv.length; i++) {
      const [s, e] = iv[i];
      if (s <= ce + gap) ce = Math.max(ce, e);
      else { mark(cs, ce); cs = s; ce = e; }
    }
    mark(cs, ce);
    iv = [];
  };
  const add = (bars: Bar[]) => { for (const b of bars) iv.push([b.ts, b.end ?? now]); };
  for (const r of layout.rows) {
    if (r.kind === 'session') { flush(); add(r.bars); }
    else if (r.kind === 'agent') {
      for (const sp of r.spans) {
        add(sp.bars);
        iv.push([sp.start, sp.end ?? now]);
      }
    }
  }
  flush();
  return { bucket, origin, counts, at: now, layout };
}

// ───────────── Frame ─────────────

export interface Frame {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  now: number;
  t0: number;
  t1: number;
  ppm: number;
  scrollTop: number;
  layout: Layout;
  pal: Palette;
  hoverKey: string | null;
  hoverId: string | null;
  selectedId: string | null;
  conc: Conc | null;
  stripes: CanvasPattern | null;
}

export function makeStripes(ctx: CanvasRenderingContext2D, color: string, dpr: number): CanvasPattern | null {
  const c = document.createElement('canvas');
  const n = Math.round(8 * dpr);
  c.width = n; c.height = n;
  const g = c.getContext('2d');
  if (!g) return null;
  g.strokeStyle = rgba(color, 0.55);
  g.lineWidth = 2 * dpr;
  g.beginPath();
  g.moveTo(-n, n * 2); g.lineTo(n * 2, -n);
  g.moveTo(-n * 2, n * 2); g.lineTo(n, -n);
  g.moveTo(0, n * 2); g.lineTo(n * 3, -n);
  g.stroke();
  const p = ctx.createPattern(c, 'repeat');
  p?.setTransform(new DOMMatrix().scale(1 / dpr, 1 / dpr));
  return p;
}

const PULSE_MS = 1400;
const pulse = (now: number, phase = 0) => 0.5 + 0.5 * Math.sin(((now + phase) / PULSE_MS) * Math.PI * 2);

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  if (w < 4) ctx.rect(x, y, w, h);
  else ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}

interface RunningBar { b: Bar; x0: number; x1: number; cy: number; half: number }

/** Tool bars for one lane. Returns running bars so their glow can be drawn on top. */
function drawBars(f: Frame, bars: Bar[], cy: number, half: number, labels: boolean, out: RunningBar[]) {
  const { ctx, t0, t1, ppm, now, w, pal } = f;
  let labelQueue: { name: string; x: number }[] | null = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (b.ts > t1) continue;
    const end = Math.min(b.end ?? now, Math.max(now, b.ts));
    if (end < t0) continue;
    const x0 = (b.ts - t0) * ppm;
    let x1 = (end - t0) * ppm;
    if (x1 - x0 < 2) x1 = x0 + 2;
    if (x1 < -2 || x0 > w + 2) continue;
    if (b.end == null) { out.push({ b, x0, x1, cy, half }); continue; }
    const color = toolColor(b.name);
    const hov = b.id === f.hoverId;
    ctx.globalAlpha = hov ? 1 : 0.88;
    ctx.fillStyle = color;
    rr(ctx, x0, cy - half, x1 - x0, half * 2, 3);
    ctx.fill();
    ctx.globalAlpha = 1;
    if (x1 - x0 > 5) {
      // Hairline top highlight gives the bars a little depth
      ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
      ctx.fillRect(x0 + 2, cy - half, x1 - x0 - 4, 1);
    }
    if (b.ok === false) {
      ctx.strokeStyle = pal.blocked;
      ctx.lineWidth = 1.5;
      rr(ctx, x0 - 1, cy - half - 1, x1 - x0 + 2, half * 2 + 2, 4);
      ctx.stroke();
      ctx.fillStyle = pal.blocked;
      ctx.beginPath();
      ctx.arc((x0 + x1) / 2, cy + half + 4.5, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    if (hov) {
      ctx.strokeStyle = pal.fg;
      ctx.lineWidth = 1.25;
      rr(ctx, x0 - 1.5, cy - half - 1.5, x1 - x0 + 3, half * 2 + 3, 4);
      ctx.stroke();
    }
    if (labels && x1 - x0 > 30) {
      const name = fmtToolName(b.name);
      const lx = Math.max(x0, 0) + 5;
      // Only when the label fits and no later call is drawn over it
      const nextX = i + 1 < bars.length ? (bars[i + 1].ts - t0) * ppm : Infinity;
      const tw = textW(ctx, name);
      if (Math.min(x1, nextX) - lx - 4 > tw) (labelQueue ??= []).push({ name, x: lx });
    }
  }
  if (labelQueue) {
    ctx.fillStyle = 'rgba(8, 9, 12, 0.8)';
    for (const l of labelQueue) ctx.fillText(l.name, l.x, cy + 3.5);
  }
}

function drawRunning(f: Frame, list: RunningBar[]) {
  const { ctx, now, pal } = f;
  for (const { b, x0, x1, cy, half } of list) {
    const p = pulse(now, b.ts % 1000);
    if (b.pending) {
      ctx.fillStyle = rgba(pal.blocked, 0.16);
      rr(ctx, x0, cy - half, x1 - x0, half * 2, 3);
      ctx.fill();
      if (f.stripes) { ctx.fillStyle = f.stripes; ctx.fill(); }
      ctx.strokeStyle = rgba(pal.blocked, 0.55 + 0.45 * p);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // "Needs you" tag right of the bar
      ctx.font = `600 10.5px ${pal.font}`;
      const label = 'Needs you';
      const tw = textW(ctx, label);
      // Right of the bar when there is room, otherwise tucked left of it
      const tx = x1 + 10 + tw + 22 < f.w ? x1 + 10 : Math.max(2, x0 - tw - 32);
      ctx.fillStyle = rgba(pal.blocked, 0.16);
      rr(ctx, tx, cy - 9, tw + 22, 18, 9);
      ctx.fill();
      ctx.strokeStyle = rgba(pal.blocked, 0.5);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = pal.blocked;
      ctx.beginPath();
      ctx.arc(tx + 9, cy, 2.6 + p, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = pal.fg;
      ctx.fillText(label, tx + 16, cy + 3.5);
      ctx.font = `600 10px ${pal.font}`;
      continue;
    }
    const color = toolColor(b.name);
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 6 + 8 * p;
    ctx.globalAlpha = 0.55 + 0.4 * p;
    ctx.fillStyle = color;
    rr(ctx, x0, cy - half, x1 - x0, half * 2, 3);
    ctx.fill();
    ctx.restore();
    // Bright leading edge at "now"
    ctx.fillStyle = rgba('#ffffff', 0.55 + 0.35 * p);
    ctx.fillRect(x1 - 2, cy - half + 1, 2, half * 2 - 2);
    if (b.id === f.hoverId) {
      ctx.strokeStyle = pal.fg;
      ctx.lineWidth = 1.25;
      rr(ctx, x0 - 1.5, cy - half - 1.5, x1 - x0 + 3, half * 2 + 3, 4);
      ctx.stroke();
    }
  }
}

/** Session lane geometry, shared with hit testing */
export function sessionGeom(top: number) {
  const capTop = top + 19;
  const capH = 24;
  return { capTop, capH, cy: capTop + capH / 2, half: 7, markY: capTop - 5 };
}
export function agentGeom(top: number) {
  const cy = top + ROW_H.agent / 2;
  return { cy, half: 8, barHalf: 3.5 };
}

function drawMarks(f: Frame, marks: Message[], g: ReturnType<typeof sessionGeom>, hoverId: string | null) {
  const { ctx, t0, t1, ppm, pal } = f;
  for (const m of marks) {
    if (m.ts < t0 - 60000 || m.ts > t1) continue;
    const x = (m.ts - t0) * ppm;
    const hov = hoverId === `m:${m.ts}:${m.role}`;
    if (m.role === 'user') {
      // Turn boundary hairline, then ▲ sitting on the lane
      ctx.fillStyle = rgba(pal.fg, 0.16);
      ctx.fillRect(x - 0.5, g.capTop, 1, g.capH);
      const s = hov ? 5.5 : 4.2;
      ctx.fillStyle = pal.fg;
      ctx.beginPath();
      ctx.moveTo(x, g.markY - s);
      ctx.lineTo(x + s, g.markY + s * 0.75);
      ctx.lineTo(x - s, g.markY + s * 0.75);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.fillStyle = hov ? pal.fg : pal.fg3;
      ctx.beginPath();
      ctx.arc(x, g.markY + 1, hov ? 3.6 : 2.7, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawSession(f: Frame, r: SessionRow, top: number, running: RunningBar[]) {
  const { ctx, t0, ppm, now, w, pal } = f;
  const g = sessionGeom(top);
  // Session lifetime capsule
  const ls = (r.start - t0) * ppm;
  const le = ((r.end ?? now) - t0) * ppm;
  if (le > 0 && ls < w) {
    const x0 = Math.max(-8, ls), x1 = Math.min(w + 8, le);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.028)';
    rr(ctx, x0, g.capTop, Math.max(2, x1 - x0), g.capH, 7);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.045)';
    ctx.lineWidth = 1;
    ctx.stroke();
    if (r.end != null && le < w) {
      // Closed: a clean end cap
      ctx.fillStyle = pal.fg4;
      ctx.fillRect(le - 1, g.capTop + 5, 2, g.capH - 10);
    }
  }
  drawMarks(f, r.marks, g, f.hoverId);
  ctx.font = `600 10px ${pal.font}`;
  drawBars(f, r.bars, g.cy, g.half, true, running);
}

function drawAgent(f: Frame, r: AgentRow, top: number, running: RunningBar[]) {
  const g = agentGeom(top);
  // The session lane this agent forked from sits above its packed lanes
  const sg = sessionGeom(top - r.lane * ROW_H.agent - ROW_H.session);
  for (let k = 0; k < r.spans.length; k++) {
    const next = r.spans[k + 1];
    drawSpan(f, r.spans[k], g, sg, running, next ? (next.start - f.t0) * f.ppm : Infinity);
  }
}

function drawSpan(f: Frame, sp: AgentSpan, g: ReturnType<typeof agentGeom>, sg: ReturnType<typeof sessionGeom>, running: RunningBar[], nextX: number) {
  const { ctx, t0, t1, ppm, now, w, pal } = f;
  if (sp.start > t1) return;
  const end = sp.end ?? now;
  if (end < t0) return;
  const working = sp.end == null;
  const hov = f.hoverId === `ag:${sp.agent.id}`;
  const x0 = (sp.start - t0) * ppm;
  let x1 = (end - t0) * ppm;
  // Short finished agents shrink to a slim tick so zoomed-out lanes stay calm
  const minW = working || hov ? 8 : 3;
  if (x1 - x0 < minW) x1 = x0 + minW;
  if (x1 < 0 || x0 > w) return;
  const p = working ? pulse(now, 300) : 0;
  const failed = sp.agent.status === 'error';
  const tone = failed ? pal.blocked : working ? pal.live : pal.fg3;
  // Finished agents step back: a slimmer, quieter capsule
  const half = working || hov ? g.half : g.half - 2;

  // Fork line from the session lane down to the agent
  if (x0 >= -1 && x0 <= w + 1) {
    ctx.strokeStyle = rgba(tone, working ? 0.55 : 0.22);
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(x0 + 0.5, sg.capTop + sg.capH);
    ctx.lineTo(x0 + 0.5, g.cy - half);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = rgba(tone, working ? 0.9 : 0.45);
    ctx.beginPath();
    ctx.arc(x0 + 0.5, sg.capTop + sg.capH, working ? 2.2 : 1.6, 0, Math.PI * 2);
    ctx.fill();
  }

  const cx0 = Math.max(x0, -10), cx1 = Math.min(x1, w + 10);
  ctx.fillStyle = rgba(tone, working ? 0.1 + 0.05 * p : hov ? 0.12 : 0.045);
  rr(ctx, cx0, g.cy - half, cx1 - cx0, half * 2, half);
  ctx.fill();
  ctx.strokeStyle = rgba(tone, working ? 0.45 + 0.4 * p : hov ? 0.6 : 0.2);
  ctx.lineWidth = 1;
  ctx.stroke();

  drawBars(f, sp.bars, g.cy, g.barHalf, false, running);

  // Label: inside on a backing pill when it fits, else just after the span if the lane is free
  ctx.font = `500 10px ${pal.mono}`;
  const label = sp.agent.agentType;
  const tw = textW(ctx, label);
  const lx = Math.max(x0, 0) + 4;
  if (x1 - lx > tw + 12) {
    if (sp.bars.length) {
      ctx.fillStyle = rgba(pal.bg1, 0.92);
      rr(ctx, lx, g.cy - 6, tw + 10, 12, 6);
      ctx.fill();
    }
    ctx.fillStyle = working ? pal.live : failed ? pal.blocked : pal.fg3;
    ctx.fillText(label, lx + 5, g.cy + 3.5);
  } else if ((working || hov || failed) && x1 + tw + 12 < Math.min(w, nextX)) {
    // Outside labels only for agents that matter right now
    ctx.fillStyle = working ? pal.live : failed ? pal.blocked : pal.fg2;
    ctx.fillText(label, x1 + 6, g.cy + 3.5);
  }
}

function drawAxis(f: Frame) {
  const { ctx, w, t0, t1, ppm, now, pal } = f;
  const step = pickStep(ppm, 96);
  const sub = step / (SUBS[step / 1000] ?? 4);
  const nowX = (now - t0) * ppm;

  // Minor ticks
  ctx.fillStyle = 'rgba(255, 255, 255, 0.10)';
  for (let t = alignLocal(t0, sub); t <= t1; t += sub) {
    const x = Math.round((t - t0) * ppm) + 0.5;
    ctx.fillRect(x - 0.5, AXIS_H - 5, 1, 4);
  }
  // Major ticks and labels
  ctx.font = `500 10.5px ${pal.mono}`;
  ctx.textAlign = 'center';
  for (let t = alignLocal(t0, step); t <= t1; t += step) {
    const x = Math.round((t - t0) * ppm) + 0.5;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.fillRect(x - 0.5, AXIS_H - 8, 1, 7);
    if (Math.abs(x - nowX) < 46) continue;
    const label = tickLabel(t, step);
    const tw = textW(ctx, label);
    if (x - tw / 2 < 2 || x + tw / 2 > w - 2) continue;
    ctx.fillStyle = pal.fg3;
    ctx.fillText(label, x, AXIS_H - 15);
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = pal.line2;
  ctx.fillRect(0, AXIS_H - 1, w, 1);
  return step;
}

function drawGrid(f: Frame, step: number) {
  const { ctx, t0, t1, ppm, h } = f;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.032)';
  for (let t = alignLocal(t0, step); t <= t1; t += step) {
    const x = Math.round((t - t0) * ppm);
    ctx.fillRect(x, AXIS_H, 1, h - AXIS_H);
  }
}

export function concPeak(f: Pick<Frame, 'conc' | 't0' | 't1'>): number {
  const c = f.conc;
  if (!c) return 0;
  const b0 = Math.max(0, Math.floor((f.t0 - c.origin) / c.bucket));
  const b1 = Math.min(c.counts.length - 1, Math.ceil((f.t1 - c.origin) / c.bucket));
  let peak = 0;
  for (let b = b0; b <= b1; b++) if (c.counts[b] > peak) peak = c.counts[b];
  return peak;
}

const CONC_TOP = 10;
const CONC_BOTTOM = 34;

function drawConc(f: Frame, peak: number) {
  const { ctx, t0, t1, ppm, pal, w } = f;
  const c = f.conc;
  const top = CONC_TOP, bottom = CONC_BOTTOM;
  // Faint guides at whole-session steps
  const scale = Math.max(Math.ceil(peak), 3);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.035)';
  for (let n = 1; n < scale; n++) {
    const y = Math.round(bottom - (n / scale) * (bottom - top));
    if (scale <= 8 || n % 2 === 0) ctx.fillRect(0, y, w, 1);
  }
  ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
  ctx.fillRect(0, bottom, w, 1);
  if (!c || peak <= 0) return;
  const yOf = (n: number) => bottom - (n / scale) * (bottom - top);
  const b0 = Math.max(0, Math.floor((t0 - c.origin) / c.bucket) - 2);
  const b1 = Math.min(c.counts.length - 1, Math.ceil((t1 - c.origin) / c.bucket) + 2);
  const bw = c.bucket * ppm;
  // Light 3-tap smoothing, then a curve through bucket centers
  const v = (b: number) => (c.counts[Math.max(0, b - 1)] + 2 * c.counts[b] + c.counts[Math.min(c.counts.length - 1, b + 1)]) / 4;
  const xOf = (b: number) => (c.origin + (b + 0.5) * c.bucket - t0) * ppm;
  const trace = (p: Path2D, closed: boolean) => {
    let px = xOf(b0), py = yOf(v(b0));
    if (closed) { p.moveTo(px, bottom); p.lineTo(px, py); } else p.moveTo(px, py);
    for (let b = b0 + 1; b <= b1; b++) {
      const x = xOf(b), y = yOf(v(b));
      if (bw > 3) p.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
      else p.lineTo(x, y);
      px = x; py = y;
    }
    p.lineTo(px, py);
    if (closed) { p.lineTo(px, bottom); p.closePath(); }
  };
  const area = new Path2D();
  trace(area, true);
  const edge = new Path2D();
  trace(edge, false);
  const grad = ctx.createLinearGradient(0, top, 0, bottom);
  grad.addColorStop(0, rgba(pal.live, 0.36));
  grad.addColorStop(1, rgba(pal.live, 0.02));
  ctx.fillStyle = grad;
  ctx.fill(area);
  ctx.strokeStyle = rgba(pal.live, 0.85);
  ctx.lineWidth = 1.25;
  ctx.lineJoin = 'round';
  ctx.stroke(edge);
}

function drawNow(f: Frame) {
  const { ctx, w, h, t0, now, ppm, pal } = f;
  const x = (now - t0) * ppm;
  if (x < -20 || x > w + 20) return;
  // Not-yet-happened region
  if (x < w) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.16)';
    ctx.fillRect(x, AXIS_H, w - x, h - AXIS_H);
  }
  const glow = ctx.createLinearGradient(x - 14, 0, x + 14, 0);
  glow.addColorStop(0, rgba(pal.live, 0));
  glow.addColorStop(0.5, rgba(pal.live, 0.16));
  glow.addColorStop(1, rgba(pal.live, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(x - 14, 6, 28, h - 6);
  ctx.fillStyle = pal.live;
  ctx.fillRect(x - 0.75, 6, 1.5, h - 6);
  // "Now" pill on the axis
  ctx.font = `650 10.5px ${pal.font}`;
  const label = 'Now';
  const tw = textW(ctx, label);
  const pw = tw + 16;
  const px = Math.min(w - pw - 2, Math.max(2, x - pw / 2));
  ctx.save();
  ctx.shadowColor = rgba(pal.live, 0.6);
  ctx.shadowBlur = 12;
  ctx.fillStyle = pal.live;
  rr(ctx, px, AXIS_H - 27, pw, 18, 9);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#1a0d05';
  ctx.fillText(label, px + 8, AXIS_H - 14.5);
}

export function drawFrame(f: Frame): number {
  const { ctx, w, h, layout, scrollTop, pal } = f;
  ctx.clearRect(0, 0, w, h);
  const peak = concPeak(f);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, AXIS_H, w, h - AXIS_H);
  ctx.clip();

  // Axis grid behind everything
  const step = pickStep(f.ppm, 96);
  drawGrid(f, step);

  const rows = layout.rows;
  const viewH = h - AXIS_H;
  const running: RunningBar[] = [];
  for (let i = firstVisibleRow(rows, scrollTop); i < rows.length; i++) {
    const r = rows[i];
    const top = AXIS_H + r.y - scrollTop;
    if (top > AXIS_H + viewH) break;
    const sid = r.kind === 'project' ? null : r.session.id;
    if (r.kind !== 'project' && sid === f.selectedId) {
      ctx.fillStyle = rgba(pal.live, 0.05);
      ctx.fillRect(0, top, w, r.h);
    } else if (r.key === f.hoverKey) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.022)';
      ctx.fillRect(0, top, w, r.h);
    }
    if (r.kind === 'project') {
      if (r.y > 0) {
        ctx.fillStyle = pal.line;
        ctx.fillRect(0, top + 4, w, 1);
      }
    } else if (r.kind === 'session') drawSession(f, r, top, running);
    else drawAgent(f, r, top, running);
  }
  drawRunning(f, running);

  // Soft fade where bars slide under the gutter
  const fade = ctx.createLinearGradient(0, 0, 18, 0);
  fade.addColorStop(0, rgba(pal.bg0, 0.95));
  fade.addColorStop(1, rgba(pal.bg0, 0));
  ctx.fillStyle = fade;
  ctx.fillRect(0, AXIS_H, 18, h - AXIS_H);
  ctx.restore();

  drawConc(f, peak);
  drawAxis(f);
  drawNow(f);
  return peak;
}

// ───────────── Hit testing ─────────────

export type Hit =
  | { kind: 'bar'; rowKey: string; sessionId: string; bar: Bar; agent: AgentSpan | null; x: number; y: number }
  | { kind: 'mark'; rowKey: string; sessionId: string; mark: Message; x: number; y: number }
  | { kind: 'agent'; rowKey: string; sessionId: string; span: AgentSpan; x: number; y: number }
  | { kind: 'row'; rowKey: string; sessionId: string | null };

function hitBars(bars: Bar[], x: number, f: Pick<Frame, 't0' | 'ppm' | 'now'>): Bar | null {
  let best: Bar | null = null;
  let bestD = Infinity;
  for (const b of bars) {
    const x0 = (b.ts - f.t0) * f.ppm;
    let x1 = (Math.min(b.end ?? f.now, Math.max(f.now, b.ts)) - f.t0) * f.ppm;
    if (x1 - x0 < 2) x1 = x0 + 2;
    if (x < x0 - 3 || x > x1 + 3) continue;
    const d = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
    // Prefer the bar under the cursor, then the shortest (on top visually)
    const score = d * 1000 + (x1 - x0) * 0.001;
    if (score < bestD) { bestD = score; best = b; }
  }
  return best;
}

export function hitTest(f: Pick<Frame, 't0' | 'ppm' | 'now' | 'layout' | 'scrollTop'>, x: number, y: number): Hit | null {
  if (y < AXIS_H) return null;
  const cy = y - AXIS_H + f.scrollTop;
  const rows = f.layout.rows;
  const i = firstVisibleRow(rows, cy);
  const r = rows[i];
  if (!r || cy < r.y) return null;
  const top = AXIS_H + r.y - f.scrollTop;
  if (r.kind === 'project') return { kind: 'row', rowKey: r.key, sessionId: null };
  if (r.kind === 'session') {
    const g = sessionGeom(top);
    if (y < g.capTop + 1) {
      let best: Message | null = null, bd = 7;
      for (const m of r.marks) {
        const d = Math.abs((m.ts - f.t0) * f.ppm - x);
        if (d < bd) { bd = d; best = m; }
      }
      if (best) return { kind: 'mark', rowKey: r.key, sessionId: r.session.id, mark: best, x: (best.ts - f.t0) * f.ppm, y: g.markY };
    }
    if (Math.abs(y - g.cy) <= g.capH / 2 + 3) {
      const b = hitBars(r.bars, x, f);
      if (b) return { kind: 'bar', rowKey: r.key, sessionId: r.session.id, bar: b, agent: null, x, y: g.cy - g.half };
    }
    return { kind: 'row', rowKey: r.key, sessionId: r.session.id };
  }
  const g = agentGeom(top);
  if (Math.abs(y - g.cy) <= g.half + 3) {
    for (let k = r.spans.length - 1; k >= 0; k--) {
      const sp = r.spans[k];
      const x0 = (sp.start - f.t0) * f.ppm;
      let x1 = ((sp.end ?? f.now) - f.t0) * f.ppm;
      if (x1 - x0 < 8) x1 = x0 + 8;
      if (x < x0 - 2 || x > x1 + 2) continue;
      const b = hitBars(sp.bars, x, f);
      if (b && Math.abs(y - g.cy) <= g.barHalf + 3) return { kind: 'bar', rowKey: r.key, sessionId: r.session.id, bar: b, agent: sp, x, y: g.cy - g.half };
      return { kind: 'agent', rowKey: r.key, sessionId: r.session.id, span: sp, x, y: g.cy - g.half };
    }
  }
  return { kind: 'row', rowKey: r.key, sessionId: r.session.id };
}
