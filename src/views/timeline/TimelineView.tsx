import { memo, useEffect, useMemo, useRef, type RefObject } from 'react';
import { create } from 'zustand';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronsRight, History, Radio, ZoomOut } from 'lucide-react';
import { useStore, useVisibleSessions } from '../../lib/store';
import { STATUS, toolColor } from '../../lib/theme';
import { clock, duration, modelInfo, sessionLabel, trimPath, truncate } from '../../lib/format';
import { Button, Empty, StatusDot, ToolChip } from '../../components/ui';
import { useNow } from '../../lib/hooks';
import { AXIS_H, GUTTER_W, buildLayout, windowStats, type Layout, type Row } from './model';
import { bucketFor, computeConc, drawFrame, hitTest, makeStripes, readPalette, type Conc, type Hit } from './draw';
import './timeline.css';

// ───────────── View state (outside React render so panning never re-renders the lanes) ─────────────

const MIN = 60_000;
const PRESETS = [
  { label: '5m', span: 5 * MIN },
  { label: '15m', span: 15 * MIN },
  { label: '30m', span: 30 * MIN },
  { label: '1h', span: 60 * MIN },
  { label: '3h', span: 180 * MIN },
  { label: '12h', span: 720 * MIN },
];
const MIN_SPAN = MIN;
const MAX_SPAN = 24 * 60 * MIN;
/** Breathing room right of the now line while live: a share of the window, at least LIVE_PAD_PX */
const LIVE_PAD = 0.05;
const LIVE_PAD_PX = 104;
let plotW = 1200;

type TipHit = Exclude<Hit, { kind: 'row' }>;
interface Tip { hit: TipHit; left: number; top: number; flip: boolean; below: boolean }

interface TlState {
  span: number;
  /** Right edge when paused */
  end: number;
  live: boolean;
  hoverKey: string | null;
  hoverId: string | null;
  tip: Tip | null;
  peak: number;
}

const useTl = create<TlState>(() => ({
  span: 30 * MIN, end: Date.now(), live: true, hoverKey: null, hoverId: null, tip: null, peak: 0,
}));

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const liveEnd = (now: number, span: number) => now + span * Math.max(LIVE_PAD, LIVE_PAD_PX / Math.max(400, plotW));

function windowAt(now: number) {
  const st = useTl.getState();
  const t1 = st.live ? liveEnd(now, st.span) : st.end;
  return { t0: t1 - st.span, t1, span: st.span };
}

/** Move the right edge; reaching now again resumes live */
function setEnd(end: number) {
  const { span } = useTl.getState();
  const at = liveEnd(Date.now(), span);
  if (end >= at - 1) useTl.setState({ live: true, end: at });
  else useTl.setState({ live: false, end });
}

function setSpan(span: number, anchorFrac = 0.5) {
  const st = useTl.getState();
  const next = clamp(span, MIN_SPAN, MAX_SPAN);
  if (st.live) {
    useTl.setState({ span: next });
    return;
  }
  const { t0 } = windowAt(Date.now());
  const anchor = t0 + anchorFrac * st.span;
  useTl.setState({ span: next });
  setEnd(anchor + (1 - anchorFrac) * next);
}

function setLive(on: boolean) {
  if (on) useTl.setState({ live: true });
  else useTl.setState({ live: false, end: windowAt(Date.now()).t1 });
}

function spanLabel(span: number): string {
  const m = Math.round(span / MIN);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = span / (60 * MIN);
  const hs = Number.isInteger(h) ? String(h) : h.toFixed(1);
  return `${hs} hour${h === 1 ? '' : 's'}`;
}

const fmtHM = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' });
const fmtDayHM = new Intl.DateTimeFormat([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
function rangeLabel(t0: number, t1: number): string {
  const today = new Date().toDateString();
  const f = (t: number) => (new Date(t).toDateString() === today ? fmtHM : fmtDayHM).format(t);
  return `${f(t0)} – ${f(t1)}`;
}

/** Stats for the visible window, recomputed only when the window moves noticeably */
function useWindowStats(layout: Layout) {
  const span = useTl((s) => s.span);
  const live = useTl((s) => s.live);
  const end = useTl((s) => s.end);
  const now = useNow(1000);
  const grain = span / 120;
  const t1 = live ? now : end;
  const q1 = Math.round(t1 / grain) * grain;
  const stats = useMemo(() => windowStats(layout.rows, q1 - span, q1), [layout, q1, span]);
  return { stats, t0: (live ? liveEnd(now, span) : end) - span, t1, span, live };
}

// ───────────── Canvas driver ─────────────

function useTimelineCanvas(canvasRef: RefObject<HTMLCanvasElement | null>, scrollRef: RefObject<HTMLDivElement | null>, layoutRef: RefObject<Layout>) {
  useEffect(() => {
    const canvas = canvasRef.current;
    const scroller = scrollRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !scroller || !ctx) return;
    // Coming back to the view always starts at now; the zoom level is kept
    useTl.setState({ live: true });
    const pal = readPalette();
    let w = 0, h = 0, dpr = 1, raf = 0;
    let stripes: CanvasPattern | null = null;
    let conc: Conc | null = null;
    let lastPeak = -1;

    const draw = () => {
      if (w < 2 || h < 2) return;
      const now = Date.now();
      const { t0, t1, span } = windowAt(now);
      const layout = layoutRef.current;
      const bucket = bucketFor(span);
      if (!conc || conc.bucket !== bucket || conc.layout !== layout || now - conc.at > 1000) conc = computeConc(layout, bucket, now);
      const st = useTl.getState();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const peak = Math.round(drawFrame({
        ctx, w, h, now, t0, t1, ppm: w / span, scrollTop: scroller.scrollTop, layout, pal,
        hoverKey: st.hoverKey, hoverId: st.hoverId, selectedId: useStore.getState().selectedId, conc, stripes,
      }));
      if (peak !== lastPeak) {
        lastPeak = peak;
        useTl.setState({ peak });
      }
    };
    const frame = () => {
      raf = requestAnimationFrame(frame);
      draw();
    };
    // Resizing clears the canvas, so redraw in the same callback (no blank frame while the drawer slides)
    const resize = () => {
      const nd = Math.min(2, window.devicePixelRatio || 1);
      const nw = Math.max(0, scroller.clientWidth - GUTTER_W);
      const nh = scroller.clientHeight;
      if (nw === w && nh === h && nd === dpr) return;
      dpr = nd; w = nw; h = nh;
      if (w > 0) plotW = w;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      stripes = makeStripes(ctx, pal.blocked, dpr);
      draw();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(scroller);
    resize();
    raf = requestAnimationFrame(frame);

    const local = (e: { clientX: number; clientY: number }) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const probe = (x: number, y: number) => {
      const now = Date.now();
      const { t0, span } = windowAt(now);
      return hitTest({ t0, ppm: w / span, now, layout: layoutRef.current, scrollTop: scroller.scrollTop }, x, y);
    };
    const clearHover = () => {
      const st = useTl.getState();
      if (st.hoverKey || st.hoverId || st.tip) useTl.setState({ hoverKey: null, hoverId: null, tip: null });
    };
    const hover = (x: number, y: number) => {
      const hit = probe(x, y);
      const hoverKey = hit?.rowKey ?? null;
      const hoverId = !hit || hit.kind === 'row' ? null
        : hit.kind === 'bar' ? hit.bar.id
        : hit.kind === 'mark' ? `m:${hit.mark.ts}:${hit.mark.role}`
        : `ag:${hit.span.agent.id}`;
      const tip: Tip | null = hit && hit.kind !== 'row'
        ? { hit, left: GUTTER_W + clamp(hit.x, 0, w), top: hit.y, flip: hit.x > w - 300, below: hit.y < 190 }
        : null;
      const st = useTl.getState();
      if (st.hoverKey !== hoverKey || st.hoverId !== hoverId || (tip && st.tip && Math.abs(st.tip.left - tip.left) > 0.5) || (!tip !== !st.tip)) {
        useTl.setState({ hoverKey, hoverId, tip });
      }
      canvas.style.cursor = hoverId ? 'pointer' : 'grab';
    };

    let drag: { x: number; y: number; end: number; scroll: number; moved: boolean } | null = null;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, end: windowAt(Date.now()).t1, scroll: scroller.scrollTop, moved: false };
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) > 4) {
          drag.moved = true;
          canvas.style.cursor = 'grabbing';
          clearHover();
        }
        if (drag.moved) {
          setEnd(drag.end - (dx * useTl.getState().span) / w);
          scroller.scrollTop = drag.scroll - dy;
        }
        return;
      }
      const p = local(e);
      hover(p.x, p.y);
    };
    const onUp = (e: PointerEvent) => {
      const d = drag;
      drag = null;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      if (!d) return;
      const p = local(e);
      if (d.moved) {
        hover(p.x, p.y);
        return;
      }
      const hit = probe(p.x, p.y);
      if (!hit?.sessionId) return;
      const sel = useStore.getState().select;
      if (hit.kind === 'bar') sel(hit.sessionId, hit.agent ? 'agents' : 'activity');
      else if (hit.kind === 'mark') sel(hit.sessionId, 'chat');
      else if (hit.kind === 'agent') sel(hit.sessionId, 'agents');
      else sel(hit.sessionId);
    };
    const onLeave = () => { if (!drag) clearHover(); };
    const onWheel = (e: WheelEvent) => {
      const st = useTl.getState();
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const { x } = local(e);
        setSpan(st.span * Math.exp(clamp(e.deltaY, -120, 120) * 0.0022), clamp(x / w, 0, 1));
        clearHover();
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        setEnd(windowAt(Date.now()).t1 + (d * st.span) / w);
        clearHover();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      const st = useTl.getState();
      const { t1 } = windowAt(Date.now());
      if (e.key === 'ArrowLeft') setEnd(t1 - st.span * 0.15);
      else if (e.key === 'ArrowRight') setEnd(t1 + st.span * 0.15);
      else if (e.key === '+' || e.key === '=') setSpan(st.span / 1.5, st.live ? 1 : 0.5);
      else if (e.key === '-' || e.key === '_') setSpan(st.span * 1.5, st.live ? 1 : 0.5);
      else return;
      e.preventDefault();
    };
    const onScroll = () => clearHover();

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('keydown', onKey);
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('keydown', onKey);
      scroller.removeEventListener('scroll', onScroll);
      useTl.setState({ hoverKey: null, hoverId: null, tip: null });
    };
  }, [canvasRef, scrollRef, layoutRef]);
}

// ───────────── Header ─────────────

function Header({ layout }: { layout: Layout }) {
  const { stats, t0, t1, span, live } = useWindowStats(layout);
  const preset = PRESETS.find((p) => Math.abs(p.span - span) < 1000);
  return (
    <header className="tl-head">
      <div className="tl-head-main">
        <div className="tl-window">
          <span className="tl-window-label">{live ? `Last ${spanLabel(span)}` : rangeLabel(t0, t1)}</span>
          {!live && <span className="tl-paused">Paused</span>}
        </div>
        <div className="tl-stats">
          <span><b className="num">{stats.calls}</b> tool calls</span>
          <span className="tl-stat-run"><span className="tl-stat-dot" /><b className="num">{stats.running}</b> running</span>
          <span className={stats.failed ? 'tl-stat-fail' : ''}><b className="num">{stats.failed}</b> failed</span>
          <span><b className="num">{stats.active}</b> of <b className="num">{layout.sessions}</b> sessions active</span>
        </div>
      </div>
      <div className="tl-head-tools">
        <span className="tl-hint">Drag to pan · Ctrl + scroll to zoom</span>
        <div className="segmented" role="radiogroup" aria-label="Time window">
          {PRESETS.map((p) => (
            <button key={p.label} role="radio" aria-checked={preset === p} className={preset === p ? 'on' : ''}
              onClick={() => setSpan(p.span, live ? 1 : 0.5)} title={`Show ${spanLabel(p.span)}`}>
              <span className="num">{p.label}</span>
            </button>
          ))}
        </div>
        <button className={`tl-live${live ? ' on' : ''}`} onClick={() => setLive(!live)} aria-pressed={live}
          title={live ? 'Pause: stop following now' : 'Follow now'}>
          <Radio size={14} />
          <span>Live</span>
        </button>
      </div>
    </header>
  );
}

// ───────────── Gutter ─────────────

function sameRow(a: Row, b: Row): boolean {
  if (a.kind !== b.kind || a.key !== b.key || a.h !== b.h) return false;
  if (a.kind === 'project' && b.kind === 'project') return a.count === b.count && a.live === b.live && a.working === b.working;
  if (a.kind === 'session' && b.kind === 'session') return a.session === b.session;
  if (a.kind === 'agent' && b.kind === 'agent') return a.lead.agent === b.lead.agent && a.spans.length === b.spans.length;
  return false;
}

const AGENT_STATE = { working: 'Running', done: 'Done', error: 'Failed' } as const;

const GutterRow = memo(function GutterRow({ row, selected }: { row: Row; selected: boolean }) {
  const hovered = useTl((s) => s.hoverKey === row.key);
  const enter = () => useTl.setState({ hoverKey: row.key });
  const leave = () => { if (useTl.getState().hoverKey === row.key) useTl.setState({ hoverKey: null }); };

  if (row.kind === 'project') {
    return (
      <div className={`tl-prow${row.y === 0 ? ' first' : ''}`} style={{ height: row.h }}>
        <span className="tl-pmark" style={{ background: row.color, boxShadow: `0 0 10px ${row.color}` }} />
        <span className="tl-pname">{row.name}</span>
        <span className="tl-pcount num">{row.count}</span>
      </div>
    );
  }
  const s = row.session;
  const cls = `${hovered ? ' hover' : ''}${selected ? ' selected' : ''}`;
  if (row.kind === 'session') {
    const st = STATUS[s.status];
    const host = s.control.managed ? 'Monitor' : s.process?.host;
    return (
      <button className={`tl-srow${cls}`} style={{ height: row.h }} onClick={() => useStore.getState().select(s.id)}
        onMouseEnter={enter} onMouseLeave={leave} title={`${sessionLabel(s)}\n${s.cwd ?? ''}`}>
        <StatusDot status={s.status} />
        <span className="tl-stext">
          <span className="tl-stitle">{sessionLabel(s)}</span>
          <span className="tl-smeta">
            <span className={`st-${s.status}`}>{st.label}</span>
            <span className="tl-sep">·</span>
            <span>{modelInfo(s.model).label}</span>
            {host && <><span className="tl-sep">·</span><span className="tl-host">{host}</span></>}
          </span>
        </span>
      </button>
    );
  }
  const a = row.lead.agent;
  const working = row.lead.end == null;
  const last = row.lane === row.lanes - 1;
  return (
    <button className={`tl-arow${cls}${last ? ' last' : ''}`} style={{ height: row.h }}
      onClick={() => useStore.getState().select(s.id, 'agents')} onMouseEnter={enter} onMouseLeave={leave}
      title={`${a.agentType}: ${a.description}`}>
      <span className="tl-tree" aria-hidden />
      <span className={`tl-atype${working ? ' working' : ''}`}>{a.agentType}</span>
      <span className={`tl-astate ag-${working ? 'working' : a.status}`}>{working ? 'Running' : AGENT_STATE[a.status]}</span>
      {row.spans.length > 1 && <span className="tl-amore num">+{row.spans.length - 1}</span>}
    </button>
  );
}, (a, b) => a.selected === b.selected && sameRow(a.row, b.row));

function Corner({ sessions }: { sessions: number }) {
  const peak = useTl((s) => s.peak);
  return (
    <div className="tl-corner" style={{ width: GUTTER_W, height: AXIS_H }}>
      <div className="tl-corner-conc" title="How many sessions were working at the same time, counting their sub-agents">
        <span>Working at once</span>
        <span className="tl-peak">peak <b className="num">{peak}</b></span>
      </div>
      <div className="tl-corner-label">
        <span>Sessions</span>
        <span className="num">{sessions}</span>
      </div>
    </div>
  );
}

// ───────────── Tooltip ─────────────

function Tooltip() {
  const tip = useTl((s) => s.tip);
  const session = useStore((s) => (tip ? s.sessions[tip.hit.sessionId] : undefined));
  const now = useNow(1000);
  if (!tip || !session) return null;
  const { hit } = tip;
  const style = { left: tip.left, top: tip.below ? tip.top + 30 : tip.top - 10 };
  const cls = `tl-tip${tip.flip ? ' flip' : ''}${tip.below ? ' below' : ''}`;
  const who = sessionLabel(session);

  if (hit.kind === 'bar') {
    const b = hit.bar;
    const running = b.end == null;
    const state = b.pending ? <span className="tl-tip-state st-blocked">Needs you</span>
      : running ? <span className="tl-tip-state st-working"><span className="pulse-dot" />Running</span>
      : b.ok === false ? <span className="tl-tip-state st-blocked">Failed</span>
      : b.ok === true ? <span className="tl-tip-state st-done">Done</span>
      : <span className="tl-tip-state">Ended</span>;
    return (
      <div className={cls} style={style}>
        <div className="tl-tip-head"><ToolChip name={b.name} />{state}</div>
        {b.detail && <div className="tl-tip-detail">{truncate(trimPath(b.detail), 220)}</div>}
        <div className="tl-tip-grid">
          <span>Started</span><span className="num">{clock(b.ts)}</span>
          <span>{running ? 'Running for' : 'Took'}</span><span className="num">{duration((b.end ?? now) - b.ts)}</span>
        </div>
        <div className="tl-tip-foot">{who}{hit.agent ? ` · ${hit.agent.agent.agentType} agent` : ''}</div>
      </div>
    );
  }
  if (hit.kind === 'mark') {
    const m = hit.mark;
    return (
      <div className={cls} style={style}>
        <div className="tl-tip-head">
          <span className="tl-tip-role">{m.role === 'user' ? '▲ Your prompt' : '● Claude replied'}</span>
          <span className="tl-tip-time num">{clock(m.ts)}</span>
        </div>
        <div className="tl-tip-text">{truncate(m.text, 240)}</div>
        <div className="tl-tip-foot">{who}</div>
      </div>
    );
  }
  const sp = hit.span;
  const a = sp.agent;
  const working = sp.end == null;
  return (
    <div className={cls} style={style}>
      <div className="tl-tip-head">
        <span className="tl-tip-agent">{a.agentType}</span>
        <span className={`tl-tip-state ${working ? 'st-working' : a.status === 'error' ? 'st-blocked' : 'st-done'}`}>
          {working && <span className="pulse-dot" />}{working ? 'Running' : AGENT_STATE[a.status]}
        </span>
      </div>
      <div className="tl-tip-text">{truncate(a.description, 200)}</div>
      <div className="tl-tip-grid">
        <span>Started</span><span className="num">{clock(sp.start)}</span>
        <span>{working ? 'Running for' : 'Took'}</span><span className="num">{duration((sp.end ?? now) - sp.start)}</span>
        <span>Tool calls</span><span className="num">{a.toolCount}</span>
      </div>
      <div className="tl-tip-foot">{who}</div>
    </div>
  );
}

// ───────────── Overlays ─────────────

function WindowEmpty({ layout }: { layout: Layout }) {
  const { stats, live } = useWindowStats(layout);
  const show = layout.sessions > 0 && stats.active === 0;
  return (
    <AnimatePresence>
      {show && (
        <motion.div className="tl-window-empty" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}>
          <div className="tl-we-title">Nothing happened in this window</div>
          <div className="tl-we-body">No tool calls or messages between these times. Zoom out to see more.</div>
          <div className="tl-we-actions">
            <Button size="sm" variant="secondary" icon={<ZoomOut size={14} />} onClick={() => setSpan(180 * MIN, live ? 1 : 0.5)}>Show 3 hours</Button>
            {!live && <Button size="sm" variant="ghost" onClick={() => setLive(true)}>Back to live</Button>}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function BackToLive() {
  const live = useTl((s) => s.live);
  return (
    <AnimatePresence>
      {!live && (
        <motion.div className="tl-back" initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 10 }}
          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}>
          <Button size="sm" variant="primary" icon={<ChevronsRight size={14} />} onClick={() => setLive(true)}>Back to live</Button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

const LEGEND: { label: string; tools: string[] }[] = [
  { label: 'Read', tools: ['Read'] },
  { label: 'Edit and write', tools: ['Edit', 'Write'] },
  { label: 'Run', tools: ['Bash'] },
  { label: 'Search', tools: ['Grep', 'Glob'] },
  { label: 'Agents', tools: ['Agent'] },
  { label: 'Web', tools: ['WebSearch'] },
  { label: 'Plan', tools: ['TodoWrite', 'Skill'] },
  { label: 'MCP', tools: ['mcp__'] },
  { label: 'Other', tools: [''] },
];

function Legend() {
  return (
    <footer className="tl-legend" aria-label="Legend">
      <div className="tl-legend-group">
        {LEGEND.map((l) => (
          <span key={l.label} className="tl-lg">
            <span className="tl-lg-sw">
              {l.tools.map((t) => <i key={t} style={{ background: toolColor(t || null) }} />)}
            </span>
            {l.label}
          </span>
        ))}
      </div>
      <div className="tl-legend-group">
        <span className="tl-lg"><span className="tl-lg-tri" />Your prompt</span>
        <span className="tl-lg"><span className="tl-lg-dot" />Claude replied</span>
        <span className="tl-lg"><span className="tl-lg-fail" />Failed</span>
        <span className="tl-lg"><span className="tl-lg-run" />Running</span>
        <span className="tl-lg"><span className="tl-lg-pend" />Needs you</span>
      </div>
    </footer>
  );
}

// ───────────── View ─────────────

export default function TimelineView() {
  const sessions = useVisibleSessions();
  const scope = useStore((s) => s.scope);
  const selectedId = useStore((s) => s.selectedId);
  const layout = useMemo(() => buildLayout(sessions), [sessions]);
  const layoutRef = useRef<Layout>(layout);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { layoutRef.current = layout; }, [layout]);
  useTimelineCanvas(canvasRef, scrollRef, layoutRef);

  return (
    <div className="tl">
      <Header layout={layout} />
      <div className="tl-body">
        <div className="tl-scroll" ref={scrollRef}>
          <div className="tl-sticky">
            <Corner sessions={layout.sessions} />
            <canvas ref={canvasRef} className="tl-canvas" style={{ left: GUTTER_W }} tabIndex={0}
              aria-label="Tool calls over time, one lane per session. Drag to pan, Ctrl and scroll to zoom, arrow keys to move." />
            <div className="tl-overlay" style={{ left: GUTTER_W, top: AXIS_H }}>
              <BackToLive />
              <div className="tl-we-wrap"><WindowEmpty layout={layout} /></div>
            </div>
            <Tooltip />
          </div>
          <div className="tl-rows" style={{ width: GUTTER_W, paddingTop: AXIS_H, minHeight: AXIS_H + layout.height + 40 }}>
            {layout.rows.map((r) => (
              <GutterRow key={r.key} row={r} selected={r.kind !== 'project' && r.session.id === selectedId} />
            ))}
          </div>
        </div>
        {!sessions.length && (
          <div className="tl-empty">
            <Empty icon={<History size={20} />} title={scope === 'live' ? 'No sessions are running' : 'No sessions to show'}>
              {scope === 'live'
                ? 'Start Claude Code anywhere and it shows up here. Switch to Recent to look back at earlier sessions.'
                : 'Nothing matches the current search or time range.'}
              {scope === 'live' && (
                <div className="tl-empty-act">
                  <Button size="sm" onClick={() => useStore.getState().setScope('recent')}>Show recent sessions</Button>
                </div>
              )}
            </Empty>
          </div>
        )}
      </div>
      <Legend />
    </div>
  );
}
