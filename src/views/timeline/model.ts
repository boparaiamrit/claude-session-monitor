// Pure layout for the timeline: sessions grouped by project, with packed sub-agent lanes.
// Rebuilt only when the visible sessions change; the canvas reads it every frame.
import type { Agent, Message, Session, ToolCall } from '../../types';
import { projectColor } from '../../lib/theme';

export const AXIS_H = 58;
export const GUTTER_W = 248;
export const ROW_H = { project: 36, session: 50, agent: 26 } as const;
const MAX_AGENT_LANES = 3;
/** A call with no end and no later call is drawn at most this long */
const STALE_CAP = 60_000;

export interface Bar {
  id: string;
  name: string;
  detail: string;
  ts: number;
  /** null while running: the bar extends to now */
  end: number | null;
  ok: boolean | null;
  /** Held on a permission decision */
  pending: boolean;
}

export interface AgentSpan {
  agent: Agent;
  start: number;
  /** null while the agent is still working */
  end: number | null;
  bars: Bar[];
}

interface RowBase { key: string; y: number; h: number }
export interface ProjectRow extends RowBase { kind: 'project'; name: string; color: string; count: number; live: number; working: number }
export interface SessionRow extends RowBase {
  kind: 'session';
  session: Session;
  color: string;
  bars: Bar[];
  marks: Message[];
  start: number;
  /** null while live */
  end: number | null;
}
export interface AgentRow extends RowBase { kind: 'agent'; session: Session; lane: number; lanes: number; spans: AgentSpan[]; lead: AgentSpan }
export type Row = ProjectRow | SessionRow | AgentRow;

export interface Layout {
  rows: Row[];
  height: number;
  sessions: number;
  /** Earliest timestamp anywhere in the data */
  first: number;
}

function sortedByTs<T extends { ts: number }>(xs: T[]): T[] {
  for (let i = 1; i < xs.length; i++) if (xs[i].ts < xs[i - 1].ts) return [...xs].sort((a, b) => a.ts - b.ts);
  return xs;
}

/** Turn raw tool calls into bars, deciding which open calls are really still running */
export function toBars(raw: ToolCall[], active: boolean, current: ToolCall | null, pendingId: string | null, lastActivity: number | null): Bar[] {
  const tools = sortedByTs(raw);
  let lastDone = -1;
  for (let i = tools.length - 1; i >= 0; i--) if (tools[i].endTs != null) { lastDone = i; break; }
  const out: Bar[] = [];
  for (let i = 0; i < tools.length; i++) {
    const t = tools[i];
    const base = { id: t.id, name: t.name, detail: t.detail, ts: t.ts, ok: t.ok, pending: t.id === pendingId };
    if (t.endTs != null) {
      out.push({ ...base, end: Math.max(t.ts, t.endTs) });
    } else if (active && (i > lastDone || t.id === current?.id)) {
      out.push({ ...base, end: null });
    } else {
      // Open call that never closed: end it at the next call (or last activity), capped
      const next = tools[i + 1]?.ts ?? lastActivity ?? t.ts;
      out.push({ ...base, end: Math.min(Math.max(next, t.ts), t.ts + STALE_CAP) });
    }
  }
  if (active && current && current.endTs == null && !tools.some((t) => t.id === current.id)) {
    out.push({ id: current.id, name: current.name, detail: current.detail, ts: current.ts, end: null, ok: null, pending: current.id === pendingId || pendingId === '*' });
  }
  return out;
}

function agentEnd(a: Agent, s: Session, start: number): number {
  let end = Math.max(start, a.lastActivity ?? start);
  const link = s.tools.find((t) => (a.toolUseId && t.id === a.toolUseId)
    || ((t.name === 'Agent' || t.name === 'Task') && Math.abs(t.ts - start) < 3000 && t.detail === a.description));
  if (link?.endTs) end = Math.max(end, link.endTs);
  for (const t of a.tools) end = Math.max(end, t.endTs ?? t.ts);
  return end;
}

function agentSpans(s: Session): AgentSpan[] {
  const spans: AgentSpan[] = [];
  for (const a of s.agents) {
    if (a.startedAt == null) continue;
    const running = a.status === 'working' && s.live;
    spans.push({
      agent: a,
      start: a.startedAt,
      end: running ? null : agentEnd(a, s, a.startedAt),
      bars: toBars(a.tools, running, a.currentTool, null, a.lastActivity),
    });
  }
  return spans.sort((x, y) => x.start - y.start);
}

/** Greedy interval packing: agents that never overlap share a lane */
function packLanes(spans: AgentSpan[]): AgentSpan[][] {
  const lanes: AgentSpan[][] = [];
  const ends: number[] = [];
  for (const sp of spans) {
    const e = sp.end ?? Infinity;
    let lane = ends.findIndex((x) => x <= sp.start);
    if (lane < 0 && lanes.length < MAX_AGENT_LANES) {
      lane = lanes.length;
      lanes.push([]);
      ends.push(-Infinity);
    }
    if (lane < 0) lane = ends.indexOf(Math.min(...ends));
    lanes[lane].push(sp);
    ends[lane] = Math.max(ends[lane], e);
  }
  return lanes;
}

function leadOf(spans: AgentSpan[]): AgentSpan {
  return spans.find((s) => s.end == null) ?? spans[spans.length - 1];
}

export function buildLayout(sessions: Session[]): Layout {
  const groups = new Map<string, Session[]>();
  for (const s of sessions) {
    const g = groups.get(s.projectName);
    if (g) g.push(s);
    else groups.set(s.projectName, [s]);
  }
  const rows: Row[] = [];
  let y = 0;
  let first = Infinity;
  for (const [name, list] of groups) {
    const color = projectColor(name);
    rows.push({
      kind: 'project', key: `p:${name}`, y, h: ROW_H.project, name, color, count: list.length,
      live: list.filter((s) => s.live).length, working: list.filter((s) => s.live && s.status === 'working').length,
    });
    y += ROW_H.project;
    for (const s of list) {
      const active = s.live && (s.status === 'working' || s.status === 'blocked');
      const pendingId = s.status === 'blocked' && s.control.pending ? (s.currentTool?.id ?? '*') : null;
      const bars = toBars(s.tools, active, s.currentTool, pendingId, s.lastActivity);
      const marks = sortedByTs(s.messages);
      const start = Math.min(s.startedAt ?? Infinity, bars[0]?.ts ?? Infinity, marks[0]?.ts ?? Infinity);
      const safeStart = Number.isFinite(start) ? start : (s.lastActivity ?? Date.now());
      first = Math.min(first, safeStart);
      rows.push({
        kind: 'session', key: `s:${s.id}`, y, h: ROW_H.session, session: s, color, bars, marks,
        start: safeStart, end: s.live ? null : (s.lastActivity ?? safeStart),
      });
      y += ROW_H.session;
      const lanes = packLanes(agentSpans(s));
      lanes.forEach((spans, i) => {
        rows.push({ kind: 'agent', key: `a:${s.id}:${i}`, y, h: ROW_H.agent, session: s, lane: i, lanes: lanes.length, spans, lead: leadOf(spans) });
        y += ROW_H.agent;
      });
    }
  }
  return { rows, height: y, sessions: sessions.length, first: Number.isFinite(first) ? first : Date.now() };
}

/** First row whose bottom edge is below `top` (rows are sorted by y) */
export function firstVisibleRow(rows: Row[], top: number): number {
  let lo = 0, hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].y + rows[mid].h <= top) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface WindowStats { calls: number; running: number; failed: number; active: number }

export function windowStats(rows: Row[], t0: number, t1: number): WindowStats {
  const st: WindowStats = { calls: 0, running: 0, failed: 0, active: 0 };
  const activeIds = new Set<string>();
  const count = (bars: Bar[], sid: string) => {
    for (const b of bars) {
      if (b.ts > t1 || (b.end != null && b.end < t0)) continue;
      st.calls++;
      if (b.end == null) st.running++;
      if (b.ok === false) st.failed++;
      activeIds.add(sid);
    }
  };
  for (const r of rows) {
    if (r.kind === 'session') {
      count(r.bars, r.session.id);
      if (r.marks.some((m) => m.ts >= t0 && m.ts <= t1)) activeIds.add(r.session.id);
    } else if (r.kind === 'agent') {
      for (const sp of r.spans) count(sp.bars, r.session.id);
    }
  }
  st.active = activeIds.size;
  return st;
}
