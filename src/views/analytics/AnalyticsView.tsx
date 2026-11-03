import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { animate, useMotionValue, useMotionValueEvent } from 'motion/react';
import { ChartColumn, Info } from 'lucide-react';
import { useStore, useVisibleSessions } from '../../lib/store';
import { duration, fmtToolName, modelInfo, sessionLabel, tokens, usd } from '../../lib/format';
import { Empty, Meter } from '../../components/ui';
import { aggregate, axisNum, int, pct, rangeLabel, type Analytics, type BucketRow } from './aggregate';
import {
  ActivityChart, ChartCard, CostByModel, HostSplit, LegendItem, SlowTools, TokensChart, ToolMix, TopSessions,
} from './charts';
import './analytics.css';

/** Hold a fast-changing value to one update per `ms`, but pass `resetKey` changes through at once */
function useThrottled<T>(value: T, ms: number, resetKey: string): T {
  const [held, setHeld] = useState(value);
  const last = useRef(0);
  const key = useRef(resetKey);
  useEffect(() => {
    const now = Date.now();
    if (key.current !== resetKey) {
      key.current = resetKey;
      last.current = now;
      setHeld(value);
      return;
    }
    const wait = last.current + ms - now;
    if (wait <= 0) {
      last.current = now;
      setHeld(value);
      return;
    }
    const t = setTimeout(() => { last.current = Date.now(); setHeld(value); }, wait);
    return () => clearTimeout(t);
  }, [value, ms, resetKey]);
  return held;
}

export default function AnalyticsView() {
  const visibleLive = useVisibleSessions();
  const allLive = useStore((s) => s.list);
  const scope = useStore((s) => s.scope);
  const query = useStore((s) => s.query);
  const windowHours = useStore((s) => s.control?.windowHours ?? 24);
  const selectedId = useStore((s) => s.selectedId);
  const reset = `${scope}|${query}|${windowHours}`;
  const visible = useThrottled(visibleLive, 2500, reset);
  const all = useThrottled(allLive, 2500, reset);

  const maxSpanH = scope === 'live' ? 24 : Math.min(192, Math.max(4, windowHours));
  const a = useMemo(() => aggregate(visible, all, maxSpanH), [visible, all, maxSpanH]);

  return (
    <div className="an">
      <Header a={a} scope={scope} query={query} windowHours={windowHours} total={allLive.length} />
      {a.sessions === 0 ? (
        <div className="an-empty">
          <Empty icon={<ChartColumn size={22} />} title={query ? 'No sessions match your search' : scope === 'live' ? 'No live sessions right now' : 'No sessions in this time range'}>
            {query ? 'Try a different search.' : scope === 'live'
              ? <>Numbers appear as soon as Claude starts working. <button className="link-btn strong" onClick={() => useStore.getState().setScope('recent')}>Show recent sessions</button></>
              : 'Try a longer time range in the top bar.'}
          </Empty>
        </div>
      ) : (
        <div className="an-grid">
          <KpiBand a={a} inRange={query ? a.sessions : Math.max(a.sessions, all.length)} />
          <Charts a={a} selectedId={selectedId} />
        </div>
      )}
    </div>
  );
}

/* ───────── Header ───────── */

function Header({ a, scope, query, windowHours, total }: { a: Analytics; scope: string; query: string; windowHours: number; total: number }) {
  const setScope = useStore.getState().setScope;
  const range = windowHours % 24 === 0 && windowHours > 24 ? `${windowHours / 24} days` : `${windowHours} hours`;
  return (
    <header className="an-head">
      <div>
        <h1 className="an-h1">Analytics</h1>
        <p className="an-scope">
          {scope === 'live' ? (
            <>
              <span className="an-live-dot" aria-hidden />
              <span><b className="num">{a.sessions}</b> live session{a.sessions === 1 ? '' : 's'}</span>
              <span className="an-dim">· updating as they work</span>
            </>
          ) : (
            <>
              <span>Last {range}</span>
              <span className="an-dim">· <b className="num">{a.sessions}</b> session{a.sessions === 1 ? '' : 's'}, {a.live} live</span>
            </>
          )}
          {query && <span className="an-dim">· matching “{query}”</span>}
        </p>
      </div>
      {scope === 'live' && total > a.sessions && (
        <button className="an-scope-btn" onClick={() => setScope('recent')}>
          Include closed sessions <span className="an-dim">· Recent shows {total}</span>
        </button>
      )}
    </header>
  );
}

/* ───────── KPI band ───────── */

function Num({ value, format }: { value: number; format: (n: number) => string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const mv = useMotionValue(value);
  const [first] = useState(() => format(value));
  useEffect(() => {
    const c = animate(mv, value, { duration: 0.9, ease: [0.16, 1, 0.3, 1] });
    return () => c.stop();
  }, [mv, value]);
  useMotionValueEvent(mv, 'change', (v) => {
    if (ref.current) ref.current.textContent = format(v);
  });
  return <span ref={ref}>{first}</span>;
}

/** 12-bucket column sparkline: history in the de-emphasis gray, the current bucket in the accent */
function MiniBars({ data, label }: { data: number[]; label: string }) {
  const max = Math.max(...data, 0);
  const w = 6;
  const gap = 3;
  const h = 28;
  return (
    <svg className="an-mini" width={data.length * (w + gap) - gap} height={h} role="img" aria-label={label}>
      {data.map((v, i) => {
        const bh = max > 0 && v > 0 ? Math.max(2, (v / max) * h) : 1.5;
        const last = i === data.length - 1;
        return <rect key={i} x={i * (w + gap)} y={h - bh} width={w} height={bh} rx={1.5} className={last ? 'cur' : v > 0 ? 'hist' : 'zero'} />;
      })}
    </svg>
  );
}

function Tile({ label, hint, children, viz, sub }: { label: string; hint?: string; children: ReactNode; viz?: ReactNode; sub?: ReactNode }) {
  return (
    <div className="an-tile" title={hint}>
      <div className="an-tile-label">{label}</div>
      <div className="an-tile-row">
        <div className="an-tile-value">{children}</div>
        {viz && <div className="an-tile-viz">{viz}</div>}
      </div>
      {sub && <div className="an-tile-sub">{sub}</div>}
    </div>
  );
}

const fmtInt = (n: number) => Math.round(n).toLocaleString();
const fmtPct = (n: number) => pct(n);
const fmtUsd = (n: number) => usd(n);
const fmtTok = (n: number) => tokens(Math.round(n));

const KpiBand = memo(function KpiBand({ a, inRange }: { a: Analytics; inRange: number }) {
  // Sparklines start at the first bucket with data (at least 6 bars, at most 12)
  const firstData = a.rows.findIndex((r) => r.tools > 0 || r.output > 0);
  const last12 = a.rows.slice(Math.min(Math.max(0, firstData), a.rows.length - 6)).slice(-12);
  const unit = a.bucketH === 1 ? 'hour' : `${a.bucketH} hours`;
  const cur = a.rows[a.rows.length - 1];
  const maxPart = Math.max(0, ...a.costParts.map((p) => p.cost));
  const perSession = a.sessions ? a.cost / a.sessions : 0;

  return (
    <section className="an-kpis" aria-label="Key numbers">
      <div className="an-hero">
        <div className="an-tile-label">
          API-equivalent cost
          <span className="an-info" title="What these tokens would cost at Anthropic API list prices. Subscription plans don't pay this."><Info size={13} /></span>
        </div>
        <div className="an-hero-value"><Num value={a.cost} format={fmtUsd} /></div>
        <div className="an-tile-sub">{usd(perSession)} per session on average · not billed on subscription plans</div>
        <div className="an-parts" aria-label="Cost by token type">
          <div className="an-parts-head">By token type</div>
          {a.costParts.map((p) => (
            <div key={p.key} className="an-part" title={p.hint}>
              <span className="an-part-label">{p.label}</span>
              <span className="an-part-track"><span style={{ width: `${maxPart ? (p.cost / maxPart) * 100 : 0}%` }} /></span>
              <span className="an-part-val num">{usd(p.cost)}</span>
              <span className="an-part-share num">{pct(p.share)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="an-tiles">
        <Tile label="Sessions" hint="Live sessions out of every session in the time range"
          viz={<MiniBars data={last12.map((r) => r.active)} label={`Sessions active per ${unit}`} />}
          sub={<>{a.working} working{a.blocked ? <> · <span className="an-needs">{a.blocked} need{a.blocked === 1 ? 's' : ''} you</span></> : null}{inRange > a.live ? <> · {inRange - a.live} closed</> : null}</>}>
          <Num value={a.live} format={fmtInt} /><span className="an-of">/{inRange}</span>
        </Tile>
        <Tile label="Tool calls" hint="Every tool call these sessions made"
          viz={<MiniBars data={last12.map((r) => r.tools)} label={`Tool calls per ${unit}`} />}
          sub={cur ? <>{int(cur.tools)} so far this {a.bucketH === 1 ? 'hour' : 'block'}</> : null}>
          <Num value={a.toolCalls} format={fmtInt} />
        </Tile>
        <Tile label="Error rate" hint="Share of tool calls that failed"
          viz={<MiniBars data={last12.map((r) => (r.tools ? r.errors / r.tools : 0))} label={`Error rate per ${unit}`} />}
          sub={<>{int(a.errors)} failed call{a.errors === 1 ? '' : 's'}</>}>
          <Num value={a.errorRate} format={fmtPct} />
        </Tile>
        <Tile label="Output tokens" hint="Tokens Claude wrote"
          viz={<MiniBars data={last12.map((r) => r.output)} label={`Output tokens per ${unit}`} />}
          sub={<>{tokens(a.prompt)} prompt tokens in</>}>
          <Num value={a.output} format={fmtTok} />
        </Tile>
        <Tile label="Cache hit rate" hint="Cache reads ÷ (fresh input + cache reads + cache writes)"
          sub="Prompt tokens re-read from the cache"
          viz={<div className="an-ratio" role="meter" aria-label="Cache hit rate" aria-valuenow={Math.round(a.cacheHit * 100)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${a.cacheHit * 100}%` }} /></div>}>
          <Num value={a.cacheHit} format={fmtPct} />
        </Tile>
        <Tile label="Average context fill" hint="How full each session's context window is, averaged"
          sub={a.ctxHot ? <span className="an-warn-text">{a.ctxHot} session{a.ctxHot === 1 ? '' : 's'} above 75%</span> : <>Across {a.ctxCount} open session{a.ctxCount === 1 ? '' : 's'}</>}
          viz={<div className="an-ctx-meter"><Meter value={a.ctxAvg * 1000} max={1000} /></div>}>
          <Num value={a.ctxAvg} format={fmtPct} />
        </Tile>
      </div>
    </section>
  );
});

/* ───────── Charts ───────── */

function busiest(rows: BucketRow[]) {
  let best: BucketRow | null = null;
  for (const r of rows) if (!best || r.tools > best.tools) best = r;
  return best && best.tools > 0 ? best : null;
}

const Charts = memo(function Charts({ a, selectedId }: { a: Analytics; selectedId: string | null }) {
  const unit = a.bucketH === 1 ? 'hour' : `${a.bucketH}-hour block`;
  const per = a.bucketH === 1 ? 'per hour' : `per ${a.bucketH} hours`;

  /* takeaways */
  const peak = busiest(a.rows);
  const peakTop = peak ? [...a.series].sort((x, y) => (peak[y.key] as number) - (peak[x.key] as number))[0] : null;
  const rangeErr = a.rows.reduce((s, r) => s + r.errors, 0);
  const rangeTools = a.rows.reduce((s, r) => s + r.tools, 0);
  const activityTake = peak
    ? <>Busiest {unit}: <b>{rangeLabel(peak).split(' – ')[0]}</b> with {int(peak.tools)} calls{peakTop && a.series.length > 1 ? <>, mostly {peakTop.name}</> : null}. {pct(rangeTools ? rangeErr / rangeTools : 0)} failed.</>
    : 'No tool calls in this range yet.';

  const outSum = a.rows.reduce((s, r) => s + r.output, 0);
  const inSum = a.rows.reduce((s, r) => s + r.input, 0);
  const tokensTake = outSum
    ? <>Claude wrote <b>{tokens(outSum)}</b> tokens and read {tokens(inSum)} prompt tokens, {Math.round(inSum / Math.max(1, outSum))}× as many. {pct(a.cacheHit)} of prompt tokens came from the cache.</>
    : 'No tokens in this range yet.';

  const m0 = a.models[0];
  const costTake = m0
    ? a.models.length === 1 ? <>All of it is <b>{m0.label}</b>.</> : <><b>{m0.label}</b> is {pct(m0.share)} of the API-equivalent cost.</>
    : undefined;

  const named = a.tools.filter((t) => !t.name.endsWith('other tools'));
  const toolTake = named.length >= 2
    ? <><b>{fmtToolName(named[0].name)}</b> and <b>{fmtToolName(named[1].name)}</b> are {pct(named[0].share + named[1].share)} of the last {int(a.toolSample)} calls.</>
    : named.length === 1 ? <>Every recent call is <b>{fmtToolName(named[0].name)}</b>.</> : undefined;

  const h0 = a.hosts[0];
  const hostTake = h0 ? <><b>{h0.total} of {a.sessions}</b> session{a.sessions === 1 ? '' : 's'} run in {h0.label}.</> : undefined;

  const s0 = a.slow[0];
  const slowTake = s0 ? <><b>{fmtToolName(s0.name)}</b> is slowest: half its calls take over {duration(s0.median)}, one in ten over {duration(s0.p90)}.</> : undefined;

  const top3 = a.top.slice(0, 3).reduce((s, t) => s + t.share, 0);
  const topTake = a.top.length > 3 ? <>The top 3 sessions are <b>{pct(top3)}</b> of the API-equivalent cost.</> : undefined;

  /* table twins */
  const timeTable = {
    columns: [{ label: 'From' }, ...a.series.map((s) => ({ label: s.name, num: true })), { label: 'Total', num: true }, { label: 'Failed', num: true }],
    rows: a.rows.filter((r) => r.tools > 0).map((r) => [rangeLabel(r), ...a.series.map((s) => int(r[s.key] as number)), int(r.tools), int(r.errors)]),
  };
  const tokTable = {
    columns: [{ label: 'From' }, { label: 'Output', num: true }, { label: 'Prompt', num: true }],
    rows: a.rows.filter((r) => r.output || r.input).map((r) => [rangeLabel(r), axisNum(r.output), axisNum(r.input)]),
  };

  return (
    <>
      <div className="an-cols">
        <div className="an-col an-col-main">
          <ChartCard index={1} title="Activity over time" takeaway={activityTake} table={timeTable}
            legend={a.series.map((s) => <LegendItem key={s.key} color={s.slot ? `var(--series-${s.slot})` : 'var(--series-other)'} label={s.name} />)}>
            <ActivityChart rows={a.rows} series={a.series} />
          </ChartCard>

          <ChartCard index={3} title={`Tokens ${per}`} takeaway={tokensTake} table={tokTable}>
            <TokensChart rows={a.rows} />
          </ChartCard>

          <ChartCard index={5} title="Slowest tools" takeaway={slowTake}
            legend={a.slow.length ? <>
              <span className="an-legend-item"><span className="an-key an-key-dot" style={{ background: 'var(--fg-2)' }} />Median</span>
              <span className="an-legend-item"><span className="an-key an-key-range" />Median to 90th percentile</span>
              <span className="an-legend-note">Log scale · recent finished calls</span>
            </> : undefined}
            table={{ columns: [{ label: 'Tool' }, { label: 'Median', num: true }, { label: '90th percentile', num: true }, { label: 'Calls timed', num: true }], rows: a.slow.map((s) => [fmtToolName(s.name), duration(s.median), duration(s.p90), s.n]) }}>
            <SlowTools slow={a.slow} />
          </ChartCard>
        </div>

        <div className="an-col an-col-side">
          <ChartCard index={2} title="Tool mix" takeaway={toolTake}
            table={{ columns: [{ label: 'Tool' }, { label: 'Recent calls', num: true }, { label: 'Share', num: true }, { label: 'Failed', num: true }], rows: a.tools.map((t) => [fmtToolName(t.name), int(t.count), pct(t.share), int(t.failed)]) }}>
            <div className="an-sub-caption">Recent calls, up to 150 per session</div>
            <ToolMix tools={a.tools} />
          </ChartCard>

          <ChartCard index={4} className="an-c-cost" title="Cost by model" takeaway={costTake}
            table={{ columns: [{ label: 'Model' }, { label: 'API-equivalent', num: true }, { label: 'Share', num: true }, { label: 'Output tokens', num: true }], rows: a.models.map((m) => [m.label, usd(m.cost), pct(m.share), tokens(m.output)]) }}>
            <div className="an-sub-caption">API-equivalent, at list prices</div>
            <CostByModel models={a.models} />
          </ChartCard>

          <ChartCard index={6} className="an-c-hosts" title="Where sessions run" takeaway={hostTake}
            legend={a.hosts.some((h) => h.closed) ? <>
              <LegendItem color="var(--series-1)" label="Live" />
              <LegendItem color="var(--series-1-soft)" label="Closed" />
            </> : undefined}
            table={{ columns: [{ label: 'Runs in' }, { label: 'Live', num: true }, { label: 'Closed', num: true }, { label: 'CPU', num: true }, { label: 'Memory', num: true }], rows: a.hosts.map((h) => [h.label, h.live, h.closed, `${Math.round(h.cpu)}%`, `${(h.mem / 1024).toFixed(1)} GB`]) }}>
            <HostSplit hosts={a.hosts} />
          </ChartCard>
        </div>
      </div>

      <ChartCard index={7} title="Top sessions by cost" takeaway={topTake}
        table={{ columns: [{ label: 'Session' }, { label: 'Project' }, { label: 'Model' }, { label: 'Tool calls', num: true }, { label: 'Output', num: true }, { label: 'API-equivalent', num: true }], rows: a.top.map((t) => [sessionLabel(t.s), t.s.projectName, modelInfo(t.s.model).label, int(t.s.counts.tools), tokens(t.s.usage.output), usd(t.cost)]) }}>
        <TopSessions top={a.top} selectedId={selectedId} />
      </ChartCard>
    </>
  );
});
