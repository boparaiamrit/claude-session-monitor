// Pure aggregations behind the Analytics view. Everything here is a function of the
// visible session list, so the view can memoize it in one place.
import type { Session, Usage } from '../../types';
import { contextWindow, costOf } from '../../lib/pricing';
import { modelInfo } from '../../lib/format';

export const HOUR = 3_600_000;
/** Categorical slots available to projects. Slot 8 (red) stays free so it never meets the error lane. */
const MAX_SLOTS = 7;

/* ───────── Sticky project colors: a project keeps its slot while it stays in range ───────── */
const projectSlots = new Map<string, number>();

function claimSlots(ranked: string[], present: Set<string>) {
  for (const p of ranked) {
    if (projectSlots.has(p)) continue;
    if (projectSlots.size >= MAX_SLOTS) {
      // Free a slot held by a project that left the time range entirely
      const stale = [...projectSlots.keys()].find((k) => !present.has(k));
      if (!stale) break;
      const slot = projectSlots.get(stale)!;
      projectSlots.delete(stale);
      projectSlots.set(p, slot);
      continue;
    }
    const used = new Set(projectSlots.values());
    let slot = 1;
    while (used.has(slot)) slot++;
    projectSlots.set(p, slot);
  }
}

export function projectSlot(project: string): number {
  return projectSlots.get(project) ?? 0;
}

/** CSS color for a project, matching the activity chart */
export function projectFill(project: string): string {
  const slot = projectSlot(project);
  return slot ? `var(--series-${slot})` : 'var(--series-other)';
}

/* ───────── Types ───────── */
export interface Series { key: string; name: string; slot: number; total: number }

export interface BucketRow {
  t: number;
  end: number;
  partial: boolean;
  tools: number;
  errors: number;
  output: number;
  input: number;
  active: number;
  /** Topmost non-empty stacked series, so only it gets the rounded cap */
  top: string | null;
  [series: string]: number | boolean | string | null;
}

export interface ModelRow { label: string; family: string; model: string; cost: number; output: number; share: number; sessions: number }
export interface ToolRow { name: string; count: number; failed: number; share: number }
export interface HostRow { label: string; live: number; closed: number; total: number; working: number; cpu: number; mem: number }
export interface SlowRow { name: string; median: number; p90: number; n: number }
export interface CostPart { key: string; label: string; hint: string; cost: number; share: number }
export interface TopRow { s: Session; cost: number; share: number }

export interface Analytics {
  sessions: number;
  live: number;
  working: number;
  blocked: number;
  toolCalls: number;
  errors: number;
  errorRate: number;
  output: number;
  prompt: number;
  cost: number;
  costParts: CostPart[];
  cacheHit: number;
  ctxAvg: number;
  ctxHot: number;
  ctxCount: number;
  bucketH: number;
  rows: BucketRow[];
  series: Series[];
  models: ModelRow[];
  tools: ToolRow[];
  toolSample: number;
  hosts: HostRow[];
  slow: SlowRow[];
  top: TopRow[];
}

const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const ENTRY_HOST: Record<string, string> = {
  'claude-vscode': 'VS Code',
  cli: 'Terminal',
  'claude-jetbrains': 'JetBrains',
  'sdk-ts': 'SDK',
  'sdk-py': 'SDK',
  'sdk-cli': 'SDK',
};

export function hostOf(s: Session): string {
  if (s.control.managed) return 'In monitor';
  if (s.process) return s.process.kind === 'background' ? 'Background' : s.process.host || 'Unknown';
  if (s.entrypoint) return ENTRY_HOST[s.entrypoint] ?? s.entrypoint;
  return 'Unknown';
}

export function aggregate(visible: Session[], all: Session[], maxSpanH: number, minSpanH = 8, now = Date.now()): Analytics {
  /* Totals */
  let toolCalls = 0, errors = 0, output = 0, cost = 0, live = 0, working = 0, blocked = 0;
  let ctxSum = 0, ctxCount = 0, ctxHot = 0;
  const usage = emptyUsage();
  const partCost = { output: 0, input: 0, cacheWrite: 0, cacheRead: 0 };
  const modelMap = new Map<string, ModelRow & { ids: Set<string> }>();
  const costById = new Map<string, number>();

  for (const s of visible) {
    toolCalls += s.counts.tools;
    errors += s.counts.errors;
    if (s.live) live++;
    if (s.status === 'working') working++;
    if (s.status === 'blocked' || s.control.pending) blocked++;
    let sc = 0;
    for (const [m, u] of Object.entries(s.usageByModel)) {
      const c = costOf(m, u);
      sc += c;
      usage.input += u.input;
      usage.output += u.output;
      usage.cacheRead += u.cacheRead;
      usage.cacheWrite += u.cacheWrite;
      partCost.output += costOf(m, { ...emptyUsage(), output: u.output });
      partCost.input += costOf(m, { ...emptyUsage(), input: u.input });
      partCost.cacheWrite += costOf(m, { ...emptyUsage(), cacheWrite: u.cacheWrite });
      partCost.cacheRead += costOf(m, { ...emptyUsage(), cacheRead: u.cacheRead });
      const info = modelInfo(m);
      const row = modelMap.get(info.label) ?? { label: info.label, family: info.family, model: m, cost: 0, output: 0, share: 0, sessions: 0, ids: new Set<string>() };
      row.cost += c;
      row.output += u.output;
      row.ids.add(s.id);
      modelMap.set(info.label, row);
    }
    costById.set(s.id, sc);
    cost += sc;
    output += s.usage.output || Object.values(s.usageByModel).reduce((a, u) => a + u.output, 0);
    if (s.contextTokens > 0 && (s.live || s.status !== 'idle')) {
      const r = s.contextTokens / contextWindow(s.model);
      ctxSum += r;
      ctxCount++;
      if (r > 0.75) ctxHot++;
    }
  }
  // Closed sessions only count toward context fill when nothing is live
  if (!ctxCount) {
    for (const s of visible) {
      if (s.contextTokens <= 0) continue;
      const r = s.contextTokens / contextWindow(s.model);
      ctxSum += r;
      ctxCount++;
      if (r > 0.75) ctxHot++;
    }
  }
  const promptAll = usage.input + usage.cacheRead + usage.cacheWrite;

  const costParts: CostPart[] = [
    { key: 'output', label: 'Output', hint: 'Tokens Claude wrote', cost: partCost.output, share: 0 },
    { key: 'cacheWrite', label: 'Cache writes', hint: 'Prompt tokens stored in the cache', cost: partCost.cacheWrite, share: 0 },
    { key: 'cacheRead', label: 'Cache reads', hint: 'Prompt tokens re-read from the cache', cost: partCost.cacheRead, share: 0 },
    { key: 'input', label: 'Fresh input', hint: 'Prompt tokens sent without the cache', cost: partCost.input, share: 0 },
  ];
  for (const p of costParts) p.share = cost ? p.cost / cost : 0;
  costParts.sort((a, b) => b.cost - a.cost);

  /* Time buckets */
  const nowHour = Math.floor(now / HOUR) * HOUR;
  const floorH = nowHour - (maxSpanH - 1) * HOUR;
  let minHour = nowHour;
  for (const s of visible) for (const h of s.hourly) if (h.hour >= floorH && h.hour < minHour) minHour = h.hour;
  const spanH = Math.max(minSpanH, (nowHour - minHour) / HOUR + 1);
  const bucketH = spanH <= 36 ? 1 : spanH <= 72 ? 2 : spanH <= 108 ? 3 : spanH <= 144 ? 4 : 6;
  const n = Math.ceil(spanH / bucketH);

  // Projects ranked by calls in range; claim sticky colors in that order
  const projTotals = new Map<string, number>();
  for (const s of visible) {
    let t = 0;
    for (const h of s.hourly) if (h.hour >= floorH) t += h.tools;
    projTotals.set(s.projectName, (projTotals.get(s.projectName) ?? 0) + t);
  }
  const ranked = [...projTotals.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
  claimSlots(ranked, new Set(all.map((s) => s.projectName)));

  const seriesMap = new Map<string, Series>();
  let otherTotal = 0;
  for (const [p, t] of projTotals) {
    const slot = projectSlot(p);
    if (slot) seriesMap.set(p, { key: `s${slot}`, name: p, slot, total: t });
    else otherTotal += t;
  }
  const series = [...seriesMap.values()].sort((a, b) => a.slot - b.slot);
  if (otherTotal > 0) series.push({ key: 'other', name: 'Other projects', slot: 0, total: otherTotal });

  const rows: BucketRow[] = Array.from({ length: n }, (_, i) => {
    const t = nowHour - ((n - 1 - i) * bucketH + bucketH - 1) * HOUR;
    const row: BucketRow = { t, end: t + bucketH * HOUR, partial: i === n - 1, tools: 0, errors: 0, output: 0, input: 0, active: 0, top: null };
    for (const se of series) row[se.key] = 0;
    return row;
  });
  const activeSets: Set<string>[] = rows.map(() => new Set());
  for (const s of visible) {
    const key = seriesMap.get(s.projectName)?.key ?? 'other';
    for (const h of s.hourly) {
      if (h.hour < floorH || h.hour > nowHour) continue;
      const idx = n - 1 - Math.floor((nowHour - h.hour) / HOUR / bucketH);
      if (idx < 0) continue;
      const r = rows[idx];
      r.tools += h.tools;
      r.errors += h.errors;
      r.output += h.output;
      r.input += h.input;
      r[key] = (r[key] as number) + h.tools;
      if (h.tools > 0) activeSets[idx].add(s.id);
    }
  }
  rows.forEach((r, i) => {
    r.active = activeSets[i].size;
    for (let j = series.length - 1; j >= 0; j--) {
      if ((r[series[j].key] as number) > 0) { r.top = series[j].key; break; }
    }
  });

  /* Models */
  const models = [...modelMap.values()]
    .map(({ ids, ...m }) => ({ ...m, sessions: ids.size, share: cost ? m.cost / cost : 0 }))
    .sort((a, b) => b.cost - a.cost);

  /* Tools and durations from the recent tool calls */
  const toolMap = new Map<string, { count: number; failed: number; durs: number[] }>();
  let toolSample = 0;
  for (const s of visible) {
    for (const t of s.tools) {
      toolSample++;
      const e = toolMap.get(t.name) ?? { count: 0, failed: 0, durs: [] };
      e.count++;
      if (t.ok === false) e.failed++;
      if (t.endTs != null && t.endTs >= t.ts) e.durs.push(t.endTs - t.ts);
      toolMap.set(t.name, e);
    }
  }
  const toolRanked = [...toolMap.entries()].sort((a, b) => b[1].count - a[1].count);
  const TOP_TOOLS = 9;
  const tools: ToolRow[] = toolRanked.slice(0, TOP_TOOLS).map(([name, e]) => ({ name, count: e.count, failed: e.failed, share: toolSample ? e.count / toolSample : 0 }));
  if (toolRanked.length > TOP_TOOLS) {
    const rest = toolRanked.slice(TOP_TOOLS);
    const count = rest.reduce((a, [, e]) => a + e.count, 0);
    const failed = rest.reduce((a, [, e]) => a + e.failed, 0);
    tools.push({ name: `${rest.length} other tools`, count, failed, share: toolSample ? count / toolSample : 0 });
  }

  const slow: SlowRow[] = toolRanked
    .filter(([, e]) => e.durs.length >= 3)
    .map(([name, e]) => {
      const d = [...e.durs].sort((a, b) => a - b);
      return { name, median: quantile(d, 0.5), p90: quantile(d, 0.9), n: d.length };
    })
    .sort((a, b) => b.p90 - a.p90)
    .slice(0, 8);

  /* Hosts */
  const hostMap = new Map<string, HostRow>();
  for (const s of visible) {
    const label = hostOf(s);
    const h = hostMap.get(label) ?? { label, live: 0, closed: 0, total: 0, working: 0, cpu: 0, mem: 0 };
    if (s.live) h.live++; else h.closed++;
    h.total++;
    if (s.status === 'working') h.working++;
    if (s.live && s.process) { h.cpu += s.process.cpu; h.mem += s.process.memMb; }
    hostMap.set(label, h);
  }
  const hosts = [...hostMap.values()].sort((a, b) => b.total - a.total || b.live - a.live);

  /* Top sessions */
  const top = visible
    .map((s) => ({ s, cost: costById.get(s.id) ?? 0, share: 0 }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 8);
  for (const r of top) r.share = cost ? r.cost / cost : 0;

  return {
    sessions: visible.length,
    live,
    working,
    blocked,
    toolCalls,
    errors,
    errorRate: toolCalls ? errors / toolCalls : 0,
    output,
    prompt: promptAll,
    cost,
    costParts,
    cacheHit: promptAll ? usage.cacheRead / promptAll : 0,
    ctxAvg: ctxCount ? ctxSum / ctxCount : 0,
    ctxHot,
    ctxCount,
    bucketH,
    rows,
    series,
    models,
    tools,
    toolSample,
    hosts,
    slow,
    top,
  };
}

/* ───────── Labels ───────── */
export function hourLabel(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: 'numeric' }).replace(/\s/g, ' ');
}

export function rangeLabel(row: { t: number; end: number; partial: boolean }): string {
  const d = new Date(row.t);
  const today = new Date();
  const day = d.toDateString() === today.toDateString() ? '' : `${d.toLocaleDateString([], { weekday: 'short' })} `;
  return `${day}${hourLabel(row.t)} – ${row.partial ? 'now' : hourLabel(row.end)}`;
}

export function pct(r: number, digits?: number): string {
  if (!isFinite(r) || r <= 0) return '0%';
  const v = r * 100;
  const d = digits ?? (v < 10 ? 1 : 0);
  // Never round a partial share up to a whole 100%
  if (r < 1 && Number(v.toFixed(d)) >= 100) return `${(Math.floor(v * 10) / 10).toFixed(1)}%`;
  return `${v.toFixed(d)}%`;
}

export function int(n: number): string {
  return Math.round(n).toLocaleString();
}

/** Compact axis numbers: in full under 10,000, compact above */
export function axisNum(n: number): string {
  if (n < 10_000) return Math.round(n).toLocaleString();
  if (n < 1e6) return `${Math.round(n / 1000)}K`;
  if (n < 1e9) return `${+(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
  return `${+(n / 1e9).toFixed(1)}B`;
}
