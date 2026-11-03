import { memo, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { motion } from 'motion/react';
import {
  AppWindow, ArrowDown, ArrowUp, ArrowUpDown, Check, CircleStop, Eye, GitBranch, Hand, Inbox, Pause,
  PanelRightOpen, Play, ShieldAlert, ShieldCheck, X,
} from 'lucide-react';
import type { Session, SessionStatus } from '../../types';
import { useStore, useVisibleSessions } from '../../lib/store';
import { costByModel, contextWindow } from '../../lib/pricing';
import { modelInfo, sessionLabel, timeAgo, trimPath, usd } from '../../lib/format';
import { STATUS } from '../../lib/theme';
import { Empty, Kbd, Meter, ModelTag, StatusPill, ToolChip } from '../../components/ui';
import { useNow } from '../../lib/hooks';
import './classic.css';

/* ───────── Sorting ───────── */

type SortKey = 'status' | 'title' | 'where' | 'model' | 'activity' | 'tools' | 'agents' | 'context' | 'cost' | 'last' | 'control';
type Dir = 'asc' | 'desc';
interface Sort { key: SortKey; dir: Dir }

const PRIORITY: Record<SessionStatus, number> = { blocked: 0, working: 1, waiting: 2, idle: 3 };
const priority = (s: Session) => (s.control.pending ? 0 : PRIORITY[s.status]);

function whereOf(s: Session): string {
  if (s.control.managed) return 'In monitor';
  if (s.process) return s.process.kind === 'background' ? 'Background' : s.process.host || 'Unknown';
  return '';
}
const ctxRatio = (s: Session) => s.contextTokens / contextWindow(s.model);
const controlRank = (s: Session) => (s.control.managed ? 0 : s.control.hooks ? 1 : s.live ? 2 : 3);
const agentsWorking = (s: Session) => s.agents.filter((a) => a.status === 'working').length;

const VALUE: Record<SortKey, (s: Session) => number | string> = {
  status: priority,
  title: (s) => sessionLabel(s).toLowerCase(),
  where: (s) => whereOf(s).toLowerCase() || '~',
  model: (s) => modelInfo(s.model).label,
  activity: (s) => s.lastActivity ?? 0,
  tools: (s) => s.counts.tools,
  agents: (s) => agentsWorking(s) * 1000 + s.agents.length,
  context: ctxRatio,
  cost: (s) => costByModel(s.usageByModel),
  last: (s) => s.lastActivity ?? 0,
  control: controlRank,
};

/** Natural first direction when a column is picked: text and status ascending, amounts descending */
const FIRST_DIR: Record<SortKey, Dir> = {
  status: 'asc', title: 'asc', where: 'asc', model: 'asc', control: 'asc',
  activity: 'desc', tools: 'desc', agents: 'desc', context: 'desc', cost: 'desc', last: 'desc',
};

const byDefault = (a: Session, b: Session) => priority(a) - priority(b) || (b.lastActivity ?? 0) - (a.lastActivity ?? 0);

function sortSessions(list: Session[], sort: Sort): Session[] {
  const get = VALUE[sort.key];
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    const va = get(a);
    const vb = get(b);
    const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
    return c * sign || byDefault(a, b);
  });
}

/* ───────── Columns ───────── */

interface Col { key: SortKey; label: string; cls: string; num?: boolean; hint?: string }
const COLS: Col[] = [
  { key: 'status', label: 'Status', cls: 'c-status', hint: 'Needs you first, then working, your turn and closed' },
  { key: 'title', label: 'Session', cls: 'c-title' },
  { key: 'where', label: 'Runs in', cls: 'c-where' },
  { key: 'model', label: 'Model', cls: 'c-model' },
  { key: 'activity', label: 'Doing now', cls: 'c-activity' },
  { key: 'tools', label: 'Tool calls', cls: 'c-tools', num: true },
  { key: 'agents', label: 'Agents', cls: 'c-agents', num: true, hint: 'Working now / all sub-agents' },
  { key: 'context', label: 'Context', cls: 'c-context', hint: 'How full the context window is' },
  { key: 'cost', label: 'Cost', cls: 'c-cost', num: true, hint: 'API-equivalent cost. Subscription plans don’t pay this.' },
  { key: 'last', label: 'Last active', cls: 'c-last', num: true },
  { key: 'control', label: 'Control', cls: 'c-control' },
];

type Density = 'comfortable' | 'compact';

function readPref<T extends string>(key: string, fallback: T, ok: (v: string) => boolean): T {
  try {
    const v = localStorage.getItem(key);
    return v && ok(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}
function writePref(key: string, v: string) {
  try { localStorage.setItem(key, v); } catch { /* storage unavailable */ }
}

/* ───────── View ───────── */

export default function ClassicView() {
  const visible = useVisibleSessions();
  const scope = useStore((s) => s.scope);
  const query = useStore((s) => s.query);
  const selectedId = useStore((s) => s.selectedId);
  const [sort, setSort] = useState<Sort>(() => {
    const key = readPref<SortKey>('csm.table.sort', 'status', (v) => v in VALUE);
    const dir = readPref<Dir>('csm.table.dir', FIRST_DIR[key], (v) => v === 'asc' || v === 'desc');
    return { key, dir };
  });
  const [density, setDensity] = useState<Density>(() => readPref<Density>('csm.table.density', 'comfortable', (v) => v === 'comfortable' || v === 'compact'));
  const [cursor, setCursor] = useState<string | null>(null);
  /** Row order captured when the pointer entered the rows; null when not holding */
  const [held, setHeld] = useState<string[] | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const sorted = useMemo(() => sortSessions(visible, sort), [visible, sort]);

  // While the pointer is over the rows, keep their order so click targets don't move
  const rows = useMemo(() => {
    if (!held) return sorted;
    const byId = new Map(sorted.map((s) => [s.id, s]));
    const kept = held.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
    const known = new Set(held);
    return [...kept, ...sorted.filter((s) => !known.has(s.id))];
  }, [sorted, held]);
  const orderHeld = !!held && rows.some((s, i) => sorted[i]?.id !== s.id);

  const counts = useMemo(() => {
    const c = { blocked: 0, working: 0, waiting: 0, idle: 0 } as Record<SessionStatus, number>;
    for (const s of visible) c[s.control.pending ? 'blocked' : s.status]++;
    return c;
  }, [visible]);

  const pickSort = (key: SortKey) => {
    const next: Sort = sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: FIRST_DIR[key] };
    setSort(next);
    writePref('csm.table.sort', next.key);
    writePref('csm.table.dir', next.dir);
  };
  const pickDensity = (d: Density) => { setDensity(d); writePref('csm.table.density', d); };

  const moveTo = (id: string | undefined) => {
    if (!id) return;
    setCursor(id);
    // When the drawer is already open it follows the keyboard
    const st = useStore.getState();
    if (st.selectedId && st.selectedId !== id) st.select(id);
    requestAnimationFrame(() => {
      scrollRef.current?.querySelector(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.target as HTMLElement).closest('button, a, input, textarea, select') && e.key === 'Enter') return;
    const ids = rows.map((s) => s.id);
    if (!ids.length) return;
    const at = cursor ? ids.indexOf(cursor) : -1;
    if (e.key === 'ArrowDown') { e.preventDefault(); moveTo(ids[Math.min(ids.length - 1, at + 1)]); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveTo(ids[Math.max(0, at < 0 ? 0 : at - 1)]); }
    else if (e.key === 'Home') { e.preventDefault(); moveTo(ids[0]); }
    else if (e.key === 'End') { e.preventDefault(); moveTo(ids[ids.length - 1]); }
    else if (e.key === 'Enter' && cursor) { e.preventDefault(); useStore.getState().select(cursor, 'chat'); }
  };

  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (!cursor || !rows.some((s) => s.id === cursor)) setCursor(selectedId && rows.some((s) => s.id === selectedId) ? selectedId : rows[0]?.id ?? null);
  };

  const open = (id: string) => { setCursor(id); useStore.getState().select(id, 'chat'); };

  return (
    <div className={`tb tb-${density}`}>
      <header className="tb-head">
        <div className="tb-head-text">
          <h1 className="tb-h1">Sessions</h1>
          <div className="tb-counts" aria-label="Sessions by status">
            {(['blocked', 'working', 'waiting', 'idle'] as SessionStatus[]).filter((k) => counts[k] > 0).map((k) => (
              <span key={k} className={`tb-count st-${k}`}>
                <span className="status-dot" />
                <b className="num">{counts[k]}</b>
                <span>{k === 'blocked' ? (counts[k] === 1 ? 'needs you' : 'need you') : STATUS[k].label.toLowerCase()}</span>
              </span>
            ))}
            {!visible.length && <span className="tb-count-none">Nothing to show</span>}
          </div>
        </div>
        <div className="tb-tools">
          <span className={`tb-held${orderHeld ? ' show' : ''}`} aria-live="polite">
            <Hand size={13} /> Order held while you point
          </span>
          <div className="segmented" role="radiogroup" aria-label="Row height">
            {(['comfortable', 'compact'] as Density[]).map((d) => (
              <button key={d} role="radio" aria-checked={density === d} className={density === d ? 'on' : ''} onClick={() => pickDensity(d)}>
                {d === 'comfortable' ? 'Comfortable' : 'Compact'}
              </button>
            ))}
          </div>
        </div>
      </header>

      {visible.length === 0 ? (
        <div className="tb-panel tb-panel-empty">
          <Empty icon={<Inbox size={22} />} title={query ? `No sessions match “${query}”` : scope === 'live' ? 'No live sessions right now' : 'No sessions in this time range'}>
            {query ? 'Try a different search.' : scope === 'live'
              ? <>Start one with <b>New session</b>, or <button className="link-btn strong" onClick={() => useStore.getState().setScope('recent')}>show recent sessions</button>.</>
              : 'Try a longer time range in the top bar.'}
          </Empty>
        </div>
      ) : (
        <div className="tb-panel">
          <motion.div
            layoutScroll
            ref={scrollRef}
            className="tb-scroll"
            role="grid"
            aria-label="Sessions"
            aria-rowcount={rows.length + 1}
            aria-activedescendant={cursor ? `tb-row-${cursor}` : undefined}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onFocus={onFocus}
          >
            <div className="tb-row tb-header" role="row">
              {COLS.map((c) => {
                const active = sort.key === c.key;
                return (
                  <div key={c.key} role="columnheader" className={`tb-cell ${c.cls}${c.num ? ' num-col' : ''}`}
                    aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                    <button className={`tb-sort${active ? ' on' : ''}`} onClick={() => pickSort(c.key)} title={c.hint ?? `Sort by ${c.label.toLowerCase()}`}>
                      <span>{c.label}</span>
                      {active ? (sort.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : <ArrowUpDown size={12} className="tb-sort-idle" />}
                    </button>
                  </div>
                );
              })}
            </div>
            <div onPointerEnter={() => setHeld(rows.map((s) => s.id))} onPointerLeave={() => setHeld(null)}>
              {rows.map((s, i) => (
                <Row key={s.id} s={s} index={i} selected={s.id === selectedId} cursor={s.id === cursor} onOpen={open} />
              ))}
            </div>
          </motion.div>
          <footer className="tb-foot">
            <span><b className="num">{rows.length}</b> session{rows.length === 1 ? '' : 's'} · sorted by {COLS.find((c) => c.key === sort.key)?.label.toLowerCase()}{sort.key === 'status' && sort.dir === 'asc' ? ', most urgent first' : ''}</span>
            <span className="tb-keys"><Kbd>↑</Kbd><Kbd>↓</Kbd> move <Kbd>Enter</Kbd> open <Kbd>Esc</Kbd> close</span>
          </footer>
        </div>
      )}
    </div>
  );
}

/* ───────── Row ───────── */

const Row = memo(function Row({ s, index, selected, cursor, onOpen }: {
  s: Session; index: number; selected: boolean; cursor: boolean; onOpen: (id: string) => void;
}) {
  const ratio = ctxRatio(s);
  const working = agentsWorking(s);
  const cost = costByModel(s.usageByModel);
  const pending = s.control.pending;
  const cls = [
    'tb-row', 'tb-body-row',
    selected && 'selected', cursor && 'cursor', pending && 'pending',
    s.status === 'idle' && 'closed',
  ].filter(Boolean).join(' ');

  return (
    <motion.div
      layout="position"
      transition={{ layout: { duration: 0.38, ease: [0.16, 1, 0.3, 1] } }}
      id={`tb-row-${s.id}`}
      data-id={s.id}
      role="row"
      aria-rowindex={index + 2}
      aria-selected={selected}
      className={cls}
      onClick={() => onOpen(s.id)}
    >
      <div role="gridcell" className="tb-cell c-status">
        <StatusPill status={pending ? 'blocked' : s.status} compact />
      </div>
      <div role="gridcell" className="tb-cell c-title">
        <div className="tb-title" title={sessionLabel(s)}>{sessionLabel(s)}</div>
        <div className="tb-sub">
          <span className="tb-project">{s.projectName}</span>
          {s.gitBranch && <span className="tb-branch"><GitBranch size={11} />{s.gitBranch}</span>}
        </div>
      </div>
      <div role="gridcell" className="tb-cell c-where"><Where s={s} /></div>
      <div role="gridcell" className="tb-cell c-model"><ModelTag model={s.model} /></div>
      <div role="gridcell" className="tb-cell c-activity"><Doing s={s} /></div>
      <div role="gridcell" className="tb-cell c-tools num-col">
        <span className="num" title={s.counts.errors ? `${s.counts.errors} failed` : undefined}>{s.counts.tools.toLocaleString()}</span>
      </div>
      <div role="gridcell" className="tb-cell c-agents num-col">
        {s.agents.length ? (
          <span className="num tb-agents" title={`${working} working of ${s.agents.length} sub-agents`}>
            <b className={working ? 'on' : ''}>{working}</b><span>/{s.agents.length}</span>
          </span>
        ) : <span className="tb-none">—</span>}
      </div>
      <div role="gridcell" className="tb-cell c-context" title={`${Math.round(s.contextTokens / 1000)}K of ${Math.round(contextWindow(s.model) / 1000)}K tokens`}>
        {s.contextTokens > 0 ? (
          <>
            <div className="tb-meter"><Meter value={s.contextTokens} max={contextWindow(s.model)} /></div>
            <span className="num tb-pct">{Math.round(ratio * 100)}%</span>
          </>
        ) : <span className="tb-none">—</span>}
      </div>
      <div role="gridcell" className="tb-cell c-cost num-col"><span className="num">{usd(cost)}</span></div>
      <div role="gridcell" className="tb-cell c-last num-col"><span className="num tb-ago"><Ago ts={s.lastActivity} /></span></div>
      <div role="gridcell" className="tb-cell c-control"><ControlBadge s={s} /></div>
      <Actions s={s} onOpen={onOpen} />
    </motion.div>
  );
});

function Ago({ ts }: { ts: number | null }) {
  const now = useNow(1000);
  return <>{timeAgo(ts, now)}</>;
}

function Where({ s }: { s: Session }) {
  if (s.control.managed) return <span className="tb-host monitor">In monitor</span>;
  if (!s.process) return <span className="tb-none">{s.live ? 'Running' : 'Not running'}</span>;
  return (
    <span className="tb-where">
      <span className="tb-host">{s.process.kind === 'background' ? 'Background' : s.process.host}</span>
      <span className="tb-pid num">{s.process.pid}</span>
    </span>
  );
}

function Doing({ s }: { s: Session }) {
  const p = s.control.pending;
  const paused = s.control.paused ? <span className="flag flag-warn tb-flag">Paused</span> : null;
  if (p) {
    return (
      <span className="tb-doing ask">
        <ShieldAlert size={13} className="tb-ask-icon" />
        <span className="tb-ask">Wants to run</span>
        <ToolChip name={p.toolName} />
        <span className="tb-detail" title={p.detail}>{trimPath(p.detail)}</span>
      </span>
    );
  }
  if (s.status === 'working') {
    const t = s.currentTool;
    return (
      <span className="tb-doing">
        {paused}
        <span className="pulse-dot" />
        {t ? (
          <>
            <ToolChip name={t.name} faded={t.endTs != null} />
            <span className="tb-detail" title={t.detail}>{trimPath(t.detail)}</span>
          </>
        ) : <span className="tb-detail tb-quiet">Thinking</span>}
      </span>
    );
  }
  return (
    <span className="tb-doing tb-quiet">
      {paused}
      <span>{s.status === 'waiting' ? 'Finished its turn' : 'Closed'}</span>
      <span className="tb-ago-inline num"><Ago ts={s.lastActivity} /></span>
    </span>
  );
}

function ControlBadge({ s }: { s: Session }) {
  if (s.control.managed) return <span className="tb-ctl managed" title="The monitor runs this session: full control"><AppWindow size={13} />In monitor</span>;
  if (s.control.hooks) return <span className="tb-ctl on" title="Hooks reach this session: approve, pause, stop and message"><ShieldCheck size={13} />Control on</span>;
  if (!s.live) return <span className="tb-none" title="Not running">—</span>;
  return <span className="tb-ctl" title="Turn on session control to steer sessions started outside the monitor"><Eye size={13} />Watch only</span>;
}

/* ───────── Row actions ───────── */

function Act({ label, icon, onClick, disabled, why, variant = 'ghost', text }: {
  label: string; icon: ReactNode; onClick: () => void; disabled?: boolean; why?: string; variant?: 'ghost' | 'allow' | 'deny'; text?: boolean;
}) {
  return (
    <button
      tabIndex={-1}
      className={`tb-act tb-act-${variant}${text ? ' text' : ''}`}
      aria-label={label}
      aria-disabled={disabled || undefined}
      title={disabled ? why : label}
      onClick={(e: MouseEvent) => { e.stopPropagation(); if (!disabled) onClick(); }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); }}
    >
      {icon}
      {text && <span>{label}</span>}
    </button>
  );
}

function Actions({ s, onOpen }: { s: Session; onOpen: (id: string) => void }) {
  const { approve, pause, stop } = useStore.getState();
  const p = s.control.pending;
  const canSteer = s.control.managed || s.control.hooks;
  const running = s.status === 'working' || s.status === 'blocked';
  const noControl = 'Turn on session control to steer sessions started outside the monitor';

  let pauseWhy: string | undefined;
  if (!s.live) pauseWhy = 'Not running';
  else if (s.control.managed) pauseWhy = 'Sessions running in the monitor can be stopped instead';
  else if (!canSteer) pauseWhy = noControl;

  let stopWhy: string | undefined;
  if (!s.live && !s.control.managed) stopWhy = 'Not running';
  else if (!canSteer) stopWhy = noControl;
  else if (!running) stopWhy = 'Nothing to stop: Claude isn’t running a turn';

  return (
    <div className="tb-actions" role="gridcell" aria-label="Actions">
      {p && (
        <>
          <Act text variant="allow" label="Allow" icon={<Check size={13} />} onClick={() => approve(s.id, true)}
            disabled={!p.held} why={`The hold expired, so answer in ${s.process?.host ?? 'the terminal'}`} />
          <Act text variant="deny" label="Deny" icon={<X size={13} />} onClick={() => approve(s.id, false)}
            disabled={!p.held} why={`The hold expired, so answer in ${s.process?.host ?? 'the terminal'}`} />
          <span className="tb-act-sep" />
        </>
      )}
      <span className="tb-more">
      <Act label={s.control.paused ? 'Resume' : 'Pause'} icon={s.control.paused ? <Play size={14} /> : <Pause size={14} />}
        onClick={() => pause(s.id, !s.control.paused)} disabled={!!pauseWhy} why={pauseWhy} />
      <Act label="Stop turn" icon={<CircleStop size={14} />} onClick={() => stop(s.id)} disabled={!!stopWhy} why={stopWhy} />
      <Act label="Open" icon={<PanelRightOpen size={14} />} onClick={() => onOpen(s.id)} />
      </span>
    </div>
  );
}
