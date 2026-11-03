import { memo, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowUp, Bot, CircleDot, MessageSquareText, Pause, Search, TriangleAlert, User, Wrench, X } from 'lucide-react';
import type { FeedItem } from '../../types';
import { useStore } from '../../lib/store';
import { STATUS, projectColor } from '../../lib/theme';
import { fmtToolName } from '../../lib/format';
import { Button, StatusDot, ToolChip } from '../../components/ui';
import { useNow } from '../../lib/hooks';
import { isFresh, readRate } from './rate';
import './stream.css';

type Cat = 'tool' | 'prompt' | 'reply' | 'agent' | 'error' | 'status';

const CATS: { id: Cat; label: string; icon: ReactNode }[] = [
  { id: 'tool', label: 'Tools', icon: <Wrench size={12} /> },
  { id: 'prompt', label: 'Prompts', icon: <User size={12} /> },
  { id: 'reply', label: 'Replies', icon: <MessageSquareText size={12} /> },
  { id: 'agent', label: 'Agents', icon: <Bot size={12} /> },
  { id: 'error', label: 'Errors', icon: <TriangleAlert size={12} /> },
  { id: 'status', label: 'Status', icon: <CircleDot size={12} /> },
];
const ALL = CATS.map((c) => c.id);
const ICON: Record<Cat, ReactNode> = {
  tool: <Wrench size={13} />, prompt: <User size={13} />, reply: <MessageSquareText size={13} />,
  agent: <Bot size={13} />, error: <TriangleAlert size={13} />, status: <CircleDot size={12} />,
};

const EASE_OUT = [0.16, 1, 0.3, 1] as const;
const EASE_IN = [0.6, 0, 0.9, 0.35] as const;
const WINDOW_MS = 10 * 60_000;

const catOf = (f: FeedItem): Cat =>
  f.kind === 'error' || f.ok === false ? 'error' : f.kind === 'hook' ? 'status' : f.kind;

const pad = (n: number) => String(n).padStart(2, '0');

interface Tag { label: string; project: string; color: string }
const UNKNOWN_TAG: Tag = { label: 'Unknown session', project: '', color: 'var(--fg-4)' };

/** Session label + project color per id; identity only changes when a title does */
function useTags(): Record<string, Tag> {
  const sig = useStore((s) => {
    let out = '';
    for (const x of s.list) out += `${x.id}\t${(x.title ?? '').replace(/[\t\n]/g, ' ')}\t${x.projectName}\n`;
    return out;
  });
  return useMemo(() => {
    const m: Record<string, Tag> = {};
    for (const line of sig.split('\n')) {
      if (!line) continue;
      const [id, title, project] = line.split('\t');
      m[id] = { label: title || `${project} · ${id.slice(0, 6)}`, project, color: projectColor(project) };
    }
    return m;
  }, [sig]);
}

interface Row { f: FeedItem; cat: Cat }

/* ───────────── View ───────────── */

export default function StreamView() {
  const live = useStore((s) => s.feed);
  const tags = useTags();
  const [frozen, setFrozen] = useState<FeedItem[] | null>(null);
  const [kinds, setKinds] = useState<Set<Cat>>(() => new Set(ALL));
  const [q, setQ] = useState('');
  const [sid, setSid] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const feed = frozen ?? live;
  const query = q.trim().toLowerCase();

  const passes = useMemo(() => {
    return (f: FeedItem) => {
      if (sid && f.sessionId !== sid) return false;
      if (!query) return true;
      const t = tags[f.sessionId];
      return f.text.toLowerCase().includes(query)
        || !!f.tool?.toLowerCase().includes(query)
        || !!t?.label.toLowerCase().includes(query)
        || !!t?.project.toLowerCase().includes(query);
    };
  }, [sid, query, tags]);

  // Session + search filter first (kind counts come from this), duplicates dropped
  const base = useMemo(() => {
    const seen = new Set<string>();
    const out: Row[] = [];
    for (const f of feed) {
      if (seen.has(f.key)) continue;
      seen.add(f.key);
      if (passes(f)) out.push({ f, cat: catOf(f) });
    }
    return out;
  }, [feed, passes]);

  const counts = useMemo(() => {
    const c: Record<Cat, number> = { tool: 0, prompt: 0, reply: 0, agent: 0, error: 0, status: 0 };
    for (const r of base) c[r.cat]++;
    return c;
  }, [base]);

  const rows = useMemo(() => base.filter((r) => kinds.has(r.cat)), [base, kinds]);

  const newCount = useMemo(() => {
    if (!frozen) return 0;
    const head = frozen[0]?.key;
    let n = 0;
    for (const f of live) {
      if (f.key === head) break;
      if (passes(f) && kinds.has(catOf(f))) n++;
    }
    return n;
  }, [frozen, live, passes, kinds]);

  const onScroll = () => {
    const el = logRef.current;
    if (!el) return;
    if (el.scrollTop > 16) setFrozen((cur) => cur ?? useStore.getState().feed);
    else if (el.scrollTop <= 2) setFrozen(null);
  };

  const jumpToLatest = () => {
    const el = logRef.current;
    if (!el) return;
    if (el.scrollTop > 4000) el.scrollTop = 600;
    el.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const toggleKind = (c: Cat, solo: boolean) => {
    setKinds((cur) => {
      if (solo) return cur.size === 1 && cur.has(c) ? new Set(ALL) : new Set([c]);
      const next = new Set(cur);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  };

  const onLogClick = (e: MouseEvent<HTMLDivElement>) => {
    const line = (e.target as HTMLElement).closest<HTMLElement>('[data-sid]');
    if (line?.dataset.sid) useStore.getState().select(line.dataset.sid, 'activity');
  };

  const filtered = !!sid || !!query || kinds.size < ALL.length;
  const clearFilters = () => { setSid(null); setQ(''); setKinds(new Set(ALL)); };
  const liveSessions = useStore((s) => s.list.filter((x) => x.live).length);

  return (
    <div className="stream">
      <div className="st-grid">
        <section className="st-main" aria-label="Live activity feed">
          <div className="st-bar">
            <span className={`st-state${frozen ? ' is-paused' : ''}`} title={frozen ? 'Scrolled away from the newest lines, so the view is held still' : 'Showing new lines as they happen'}>
              {frozen ? <Pause size={11} strokeWidth={3} /> : <span className="st-state-dot" />}
              {frozen ? 'Paused' : 'Live'}
            </span>
            <div className="st-kinds" role="group" aria-label="Show kinds of lines">
              {CATS.map((c) => {
                const on = kinds.has(c.id);
                return (
                  <button key={c.id} className={`st-kind k-${c.id}${on ? ' is-on' : ''}`} aria-pressed={on}
                    onClick={(e) => toggleKind(c.id, e.shiftKey || e.altKey)}
                    title={`${on ? 'Hide' : 'Show'} ${c.label.toLowerCase()} · Shift-click to show only these`}>
                    {c.icon}
                    <span>{c.label}</span>
                    <span className="st-kind-n num">{counts[c.id]}</span>
                  </button>
                );
              })}
            </div>
            <div className="spacer" />
            <label className="st-search">
              <Search size={13} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter lines"
                onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.stopPropagation(); setQ(''); } }} aria-label="Filter lines by text" />
              {q && <button className="st-search-clear" onClick={() => setQ('')} aria-label="Clear filter"><X size={12} /></button>}
            </label>
            <SessionPicker value={sid} onChange={setSid} tags={tags} />
          </div>

          <div className="st-log-wrap">
            <AnimatePresence>
              {frozen && (
                <motion.button key="paused" className="sv-paused" onClick={jumpToLatest}
                  initial={{ opacity: 0, y: -8, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: 0.42, ease: EASE_OUT } }}
                  exit={{ opacity: 0, y: -6, scale: 0.97, transition: { duration: 0.2, ease: EASE_IN } }}>
                  <Pause size={12} strokeWidth={3} />
                  <span>Paused</span>
                  <span className="sv-paused-sep" />
                  <span className="num">{newCount}</span>&nbsp;new
                  <span className="sv-paused-go"><ArrowUp size={12} strokeWidth={2.5} />Jump to latest</span>
                </motion.button>
              )}
            </AnimatePresence>

            <div className="st-log" ref={logRef} onScroll={onScroll} onClick={onLogClick}>
              <div className={`st-head${frozen ? ' is-paused' : ''}`} aria-hidden>
                {frozen ? (
                  <><Pause size={11} strokeWidth={3} /> held still while you read · {newCount} new above</>
                ) : (
                  <><span className="st-caret" /> tailing {liveSessions} live session{liveSessions === 1 ? '' : 's'} · newest first</>
                )}
              </div>
              {rows.length === 0 ? (
                <div className="st-empty">
                  <div className="st-empty-title">{filtered ? 'No lines match these filters' : 'Waiting for activity'}</div>
                  <div className="st-empty-body">
                    {filtered ? 'New lines that match will appear here as they happen.' : 'Tool calls, prompts, replies and agents from every session stream in here.'}
                  </div>
                  {filtered && <Button size="sm" onClick={clearFilters}>Clear filters</Button>}
                </div>
              ) : (
                <Lines rows={rows} tags={tags} />
              )}
            </div>
          </div>
        </section>

        <aside className="st-side" aria-label="Rate and sessions">
          <RateCard />
          <SessionsCard active={sid} onPick={(id) => setSid((cur) => (cur === id ? null : id))} tags={tags} />
        </aside>
      </div>
    </div>
  );
}

/* ───────────── Log lines ───────────── */

const Lines = memo(function Lines({ rows, tags }: { rows: Row[]; tags: Record<string, Tag> }) {
  return (
    <div className="st-lines" role="list">
      {rows.map((r) => (
        <Line key={r.f.key} f={r.f} cat={r.cat} tag={tags[r.f.sessionId] ?? UNKNOWN_TAG} fresh={isFresh(r.f.key)} />
      ))}
    </div>
  );
});

function stripLead(text: string, lead: string): string {
  return lead && text.startsWith(lead) ? text.slice(lead.length).trimStart() : text;
}

const Line = memo(function Line({ f, cat, tag, fresh }: { f: FeedItem; cat: Cat; tag: Tag; fresh: boolean }) {
  const d = new Date(f.ts);
  const name = f.tool ? fmtToolName(f.tool) : '';
  let body: ReactNode;
  if (cat === 'prompt' || cat === 'reply') {
    body = (
      <>
        <span className={`st-who ${cat === 'prompt' ? 'is-you' : 'is-claude'}`}>{cat === 'prompt' ? 'You' : 'Claude'}</span>
        <span className="st-text">{f.text}</span>
      </>
    );
  } else if (cat === 'error') {
    const rest = stripLead(stripLead(f.text, `${name} failed`), name);
    body = (
      <>
        {f.tool && <ToolChip name={f.tool} />}
        <span className="st-fail">failed</span>
        <span className="st-text">{rest}</span>
      </>
    );
  } else if (cat === 'status') {
    body = <span className="st-text">{f.text}</span>;
  } else {
    body = (
      <>
        {f.tool && <ToolChip name={f.tool} />}
        <span className="st-text">{stripLead(f.text, name)}</span>
      </>
    );
  }
  return (
    <div className={`st-line k-${cat}${fresh ? ' is-new' : ''}`} data-sid={f.sessionId} role="listitem" title={`${tag.label} · open its activity`}>
      <span className="st-time"><b>{pad(d.getHours())}:{pad(d.getMinutes())}</b>:{pad(d.getSeconds())}</span>
      <span className="st-tag">
        <span className="st-dot" style={{ background: tag.color }} />
        <span className="st-tag-text">{tag.label}</span>
      </span>
      <span className="st-icon">{ICON[cat]}</span>
      <span className="st-body">{body}</span>
    </div>
  );
});

/* ───────────── Session filter ───────────── */

/** Sessions ranked by events in the last 10 minutes, then by their latest event */
function rankSessions(feed: FeedItem[], now: number): { id: string; n: number; last: number }[] {
  const m = new Map<string, { id: string; n: number; last: number }>();
  for (const f of feed) {
    let e = m.get(f.sessionId);
    if (!e) { e = { id: f.sessionId, n: 0, last: f.ts }; m.set(f.sessionId, e); }
    if (f.ts > now - WINDOW_MS) e.n++;
    if (f.ts > e.last) e.last = f.ts;
  }
  return [...m.values()].sort((a, b) => b.n - a.n || b.last - a.last);
}

function SessionPicker({ value, onChange, tags }: { value: string | null; onChange: (id: string | null) => void; tags: Record<string, Tag> }) {
  const feed = useStore((s) => s.feed);
  const now = useNow(5000);
  const ranked = useMemo(() => rankSessions(feed, now), [feed, now]);
  return (
    <div className={`st-picker${value ? ' is-on' : ''}`}>
      {value && <span className="st-dot" style={{ background: tags[value]?.color ?? 'var(--fg-4)' }} />}
      <select className="select st-select" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} aria-label="Show one session">
        <option value="">All sessions</option>
        {ranked.map((r) => (
          <option key={r.id} value={r.id}>{(tags[r.id] ?? UNKNOWN_TAG).label} · {r.n} recent</option>
        ))}
        {value && !ranked.some((r) => r.id === value) && <option value={value}>{tags[value]?.label ?? value}</option>}
      </select>
      {value && <button className="st-picker-clear" onClick={() => onChange(null)} aria-label="Show all sessions"><X size={12} /></button>}
    </div>
  );
}

/* ───────────── Sidebar ───────────── */

function RateCard() {
  const now = useNow(1000);
  const { perMin, bars } = readRate(now, 10);
  const known = bars.filter((b) => b.known);
  const avg = known.length ? known.reduce((a, b) => a + b.count, 0) / known.length : 0;
  const max = Math.max(1, ...bars.map((b) => b.count));
  const delta = avg ? Math.round(((perMin - avg) / avg) * 100) : 0;

  return (
    <div className="st-card st-rate">
      <div className="st-card-head">
        <span>Events per minute</span>
        <span className="st-live-tag"><span className="st-state-dot" />live</span>
      </div>
      <div className="st-rate-row">
        <motion.span key={perMin} className="st-rate-n"
          initial={{ opacity: 0.55, y: 5 }} animate={{ opacity: 1, y: 0, transition: { duration: 0.42, ease: EASE_OUT } }}>
          {perMin}
        </motion.span>
        {avg > 0 && (
          <span className={`st-rate-delta${delta > 0 ? ' is-up' : delta < 0 ? ' is-down' : ''}`} title="Compared with the 10-minute average">
            {delta > 0 ? '+' : ''}{delta}%
          </span>
        )}
      </div>
      <div className="st-rate-sub">{Math.round(avg)} a minute on average over 10 min</div>
      <div className="st-bars" role="img" aria-label={`Events per minute for the last 10 minutes: ${bars.map((b) => b.count).join(', ')}`}>
        {bars.map((b, i) => (
          <div key={b.t} className={`st-bar-col${i === bars.length - 1 ? ' is-now' : ''}${b.known ? '' : ' is-unknown'}`}
            title={b.known ? `${b.count} events, ${bars.length - 1 - i === 0 ? 'last minute' : `${bars.length - 1 - i} min ago`}` : 'Before the monitor started counting'}>
            <span style={{ height: `${b.known ? Math.max(3, (b.count / max) * 100) : 100}%` }} />
          </div>
        ))}
      </div>
      <div className="st-bars-axis"><span>10 min ago</span><span>now</span></div>
    </div>
  );
}

function SessionsCard({ active, onPick, tags }: { active: string | null; onPick: (id: string) => void; tags: Record<string, Tag> }) {
  const feed = useStore((s) => s.feed);
  const sessions = useStore((s) => s.sessions);
  const now = useNow(4000);
  const [hovered, setHovered] = useState(false);
  const ranked = useMemo(() => rankSessions(feed, now), [feed, now]);
  const counts = useMemo(() => new Map(ranked.map((r) => [r.id, r.n])), [ranked]);

  // Re-rank every few seconds, never while the pointer is over the list
  const [order, setOrder] = useState<string[]>(() => ranked.map((r) => r.id));
  const [rankedAt, setRankedAt] = useState(now);
  if (!hovered && rankedAt !== now) {
    setRankedAt(now);
    setOrder(ranked.map((r) => r.id));
  }
  const ids = useMemo(() => {
    const known = new Set(order);
    return [...order.filter((id) => counts.has(id)), ...ranked.filter((r) => !known.has(r.id)).map((r) => r.id)];
  }, [order, ranked, counts]);
  const max = Math.max(1, ...ranked.map((r) => r.n));

  return (
    <div className="st-card st-sessions">
      <div className="st-card-head">
        <span>Most active · 10 min</span>
        {active && <button className="link-btn" onClick={() => onPick(active)}>Show all</button>}
      </div>
      <div className="st-sess-list" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
        {ids.length === 0 && <div className="st-sess-empty">No sessions have reported activity yet.</div>}
        {ids.map((id) => {
          const s = sessions[id];
          const n = counts.get(id) ?? 0;
          const tag = tags[id] ?? UNKNOWN_TAG;
          return (
            <motion.button key={id} layout="position" transition={{ layout: { duration: 0.5, ease: EASE_OUT } }}
              className={`st-sess${active === id ? ' is-on' : ''}${active && active !== id ? ' is-dim' : ''}${n === 0 ? ' is-quiet' : ''}`}
              style={{ ['--share' as string]: n / max, ['--proj' as string]: tag.color }}
              onClick={() => onPick(id)} aria-pressed={active === id}
              title={active === id ? 'Show every session again' : `Show only ${tag.label}`}>
              {s ? <StatusDot status={s.status} /> : <span className="status-dot solo st-idle" />}
              <span className="st-sess-main">
                <span className="st-sess-title">{tag.label}</span>
                <span className="st-sess-sub">
                  <span className={`st-sess-status st-${s?.status ?? 'idle'}`}>{s ? STATUS[s.status].label : 'Gone'}</span>
                  <span className="st-sess-proj">{tag.project}</span>
                </span>
              </span>
              <span className="st-sess-n num">{n}</span>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
