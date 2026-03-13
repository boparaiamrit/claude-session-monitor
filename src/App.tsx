import { useState, useEffect, useCallback } from 'react';
import './App.css';
import { PieChart, Pie, Cell } from 'recharts';
import type { Session, ViewMode, FilterMode, TabMode, ToolEntry, AgentInfo } from './types';
import {
  modelInfo, chipClass, stickyClass, fmtToolName, agentTypeClass,
  fmtProjectShort, fmtTimeAgo, fmtBytes, truncate, trimPath,
} from './helpers';

// Tauri API - uses global window.__TAURI__ via withGlobalTauri
declare global {
  interface Window {
    __TAURI__?: {
      core: {
        invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
      };
      event: {
        listen: <T>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>;
      };
    };
  }
}

const invoke = window.__TAURI__?.core?.invoke;
const listen = window.__TAURI__?.event?.listen;

function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterMode>('active');
  const [hours, setHours] = useState(4);
  const [view, setView] = useState<ViewMode>('office');
  const [tab, setTab] = useState<TabMode>('tools');
  const [connStatus, setConnStatus] = useState<'connected' | 'disconnected' | 'polling'>('polling');
  const [showRefresh, setShowRefresh] = useState(false);
  const [overlaySession, setOverlaySession] = useState<string | null>(null);
  const [overlayTab, setOverlayTab] = useState<TabMode>('tools');

  // Fetch sessions
  const fetchSessions = useCallback(async () => {
    if (invoke) {
      try {
        const data = await invoke<Session[]>('get_sessions', {
          activeOnly: filter === 'active',
          hours: hours,
        });
        setSessions(data);
        setConnStatus('connected');
        setShowRefresh(true);
        setTimeout(() => setShowRefresh(false), 800);
      } catch {
        setConnStatus('disconnected');
      }
    }
  }, [filter, hours]);

  // Listen for Tauri events
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    if (listen) {
      listen<Session[]>('sessions-updated', (event) => {
        setSessions(event.payload);
        setConnStatus('connected');
        setShowRefresh(true);
        setTimeout(() => setShowRefresh(false), 800);
      }).then(fn => { unlisten = fn; });
    }

    fetchSessions();
    const interval = setInterval(fetchSessions, 3000);

    return () => {
      unlisten?.();
      clearInterval(interval);
    };
  }, [fetchSessions]);

  // Escape key closes overlay
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOverlaySession(null);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  // Derived data
  const filtered = filter === 'active' ? sessions.filter(s => s.status !== 'idle') : sessions;
  const activeCount = sessions.filter(s => ['streaming', 'working'].includes(s.status)).length;
  const selectedSession = sessions.find(s => s.id === selectedId) || null;
  const overlaySessionData = sessions.find(s => s.id === overlaySession) || null;

  // Auto-select first session
  useEffect(() => {
    if (!selectedId && filtered.length > 0) {
      setSelectedId(filtered[0].id);
    }
  }, [filtered, selectedId]);

  return (
    <>
      <Particles />
      <div className="app">
        <Header
          activeCount={activeCount}
          totalCount={sessions.length}
          connStatus={connStatus}
          view={view}
          setView={setView}
          filter={filter}
          setFilter={setFilter}
          hours={hours}
          setHours={setHours}
        />

        {view === 'classic' ? (
          <div className="main" id="classic-view">
            <SessionList sessions={filtered} selectedId={selectedId} onSelect={setSelectedId} />
            <DetailPanel session={selectedSession} tab={tab} setTab={setTab} />
          </div>
        ) : (
          <div className="office-floor" id="office-view">
            <div id="cabins-container">
              <OfficeView sessions={filtered} onOpenOverlay={(id) => { setOverlaySession(id); setOverlayTab('tools'); }} />
            </div>
          </div>
        )}

        {overlaySessionData && (
          <div className="detail-overlay" id="detail-overlay">
            <div className="detail-overlay-backdrop" onClick={() => setOverlaySession(null)} />
            <div className="detail-overlay-panel" id="detail-overlay-panel">
              <button className="overlay-close" onClick={() => setOverlaySession(null)}>x</button>
              <DetailContent session={overlaySessionData} tab={overlayTab} setTab={setOverlayTab} />
            </div>
          </div>
        )}
      </div>

      <div className={`refresh-flash${showRefresh ? ' visible' : ''}`} id="refresh-flash">
        <span style={{ display: 'inline-block', animation: 'pulse-dot 1s infinite' }}>&#9679;</span>
        Updated
      </div>
    </>
  );
}

// ── Particles ──
function Particles() {
  const colors = ['var(--accent)', 'var(--pink)', 'var(--cyan)', 'var(--green)', 'var(--blue)'];
  const particles = Array.from({ length: 25 }, (_, i) => ({
    key: i,
    left: Math.random() * 100 + '%',
    bg: colors[Math.floor(Math.random() * colors.length)],
    dur: (15 + Math.random() * 25) + 's',
    delay: (Math.random() * 20) + 's',
    size: (2 + Math.random() * 3) + 'px',
  }));

  return (
    <div className="particles" id="particles">
      {particles.map(p => (
        <div key={p.key} className="particle" style={{ left: p.left, background: p.bg, animationDuration: p.dur, animationDelay: p.delay, width: p.size, height: p.size }} />
      ))}
    </div>
  );
}

// ── Header ──
function Header({ activeCount, totalCount, connStatus, view, setView, filter, setFilter, hours, setHours }: {
  activeCount: number; totalCount: number; connStatus: string; view: ViewMode; setView: (v: ViewMode) => void;
  filter: FilterMode; setFilter: (f: FilterMode) => void; hours: number; setHours: (h: number) => void;
}) {
  return (
    <header>
      <div className="logo">
        <div className="logo-icon">C</div>
        <div>
          <h1>Claude Session Monitor</h1>
          <div className="subtitle">Claude Code Live</div>
        </div>
      </div>
      <div className="header-right">
        <div className="header-stats">
          <div className="stat-pill">
            <span className="dot live" style={{ animationPlayState: activeCount > 0 ? 'running' : 'paused' }} />
            <span>{activeCount}</span> <span className="stat-label">active</span>
          </div>
          <div className="stat-pill">
            <span className="dot total" />
            <span>{totalCount}</span> <span className="stat-label">total</span>
          </div>
          <div className={`connection-status ${connStatus}`}>
            <span className="dot" />
            <span className="conn-text">
              {{ connected: 'live', disconnected: 'offline', polling: 'polling' }[connStatus] || connStatus}
            </span>
          </div>
        </div>
        <div className="controls">
          <div className="view-toggle">
            <button className={`view-btn${view === 'office' ? ' active' : ''}`} onClick={() => setView('office')}>Office</button>
            <button className={`view-btn${view === 'classic' ? ' active' : ''}`} onClick={() => setView('classic')}>Classic</button>
          </div>
          <button className={`btn${filter === 'active' ? ' active' : ''}`} onClick={() => setFilter('active')}>Active Only</button>
          <button className={`btn${filter === 'all' ? ' active' : ''}`} onClick={() => setFilter('all')}>All Sessions</button>
          <select className="btn" value={hours} onChange={(e) => setHours(parseInt(e.target.value))}>
            <option value="1">1h</option>
            <option value="4">4h</option>
            <option value="12">12h</option>
            <option value="24">24h</option>
            <option value="72">3d</option>
          </select>
        </div>
      </div>
    </header>
  );
}

// ── Session List ──
function SessionList({ sessions, selectedId, onSelect }: { sessions: Session[]; selectedId: string | null; onSelect: (id: string) => void }) {
  if (!sessions.length) {
    return (
      <div className="session-list">
        <div className="session-list-header">Sessions</div>
        <div className="no-sessions">
          <div className="big-icon">C</div>
          <div>No sessions</div>
          <div style={{ fontSize: '11px', marginTop: '4px', color: 'var(--text3)' }}>Expand time range</div>
        </div>
      </div>
    );
  }

  return (
    <div className="session-list">
      <div className="session-list-header">Sessions</div>
      <div>
        {sessions.map(s => <SessionCard key={s.id} session={s} selected={s.id === selectedId} onSelect={onSelect} />)}
      </div>
    </div>
  );
}

function SessionCard({ session: s, selected, onSelect }: { session: Session; selected: boolean; onSelect: (id: string) => void }) {
  const m = modelInfo(s.model);
  const lastTool = s.tools_used[s.tools_used.length - 1];
  const isActive = ['streaming', 'working'].includes(s.status);
  const toolPips = s.tools_used.slice(-30);

  return (
    <div className={`session-card${selected ? ' selected' : ''}${isActive ? ' is-active' : ''}`} onClick={() => onSelect(s.id)}>
      <div className="top-row">
        <span className="project-name">{fmtProjectShort(s.project, s.cwd)}</span>
        <span className={`status-badge ${s.status}`}><span className="status-dot" />{s.status}</span>
      </div>
      <div className="meta-row">
        <span className={`model-tag ${m.cls}`}>{m.label}</span>
        <span className="meta-tag">{fmtTimeAgo(s.last_activity)}</span>
        <span className="meta-tag">{s.tool_count} tools</span>
        {s.agents_spawned.length > 0 && <span className="meta-tag" style={{ color: 'var(--pink)' }}>{s.agents_spawned.length} agents</span>}
      </div>
      {s.git_branch && <div className="meta-row"><span className="branch-tag">{s.git_branch}</span></div>}
      {toolPips.length > 0 && (
        <div className="card-tool-bar">
          {toolPips.map((t, i) => {
            const cls = ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'Agent'].includes(t.name) ? t.name : 'other';
            return <div key={i} className={`card-tool-pip pip-${cls}`} style={{ width: cls === 'Agent' ? '6px' : '3px' }} title={t.name} />;
          })}
        </div>
      )}
      {lastTool && isActive && (
        <div className="card-activity">
          <span className={`tool-chip ${chipClass(lastTool.name)}`}>{lastTool.name}</span>
          <span style={{ color: 'var(--text2)' }}>{truncate(trimPath(lastTool.detail || lastTool.agent_info?.description || ''), 45)}</span>
        </div>
      )}
    </div>
  );
}

// ── Detail Panel ──
function DetailPanel({ session, tab, setTab }: { session: Session | null; tab: TabMode; setTab: (t: TabMode) => void }) {
  if (!session) {
    return (
      <div className="detail-panel">
        <div className="detail-empty">
          <div className="empty-icon">C</div>
          <div style={{ fontSize: '14px', fontWeight: 600 }}>Select a session</div>
          <div style={{ fontSize: '11px' }}>Live data refreshes every 1.5s</div>
        </div>
      </div>
    );
  }

  return (
    <div className="detail-panel">
      <DetailContent session={session} tab={tab} setTab={setTab} />
    </div>
  );
}

// ── Shared Detail Content ──
function DetailContent({ session: s, tab, setTab }: { session: Session; tab: TabMode; setTab: (t: TabMode) => void }) {
  const m = modelInfo(s.model);
  const toolFreq: Record<string, number> = {};
  s.tools_used.forEach(t => { toolFreq[t.name] = (toolFreq[t.name] || 0) + 1; });
  const freqSorted = Object.entries(toolFreq).sort((a, b) => b[1] - a[1]);

  const filesRead = new Set<string>();
  const filesWritten = new Set<string>();
  s.tools_used.forEach(t => {
    if (t.name === 'Read' && t.detail) filesRead.add(trimPath(t.detail));
    if ((t.name === 'Write' || t.name === 'Edit') && t.detail) filesWritten.add(trimPath(t.detail));
  });

  // Donuts for classic view
  const toolTotal = s.tool_count || 1;
  const classicToolColors: Record<string, string> = {
    Edit: '#a78bfa', Read: '#60a5fa', Bash: '#34d399', Write: '#f472b6',
    Grep: '#22d3ee', Glob: '#fbbf24', Agent: '#fb923c', TodoWrite: '#f87171',
  };
  const classicToolSegs = freqSorted.slice(0, 6).map(([name, count]) => ({
    pct: (count / toolTotal) * 100, color: classicToolColors[name] || '#6366f1',
  }));
  const classicTotalMsgs = s.message_count.user + s.message_count.assistant || 1;
  const classicMsgSegs = [
    { pct: (s.message_count.user / classicTotalMsgs) * 100, color: '#60a5fa' },
    { pct: (s.message_count.assistant / classicTotalMsgs) * 100, color: '#a78bfa' },
  ];
  const classicTotalFiles = new Set([...filesRead, ...filesWritten]).size || 1;
  const classicFileSegs = [
    { pct: (filesWritten.size / classicTotalFiles) * 100, color: '#f472b6' },
    { pct: ((filesRead.size > filesWritten.size ? filesRead.size - filesWritten.size : 0) / classicTotalFiles) * 100, color: '#60a5fa' },
  ];

  return (
    <>
      <div className="detail-header">
        <div className="detail-title">
          <span className={`status-badge ${s.status}`}><span className="status-dot" />{s.status}</span>
          <span className={`model-tag ${m.cls}`}>{m.label}</span>
          <h2>{fmtProjectShort(s.project, s.cwd)}</h2>
        </div>
        <div className="detail-meta-grid">
          <div className="detail-meta-item"><span className="label">ID</span> {s.id.slice(0, 8)}</div>
          {s.cwd && <div className="detail-meta-item"><span className="label">Dir</span> {s.cwd}</div>}
          {s.git_branch && <div className="detail-meta-item"><span className="label">Branch</span> {s.git_branch}</div>}
          {s.version && <div className="detail-meta-item"><span className="label">Ver</span> {s.version}</div>}
          <div className="detail-meta-item"><span className="label">Size</span> {fmtBytes(s.file_size)}</div>
        </div>
      </div>

      <div className="stats-grid">
        <div className="stat-card purple">
          <DonutChart segments={classicMsgSegs} label="" value={classicTotalMsgs > 1 ? classicTotalMsgs - 1 : 0} size={64} thickness={6} />
          <div className="label">Messages</div>
        </div>
        <div className="stat-card green">
          <DonutChart segments={classicToolSegs} label="" value={s.tool_count} size={64} thickness={6} />
          <div className="label">Tool Calls</div>
        </div>
        <div className="stat-card pink">
          <DonutChart segments={[{ pct: Math.min(s.agents_spawned.length * 10, 100), color: '#fb923c' }]} label="" value={s.agents_spawned.length} size={64} thickness={6} />
          <div className="label">Agents</div>
        </div>
        <div className="stat-card orange">
          <DonutChart segments={classicFileSegs} label="" value={filesRead.size + filesWritten.size} size={64} thickness={6} />
          <div className="label">Files Touched</div>
        </div>
      </div>

      {freqSorted.length > 0 && (
        <div className="tool-freq-bar">
          <span className="bar-label">Tool Freq</span>
          <div className="tool-freq-chips">
            {freqSorted.map(([name, count]) => (
              <div key={name} className={`freq-chip ${chipClass(name)}`}>{fmtToolName(name)} <span className="count">{count}</span></div>
            ))}
          </div>
        </div>
      )}

      {s.current_thinking && (
        <div className="thinking-panel">
          <div className="label"><span className="brain-icon" style={{ color: 'var(--accent)' }}>*</span> Thinking</div>
          <div className="text">{s.current_thinking}</div>
        </div>
      )}

      <div className="tabs">
        <div className={`tab${tab === 'tools' ? ' active' : ''}`} onClick={() => setTab('tools')}>Timeline <span className="badge">{s.tools_used.length}</span></div>
        <div className={`tab${tab === 'agents' ? ' active' : ''}`} onClick={() => setTab('agents')}>Agents <span className="badge">{s.agents_spawned.length}</span></div>
        <div className={`tab${tab === 'messages' ? ' active' : ''}`} onClick={() => setTab('messages')}>Chat <span className="badge">{s.messages.length}</span></div>
        <div className={`tab${tab === 'files' ? ' active' : ''}`} onClick={() => setTab('files')}>Files <span className="badge">{filesRead.size + filesWritten.size}</span></div>
      </div>

      {tab === 'tools' && <ToolsTimeline tools={s.tools_used} />}
      {tab === 'agents' && <AgentsTree agents={s.agents_spawned} />}
      {tab === 'messages' && <MessagesTab messages={s.messages} />}
      {tab === 'files' && <FilesTab filesRead={filesRead} filesWritten={filesWritten} />}
    </>
  );
}

// ── Tools Timeline Tab ──
function ToolsTimeline({ tools }: { tools: ToolEntry[] }) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  if (!tools.length) {
    return <div style={{ color: 'var(--text3)', padding: '30px', textAlign: 'center' }}>No tool calls yet</div>;
  }

  return (
    <div className="tab-content active">
      <div className="timeline">
        {[...tools].reverse().map((t, i) => (
          <div key={i} className={`timeline-item ${chipClass(t.name)}`} onClick={() => setExpandedIdx(expandedIdx === i ? null : i)}>
            <span className={`tool-chip ${chipClass(t.name)}`}>{fmtToolName(t.name)}</span>
            <div>
              <span className={`timeline-detail${expandedIdx === i ? ' expanded' : ''}`}>{truncate(trimPath(t.detail || t.agent_info?.description || ''), 120)}</span>
              {t.agent_info && (
                <div style={{ marginTop: '4px' }}>
                  <span className={`agent-type-tag ${agentTypeClass(t.agent_info.subagent_type)}`}>{t.agent_info.subagent_type || 'general'}</span>
                  {t.agent_info.background && <span className="bg-badge">BG</span>}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Agent icon SVGs (static trusted content) ──
function AgentIcon({ type }: { type: string }) {
  switch (type) {
    case 'explore':
      return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></svg>;
    case 'researcher':
      return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 19.5A2.5 2.5 0 016.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" /></svg>;
    case 'reviewer':
      return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>;
    case 'executor':
      return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>;
    case 'planner':
      return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg>;
    default:
      return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0110 0v4" /></svg>;
  }
}

// ── Agents Tree Tab ──
function AgentsTree({ agents }: { agents: AgentInfo[] }) {
  if (!agents.length) {
    return <div className="tab-content active"><div style={{ color: 'var(--text3)', padding: '30px', textAlign: 'center' }}>No agents spawned</div></div>;
  }

  return (
    <div className="tab-content active">
      <div className="agent-tree">
        {agents.map((a, i) => {
          const type = agentTypeClass(a.subagent_type);
          return (
            <div key={i}>
              {i > 0 && <div className="agent-connector" />}
              <div className={`agent-node ${type}`}>
                <div className={`agent-icon-wrap ${type}`}>
                  <AgentIcon type={type} />
                  <div className="ring" />
                </div>
                <div className="agent-body">
                  <div className="agent-desc">{a.description}</div>
                  <div className="agent-tags">
                    <span className={`agent-type-tag ${type}`}>{a.subagent_type || 'general'}</span>
                    {a.model && <span className={`agent-model-tag ${modelInfo(a.model).cls}`}>{a.model}</span>}
                    {a.background && <span className="bg-badge">Background</span>}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Messages Tab ──
function MessagesTab({ messages }: { messages: { role: string; text: string }[] }) {
  if (!messages.length) {
    return <div className="tab-content active"><div style={{ color: 'var(--text3)', padding: '30px', textAlign: 'center' }}>No messages</div></div>;
  }

  return (
    <div className="tab-content active">
      <div className="message-list">
        {messages.map((m, i) => (
          <div key={i} className={`message ${m.role}`}>
            <div className="role-tag">{m.role}</div>
            <div className="msg-text">{m.text}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Files Tab ──
function FilesTab({ filesRead, filesWritten }: { filesRead: Set<string>; filesWritten: Set<string> }) {
  return (
    <div className="tab-content active">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
        <div>
          <div style={{ fontSize: '10px', color: 'var(--text3)', textTransform: 'uppercase' as const, letterSpacing: '1px', marginBottom: '10px', fontWeight: 700 }}>Files Read ({filesRead.size})</div>
          {[...filesRead].map((f, i) => (
            <div key={i} style={{ fontSize: '11px', color: 'var(--blue)', padding: '4px 0', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ color: 'var(--text3)' }}>&#8594;</span> {f}
            </div>
          ))}
          {filesRead.size === 0 && <div style={{ color: 'var(--text3)', fontSize: '11px' }}>None</div>}
        </div>
        <div>
          <div style={{ fontSize: '10px', color: 'var(--text3)', textTransform: 'uppercase' as const, letterSpacing: '1px', marginBottom: '10px', fontWeight: 700 }}>Files Changed ({filesWritten.size})</div>
          {[...filesWritten].map((f, i) => (
            <div key={i} style={{ fontSize: '11px', color: 'var(--orange)', padding: '4px 0', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ color: 'var(--text3)' }}>&#9998;</span> {f}
            </div>
          ))}
          {filesWritten.size === 0 && <div style={{ color: 'var(--text3)', fontSize: '11px' }}>None</div>}
        </div>
      </div>
    </div>
  );
}

// ── Office View ──
function OfficeView({ sessions, onOpenOverlay }: { sessions: Session[]; onOpenOverlay: (id: string) => void }) {
  const [openStreams, setOpenStreams] = useState<Set<string>>(new Set());

  const toggleStream = useCallback((cabinId: string) => {
    setOpenStreams(prev => {
      const next = new Set(prev);
      if (next.has(cabinId)) next.delete(cabinId);
      else next.add(cabinId);
      return next;
    });
  }, []);

  if (!sessions.length) {
    return (
      <div className="no-sessions" style={{ gridColumn: '1/-1' }}>
        <div className="big-icon">C</div>
        <div>No sessions</div>
        <div style={{ fontSize: '11px', marginTop: '4px', color: 'var(--text3)' }}>Expand time range or switch filter</div>
      </div>
    );
  }

  const groups: Record<string, Session[]> = {};
  sessions.forEach(s => {
    const proj = fmtProjectShort(s.project, s.cwd);
    if (!groups[proj]) groups[proj] = [];
    groups[proj].push(s);
  });

  return (
    <>
      {Object.entries(groups).map(([proj, sessList]) => (
        <Cabin key={proj} project={proj} sessions={sessList} onOpenOverlay={onOpenOverlay} streamOpen={openStreams.has(proj.replace(/[^a-zA-Z0-9]/g, '_'))} onToggleStream={() => toggleStream(proj.replace(/[^a-zA-Z0-9]/g, '_'))} />
      ))}
    </>
  );
}

// Donut chart using Recharts
function DonutChart({ segments, size = 52, thickness = 6, label, value }: {
  segments: { pct: number; color: string }[]; size?: number; thickness?: number;
  label: string; value: number | string;
}) {
  const total = segments.reduce((a, s) => a + s.pct, 0);
  const data = [
    ...segments.map((s, i) => ({ name: `s${i}`, value: s.pct, color: s.color })),
    ...(total < 100 ? [{ name: 'empty', value: 100 - total, color: 'rgba(60,60,90,0.25)' }] : []),
  ];
  const innerR = Math.max(0, size / 2 - thickness);
  const outerR = size / 2;
  return (
    <div className="donut-chart" style={{ width: size, height: size }}>
      <PieChart width={size} height={size} style={{ position: 'absolute', inset: 0 }}>
        <Pie data={data} dataKey="value" cx="50%" cy="50%" innerRadius={innerR} outerRadius={outerR} startAngle={90} endAngle={-270} strokeWidth={0} isAnimationActive={false}>
          {data.map((d, i) => <Cell key={i} fill={d.color} />)}
        </Pie>
      </PieChart>
      <div className="donut-center">
        <div className="donut-value">{value}</div>
        {label && <div className="donut-label">{label}</div>}
      </div>
    </div>
  );
}

function Cabin({ project, sessions, onOpenOverlay, streamOpen, onToggleStream }: {
  project: string; sessions: Session[]; onOpenOverlay: (id: string) => void;
  streamOpen: boolean; onToggleStream: () => void;
}) {
  const sorted = [...sessions].sort((a, b) => {
    const priority: Record<string, number> = { streaming: 0, working: 1, waiting: 2, idle: 3 };
    return (priority[a.status] ?? 3) - (priority[b.status] ?? 3);
  });
  const manager = sorted[0];
  const m = modelInfo(manager.model);
  const isActive = ['streaming', 'working'].includes(manager.status);
  const lastTool = manager.tools_used[manager.tools_used.length - 1];

  const allAgents: (AgentInfo & { sessionId: string })[] = [];
  sorted.forEach(s => { s.agents_spawned.forEach(a => { allAgents.push({ ...a, sessionId: s.id }); }); });

  const recentTools = manager.tools_used.slice(-12);
  const visibleWorkers = allAgents.slice(0, 6);
  const extraWorkers = allAgents.length - visibleWorkers.length;

  // Compute tool distribution for donut
  const toolCounts: Record<string, number> = {};
  manager.tools_used.forEach(t => { toolCounts[t.name] = (toolCounts[t.name] || 0) + 1; });
  const toolTotal = manager.tool_count || 1;
  const toolColors: Record<string, string> = {
    Edit: '#a78bfa', Read: '#60a5fa', Bash: '#34d399', Write: '#f472b6',
    Grep: '#22d3ee', Glob: '#fbbf24', Agent: '#fb923c', TodoWrite: '#f87171',
  };
  const toolSegments = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, count]) => ({ pct: (count / toolTotal) * 100, color: toolColors[name] || '#6366f1' }));

  // Message ratio donut
  const totalMsgs = manager.message_count.user + manager.message_count.assistant || 1;
  const msgSegments = [
    { pct: (manager.message_count.user / totalMsgs) * 100, color: '#60a5fa' },
    { pct: (manager.message_count.assistant / totalMsgs) * 100, color: '#a78bfa' },
  ];

  // Files touched
  const filesRead = new Set<string>();
  const filesWritten = new Set<string>();
  manager.tools_used.forEach(t => {
    if (t.name === 'Read' && t.detail) filesRead.add(trimPath(t.detail));
    if ((t.name === 'Write' || t.name === 'Edit') && t.detail) filesWritten.add(trimPath(t.detail));
  });
  const totalFiles = new Set([...filesRead, ...filesWritten]).size || 0;
  const filesTotal = totalFiles || 1;
  const fileSegments = [
    { pct: (filesWritten.size / filesTotal) * 100, color: '#f472b6' },
    { pct: ((filesRead.size - filesWritten.size > 0 ? filesRead.size - filesWritten.size : 0) / filesTotal) * 100, color: '#60a5fa' },
  ];

  return (
    <div className="cabin">
      <div className="cabin-header">
        <div className="cabin-title">
          <div className="cabin-icon">C</div>
          <span title={project}>{fmtProjectShort(manager.project, manager.cwd)}</span>
        </div>
        <div className="cabin-meta">
          <span className={`model-tag ${m.cls}`}>{m.label}</span>
          <span className={`status-badge ${manager.status}`}><span className="status-dot" />{manager.status}</span>
        </div>
      </div>

      {/* Manager Hero Section — Redesigned */}
      <div className="cabin-hero-v2" onClick={() => onOpenOverlay(manager.id)}>
        <div className="hero-top-row">
          <div className="hero-left">
            <div className={`hero-avatar-ring st-${manager.status}`}>
              <div className={`desk manager st-${manager.status}`} style={{ margin: 0 }}>
                <div className="person">
                  <div className="person-head">
                    <div className="person-eyes"><div className="person-eye" /><div className="person-eye" /></div>
                  </div>
                  <div className="person-body" />
                </div>
              </div>
            </div>
            <div className="hero-identity">
              <div className="hero-name-v2">{m.label}</div>
              <div className="hero-role">Manager</div>
              {/* Activity — tool chip below manager name */}
              {isActive && lastTool && (
                <div className="hero-tool-badge">
                  <span className={`tool-chip ${chipClass(lastTool.name)}`} style={{ fontSize: '8px', padding: '1px 6px' }}>{lastTool.name}</span>
                </div>
              )}
            </div>
          </div>
          <div className="hero-donuts">
            <DonutChart segments={msgSegments} label="msgs" value={totalMsgs > 1 ? totalMsgs - 1 : 0} size={44} thickness={4} />
            <DonutChart segments={toolSegments} label="tools" value={manager.tool_count} size={44} thickness={4} />
            <DonutChart segments={[{ pct: Math.min(allAgents.length * 10, 100), color: '#fb923c' }]} label="agents" value={allAgents.length} size={44} thickness={4} />
            <DonutChart segments={fileSegments} label="files" value={totalFiles} size={44} thickness={4} />
          </div>
        </div>
      </div>

      {/* Activity Band — full detail of current operation */}
      <div className={`cabin-activity-bar${isActive ? '' : ' idle'}`}>
        <div className="activity-pulse" />
        <div className="activity-text">
          {lastTool && isActive ? (
            <>
              <span className={`tool-chip ${chipClass(lastTool.name)}`} style={{ fontSize: '8px', padding: '1px 5px' }}>{lastTool.name}</span>
              {' '}{truncate(trimPath(lastTool.detail || ''), 80)}
            </>
          ) : 'No active operation'}
        </div>
      </div>

      {/* Swappable content area — accordion between workers+stickies and stream */}
      <div className={`cabin-content${streamOpen ? ' stream-active' : ''}`}>
        <div className="cabin-content-default">
          {/* Workers Grid */}
          {allAgents.length > 0 && (
            <>
              <div className="manager-separator">
                <div className="sep-line" /><div className="sep-label">Team ({allAgents.length})</div><div className="sep-line" />
              </div>
              <div className="workers-grid">
                {visibleWorkers.map((a, i) => {
                  const type = agentTypeClass(a.subagent_type);
                  return (
                    <div key={i} className={`worker-card wt-${type}`} onClick={(e) => { e.stopPropagation(); onOpenOverlay(a.sessionId); }}>
                      <div className="person">
                        <div className="person-head">
                          <div className="person-eyes"><div className="person-eye" /><div className="person-eye" /></div>
                        </div>
                        <div className="person-body" />
                      </div>
                      <div className="worker-name" title={a.description || type}>{truncate(a.description || type, 16)}</div>
                      <div className={`worker-type ${type}`}>{a.subagent_type || 'general'}</div>
                    </div>
                  );
                })}
                {extraWorkers > 0 && (
                  <div className="workers-more" onClick={(e) => { e.stopPropagation(); onOpenOverlay(manager.id); }}>+{extraWorkers} more</div>
                )}
              </div>
            </>
          )}

          {/* Sticky Notes Wall */}
          {recentTools.length > 0 && (
            <div className="sticky-wall">
              {recentTools.slice(-8).map((t, i) => {
                const cls = stickyClass(t.name);
                const rotations = [-3, 1, -2, 2.5, -1, 3, -2.5, 1.5];
                const rot = rotations[i % rotations.length];
                return (
                  <div key={i} className={`sticky-note s-${cls}`} style={{ transform: `rotate(${rot}deg)` }}>
                    <div className="sticky-title">{fmtToolName(t.name)}</div>
                    <div className="sticky-body">{truncate(trimPath(t.detail || t.agent_info?.description || ''), 60)}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Live Stream Terminal — slides up from bottom */}
        <div className="cabin-content-stream">
          <div className="live-stream-panel">
            {recentTools.length > 0 ? [...recentTools].reverse().map((t, i) => (
              <div key={i} className="stream-line">
                <span className={`sl-tool tool-chip ${chipClass(t.name)}`} style={{ fontSize: '8px', padding: '1px 5px' }}>{t.name}</span>
                <span className="sl-detail">{truncate(trimPath(t.detail || t.agent_info?.description || ''), 80)}</span>
              </div>
            )) : (
              <div style={{ color: 'var(--text3)', padding: '8px', textAlign: 'center', fontSize: '10px' }}>No activity yet</div>
            )}
          </div>
        </div>
      </div>

      {/* Footer with Stream Toggle */}
      <div className="cabin-footer-controls">
        <div className="cabin-footer" style={{ borderTop: 'none', flex: 1 }}>
          <div className="cabin-stat">msgs <span className="cs-val">{manager.message_count.user + manager.message_count.assistant}</span></div>
          <div className="cabin-stat">tools <span className="cs-val">{manager.tool_count}</span></div>
          <div className="cabin-stat">agents <span className="cs-val">{allAgents.length}</span></div>
          {manager.git_branch && <div className="cabin-stat" style={{ color: 'var(--accent2)' }}>{manager.git_branch}</div>}
          <div className="cabin-stat" style={{ marginLeft: 'auto' }}>{fmtTimeAgo(manager.last_activity)}</div>
        </div>
        <button className={`live-stream-toggle${streamOpen ? ' active' : ''}`} onClick={(e) => { e.stopPropagation(); onToggleStream(); }} title="Toggle live stream">
          <div className="term-icon" />
          Stream
        </button>
      </div>
    </div>
  );
}

export default App;
