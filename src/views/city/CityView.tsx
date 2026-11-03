import { useMemo } from 'react';
import { Building2, Plus, History, SearchX, X } from 'lucide-react';
import { useStore, useVisibleSessions } from '../../lib/store';
import { STATUS } from '../../lib/theme';
import type { Session, SessionStatus } from '../../types';
import { Stage } from '../../three/kit';
import { CityScene, FOG_COLOR } from './CityScene';
import './city.css';

const ORDER: SessionStatus[] = ['working', 'blocked', 'waiting', 'idle'];

function CityHud({ sessions }: { sessions: Session[] }) {
  const counts = useMemo(() => {
    const c: Record<SessionStatus, number> = { working: 0, blocked: 0, waiting: 0, idle: 0 };
    for (const s of sessions) c[s.status]++;
    return c;
  }, [sessions]);
  const projects = useMemo(() => new Set(sessions.map((s) => s.project)).size, [sessions]);
  const agents = useMemo(() => sessions.reduce((n, s) => n + s.agents.filter((a) => a.status === 'working').length, 0), [sessions]);
  return (
    <div className="city-hud" aria-label="City summary">
      <div className="city-hud-title">
        <Building2 size={14} aria-hidden />
        <span><b className="num">{sessions.length}</b> {sessions.length === 1 ? 'tower' : 'towers'} in <b className="num">{projects}</b> {projects === 1 ? 'district' : 'districts'}</span>
      </div>
      <ul className="city-hud-counts">
        {ORDER.filter((k) => k !== 'idle' || counts.idle > 0).map((k) => (
          <li key={k} className={`city-hud-count st-${k}${counts[k] ? '' : ' zero'}`}>
            <span className="status-dot" />
            <span className="city-hud-label">{STATUS[k].label}</span>
            <b className="num">{counts[k]}</b>
          </li>
        ))}
      </ul>
      <ul className="city-hud-legend">
        <li><span className="lg-tower" aria-hidden />Taller tower, more tool calls</li>
        <li><span className="lg-windows" aria-hidden />Windows flash per tool call</li>
        <li><span className="lg-drone" aria-hidden />Drone: a sub-agent at work{agents ? <b className="num"> {agents}</b> : null}</li>
      </ul>
    </div>
  );
}

function CityEmpty() {
  const scope = useStore((s) => s.scope);
  const query = useStore((s) => s.query.trim());
  const { setNewSession, setScope, setQuery } = useStore.getState();
  return (
    <div className="city-empty">
      <div className="city-empty-card">
        <div className="city-empty-icon">{query ? <SearchX size={20} /> : <Building2 size={20} />}</div>
        <h2>{query ? 'No towers match your search' : 'The city is quiet'}</h2>
        <p>{query
          ? `Nothing in ${scope === 'live' ? 'live sessions' : 'recent sessions'} matches “${query}”.`
          : scope === 'live'
            ? 'No Claude sessions are running right now. Start one, or switch to Recent to see the towers from earlier work.'
            : 'No sessions in this time range yet. Start one and its tower will rise here.'}</p>
        <div className="city-empty-actions">
          {query
            ? <button className="btn btn-secondary btn-md" onClick={() => setQuery('')}><X size={15} /><span>Clear search</span></button>
            : <button className="btn btn-primary btn-md" onClick={() => setNewSession(true)}><Plus size={15} /><span>New session</span></button>}
          {scope === 'live' && <button className="btn btn-secondary btn-md" onClick={() => setScope('recent')}><History size={15} /><span>Show recent</span></button>}
        </div>
      </div>
    </div>
  );
}

export default function CityView() {
  const sessions = useVisibleSessions();
  const empty = sessions.length === 0;
  return (
    <div className="city-view">
      <Stage
        camera={{ position: [60, 40, 60], fov: 36, near: 0.5, far: 1200 }}
        background="#04050a"
        fog={[FOG_COLOR, 70, 230]}
        bloom={{ intensity: 1.05, threshold: 0.58, radius: 0.72 }}
        shadows={false}
        onPointerMissed={() => { if (useStore.getState().selectedId) useStore.getState().select(null); }}
      >
        <CityScene sessions={sessions} />
      </Stage>
      {!empty && <CityHud sessions={sessions} />}
      {!empty && <div className="city-hint">Drag to orbit · Scroll to zoom · Click a tower to open it</div>}
      {empty && <CityEmpty />}
    </div>
  );
}
