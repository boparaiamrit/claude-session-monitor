// DOM chrome over the office: a minimal legend with live counts (top-left), a quiet hint with
// a recenter button (bottom-left), and the empty-office message.
import { useMemo } from 'react';
import { Crosshair, Plus } from 'lucide-react';
import { useStore } from '../../lib/store';
import { Button } from '../../components/ui';
import type { Session } from '../../types';
import { recenter } from './bus';

export function OfficeHud({ sessions }: { sessions: Session[] }) {
  const scope = useStore((s) => s.scope);
  const c = useMemo(() => {
    let working = 0, blocked = 0, waiting = 0, paused = 0, closed = 0, agents = 0;
    const rooms = new Set<string>();
    for (const s of sessions) {
      rooms.add(s.projectName);
      if (s.control.paused && s.status !== 'idle') paused++;
      else if (s.status === 'working') working++;
      else if (s.status === 'blocked') blocked++;
      else if (s.status === 'waiting') waiting++;
      else closed++;
      for (const a of s.agents) if (a.status === 'working') agents++;
    }
    return { working, blocked, waiting, paused, closed, agents, rooms: rooms.size };
  }, [sessions]);

  const rows: { cls: string; label: string; n: number; show: boolean }[] = [
    { cls: 'st-working', label: 'Working', n: c.working, show: true },
    { cls: 'st-blocked', label: 'Needs you', n: c.blocked, show: true },
    { cls: 'st-waiting', label: 'Your turn', n: c.waiting, show: true },
    { cls: 'st-paused', label: 'Paused', n: c.paused, show: c.paused > 0 },
    { cls: 'st-idle', label: 'Closed', n: c.closed, show: scope === 'recent' || c.closed > 0 },
  ];

  return (
    <>
      <div className="of-hud" aria-label="Office legend">
        <div className="of-hud-title">Office floor</div>
        <div className="of-hud-meta">
          {c.rooms} {c.rooms === 1 ? 'room' : 'rooms'} · {sessions.length} {sessions.length === 1 ? 'session' : 'sessions'} · {c.agents} {c.agents === 1 ? 'agent' : 'agents'}
        </div>
        <ul className="of-legend">
          {rows.filter((r) => r.show).map((r) => (
            <li key={r.cls} className={r.n ? '' : 'zero'}>
              <span className={`of-dot ${r.cls}`} />
              <span className="of-legend-label">{r.label}</span>
              <b className="num">{r.n}</b>
            </li>
          ))}
          <li className={c.agents ? '' : 'zero'}>
            <span className="of-dot of-dot-agent" />
            <span className="of-legend-label">Sub-agents</span>
            <b className="num">{c.agents}</b>
          </li>
        </ul>
      </div>
      <div className="of-hint">
        <button className="of-recenter" onClick={recenter} title="Reset the camera">
          <Crosshair size={13} />
          <span>Recenter</span>
        </button>
        <span>Drag or arrow keys to orbit · Right-drag to pan · Scroll to zoom · Click a desk to open it</span>
      </div>
    </>
  );
}

export function EmptyOffice() {
  const scope = useStore((s) => s.scope);
  const query = useStore((s) => s.query.trim());
  const st = useStore.getState;
  if (query) {
    return (
      <div className="of-empty">
        <div className="of-empty-card">
          <div className="of-empty-title">No sessions match “{query}”</div>
          <div className="of-empty-body">The office only shows sessions that match your search.</div>
          <div className="of-empty-actions">
            <Button variant="secondary" size="sm" onClick={() => st().setQuery('')}>Clear the search</Button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="of-empty">
      <div className="of-empty-card">
        <div className="of-empty-title">{scope === 'live' ? 'No live sessions' : 'No sessions in this time range'}</div>
        <div className="of-empty-body">
          {scope === 'live' ? 'Start one with New session, or switch to Recent.' : 'Start one with New session, or widen the time range.'}
        </div>
        <div className="of-empty-actions">
          <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => st().setNewSession(true)}>New session</Button>
          {scope === 'live' && <Button variant="secondary" size="sm" onClick={() => st().setScope('recent')}>Show recent</Button>}
        </div>
      </div>
    </div>
  );
}
