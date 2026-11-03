// Force-directed graph engine. Owns the d3 simulation, the camera and the canvas;
// React only hands it new specs and listens for hover and click.
import {
  forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY,
  type ForceLink, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum,
} from 'd3-force';
import type { Agent, Session } from '../../types';
import { STATUS, hash01, projectColor, toolColor } from '../../lib/theme';
import { basename, modelInfo, sessionLabel } from '../../lib/format';
import { fileId, fileKey, sessionId as sid, type FileInfo, type NodeKind, type Spec } from './model';
import { clamp, easeOut, easeOutBack, fitText, readPalette, rgba, textW, type Palette } from './paint';

export interface GNode extends SimulationNodeDatum {
  id: string;
  kind: NodeKind;
  project: string;
  color: string;
  born: number;
  session?: Session;
  agent?: Agent;
  file?: FileInfo;
  /** Agents: the session node they orbit */
  owner?: GNode;
  collide: number;
  // Screen geometry from the last frame (hit testing, labels)
  sx: number;
  sy: number;
  sr: number;
  sw: number;
  sh: number;
}

export interface GLink extends SimulationLinkDatum<GNode> {
  id: string;
  kind: 'ps' | 'sf';
  source: GNode;
  target: GNode;
  write: boolean;
  lastTs: number;
}

export interface Target {
  id: string;
  kind: NodeKind;
  project: string;
  sessionId: string | null;
  agentId: string | null;
  fileKey: string | null;
  /** Screen position of the node's top edge, relative to the canvas */
  x: number;
  y: number;
}

export interface EngineEvents {
  hover(t: Target | null): void;
  click(t: Target | null): void;
}

interface Particle { from: GNode; to: GNode; born: number; color: string }
interface Ping { node: GNode; born: number; color: string }

const PAD_TOP = 72;
const PAD_BOTTOM = 56;
const PAD_X = 48;
const MIN_K = 0.2;
const MAX_K = 4;
const RECENCY_MS = 20 * 60_000;
const PARTICLE_MS = 850;
const PING_MS = 800;

function toTarget(n: GNode): Target {
  return {
    id: n.id, kind: n.kind, project: n.project,
    sessionId: n.session?.id ?? null, agentId: n.agent?.id ?? null, fileKey: n.file?.key ?? null,
    x: n.sx, y: n.sy - (n.kind === 'project' ? n.sh / 2 : n.sr),
  };
}

export class GraphEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private pal: Palette;
  private ev: EngineEvents;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private raf = 0;
  private ro: ResizeObserver;

  private nodes = new Map<string, GNode>();
  private simNodes: GNode[] = [];
  private agentsBy = new Map<string, GNode[]>();
  private links: GLink[] = [];
  private adj = new Map<string, Set<string>>();
  private sig = '';
  private sim: Simulation<GNode, GLink>;
  private linkForce: ForceLink<GNode, GLink>;

  private k = 1;
  private tx = 0;
  private ty = 0;
  private cam: { k: number; tx: number; ty: number } | null = null;
  private autoFit = true;
  private frameN = 0;

  private hoverId: string | null = null;
  private pinnedId: string | null = null;
  private selectedSession: string | null = null;
  private flash: { id: string; born: number } | null = null;
  private particles: Particle[] = [];
  private pings: Ping[] = [];
  private seenTool = new Map<string, string>();
  private fitCache = new Map<string, string>();

  private drag: { node: GNode | null; x: number; y: number; tx: number; ty: number; moved: boolean } | null = null;

  constructor(canvas: HTMLCanvasElement, ev: EngineEvents) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is not available');
    this.ctx = ctx;
    this.ev = ev;
    this.pal = readPalette();

    this.linkForce = forceLink<GNode, GLink>([])
      .distance((l) => (l.kind === 'ps' ? 125 : l.target.file?.shared ? 96 : 72))
      .strength((l) => (l.kind === 'ps' ? 0.6 : l.target.file?.shared ? 0.16 : 0.3));
    this.sim = forceSimulation<GNode, GLink>([])
      .force('link', this.linkForce)
      .force('charge', forceManyBody<GNode>()
        .strength((d) => (d.kind === 'project' ? -1100 : d.kind === 'session' ? -520 : -95))
        .distanceMax(520).theta(0.9))
      .force('collide', forceCollide<GNode>((d) => d.collide).strength(0.85).iterations(2))
      .force('x', forceX<GNode>(0).strength((d) => (d.kind === 'project' ? 0.08 : 0.03)))
      .force('y', forceY<GNode>(0).strength((d) => (d.kind === 'project' ? 0.11 : 0.042)))
      .velocityDecay(0.4)
      .alphaDecay(0.024)
      .stop();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement ?? canvas);
    this.resize();

    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('pointerleave', this.onLeave);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('dblclick', this.onDbl);
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.sim.stop();
    const c = this.canvas;
    c.removeEventListener('pointerdown', this.onDown);
    c.removeEventListener('pointermove', this.onMove);
    c.removeEventListener('pointerup', this.onUp);
    c.removeEventListener('pointercancel', this.onUp);
    c.removeEventListener('pointerleave', this.onLeave);
    c.removeEventListener('wheel', this.onWheel);
    c.removeEventListener('dblclick', this.onDbl);
  }

  // ───────────── Data ─────────────

  update(spec: Spec, sessions: Session[]) {
    const now = performance.now();
    const first = this.nodes.size === 0;
    const next = new Map<string, GNode>();
    let order = 0;
    for (const ns of spec.nodes) {
      let n = this.nodes.get(ns.id);
      if (!n) {
        const parent = ns.parent ? next.get(ns.parent) ?? null : null;
        n = this.spawn(ns.id, ns.kind, ns.project, parent, first ? now + Math.min(700, order++ * 9) : now);
      }
      n.session = ns.session;
      n.agent = ns.agent;
      n.file = ns.file;
      next.set(ns.id, n);
    }
    this.nodes = next;

    // Agents orbit their session instead of joining the simulation
    this.agentsBy.clear();
    const simNodes: GNode[] = [];
    for (const n of next.values()) {
      if (n.kind === 'agent') {
        const owner = n.session ? next.get(sid(n.session.id)) : undefined;
        n.owner = owner;
        if (owner) {
          const list = this.agentsBy.get(owner.id);
          if (list) list.push(n);
          else this.agentsBy.set(owner.id, [n]);
        }
      } else simNodes.push(n);
    }
    for (const n of simNodes) {
      if (n.kind === 'session') n.collide = this.agentsBy.has(n.id) ? 42 : 30;
      else if (n.kind === 'file') n.collide = n.file?.conflict ? 17 : 13;
      else n.collide = 34 + Math.min(60, n.project.length * 3.4);
    }

    const links: GLink[] = [];
    const seen = new Set<string>();
    for (const l of spec.links) {
      const s = next.get(l.source), t = next.get(l.target);
      if (!s || !t || seen.has(l.id)) continue;
      seen.add(l.id);
      links.push({ id: l.id, kind: l.kind, source: s, target: t, write: l.write, lastTs: l.lastTs });
    }
    this.links = links;

    this.adj.clear();
    const link = (a: string, b: string) => {
      let sa = this.adj.get(a);
      if (!sa) this.adj.set(a, (sa = new Set()));
      sa.add(b);
      let sb = this.adj.get(b);
      if (!sb) this.adj.set(b, (sb = new Set()));
      sb.add(a);
    };
    for (const l of links) link(l.source.id, l.target.id);
    for (const [owner, list] of this.agentsBy) for (const a of list) link(owner, a.id);

    // d3 caches radii and link distances when forces initialize, so anything they read is in the signature
    const sig = simNodes.map((n) => `${n.id}:${n.collide}`).join(',') + '|' + links.map((l) => (l.target.file?.shared ? `${l.id}*` : l.id)).join(',');
    if (sig !== this.sig) {
      this.sig = sig;
      this.simNodes = simNodes;
      this.sim.nodes(simNodes);
      this.linkForce.links(links);
      if (first) {
        this.sim.alpha(1);
        for (let i = 0; i < 240; i++) this.sim.tick();
        this.fit(false);
      } else {
        this.sim.alpha(Math.max(this.sim.alpha(), 0.3));
      }
    }
    if (this.hoverId && !next.has(this.hoverId)) this.hoverId = null;
    this.trackTools(sessions, first);
  }

  private spawn(id: string, kind: NodeKind, project: string, parent: GNode | null, born: number): GNode {
    const a = hash01(id) * Math.PI * 2;
    let x = 0, y = 0;
    if (parent && parent.x != null && parent.y != null) {
      const d = kind === 'session' ? 70 : kind === 'file' ? 36 : 20;
      x = parent.x + Math.cos(a) * d;
      y = parent.y + Math.sin(a) * d;
    } else if (kind === 'project') {
      // New hubs land on the rim of what is already there
      let r = 0;
      for (const n of this.simNodes) if (n.x != null && n.y != null) r = Math.max(r, Math.hypot(n.x, n.y));
      const rr = this.simNodes.length ? r + 90 : 40 + hash01(id + 'r') * 160;
      x = Math.cos(a) * rr;
      y = Math.sin(a) * rr;
    }
    return {
      id, kind, project, color: projectColor(project), born, x, y, collide: 10,
      sx: 0, sy: 0, sr: 0, sw: 0, sh: 0,
    };
  }

  /** New tool calls send a particle to the file they touched, or ping the session */
  private trackTools(sessions: Session[], first: boolean) {
    const now = performance.now();
    for (const s of sessions) {
      const last = this.seenTool.get(s.id);
      const tools = s.tools;
      if (!tools.length) continue;
      this.seenTool.set(s.id, tools[tools.length - 1].id);
      if (first || last == null || last === tools[tools.length - 1].id) continue;
      const node = this.nodes.get(sid(s.id));
      if (!node) continue;
      let i = tools.length - 1;
      let n = 0;
      while (i >= 0 && tools[i].id !== last && n < 4) {
        const t = tools[i];
        const target = t.file ? this.nodes.get(fileId(fileKey(t.file))) : undefined;
        const color = toolColor(t.name);
        if (target) this.particles.push({ from: node, to: target, born: now + n * 120, color });
        else this.pings.push({ node, born: now + n * 120, color });
        i--;
        n++;
      }
    }
    if (this.particles.length > 120) this.particles.splice(0, this.particles.length - 120);
    if (this.pings.length > 80) this.pings.splice(0, this.pings.length - 80);
  }

  // ───────────── Camera ─────────────

  private resize() {
    const host = this.canvas.parentElement ?? this.canvas;
    const nw = host.clientWidth, nh = host.clientHeight;
    const nd = Math.min(2, window.devicePixelRatio || 1);
    if (nw === this.w && nh === this.h && nd === this.dpr) return;
    // Keep the world point at the center where it was
    if (this.w && this.h) {
      this.tx += (nw - this.w) / 2;
      this.ty += (nh - this.h) / 2;
      if (this.cam) { this.cam.tx += (nw - this.w) / 2; this.cam.ty += (nh - this.h) / 2; }
    }
    this.w = nw; this.h = nh; this.dpr = nd;
    this.canvas.width = Math.max(1, Math.round(nw * nd));
    this.canvas.height = Math.max(1, Math.round(nh * nd));
    this.canvas.style.width = `${nw}px`;
    this.canvas.style.height = `${nh}px`;
    if (this.autoFit && this.simNodes.length) this.fit(false);
    this.draw();
  }

  private fitTarget(nodes: GNode[], maxK = 1.5) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
      if (n.x == null || n.y == null) continue;
      const r = n.kind === 'session' ? 70 : n.collide + 10;
      x0 = Math.min(x0, n.x - r); x1 = Math.max(x1, n.x + r);
      y0 = Math.min(y0, n.y - r); y1 = Math.max(y1, n.y + r + (n.kind === 'session' ? 20 : 0));
    }
    if (!Number.isFinite(x0)) return null;
    const aw = Math.max(100, this.w - PAD_X * 2), ah = Math.max(100, this.h - PAD_TOP - PAD_BOTTOM);
    const k = clamp(Math.min(aw / (x1 - x0), ah / (y1 - y0)), MIN_K, maxK);
    return { k, tx: this.w / 2 - ((x0 + x1) / 2) * k, ty: PAD_TOP + ah / 2 - ((y0 + y1) / 2) * k };
  }

  fit(animate = true) {
    const t = this.fitTarget(this.simNodes);
    if (!t) return;
    this.autoFit = true;
    if (animate) this.cam = t;
    else { this.k = t.k; this.tx = t.tx; this.ty = t.ty; this.cam = null; }
  }

  /** Center on a node and keep its neighborhood highlighted */
  focus(id: string | null) {
    this.pinnedId = id;
    if (!id) return;
    const n = this.nodes.get(id);
    if (!n || n.x == null || n.y == null) return;
    const nb = [n, ...[...(this.adj.get(id) ?? [])].map((x) => this.nodes.get(x)).filter((x): x is GNode => !!x && x.kind !== 'agent')];
    const t = this.fitTarget(nb, 1.8);
    const k = t ? Math.max(Math.min(t.k, 1.8), Math.min(1.25, this.k * 1.2)) : Math.max(this.k, 1.4);
    this.autoFit = false;
    this.cam = { k, tx: this.w / 2 - n.x * k, ty: PAD_TOP + (this.h - PAD_TOP - PAD_BOTTOM) / 2 - n.y * k };
    this.flash = { id, born: performance.now() };
  }

  setPinned(id: string | null) { this.pinnedId = id; }
  setSelectedSession(id: string | null) { this.selectedSession = id ? sid(id) : null; }

  zoomBy(f: number) {
    this.zoomAt(this.w / 2, this.h / 2, f);
  }

  private zoomAt(x: number, y: number, f: number) {
    const k = clamp((this.cam?.k ?? this.k) * f, MIN_K, MAX_K);
    const base = this.cam ?? { k: this.k, tx: this.tx, ty: this.ty };
    const wx = (x - base.tx) / base.k, wy = (y - base.ty) / base.k;
    this.cam = { k, tx: x - wx * k, ty: y - wy * k };
    this.autoFit = false;
  }

  private stepCamera() {
    if (this.autoFit && this.frameN % 24 === 0 && this.sim.alpha() > 0.02) {
      const t = this.fitTarget(this.simNodes);
      if (t) this.cam = t;
    }
    const c = this.cam;
    if (!c) return;
    const a = 0.16;
    this.k += (c.k - this.k) * a;
    this.tx += (c.tx - this.tx) * a;
    this.ty += (c.ty - this.ty) * a;
    if (Math.abs(c.k - this.k) < 0.0005 && Math.abs(c.tx - this.tx) < 0.3 && Math.abs(c.ty - this.ty) < 0.3) {
      this.k = c.k; this.tx = c.tx; this.ty = c.ty;
      this.cam = null;
    }
  }

  // ───────────── Interaction ─────────────

  private local(e: { clientX: number; clientY: number }) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private hit(x: number, y: number): GNode | null {
    let best: GNode | null = null;
    let bestD = Infinity;
    const consider = (n: GNode, d: number) => { if (d < bestD) { bestD = d; best = n; } };
    for (const n of this.nodes.values()) {
      if (n.kind === 'project') {
        if (Math.abs(x - n.sx) <= n.sw / 2 + 2 && Math.abs(y - n.sy) <= n.sh / 2 + 2) consider(n, -1);
      } else if (n.kind === 'file') {
        const d = Math.max(Math.abs(x - n.sx), Math.abs(y - n.sy));
        if (d <= n.sr + 4) consider(n, d + 2);
      } else {
        const d = Math.hypot(x - n.sx, y - n.sy);
        if (d <= n.sr + (n.kind === 'agent' ? 5 : 4)) consider(n, n.kind === 'agent' ? d - 3 : d);
      }
    }
    return best;
  }

  private setHover(n: GNode | null) {
    const id = n?.id ?? null;
    if (id === this.hoverId) return;
    this.hoverId = id;
    this.canvas.style.cursor = n ? 'pointer' : 'grab';
    this.ev.hover(n ? toTarget(n) : null);
  }

  private onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const p = this.local(e);
    const n = this.hit(p.x, p.y);
    // Agents ride their session's orbit, so pressing one pans instead of dragging it
    this.drag = { node: n && n.kind !== 'agent' ? n : null, x: p.x, y: p.y, tx: this.tx, ty: this.ty, moved: false };
    this.canvas.setPointerCapture(e.pointerId);
  };

  private onMove = (e: PointerEvent) => {
    const p = this.local(e);
    const d = this.drag;
    if (!d) {
      this.setHover(this.hit(p.x, p.y));
      return;
    }
    if (!d.moved && Math.hypot(p.x - d.x, p.y - d.y) > 4) {
      d.moved = true;
      this.setHover(null);
      this.canvas.style.cursor = 'grabbing';
      if (d.node) this.sim.alphaTarget(0.22);
    }
    if (!d.moved) return;
    if (d.node) {
      d.node.fx = (p.x - this.tx) / this.k;
      d.node.fy = (p.y - this.ty) / this.k;
    } else {
      this.cam = null;
      this.autoFit = false;
      this.tx = d.tx + (p.x - d.x);
      this.ty = d.ty + (p.y - d.y);
    }
  };

  private onUp = (e: PointerEvent) => {
    const d = this.drag;
    this.drag = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (!d) return;
    if (d.node) {
      d.node.fx = null;
      d.node.fy = null;
      this.sim.alphaTarget(0);
    }
    const p = this.local(e);
    if (!d.moved) {
      const n = this.hit(p.x, p.y);
      this.ev.click(n ? toTarget(n) : null);
    }
    this.setHover(this.hit(p.x, p.y));
  };

  private onLeave = () => { if (!this.drag) this.setHover(null); };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = this.local(e);
    this.zoomAt(p.x, p.y, Math.exp(-clamp(e.deltaY, -150, 150) * 0.0016));
    this.setHover(null);
  };

  private onDbl = () => this.fit(true);

  // ───────────── Render ─────────────

  private frame = () => {
    this.raf = requestAnimationFrame(this.frame);
    this.frameN++;
    if (this.sim.alpha() > this.sim.alphaMin() || (this.drag?.node && this.drag.moved)) this.sim.tick();
    this.stepCamera();
    this.draw();
  };

  private draw() {
    const { ctx, w, h, k, tx, ty, pal } = this;
    if (w < 2 || h < 2) return;
    const now = performance.now();
    const wall = Date.now();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const sz = clamp(Math.sqrt(k), 0.72, 1.45);

    // Screen positions
    for (const n of this.simNodes) {
      n.sx = (n.x ?? 0) * k + tx;
      n.sy = (n.y ?? 0) * k + ty;
      n.sr = n.kind === 'session' ? 13.5 * sz : n.kind === 'file' ? (n.file?.conflict ? 4.6 : 3.6) * sz : 0;
    }
    for (const [ownerId, list] of this.agentsBy) {
      const o = this.nodes.get(ownerId);
      if (!o) continue;
      const anyWorking = list.some((a) => a.agent?.status === 'working');
      const base = hash01(ownerId) * Math.PI * 2 + (anyWorking ? (now / 1000) * 0.32 : 0);
      const orbit = o.sr + 9 + 5 * sz;
      list.forEach((a, i) => {
        const ang = base + (i / list.length) * Math.PI * 2;
        a.sx = o.sx + Math.cos(ang) * orbit;
        a.sy = o.sy + Math.sin(ang) * orbit;
        a.sr = 3.6 * sz;
      });
    }

    // A pinned node that has since disappeared must not dim everything
    const pinned = this.pinnedId && this.nodes.has(this.pinnedId) ? this.pinnedId : null;
    const focus = this.hoverId ?? pinned;
    const nb = focus ? this.adj.get(focus) : null;
    const lit = (id: string) => !focus || id === focus || !!nb?.has(id);
    const DIM = 0.13;

    this.drawBackdrop(sz);

    // ── Edges
    ctx.lineCap = 'round';
    for (const l of this.links) {
      const a = l.source, b = l.target;
      const on = a.id === focus || b.id === focus;
      const appear = Math.min(this.appear(a, now), this.appear(b, now));
      if (appear <= 0) continue;
      let alpha: number;
      if (l.kind === 'ps') {
        ctx.strokeStyle = a.color;
        ctx.lineWidth = 1.4;
        ctx.setLineDash([]);
        alpha = 0.32;
      } else {
        const recency = Math.exp(-(wall - l.lastTs) / RECENCY_MS);
        ctx.strokeStyle = l.write ? pal.edit : pal.read;
        ctx.lineWidth = l.write ? 1.3 : 1;
        ctx.setLineDash(l.write ? [] : [2.5, 3.5]);
        alpha = 0.1 + 0.5 * recency;
        if (b.file?.conflict) alpha = Math.max(alpha, 0.35);
      }
      if (focus) alpha = on ? Math.min(1, alpha + 0.4) : alpha * DIM;
      ctx.globalAlpha = alpha * appear;
      this.curve(a.sx, a.sy, b.sx, b.sy, l.kind === 'ps' ? 0.1 : 0.06);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // ── Particles along edges
    this.particles = this.particles.filter((p) => now - p.born < PARTICLE_MS);
    for (const p of this.particles) {
      const t = (now - p.born) / PARTICLE_MS;
      if (t < 0) continue;
      const e = easeOut(t);
      const pt = this.curvePoint(p.from.sx, p.from.sy, p.to.sx, p.to.sy, 0.06, e);
      ctx.save();
      ctx.globalAlpha = (1 - t * 0.5) * (focus && !(lit(p.from.id) && lit(p.to.id)) ? DIM : 1);
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 10;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 2.4 * sz, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      if (t > 0.92 && !this.pings.some((g) => g.node === p.to && now - g.born < 200)) this.pings.push({ node: p.to, born: now, color: p.color });
    }

    // ── Pings
    this.pings = this.pings.filter((g) => now - g.born < PING_MS);
    for (const g of this.pings) {
      const t = (now - g.born) / PING_MS;
      if (t < 0) continue;
      const base = g.node.kind === 'file' ? g.node.sr + 2 : g.node.sr + 2;
      ctx.globalAlpha = (1 - t) * 0.8 * (lit(g.node.id) ? 1 : DIM);
      ctx.strokeStyle = g.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(g.node.sx, g.node.sy, base + easeOut(t) * 14 * sz, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // ── Files
    for (const n of this.simNodes) {
      if (n.kind !== 'file' || !n.file) continue;
      const ap = this.appear(n, now);
      if (ap <= 0 || n.sx < -20 || n.sx > w + 20 || n.sy < -20 || n.sy > h + 20) continue;
      const f = n.file;
      const recency = Math.exp(-(wall - f.lastTs) / RECENCY_MS);
      const s = n.sr * (0.5 + 0.5 * easeOutBack(ap));
      const a = (lit(n.id) ? 1 : DIM) * ap;
      if (f.conflict) {
        // Soft amber glow that breathes, plus a crisp ring
        const pulse = 0.5 + 0.5 * Math.sin(now / 520 + hash01(n.id) * 6);
        const gr = s + 11 + 3 * pulse;
        const glow = ctx.createRadialGradient(n.sx, n.sy, s, n.sx, n.sy, gr);
        glow.addColorStop(0, rgba(pal.warn, 0.16 + 0.12 * pulse));
        glow.addColorStop(1, rgba(pal.warn, 0));
        ctx.globalAlpha = a;
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(n.sx, n.sy, gr, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = pal.warn;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(n.sx, n.sy, s + 4.5, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = a * (0.55 + 0.45 * recency);
      ctx.fillStyle = f.written ? pal.edit : pal.read;
      ctx.beginPath();
      ctx.roundRect(n.sx - s, n.sy - s, s * 2, s * 2, 1.5);
      ctx.fill();
      if (n.id === this.hoverId || n.id === this.pinnedId) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = pal.fg;
        ctx.lineWidth = 1.2;
        ctx.strokeRect(n.sx - s - 2, n.sy - s - 2, (s + 2) * 2, (s + 2) * 2);
      }
    }
    ctx.globalAlpha = 1;

    // ── Sessions and their orbiting agents
    for (const n of this.simNodes) {
      if (n.kind !== 'session' || !n.session) continue;
      this.drawSession(n, now, lit(n.id) ? 1 : DIM, sz, focus, lit);
    }

    // ── Project hubs
    for (const n of this.simNodes) {
      if (n.kind === 'project') this.drawProject(n, now, lit(n.id) ? 1 : DIM);
    }

    // ── Labels last, so they sit above edges and nodes
    this.drawLabels(now, sz, focus, lit, DIM);

    // Focus flash ring
    if (this.flash) {
      const n = this.nodes.get(this.flash.id);
      const t = (now - this.flash.born) / 1600;
      if (!n || t > 1) this.flash = null;
      else {
        for (const off of [0, 0.3]) {
          const tt = clamp((t - off) / 0.7, 0, 1);
          if (tt <= 0 || tt >= 1) continue;
          ctx.globalAlpha = 1 - tt;
          ctx.strokeStyle = n.file?.conflict ? pal.warn : pal.fg;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(n.sx, n.sy, 8 + easeOut(tt) * 34, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
    }
  }

  private appear(n: GNode, now: number) {
    return clamp((now - n.born) / 520, 0, 1);
  }

  private drawBackdrop(sz: number) {
    const { ctx, w, h, k, tx, ty } = this;
    // Soft territory glow per project
    for (const n of this.simNodes) {
      if (n.kind !== 'project') continue;
      const r = 230 * k;
      if (n.sx < -r || n.sx > w + r || n.sy < -r || n.sy > h + r) continue;
      const g = ctx.createRadialGradient(n.sx, n.sy, 0, n.sx, n.sy, r);
      g.addColorStop(0, this.hslA(n.color, 0.09));
      g.addColorStop(1, this.hslA(n.color, 0));
      ctx.fillStyle = g;
      ctx.fillRect(n.sx - r, n.sy - r, r * 2, r * 2);
    }
    // Dot grid that moves with the camera
    let step = 44 * k;
    while (step < 22) step *= 2;
    const ox = ((tx % step) + step) % step, oy = ((ty % step) + step) % step;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.055)';
    const d = Math.max(1, sz * 0.9);
    for (let x = ox; x < w; x += step) for (let y = oy; y < h; y += step) ctx.fillRect(x, y, d, d);
  }

  /** Apply alpha to the hsl() project colors from theme.ts */
  private hslA(hsl: string, a: number) {
    return hsl.replace(')', ` / ${a})`);
  }

  private curve(x0: number, y0: number, x1: number, y1: number, bend: number) {
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    const dx = x1 - x0, dy = y1 - y0;
    this.ctx.beginPath();
    this.ctx.moveTo(x0, y0);
    this.ctx.quadraticCurveTo(mx - dy * bend, my + dx * bend, x1, y1);
  }

  private curvePoint(x0: number, y0: number, x1: number, y1: number, bend: number, t: number) {
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    const cx = mx - (y1 - y0) * bend, cy = my + (x1 - x0) * bend;
    const u = 1 - t;
    return { x: u * u * x0 + 2 * u * t * cx + t * t * x1, y: u * u * y0 + 2 * u * t * cy + t * t * y1 };
  }

  private drawSession(n: GNode, now: number, alpha: number, sz: number, focus: string | null, lit: (id: string) => boolean) {
    const { ctx, pal } = this;
    const s = n.session!;
    const ap = this.appear(n, now);
    if (ap <= 0) return;
    const r = n.sr * (0.4 + 0.6 * easeOutBack(ap));
    const color = STATUS[s.status].color;
    const working = s.live && s.status === 'working';
    const blocked = s.status === 'blocked';
    const a = alpha * ap;

    // Orbit track + agents
    const agents = this.agentsBy.get(n.id);
    if (agents?.length) {
      const orbit = n.sr + 9 + 5 * sz;
      ctx.globalAlpha = a * 0.5;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(n.sx, n.sy, orbit, 0, Math.PI * 2);
      ctx.stroke();
      for (const ag of agents) {
        const st = ag.agent?.status;
        const on = st === 'working' && s.live;
        const aa = (focus ? (lit(ag.id) || ag.id === focus ? 1 : 0.13) : 1) * this.appear(ag, now) * ap;
        ctx.globalAlpha = aa;
        if (on) {
          ctx.save();
          ctx.shadowColor = pal.live;
          ctx.shadowBlur = 10;
          ctx.fillStyle = pal.live;
          ctx.beginPath();
          ctx.arc(ag.sx, ag.sy, ag.sr, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        } else {
          ctx.fillStyle = st === 'error' ? pal.blocked : pal.bg3;
          ctx.strokeStyle = st === 'error' ? pal.blocked : pal.fg4;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(ag.sx, ag.sy, ag.sr * 0.9, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
        if (ag.id === this.hoverId) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = pal.fg;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(ag.sx, ag.sy, ag.sr + 3, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    // Working pulse
    if (working || blocked) {
      const period = blocked ? 1100 : 1800;
      const t = ((now + hash01(n.id) * period) % period) / period;
      ctx.globalAlpha = a * (1 - t) * (blocked ? 0.75 : 0.55);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(n.sx, n.sy, r + 2 + easeOut(t) * 16 * sz, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Body
    ctx.globalAlpha = a;
    ctx.save();
    if (working || blocked) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 16;
    }
    const g = ctx.createRadialGradient(n.sx - r * 0.35, n.sy - r * 0.4, r * 0.1, n.sx, n.sy, r);
    g.addColorStop(0, pal.bg4);
    g.addColorStop(1, pal.bg1);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(n.sx, n.sy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = a;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.arc(n.sx, n.sy, r, 0, Math.PI * 2);
    ctx.stroke();

    // Core: what it is doing right now
    const cur = s.currentTool && s.currentTool.endTs == null && s.live ? s.currentTool : null;
    ctx.fillStyle = cur ? toolColor(cur.name) : color;
    ctx.globalAlpha = a * (cur ? 1 : 0.5);
    ctx.beginPath();
    ctx.arc(n.sx, n.sy, Math.max(2, r * (cur ? 0.36 : 0.26)), 0, Math.PI * 2);
    ctx.fill();

    // Selected in the drawer
    if (n.id === this.selectedSession || n.id === this.hoverId) {
      ctx.globalAlpha = n.id === this.selectedSession ? 1 : 0.7;
      ctx.strokeStyle = n.id === this.selectedSession ? pal.live : pal.fg;
      ctx.lineWidth = 1.5;
      ctx.setLineDash(n.id === this.selectedSession ? [] : [3, 3]);
      ctx.beginPath();
      ctx.arc(n.sx, n.sy, r + 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;
  }

  private drawProject(n: GNode, now: number, alpha: number) {
    const { ctx, pal } = this;
    const ap = this.appear(n, now);
    if (ap <= 0) return;
    ctx.font = `650 12.5px ${pal.font}`;
    const label = n.project;
    const tw = textW(ctx, label);
    const sessions = this.adj.get(n.id)?.size ?? 0;
    ctx.font = `600 10.5px ${pal.mono}`;
    const cw = textW(ctx, String(sessions));
    const ph = 30;
    const pw = 14 + 10 + 8 + tw + 10 + cw + 12;
    n.sw = pw;
    n.sh = ph;
    const s = 0.6 + 0.4 * easeOutBack(ap);
    const x = n.sx - (pw * s) / 2, y = n.sy - (ph * s) / 2;
    ctx.save();
    ctx.globalAlpha = alpha * ap;
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.shadowColor = this.hslA(n.color, 0.45);
    ctx.shadowBlur = n.id === this.hoverId ? 26 : 18;
    ctx.fillStyle = pal.bg2;
    ctx.beginPath();
    ctx.roundRect(0, 0, pw, ph, ph / 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    const grad = ctx.createLinearGradient(0, 0, 0, ph);
    grad.addColorStop(0, this.hslA(n.color, 0.16));
    grad.addColorStop(1, this.hslA(n.color, 0.04));
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = this.hslA(n.color, n.id === this.hoverId ? 0.9 : 0.55);
    ctx.lineWidth = 1.2;
    ctx.stroke();
    // Color dot, name, session count
    ctx.fillStyle = n.color;
    ctx.beginPath();
    ctx.arc(14 + 4, ph / 2, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `650 12.5px ${pal.font}`;
    ctx.fillStyle = pal.fg;
    ctx.fillText(label, 14 + 8 + 8, ph / 2 + 4.3);
    ctx.font = `600 10.5px ${pal.mono}`;
    ctx.fillStyle = pal.fg3;
    ctx.fillText(String(sessions), 14 + 8 + 8 + tw + 10, ph / 2 + 3.8);
    ctx.restore();
  }

  private fitted(text: string, max: number) {
    const key = `${this.ctx.font}|${max}|${text}`;
    let s = this.fitCache.get(key);
    if (s == null) {
      s = fitText(this.ctx, text, max);
      if (this.fitCache.size > 2000) this.fitCache.clear();
      this.fitCache.set(key, s);
    }
    return s;
  }

  private label(text: string, x: number, y: number, color: string, align: CanvasTextAlign = 'center') {
    const { ctx } = this;
    ctx.textAlign = align;
    ctx.lineWidth = 4;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = rgba(this.pal.bg0, 0.85);
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  /**
   * Labels are placed greedily so they never pile up: hubs and session nodes are
   * obstacles, session titles go first (below, else above), then file names try
   * right, left, below and above. A file label that fits nowhere waits for hover or zoom.
   */
  private drawLabels(now: number, sz: number, focus: string | null, lit: (id: string) => boolean, DIM: number) {
    const { ctx, pal, k, w, h } = this;
    const taken: Rect[] = [];
    for (const n of this.simNodes) {
      if (n.kind === 'project') taken.push({ x0: n.sx - n.sw / 2 - 4, y0: n.sy - n.sh / 2 - 4, x1: n.sx + n.sw / 2 + 4, y1: n.sy + n.sh / 2 + 4 });
      else if (n.kind === 'session') taken.push({ x0: n.sx - n.sr - 3, y0: n.sy - n.sr - 3, x1: n.sx + n.sr + 3, y1: n.sy + n.sr + 3 });
    }

    // Sessions: title + status, always (the status color never stands alone)
    if (k >= 0.32) {
      const order = this.simNodes.filter((n) => n.kind === 'session' && n.session)
        .sort((a, b) => rank(b, this.hoverId, this.selectedSession) - rank(a, this.hoverId, this.selectedSession));
      for (const n of order) {
        if (n.sx < -200 || n.sx > w + 200 || n.sy < -60 || n.sy > h + 60) continue;
        const s = n.session!;
        const ap = this.appear(n, now);
        const ring = this.agentsBy.get(n.id)?.length ? 9 + 5 * sz + 4 : 0;
        ctx.font = `600 12px ${pal.font}`;
        const title = this.fitted(sessionLabel(s), 180);
        const st = STATUS[s.status];
        const sub = `${st.label} · ${modelInfo(s.model).label}`;
        const tw = textW(ctx, title);
        ctx.font = `550 10.5px ${pal.font}`;
        const bw = Math.max(tw, textW(ctx, sub)) / 2 + 4;
        const below = n.sy + n.sr + ring + 15;
        const above = n.sy - n.sr - ring - 22;
        let y = below;
        let r: Rect = { x0: n.sx - bw, y0: below - 12, x1: n.sx + bw, y1: below + 18 };
        if (overlaps(r, taken)) {
          const r2 = { x0: n.sx - bw, y0: above - 12, x1: n.sx + bw, y1: above + 18 };
          if (!overlaps(r2, taken)) { r = r2; y = above; }
        }
        taken.push(r);
        ctx.globalAlpha = (lit(n.id) ? 1 : DIM) * ap;
        ctx.font = `600 12px ${pal.font}`;
        this.label(title, n.sx, y, n.id === this.selectedSession ? '#fff' : pal.fg);
        ctx.font = `550 10.5px ${pal.font}`;
        this.label(sub, n.sx, y + 14, s.status === 'idle' ? pal.fg3 : st.color);
      }
    }

    this.drawAgentLabels(taken, focus, lit, DIM);

    // Files: conflicts always, others in focus or when zoomed in
    ctx.font = `500 10.5px ${pal.mono}`;
    const files = this.simNodes.filter((n) => {
      if (n.kind !== 'file' || !n.file) return false;
      if (n.sx < -100 || n.sx > w + 100 || n.sy < -20 || n.sy > h + 20) return false;
      return n.file.conflict || n.id === this.hoverId || n.id === this.pinnedId || (!!focus && nb(focus, n.id, this.adj)) || k >= 1.55;
    }).sort((a, b) => fileRank(b, this.hoverId, this.pinnedId) - fileRank(a, this.hoverId, this.pinnedId));
    for (const n of files) {
      const f = n.file!;
      const text = basename(f.path);
      const tw = textW(ctx, text);
      const gap = n.sr + 6;
      const forced = n.id === this.hoverId || n.id === this.pinnedId;
      const spots: [number, number, CanvasTextAlign][] = [
        [n.sx + gap, n.sy + 3.5, 'left'],
        [n.sx - gap, n.sy + 3.5, 'right'],
        [n.sx, n.sy + gap + 9, 'center'],
        [n.sx, n.sy - gap - 3, 'center'],
      ];
      let chosen: [number, number, CanvasTextAlign] | null = null;
      for (const sp of spots) {
        const r = textRect(sp[0], sp[1], tw, sp[2]);
        if (!overlaps(r, taken)) { chosen = sp; taken.push(r); break; }
      }
      if (!chosen && forced) { chosen = spots[0]; taken.push(textRect(spots[0][0], spots[0][1], tw, 'left')); }
      if (!chosen) continue;
      ctx.globalAlpha = (lit(n.id) ? 1 : DIM) * this.appear(n, now);
      this.label(text, chosen[0], chosen[1], f.conflict ? pal.warn : forced ? pal.fg : pal.fg2, chosen[2]);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  }

  /** Agent types on hover, around a focused session, or when zoomed in (before file labels) */
  private drawAgentLabels(taken: Rect[], focus: string | null, lit: (id: string) => boolean, DIM: number) {
    const { ctx, pal, k } = this;
    ctx.font = `500 10px ${pal.mono}`;
    for (const list of this.agentsBy.values()) {
      for (const a of list) {
        const forced = a.id === this.hoverId;
        const show = forced || (focus && focus === a.owner?.id) || k >= 1.9;
        if (!show || !a.agent) continue;
        const dx = a.sx - (a.owner?.sx ?? a.sx);
        const align: CanvasTextAlign = dx >= 0 ? 'left' : 'right';
        const x = a.sx + (dx >= 0 ? 8 : -8), y = a.sy + 3.5;
        const r = textRect(x, y, textW(ctx, a.agent.agentType), align);
        if (!forced && overlaps(r, taken)) continue;
        taken.push(r);
        ctx.globalAlpha = lit(a.id) || focus === a.owner?.id ? 1 : DIM;
        this.label(a.agent.agentType, x, y, a.agent.status === 'working' ? pal.live : pal.fg3, align);
      }
    }
  }
}

function nb(focus: string, id: string, adj: Map<string, Set<string>>): boolean {
  return focus === id || !!adj.get(focus)?.has(id);
}

interface Rect { x0: number; y0: number; x1: number; y1: number }

function overlaps(r: Rect, list: Rect[]): boolean {
  for (const o of list) if (r.x0 < o.x1 && r.x1 > o.x0 && r.y0 < o.y1 && r.y1 > o.y0) return true;
  return false;
}

function textRect(x: number, baseline: number, tw: number, align: CanvasTextAlign): Rect {
  const x0 = align === 'left' ? x : align === 'right' ? x - tw : x - tw / 2;
  return { x0: x0 - 3, y0: baseline - 10, x1: x0 + tw + 3, y1: baseline + 4 };
}

/** Who gets first pick of label space */
function rank(n: GNode, hover: string | null, selected: string | null): number {
  const s = n.session;
  if (!s) return 0;
  if (n.id === hover) return 100;
  if (n.id === selected) return 90;
  return s.status === 'blocked' ? 50 : s.status === 'working' ? 40 : s.status === 'waiting' ? 30 : 10;
}

function fileRank(n: GNode, hover: string | null, pinned: string | null): number {
  if (n.id === hover || n.id === pinned) return 1e15;
  return (n.file?.conflict ? 1e14 : 0) + (n.file?.lastTs ?? 0) / 1000;
}
