import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { History, LayoutGrid, MonitorDot, Plus, SearchX, Server, SquareCode, SquareTerminal, Cpu } from 'lucide-react';
import type { Session, SessionStatus } from '../../types';
import { useStore, useVisibleSessions } from '../../lib/store';
import { costByModel } from '../../lib/pricing';
import { projectColor } from '../../lib/theme';
import { usd } from '../../lib/format';
import { Button, Empty, Sparkline } from '../../components/ui';
import { SessionConsole } from './SessionConsole';
import './command.css';

type GroupBy = 'none' | 'project' | 'host';
type Density = 'comfortable' | 'compact';

const EASE_OUT = [0.16, 1, 0.3, 1] as const;
const EASE_IN = [0.6, 0, 0.9, 0.35] as const;

/* ───────────── Ordering & grouping ───────────── */

/** Needs you first, then working, your turn, closed */
function rank(s: Session): number {
  if (s.control.pending || s.status === 'blocked') return 0;
  return { working: 1, waiting: 2, idle: 3, blocked: 0 }[s.status];
}

/** Stable inside a status band: project, then start time, never last activity */
function compare(a: Session, b: Session): number {
  return rank(a) - rank(b)
    || a.projectName.localeCompare(b.projectName)
    || (a.startedAt ?? 0) - (b.startedAt ?? 0)
    || a.id.localeCompare(b.id);
}

function hostGroup(s: Session): string {
  if (s.control.managed) return 'In monitor';
  if (s.process?.kind === 'background') return 'Background';
  if (s.process) return s.process.host || 'Unknown app';
  return s.live ? 'Unknown app' : 'Not running';
}

interface Group {
  key: string;
  label: string;
  ids: string[];
  /** blocked, working, waiting, idle */
  counts: [number, number, number, number];
}

function buildGroups(list: Session[], by: GroupBy): Group[] {
  const sorted = [...list].sort(compare);
  const map = new Map<string, Group>();
  for (const s of sorted) {
    const label = by === 'none' ? '' : by === 'project' ? s.projectName : hostGroup(s);
    let g = map.get(label);
    if (!g) {
      g = { key: `${by}:${label}`, label, ids: [], counts: [0, 0, 0, 0] };
      map.set(label, g);
    }
    g.ids.push(s.id);
    g.counts[rank(s)] += 1;
  }
  const groups = [...map.values()];
  // Groups with live sessions first, then by name, so headers stay put
  const live = (g: Group) => g.counts[3] === g.ids.length ? 1 : 0;
  return groups.sort((a, b) => live(a) - live(b) || a.label.localeCompare(b.label));
}

/* ───────────── Preferences ───────────── */

function usePref<T extends string>(key: string, fallback: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      return (localStorage.getItem(key) as T) || fallback;
    } catch {
      return fallback;
    }
  });
  const set = (next: T) => {
    setV(next);
    try {
      localStorage.setItem(key, next);
    } catch {
      /* storage unavailable */
    }
  };
  return [v, set];
}

/* ───────────── View ───────────── */

export default function CommandView() {
  const visible = useVisibleSessions();
  const scope = useStore((s) => s.scope);
  const query = useStore((s) => s.query);
  const [groupBy, setGroupBy] = usePref<GroupBy>('csm.command.group', 'none');
  const [density, setDensity] = usePref<Density>('csm.command.density', 'comfortable');

  // The board only re-renders when order or grouping changes, not on every tick
  const sig = JSON.stringify(buildGroups(visible, groupBy));
  const groups = useMemo(() => JSON.parse(sig) as Group[], [sig]);

  const compact = density === 'compact';

  return (
    <div className={`cmd${compact ? ' is-compact' : ''}`}>
      <div className="cmd-top">
        <Kpis visible={visible} />
        <div className="cmd-bar">
          <div className="cmd-bar-title">
            Sessions <span className="cmd-bar-count num">{visible.length}</span>
          </div>
          <span className="cmd-bar-hint">Needs you first, then working, your turn and closed</span>
          <div className="spacer" />
          <Segmented label="Group by" value={groupBy} onChange={setGroupBy}
            options={[['none', 'None'], ['project', 'Project'], ['host', 'Where it runs']]} />
          <Segmented label="Density" value={density} onChange={setDensity}
            options={[['comfortable', 'Comfortable'], ['compact', 'Compact']]} />
        </div>
      </div>

      <div className="cmd-scroll">
        {visible.length === 0
          ? <EmptyBoard scope={scope} query={query} />
          : <Board groups={groups} compact={compact} grouped={groupBy !== 'none'} groupBy={groupBy} />}
      </div>
    </div>
  );
}

function Segmented<T extends string>({ label, value, onChange, options }: {
  label: string; value: T; onChange: (v: T) => void; options: [T, string][];
}) {
  return (
    <div className="cmd-seg">
      <span className="cmd-seg-label">{label}</span>
      <div className="segmented" role="radiogroup" aria-label={label}>
        {options.map(([v, text]) => (
          <button key={v} role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ───────────── KPIs ───────────── */

function jumpTo(id: string | undefined) {
  if (!id) return;
  const el = document.getElementById(`cc-${id}`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('is-flash');
  void el.offsetWidth;
  el.classList.add('is-flash');
}

function Kpis({ visible }: { visible: Session[] }) {
  const k = useMemo(() => {
    let working = 0, blocked = 0, waiting = 0, live = 0, cost = 0;
    let firstWorking: string | undefined, firstBlocked: string | undefined, firstWaiting: string | undefined;
    const act = new Array<number>(60).fill(0);
    for (const s of [...visible].sort(compare)) {
      if (s.live) live++;
      if (s.control.pending || s.status === 'blocked') { blocked++; firstBlocked ??= s.id; }
      else if (s.status === 'working') { working++; firstWorking ??= s.id; }
      else if (s.status === 'waiting') { waiting++; firstWaiting ??= s.id; }
      cost += costByModel(s.usageByModel);
      const off = 60 - s.activity.length;
      s.activity.forEach((v, i) => { if (i + off >= 0) act[i + off] += v; });
    }
    const calls = act.reduce((a, b) => a + b, 0);
    const lastTen = act.slice(-10).reduce((a, b) => a + b, 0);
    return { working, blocked, waiting, live, cost, act, calls, lastTen, firstWorking, firstBlocked, firstWaiting };
  }, [visible]);

  return (
    <div className="cmd-kpis" role="group" aria-label="Overview">
      <Kpi tone="working" label="Working now" value={k.working} sub={`of ${k.live} live`} onClick={k.firstWorking ? () => jumpTo(k.firstWorking) : undefined} />
      <Kpi tone="blocked" label="Needs you" value={k.blocked} sub={k.blocked ? 'waiting on a decision' : 'all clear'} alert={k.blocked > 0}
        onClick={k.firstBlocked ? () => jumpTo(k.firstBlocked) : undefined} />
      <Kpi tone="waiting" label="Your turn" value={k.waiting} sub={k.waiting ? 'ready for a message' : 'none waiting'} onClick={k.firstWaiting ? () => jumpTo(k.firstWaiting) : undefined} />
      <Kpi label="Tool calls · last hour" value={k.calls.toLocaleString()} sub={`${k.lastTen} in the last 10 min`}
        aside={<Sparkline data={k.act} width={132} height={30} color="var(--live)" />} />
      <Kpi label="Cost · API-equivalent" value={usd(k.cost)} sub={visible.length === 1 ? 'for 1 session shown' : `across ${visible.length} sessions shown`} quiet />
    </div>
  );
}

function Kpi({ tone, label, value, sub, aside, alert, quiet, onClick }: {
  tone?: SessionStatus; label: string; value: number | string; sub: string; aside?: ReactNode; alert?: boolean; quiet?: boolean; onClick?: () => void;
}) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag className={`kpi${alert ? ' is-alert' : ''}${onClick ? ' is-link' : ''}${quiet ? ' is-quiet' : ''}`} onClick={onClick}
      title={onClick ? `Jump to the first session: ${label.toLowerCase()}` : undefined}>
      <span className="kpi-label">
        {tone && <span className={`status-dot solo st-${tone}${value === 0 ? ' is-calm' : ''}`} />}
        {label}
      </span>
      <span className="kpi-row">
        <span className="kpi-value">
          {typeof value === 'number' ? (
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span key={value} className="kpi-num"
                initial={{ y: 10, opacity: 0 }} animate={{ y: 0, opacity: 1, transition: { duration: 0.42, ease: EASE_OUT } }}
                exit={{ y: -10, opacity: 0, transition: { duration: 0.2, ease: EASE_IN } }}>
                {value}
              </motion.span>
            </AnimatePresence>
          ) : <span className="kpi-num">{value}</span>}
        </span>
        {aside && <span className="kpi-aside">{aside}</span>}
      </span>
      <span className="kpi-sub">{sub}</span>
    </Tag>
  );
}

/* ───────────── Board ───────────── */

const Board = memo(function Board({ groups, compact, grouped, groupBy }: { groups: Group[]; compact: boolean; grouped: boolean; groupBy: GroupBy }) {
  // Stagger the very first paint only; later arrivals come in on their own
  const [booted, setBooted] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setBooted(true), 1200);
    return () => clearTimeout(t);
  }, []);
  let n = 0;

  return (
    <div className="cmd-groups">
      {groups.map((g) => (
        <section key={g.key} className="cmd-group">
          {grouped && <GroupHead g={g} groupBy={groupBy} />}
          <div className="cmd-grid">
            <AnimatePresence mode="popLayout">
              {g.ids.map((id) => {
                const delay = booted ? 0 : Math.min(n++, 12) * 0.06;
                return (
                  <motion.div key={id} className="cmd-cell" layout="position"
                    initial={{ opacity: 0, y: 16, scale: 0.985 }}
                    animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: 0.6, ease: EASE_OUT, delay } }}
                    exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.26, ease: EASE_IN } }}
                    transition={{ layout: { duration: 0.55, ease: EASE_OUT } }}>
                    <SessionConsole id={id} compact={compact} />
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        </section>
      ))}
    </div>
  );
});

function groupIcon(label: string, groupBy: GroupBy): ReactNode {
  if (groupBy === 'project') return <span className="cmd-group-dot" style={{ background: projectColor(label) }} />;
  if (label === 'In monitor') return <MonitorDot size={14} />;
  if (label === 'Background') return <Server size={14} />;
  if (label === 'Not running' || label === 'Unknown app') return <Cpu size={14} />;
  return /terminal|iterm|pwsh|powershell|warp|kitty|wezterm/i.test(label) ? <SquareTerminal size={14} /> : <SquareCode size={14} />;
}

function GroupHead({ g, groupBy }: { g: Group; groupBy: GroupBy }) {
  const [blocked, working, waiting, idle] = g.counts;
  const parts: [SessionStatus, number, string][] = [
    ['blocked', blocked, 'need you'], ['working', working, 'working'], ['waiting', waiting, 'your turn'], ['idle', idle, 'closed'],
  ];
  return (
    <div className="cmd-group-head">
      <span className="cmd-group-icon">{groupIcon(g.label, groupBy)}</span>
      <span className="cmd-group-name">{g.label}</span>
      <span className="cmd-group-total num">{g.ids.length}</span>
      <span className="cmd-group-counts">
        {parts.filter(([, c]) => c > 0).map(([st, c, word]) => (
          <span key={st} className="cmd-group-count">
            <span className={`status-dot solo st-${st}`} />{c} {st === 'blocked' && c === 1 ? 'needs you' : word}
          </span>
        ))}
      </span>
      <span className="cmd-group-rule" />
    </div>
  );
}

function EmptyBoard({ scope, query }: { scope: string; query: string }) {
  const st = useStore.getState();
  if (query.trim()) {
    return (
      <Empty icon={<SearchX size={22} />} title={`Nothing matches “${query.trim()}”`}>
        <p className="cmd-empty-copy">Search looks at titles, projects, folders, branches, models and where sessions run.</p>
        <div className="cmd-empty-actions">
          <Button size="sm" onClick={() => st.setQuery('')}>Clear search</Button>
        </div>
      </Empty>
    );
  }
  return (
    <Empty icon={<LayoutGrid size={22} />} title={scope === 'live' ? 'No live sessions right now' : 'No sessions in this time range'}>
      <p className="cmd-empty-copy">
        Start a session here and run it from this board, or open Claude Code anywhere. It shows up the moment it starts.
      </p>
      <div className="cmd-empty-actions">
        <Button variant="primary" icon={<Plus size={15} />} onClick={() => st.setNewSession(true)}>New session</Button>
        {scope === 'live' && <Button icon={<History size={15} />} onClick={() => st.setScope('recent')}>Show recent</Button>}
      </div>
    </Empty>
  );
}
