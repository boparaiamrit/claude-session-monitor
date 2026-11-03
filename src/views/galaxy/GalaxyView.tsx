import { useMemo } from 'react';
import { Orbit, Plus, History, SearchX, X } from 'lucide-react';
import { useStore, useVisibleSessions } from '../../lib/store';
import { STATUS } from '../../lib/theme';
import type { Session, SessionStatus } from '../../types';
import { Stage } from '../../three/kit';
import { GalaxyScene } from './GalaxyScene';
import './galaxy.css';

const ORDER: SessionStatus[] = ['working', 'blocked', 'waiting', 'idle'];

function GalaxyHud({ sessions }: { sessions: Session[] }) {
  const counts = useMemo(() => {
    const c: Record<SessionStatus, number> = { working: 0, blocked: 0, waiting: 0, idle: 0 };
    for (const s of sessions) c[s.status]++;
    return c;
  }, [sessions]);
  const stars = useMemo(() => new Set(sessions.map((s) => s.project)).size, [sessions]);
  const moons = useMemo(() => sessions.reduce((n, s) => n + s.agents.filter((a) => a.status === 'working').length, 0), [sessions]);
  return (
    <div className="galaxy-hud" aria-label="Galaxy summary">
      <div className="galaxy-hud-title">
        <Orbit size={14} aria-hidden />
        <span><b className="num">{sessions.length}</b> {sessions.length === 1 ? 'planet' : 'planets'} around <b className="num">{stars}</b> {stars === 1 ? 'star' : 'stars'}</span>
      </div>
      <ul className="galaxy-hud-counts">
        {ORDER.filter((k) => k !== 'idle' || counts.idle > 0).map((k) => (
          <li key={k} className={`galaxy-hud-count st-${k}${counts[k] ? '' : ' zero'}`}>
            <span className="status-dot" />
            <span className="galaxy-hud-label">{STATUS[k].label}</span>
            <b className="num">{counts[k]}</b>
          </li>
        ))}
      </ul>
      <ul className="galaxy-hud-legend">
        <li><span className="lg-star" aria-hidden />Star: a project</li>
        <li><span className="lg-planet" aria-hidden />Planet: a session, sized by context used</li>
        <li><span className="lg-orbit" aria-hidden />Faster orbit, more recent tool calls</li>
        <li><span className="lg-comet" aria-hidden />Comet: a tool call, in the tool's color</li>
        <li><span className="lg-moon" aria-hidden />Moon: a sub-agent at work{moons ? <b className="num"> {moons}</b> : null}</li>
      </ul>
    </div>
  );
}

function GalaxyEmpty() {
  const scope = useStore((s) => s.scope);
  const query = useStore((s) => s.query.trim());
  const { setNewSession, setScope, setQuery } = useStore.getState();
  return (
    <div className="galaxy-empty">
      <div className="galaxy-empty-card">
        <div className="galaxy-empty-icon">{query ? <SearchX size={20} /> : <Orbit size={20} />}</div>
        <h2>{query ? 'No planets match your search' : 'Nothing in orbit'}</h2>
        <p>{query
          ? `Nothing in ${scope === 'live' ? 'live sessions' : 'recent sessions'} matches “${query}”.`
          : scope === 'live'
            ? 'No Claude sessions are running right now. Start one, or switch to Recent to see the systems from earlier work.'
            : 'No sessions in this time range yet. Start one and it will appear here as a planet.'}</p>
        <div className="galaxy-empty-actions">
          {query
            ? <button className="btn btn-secondary btn-md" onClick={() => setQuery('')}><X size={15} /><span>Clear search</span></button>
            : <button className="btn btn-primary btn-md" onClick={() => setNewSession(true)}><Plus size={15} /><span>New session</span></button>}
          {scope === 'live' && <button className="btn btn-secondary btn-md" onClick={() => setScope('recent')}><History size={15} /><span>Show recent</span></button>}
        </div>
      </div>
    </div>
  );
}

export default function GalaxyView() {
  const sessions = useVisibleSessions();
  const empty = sessions.length === 0;
  return (
    <div className="galaxy-view">
      <Stage
        camera={{ position: [0, 60, 80], fov: 38, near: 0.1, far: 2400 }}
        background="#03040a"
        bloom={{ intensity: 1.15, threshold: 0.55, radius: 0.75 }}
        studio={false}
        shadows={false}
        onPointerMissed={() => { if (useStore.getState().selectedId) useStore.getState().select(null); }}
      >
        <GalaxyScene sessions={sessions} />
      </Stage>
      {!empty && <GalaxyHud sessions={sessions} />}
      {!empty && <div className="galaxy-hint">Drag to orbit · Scroll to zoom · Click a planet to open it</div>}
      {empty && <GalaxyEmpty />}
    </div>
  );
}
