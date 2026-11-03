import { memo, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type PointerEvent, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartColumn, CircleX, Table2 } from 'lucide-react';
import type { Session } from '../../types';
import { useStore } from '../../lib/store';
import { duration, fmtToolName, sessionLabel, tokens, truncate, usd } from '../../lib/format';
import { toolColor } from '../../lib/theme';
import { IconButton, ModelTag, StatusPill } from '../../components/ui';
import {
  axisNum, hourLabel, int, pct, projectFill, rangeLabel,
  type BucketRow, type HostRow, type ModelRow, type Series, type SlowRow, type ToolRow, type TopRow,
} from './aggregate';

/* ═════════════ Card shell with a table-view twin ═════════════ */

export interface TableSpec {
  columns: { label: string; num?: boolean }[];
  rows: (string | number)[][];
}

export function ChartCard({ title, takeaway, legend, table, className = '', index = 0, children }: {
  title: string;
  index?: number;
  takeaway?: ReactNode;
  legend?: ReactNode;
  table?: TableSpec;
  className?: string;
  children: ReactNode;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className={`an-card ${className}`} style={{ animationDelay: `${60 + index * 45}ms` }}>
      <header className="an-card-head">
        <div className="an-card-titles">
          <h3>{title}</h3>
          {takeaway && <p>{takeaway}</p>}
        </div>
        {table && (
          <IconButton className="an-table-toggle" label={asTable ? 'Show the chart' : 'Show as a table'} onClick={() => setAsTable(!asTable)}>
            {asTable ? <ChartColumn size={15} /> : <Table2 size={15} />}
          </IconButton>
        )}
      </header>
      {legend && !asTable && <div className="an-legend">{legend}</div>}
      <div className="an-card-body">{asTable && table ? <DataTable spec={table} /> : children}</div>
    </section>
  );
}

function DataTable({ spec }: { spec: TableSpec }) {
  return (
    <div className="an-dt-wrap">
      <table className="an-dt">
        <thead>
          <tr>{spec.columns.map((c) => <th key={c.label} className={c.num ? 'an-num-col' : ''}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {spec.rows.map((r, i) => (
            <tr key={i}>{r.map((v, j) => <td key={j} className={spec.columns[j]?.num ? 'num' : ''}>{v}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LegendItem({ color, label, kind = 'rect' }: { color: string; label: ReactNode; kind?: 'rect' | 'line' | 'dot' }) {
  return (
    <span className="an-legend-item">
      <span className={`an-key an-key-${kind}`} style={{ background: color }} />
      {label}
    </span>
  );
}

/* ═════════════ Hover layer for the HTML charts ═════════════ */

function useHoverTip(render: (key: string) => ReactNode) {
  const [key, setKey] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const at = useRef({ x: 0, y: 0 });

  const place = () => {
    const host = hostRef.current;
    const box = boxRef.current;
    if (!host || !box) return;
    const r = host.getBoundingClientRect();
    const bw = box.offsetWidth;
    const bh = box.offsetHeight;
    let x = at.current.x - r.left + 14;
    let y = at.current.y - r.top + 16;
    if (x + bw > r.width - 4) x = at.current.x - r.left - bw - 14;
    if (y + bh > r.height - 4) y = at.current.y - r.top - bh - 12;
    box.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
  };
  useLayoutEffect(place, [key]);

  const bind = (k: string) => ({
    onPointerEnter: (e: PointerEvent) => { at.current = { x: e.clientX, y: e.clientY }; setKey(k); },
    onPointerMove: (e: PointerEvent) => { at.current = { x: e.clientX, y: e.clientY }; place(); },
    onPointerLeave: () => setKey((cur) => (cur === k ? null : cur)),
    onFocus: (e: FocusEvent<HTMLElement>) => {
      const b = e.currentTarget.getBoundingClientRect();
      at.current = { x: b.left + b.width * 0.6, y: b.top + b.height / 2 };
      setKey(k);
    },
    onBlur: () => setKey((cur) => (cur === k ? null : cur)),
  });

  const tip = (
    <div ref={boxRef} className={`an-tip an-tip-float${key ? ' show' : ''}`} role="tooltip" aria-hidden={!key}>
      {key ? render(key) : null}
    </div>
  );
  return { hostRef, bind, tip, active: key };
}

/* ═════════════ Recharts plumbing ═════════════ */

const Y_W = 44;
const M = { top: 6, right: 6, bottom: 0, left: 0 };
const CURSOR = { fill: 'rgba(255, 255, 255, 0.045)' };

/** Only the chart under the pointer shows its tooltip; synced charts only show the band */
let hoveredChart: string | null = null;
const hoverProps = (id: string) => ({
  onMouseEnter: () => { hoveredChart = id; },
  onMouseLeave: () => { if (hoveredChart === id) hoveredChart = null; },
});

function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h}V${y + rr}A${rr},${rr} 0 0 1 ${x + rr},${y}H${x + w - rr}A${rr},${rr} 0 0 1 ${x + w},${y + rr}V${y + h}Z`;
}

interface ShapeProps { x?: number; y?: number; width?: number; height?: number; fill?: string; payload?: BucketRow }

/** Stacked segment: 2px surface gap above each segment, 4px rounded cap only on the top one */
function stackShape(key: string) {
  return function StackSeg(p: unknown) {
    const { x = 0, y = 0, width = 0, height = 0, fill, payload } = p as ShapeProps;
    if (height <= 0 || width <= 0) return <g />;
    const cls = payload?.partial ? 'an-partial' : undefined;
    if (payload?.top === key) return <path className={cls} d={roundedTop(x, y, width, height, 4)} style={{ fill }} />;
    const gap = height > 3 ? 2 : 0;
    return <rect className={cls} x={x} y={y + gap} width={width} height={height - gap} style={{ fill }} />;
  };
}

function singleShape(p: unknown) {
  const { x = 0, y = 0, width = 0, height = 0, fill, payload } = p as ShapeProps;
  if (height <= 0 || width <= 0) return <g />;
  return <path className={payload?.partial ? 'an-partial' : undefined} d={roundedTop(x, y, width, height, 4)} style={{ fill }} />;
}

function useTicks(rows: BucketRow[]) {
  const step = Math.max(1, Math.ceil(rows.length / 8));
  return (_: unknown, i: number) => {
    const fromEnd = rows.length - 1 - i;
    if (fromEnd % step !== 0) return '';
    if (fromEnd === 0) return 'Now';
    const r = rows[i];
    if (!r) return '';
    const d = new Date(r.t);
    if (d.getHours() < (rows.length > 24 ? 6 : 1) && rows.length > 24) return d.toLocaleDateString([], { weekday: 'short' });
    return hourLabel(r.t);
  };
}

interface TipPayload { payload?: BucketRow }

function TipFrame({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <div className="an-tip">
      <div className="an-tip-head">{head}</div>
      {children}
    </div>
  );
}

function TipRow({ color, value, label, kind = 'line' }: { color?: string; value: ReactNode; label: ReactNode; kind?: 'line' | 'icon' }) {
  return (
    <div className="an-tip-row">
      {kind === 'line' ? <span className="an-tip-key" style={{ background: color }} /> : <CircleX size={12} className="an-tip-icon" />}
      <b className="num">{value}</b>
      <span>{label}</span>
    </div>
  );
}

/* ═════════════ 1. Activity over time ═════════════ */

export const ActivityChart = memo(function ActivityChart({ rows, series }: { rows: BucketRow[]; series: Series[] }) {
  const tick = useTicks(rows);
  const keys = series.map((se) => se.key).join(',');
  const shapes = useMemo(() => Object.fromEntries(keys.split(',').map((k) => [k, stackShape(k)])), [keys]);
  const errMax = Math.max(1, ...rows.map((r) => r.errors));
  const content = (id: string) => (p: { active?: boolean; payload?: readonly TipPayload[] }) => {
    const row = p.payload?.[0]?.payload;
    if (!row || !p.active || hoveredChart !== id) return null;
    const parts = series.filter((se) => (row[se.key] as number) > 0).reverse();
    return (
      <TipFrame head={rangeLabel(row)}>
        <div className="an-tip-total"><b className="num">{int(row.tools)}</b> tool calls · {row.active} session{row.active === 1 ? '' : 's'}</div>
        {parts.map((se) => (
          <TipRow key={se.key} color={se.slot ? `var(--series-${se.slot})` : 'var(--series-other)'} value={int(row[se.key] as number)} label={se.name} />
        ))}
        <div className="an-tip-sep" />
        <TipRow kind="icon" value={int(row.errors)} label={`failed${row.tools ? ` · ${pct(row.errors / row.tools)}` : ''}`} />
      </TipFrame>
    );
  };

  return (
    <div className="an-time">
      <div {...hoverProps('activity')}>
        <ResponsiveContainer width="100%" height={208} initialDimension={{ width: 600, height: 208 }}>
          <BarChart data={rows} margin={M} syncId="an-time" barCategoryGap="24%">
            <CartesianGrid vertical={false} />
            <XAxis dataKey="t" hide />
            <YAxis width={Y_W} tickFormatter={axisNum} axisLine={false} tickLine={false} allowDecimals={false} tickCount={5} />
            <Tooltip cursor={CURSOR} content={content('activity')} isAnimationActive={false} />
            {series.map((se) => (
              <Bar key={se.key} dataKey={se.key} name={se.name} stackId="calls" maxBarSize={24}
                fill={se.slot ? `var(--series-${se.slot})` : 'var(--series-other)'} shape={shapes[se.key]}
                isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="an-lane-label"><CircleX size={12} /> Failed calls</div>
      <div {...hoverProps('errors')}>
        <ResponsiveContainer width="100%" height={78} initialDimension={{ width: 600, height: 78 }}>
          <BarChart data={rows} margin={{ ...M, top: 2 }} syncId="an-time" barCategoryGap="24%">
            <CartesianGrid vertical={false} />
            <XAxis dataKey="t" tickFormatter={tick} interval={0} axisLine={false} tickLine={false} height={24} tickMargin={8} />
            <YAxis width={Y_W} domain={[0, errMax]} ticks={[0, errMax]} axisLine={false} tickLine={false} allowDecimals={false} />
            <Tooltip cursor={CURSOR} content={content('errors')} isAnimationActive={false} />
            <Bar dataKey="errors" name="Failed calls" maxBarSize={24} fill="var(--blocked)" shape={singleShape}
              isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
});

/* ═════════════ 2. Tokens per hour (two small multiples on one time axis) ═════════════ */

export const TokensChart = memo(function TokensChart({ rows }: { rows: BucketRow[] }) {
  const tick = useTicks(rows);
  const totalOut = rows.reduce((a, r) => a + r.output, 0);
  const totalIn = rows.reduce((a, r) => a + r.input, 0);
  const tip = (id: string, key: 'output' | 'input', label: string) =>
    (p: { active?: boolean; payload?: readonly TipPayload[] }) => {
      const row = p.payload?.[0]?.payload;
      if (!row || !p.active || hoveredChart !== id) return null;
      return (
        <TipFrame head={rangeLabel(row)}>
          <div className="an-tip-total"><b className="num">{tokens(row[key])}</b> {label}</div>
          {row.tools > 0 && <div className="an-tip-note">{tokens(Math.round(row[key] / row.tools))} per tool call</div>}
        </TipFrame>
      );
    };

  const panel = (id: string, key: 'output' | 'input', title: string, total: number, unit: string, last: boolean) => (
    <div className="an-multiple">
      <div className="an-multiple-head">
        <span>{title}</span>
        <span className="num">{tokens(total)}</span>
      </div>
      <div {...hoverProps(id)}>
        <ResponsiveContainer width="100%" height={last ? 128 : 104} initialDimension={{ width: 600, height: 104 }}>
          <BarChart data={rows} margin={last ? M : { ...M, bottom: 8 }} syncId="an-time" barCategoryGap="24%">
            <CartesianGrid vertical={false} />
            <XAxis dataKey="t" hide={!last} tickFormatter={tick} interval={0} axisLine={false} tickLine={false} height={24} tickMargin={8} />
            <YAxis width={Y_W} tickFormatter={axisNum} axisLine={false} tickLine={false} tickCount={3} />
            <Tooltip cursor={CURSOR} content={tip(id, key, unit)} isAnimationActive={false} />
            <Bar dataKey={key} name={title} maxBarSize={24} fill="var(--series-1)" shape={singleShape}
              isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );

  return (
    <div className="an-time">
      {panel('tok-out', 'output', 'Output tokens', totalOut, 'output tokens', false)}
      {panel('tok-in', 'input', 'Prompt tokens, including cache', totalIn, 'prompt tokens', true)}
    </div>
  );
});

/* ═════════════ Ranked horizontal bars (HTML) ═════════════ */

function BarTrack({ value, max, color, children, soft }: { value: number; max: number; color: string; children?: ReactNode; soft?: { value: number; color: string } }) {
  const r = max > 0 ? value / max : 0;
  const rs = soft && max > 0 ? soft.value / max : 0;
  return (
    <div className="an-bar-track">
      {(r > 0 || rs === 0) && (
        <div className={`an-bar-fill${rs > 0 ? ' joined' : ''}`} style={{ width: `calc((100% - var(--tip-w)) * ${r.toFixed(4)})`, background: color }} />
      )}
      {soft && rs > 0 && (
        <div className="an-bar-fill an-bar-soft" style={{ width: `calc((100% - var(--tip-w)) * ${rs.toFixed(4)})`, background: soft.color }} />
      )}
      {children != null && <span className="an-bar-value num">{children}</span>}
    </div>
  );
}

/* ═════════════ 3. Cost by model ═════════════ */

export const CostByModel = memo(function CostByModel({ models }: { models: ModelRow[] }) {
  const max = Math.max(0, ...models.map((m) => m.cost));
  const { hostRef, bind, tip } = useHoverTip((k) => {
    const m = models.find((x) => x.label === k);
    if (!m) return null;
    return (
      <TipFrame head={m.label}>
        <div className="an-tip-total"><b className="num">{usd(m.cost)}</b> API-equivalent · {pct(m.share)}</div>
        <div className="an-tip-note">{tokens(m.output)} output tokens · {m.sessions} session{m.sessions === 1 ? '' : 's'}</div>
      </TipFrame>
    );
  });
  if (!models.length) return <div className="an-none">No token usage yet.</div>;
  return (
    <div className="an-bars" ref={hostRef}>
      {models.map((m) => (
        <div key={m.label} className="an-bar-row" tabIndex={0} {...bind(m.label)}>
          <span className="an-bar-label"><ModelTag model={m.model} /></span>
          <BarTrack value={m.cost} max={max} color="var(--series-1)">{usd(m.cost)}</BarTrack>
          <span className="an-bar-aside num">{pct(m.share)}</span>
        </div>
      ))}
      {tip}
    </div>
  );
});

/* ═════════════ 4. Tool mix ═════════════ */

export const ToolMix = memo(function ToolMix({ tools }: { tools: ToolRow[] }) {
  const max = Math.max(0, ...tools.map((t) => t.count));
  const { hostRef, bind, tip } = useHoverTip((k) => {
    const t = tools.find((x) => x.name === k);
    if (!t) return null;
    const other = t.name.endsWith('other tools');
    return (
      <TipFrame head={other ? t.name : fmtToolName(t.name)}>
        <div className="an-tip-total"><b className="num">{int(t.count)}</b> recent calls · {pct(t.share)}</div>
        <TipRow kind="icon" value={int(t.failed)} label={`failed${t.count ? ` · ${pct(t.failed / t.count)}` : ''}`} />
      </TipFrame>
    );
  });
  if (!tools.length) return <div className="an-none">No tool calls yet.</div>;
  return (
    <div className="an-bars" ref={hostRef}>
      {tools.map((t) => {
        const other = t.name.endsWith('other tools');
        return (
          <div key={t.name} className="an-bar-row" tabIndex={0} {...bind(t.name)}>
            <span className="an-bar-label an-tool-name" title={t.name}>{other ? 'Other' : fmtToolName(t.name)}</span>
            <BarTrack value={t.count} max={max} color={other ? 'var(--series-other)' : toolColor(t.name)}>{int(t.count)}</BarTrack>
            <span className="an-bar-aside num">{pct(t.share)}</span>
          </div>
        );
      })}
      {tip}
    </div>
  );
});

/* ═════════════ 5. Where sessions run ═════════════ */

export const HostSplit = memo(function HostSplit({ hosts }: { hosts: HostRow[] }) {
  const max = Math.max(0, ...hosts.map((h) => h.total));
  const { hostRef, bind, tip } = useHoverTip((k) => {
    const h = hosts.find((x) => x.label === k);
    if (!h) return null;
    return (
      <TipFrame head={h.label}>
        <div className="an-tip-total"><b className="num">{h.total}</b> session{h.total === 1 ? '' : 's'}</div>
        <TipRow color="var(--series-1)" value={h.live} label={`live${h.working ? ` · ${h.working} working` : ''}`} />
        {h.closed > 0 && <TipRow color="var(--series-1-soft)" value={h.closed} label="closed" />}
        {h.live > 0 && h.mem > 0 && <div className="an-tip-note">{Math.round(h.cpu)}% CPU · {(h.mem / 1024).toFixed(1)} GB memory</div>}
      </TipFrame>
    );
  });
  if (!hosts.length) return <div className="an-none">No sessions in range.</div>;
  const cpu = hosts.reduce((s, h) => s + h.cpu, 0);
  const mem = hosts.reduce((s, h) => s + h.mem, 0);
  const live = hosts.reduce((s, h) => s + h.live, 0);
  return (
    <>
    <div className="an-bars an-bars-tall" ref={hostRef}>
      {hosts.map((h) => (
        <div key={h.label} className="an-bar-row" tabIndex={0} {...bind(h.label)}>
          <span className="an-bar-label">{h.label}</span>
          <div className="an-bar-stack">
            <BarTrack value={h.live} max={max} color="var(--series-1)" soft={h.closed ? { value: h.closed, color: 'var(--series-1-soft)' } : undefined}>
              {h.total}
            </BarTrack>
            <span className="an-bar-sub">
              {h.live > 0 ? `${h.live} live${h.working ? `, ${h.working} working` : ''}` : 'Not running'}
              {h.live > 0 && h.mem > 0 ? ` · ${Math.round(h.cpu)}% CPU · ${(h.mem / 1024).toFixed(1)} GB` : ''}
            </span>
          </div>
        </div>
      ))}
      {tip}
    </div>
    {live > 0 && mem > 0 && (
      <div className="an-foot">
        <span>Live Claude processes use <b className="num">{Math.round(cpu)}%</b> CPU and <b className="num">{(mem / 1024).toFixed(1)} GB</b> of memory</span>
      </div>
    )}
    </>
  );
});

/* ═════════════ 6. Slowest tools (median to p90 on a log scale) ═════════════ */

const TIME_TICKS = [10, 100, 1000, 10_000, 60_000, 600_000, 3_600_000];
/** Domain ends can stop between decades so the plot isn't mostly empty */
const TIME_ENDS = [10, 30, 100, 300, 1000, 3000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000];
const tickName = (ms: number) => (ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${ms / 1000}s` : ms < 3_600_000 ? `${ms / 60_000}m` : `${ms / 3_600_000}h`);

export const SlowTools = memo(function SlowTools({ slow }: { slow: SlowRow[] }) {
  const lo0 = Math.min(...slow.map((s) => Math.max(1, s.median)));
  const hi0 = Math.max(...slow.map((s) => s.p90));
  const lo = [...TIME_ENDS].reverse().find((t) => t <= lo0) ?? TIME_ENDS[0];
  const hi = TIME_ENDS.find((t) => t >= hi0 && t > lo) ?? TIME_ENDS[TIME_ENDS.length - 1];
  const ticks = [...new Set([lo, ...TIME_TICKS.filter((t) => t > lo && t < hi), hi])];
  const L = (ms: number) => {
    const v = (Math.log10(Math.max(lo, Math.min(hi, ms))) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo) || 1);
    return `${(v * 100).toFixed(3)}%`;
  };
  const { hostRef, bind, tip } = useHoverTip((k) => {
    const s = slow.find((x) => x.name === k);
    if (!s) return null;
    return (
      <TipFrame head={fmtToolName(s.name)}>
        <div className="an-tip-total"><b className="num">{duration(s.median)}</b> median</div>
        <div className="an-tip-total"><b className="num">{duration(s.p90)}</b> 90th percentile</div>
        <div className="an-tip-note">From {s.n} finished calls</div>
      </TipFrame>
    );
  });
  if (!slow.length) return <div className="an-none">Not enough finished calls to time yet.</div>;
  return (
    <div className="an-slow" ref={hostRef}>
      <div className="an-slow-axis an-slow-top" aria-hidden>
        <span />
        <span />
        <span className="an-slow-vals-head"><span>Median</span><span>p90</span></span>
      </div>
      {slow.map((s) => {
        const c = toolColor(s.name);
        return (
          <div key={s.name} className="an-slow-row" tabIndex={0} {...bind(s.name)}>
            <span className="an-bar-label an-tool-name">{fmtToolName(s.name)}</span>
            <div className="an-slow-track">
              {ticks.map((t) => <span key={t} className="an-vgrid" style={{ left: L(t) }} />)}
              <span className="an-range" style={{ left: L(s.median), width: `calc(${L(s.p90)} - ${L(s.median)})`, background: c }} />
              <span className="an-p90" style={{ left: L(s.p90), background: c }} />
              <span className="an-median" style={{ left: L(s.median), background: c }} />
            </div>
            <span className="an-slow-vals num"><b>{duration(s.median)}</b><span>{duration(s.p90)}</span></span>
          </div>
        );
      })}
      <div className="an-slow-axis">
        <span />
        <div className="an-slow-ticks">
          {ticks.map((t) => <span key={t} style={{ left: L(t) }}>{tickName(t)}</span>)}
        </div>
        <span />
      </div>
      {tip}
    </div>
  );
});

/* ═════════════ Top sessions by cost ═════════════ */

export const TopSessions = memo(function TopSessions({ top, selectedId }: { top: TopRow[]; selectedId: string | null }) {
  const select = useStore.getState().select;
  const max = Math.max(0, ...top.map((t) => t.cost));
  if (!top.length) return <div className="an-none">No sessions in range.</div>;
  return (
    <div className="an-top" role="table" aria-label="Top sessions by API-equivalent cost">
      <div className="an-top-row an-top-head" role="row">
        <span role="columnheader">#</span>
        <span role="columnheader">Session</span>
        <span role="columnheader">Status</span>
        <span role="columnheader">Project</span>
        <span role="columnheader">Model</span>
        <span role="columnheader" className="r">Tool calls</span>
        <span role="columnheader" className="r">Output</span>
        <span role="columnheader" className="r">Cost</span>
      </div>
      {top.map((t, i) => <TopRowView key={t.s.id} rank={i + 1} row={t} max={max} selected={t.s.id === selectedId} onOpen={() => select(t.s.id, 'chat')} />)}
    </div>
  );
});

function TopRowView({ rank, row, max, selected, onOpen }: { rank: number; row: TopRow; max: number; selected: boolean; onOpen: () => void }) {
  const s: Session = row.s;
  return (
    <button className={`an-top-row${selected ? ' selected' : ''}`} role="row" onClick={onOpen} title="Open this session">
      <span className="an-rank num" role="cell">{rank}</span>
      <span className="an-top-title" role="cell">{truncate(sessionLabel(s), 80)}</span>
      <span role="cell"><StatusPill status={s.status} compact /></span>
      <span className="an-top-project" role="cell">
        <span className="an-key an-key-rect" style={{ background: projectFill(s.projectName) }} />
        {s.projectName}
      </span>
      <span role="cell"><ModelTag model={s.model} /></span>
      <span className="num r" role="cell">{int(s.counts.tools)}</span>
      <span className="num r" role="cell">{tokens(s.usage.output)}</span>
      <span className="an-top-cost r" role="cell">
        <span className="an-top-costbar"><span style={{ width: `${max ? (row.cost / max) * 100 : 0}%` }} /></span>
        <span className="num">{usd(row.cost)}</span>
      </span>
    </button>
  );
}
