import { useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { create } from 'zustand';
import { AnimatePresence, motion } from 'motion/react';
import { FileText, FileWarning, Minus, PanelRightClose, PanelRightOpen, Plus, Scan, Share2, X } from 'lucide-react';
import type { Session } from '../../types';
import { useStore, useVisibleSessions } from '../../lib/store';
import { STATUS, projectColor } from '../../lib/theme';
import { basename, modelInfo, sessionLabel, timeAgo, trimPath, truncate } from '../../lib/format';
import { Empty, IconButton, StatusDot, ToolChip } from '../../components/ui';
import { useNow } from '../../lib/hooks';
import { analyzeFiles, buildSpec, fileId, type FileInfo, type Touch } from './model';
import { GraphEngine, type Target } from './engine';
import './graph.css';

interface GraphUi {
  hover: Target | null;
  /** File key whose touches are shown in the panel */
  pinned: string | null;
  showAll: boolean;
  panel: boolean;
}

const useGraphUi = create<GraphUi>(() => ({ hover: null, pinned: null, showAll: false, panel: true }));

/** Path shown relative to its project when a touching session's cwd contains it */
function shortDir(path: string, touches: Touch[], sessions: Record<string, Session>): string {
  const dir = path.slice(0, Math.max(0, path.lastIndexOf('/')));
  for (const t of touches) {
    const s = sessions[t.sessionId];
    const cwd = s?.cwd?.replace(/\\/g, '/');
    if (cwd && dir.toLowerCase().startsWith(cwd.toLowerCase())) {
      const rest = dir.slice(cwd.length).replace(/^\//, '');
      return rest ? `${s.projectName}/${rest}` : s.projectName;
    }
  }
  return dir.split('/').slice(-3).join('/');
}

function touchText(t: Touch): string {
  const parts: string[] = [];
  if (t.writes) parts.push(`changed ${t.writes}×`);
  if (t.reads) parts.push(`read ${t.reads}×`);
  return parts.join(' · ');
}

// ───────────── Side panel ─────────────

function TouchList({ info, sessions, now }: { info: FileInfo; sessions: Record<string, Session>; now: number }) {
  return (
    <ul className="gv-touches">
      {info.touches.map((t) => {
        const s = sessions[t.sessionId];
        if (!s) return null;
        return (
          <li key={t.sessionId}>
            <StatusDot status={s.status} />
            <div className="gv-tbody">
              <button className="gv-tname" title={`Open ${sessionLabel(s)}`}
                onClick={(e) => { e.stopPropagation(); useStore.getState().select(s.id, 'files'); }}>
                {sessionLabel(s)}
              </button>
              <span className="gv-tmeta">
                <span className={t.writes ? 'w' : 'r'}>{touchText(t)}</span>
                <span className="gv-tsep">·</span>
                <span className="num">{timeAgo(t.lastTs, now)}</span>
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function FileItem({ info, sessions, now, active, onFocus }:
  { info: FileInfo; sessions: Record<string, Session>; now: number; active: boolean; onFocus: (key: string) => void }) {
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onFocus(info.key); } };
  return (
    <div role="button" tabIndex={0} className={`gv-item${info.conflict ? ' conflict' : ''}${active ? ' active' : ''}`}
      onClick={() => onFocus(info.key)} onKeyDown={onKey} title={info.path}>
      <div className="gv-item-top">
        {info.conflict ? <FileWarning size={14} className="gv-ficon warn" /> : <FileText size={14} className={`gv-ficon${info.written ? ' w' : ''}`} />}
        <span className="gv-fname">{basename(info.path)}</span>
        {info.conflict && <span className="gv-tag">Possible conflict</span>}
      </div>
      <div className="gv-fdir">{shortDir(info.path, info.touches, sessions)}</div>
      <TouchList info={info} sessions={sessions} now={now} />
    </div>
  );
}

function Panel({ files, sessions, onFocus }: { files: Map<string, FileInfo>; sessions: Record<string, Session>; onFocus: (key: string | null) => void }) {
  const pinned = useGraphUi((s) => s.pinned);
  const now = useNow(5000);
  const shared = useMemo(() => [...files.values()].filter((f) => f.shared).sort((a, b) => b.lastTs - a.lastTs), [files]);
  const conflicts = shared.filter((f) => f.conflict).length;
  const pinnedInfo = pinned ? files.get(pinned) : undefined;

  return (
    <aside className="gv-panel" aria-label="Files touched by more than one session">
      <AnimatePresence initial={false}>
        {pinnedInfo && (
          <motion.section key={pinnedInfo.key} className="gv-selected" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}>
            <div className="gv-selected-head">
              <span className="gv-selected-label">Selected file</span>
              <IconButton label="Clear selection" onClick={() => onFocus(null)}><X size={14} /></IconButton>
            </div>
            <div className="gv-item-top">
              {pinnedInfo.conflict ? <FileWarning size={15} className="gv-ficon warn" /> : <FileText size={15} className={`gv-ficon${pinnedInfo.written ? ' w' : ''}`} />}
              <span className="gv-fname big">{basename(pinnedInfo.path)}</span>
            </div>
            <div className="gv-fdir">{shortDir(pinnedInfo.path, pinnedInfo.touches, sessions)}</div>
            {pinnedInfo.conflict && (
              <div className="gv-warnline">
                {pinnedInfo.touches.filter((t) => t.writes).length >= 2
                  ? 'Changed by more than one session. Their edits may overwrite each other.'
                  : 'Changed by one session while another live session reads it.'}
              </div>
            )}
            <TouchList info={pinnedInfo} sessions={sessions} now={now} />
          </motion.section>
        )}
      </AnimatePresence>
      <header className="gv-panel-head">
        <div className="gv-panel-title">Files touched by more than one session</div>
        <div className="gv-panel-sub">
          <span className="num">{shared.length}</span> shared
          {conflicts > 0 && <span className="gv-panel-warn"><span className="gv-warn-dot" /><span className="num">{conflicts}</span> possible conflict{conflicts === 1 ? '' : 's'}</span>}
        </div>
      </header>
      <div className="gv-list">
        {shared.length === 0 ? (
          <div className="gv-none">
            <Share2 size={18} />
            <div>No file is shared between sessions right now.</div>
            <span>When two sessions read or change the same file, it shows up here.</span>
          </div>
        ) : shared.map((f) => (
          <FileItem key={f.key} info={f} sessions={sessions} now={now} active={pinned === f.key} onFocus={onFocus} />
        ))}
      </div>
    </aside>
  );
}

// ───────────── Tooltip ─────────────

function Tooltip({ files }: { files: Map<string, FileInfo> }) {
  const t = useGraphUi((s) => s.hover);
  const sessions = useStore((s) => s.sessions);
  const now = useNow(1000);
  if (!t) return null;
  const below = t.y < 170;
  const style = { left: t.x, top: below ? t.y + 46 : t.y - 12 };
  const cls = `gv-tip${below ? ' below' : ''}`;

  if (t.kind === 'session' && t.sessionId) {
    const s = sessions[t.sessionId];
    if (!s) return null;
    const st = STATUS[s.status];
    const cur = s.currentTool && s.currentTool.endTs == null && s.live ? s.currentTool : null;
    return (
      <div className={cls} style={style}>
        <div className="gv-tip-title">{sessionLabel(s)}</div>
        <div className="gv-tip-meta">
          <span className={`st-${s.status}`}>{st.label}</span><span>·</span>
          <span>{modelInfo(s.model).label}</span>
          {s.process?.host && <><span>·</span><span>{s.process.host}</span></>}
        </div>
        {cur && <div className="gv-tip-now"><ToolChip name={cur.name} /><span>{truncate(trimPath(cur.detail), 60)}</span></div>}
        <div className="gv-tip-foot">{s.files.length} files · {s.agents.length} sub-agents · click to open</div>
      </div>
    );
  }
  if (t.kind === 'agent' && t.sessionId && t.agentId) {
    const s = sessions[t.sessionId];
    const a = s?.agents.find((x) => x.id === t.agentId);
    if (!s || !a) return null;
    const working = a.status === 'working' && s.live;
    return (
      <div className={cls} style={style}>
        <div className="gv-tip-title mono">{a.agentType}</div>
        <div className="gv-tip-meta">
          <span className={working ? 'st-working' : a.status === 'error' ? 'st-blocked' : 'st-done'}>{working ? 'Running' : a.status === 'error' ? 'Failed' : 'Done'}</span>
          <span>·</span><span>{a.toolCount} tool calls</span>
          {a.startedAt && <><span>·</span><span>started {timeAgo(a.startedAt, now)}</span></>}
        </div>
        <div className="gv-tip-text">{truncate(a.description, 140)}</div>
        <div className="gv-tip-foot">Sub-agent of {sessionLabel(s)}</div>
      </div>
    );
  }
  if (t.kind === 'file' && t.fileKey) {
    const f = files.get(t.fileKey);
    if (!f) return null;
    return (
      <div className={cls} style={style}>
        <div className="gv-tip-title mono">{basename(f.path)}</div>
        <div className="gv-tip-meta">
          {f.conflict ? <span className="gv-tip-warn">Possible conflict</span> : <span>{f.written ? 'Changed' : 'Read only'}</span>}
          <span>·</span><span>{f.touches.length} session{f.touches.length === 1 ? '' : 's'}</span>
          <span>·</span><span>{timeAgo(f.lastTs, now)}</span>
        </div>
        <ul className="gv-tip-touches">
          {f.touches.slice(0, 4).map((x) => {
            const s = sessions[x.sessionId];
            return s ? <li key={x.sessionId}><StatusDot status={s.status} /><span>{truncate(sessionLabel(s), 30)}</span><em>{touchText(x)}</em></li> : null;
          })}
        </ul>
        <div className="gv-tip-foot">Click to see every touch</div>
      </div>
    );
  }
  const list = Object.values(sessions).filter((s) => s.projectName === t.project);
  return (
    <div className={cls} style={style}>
      <div className="gv-tip-title"><span className="gv-tip-pdot" style={{ background: projectColor(t.project) }} />{t.project}</div>
      <div className="gv-tip-meta">
        <span>{list.length} session{list.length === 1 ? '' : 's'}</span><span>·</span>
        <span className="st-working">{list.filter((s) => s.live && s.status === 'working').length} working</span>
      </div>
      <div className="gv-tip-foot">Click to focus this project</div>
    </div>
  );
}

// ───────────── View ─────────────

export default function GraphView() {
  const sessions = useVisibleSessions();
  const sessionMap = useStore((s) => s.sessions);
  const scope = useStore((s) => s.scope);
  const selectedId = useStore((s) => s.selectedId);
  const showAll = useGraphUi((s) => s.showAll);
  const pinned = useGraphUi((s) => s.pinned);
  const panel = useGraphUi((s) => s.panel);
  const files = useMemo(() => analyzeFiles(sessions), [sessions]);
  const spec = useMemo(() => buildSpec(sessions, files, showAll), [sessions, files, showAll]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GraphEngine | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new GraphEngine(canvas, {
      hover: (t) => useGraphUi.setState({ hover: t }),
      click: (t) => {
        if (!t) {
          useGraphUi.setState({ pinned: null });
          engine.setPinned(null);
        } else if (t.kind === 'file' && t.fileKey) {
          useGraphUi.setState({ pinned: t.fileKey, panel: true });
        } else if (t.kind === 'session' && t.sessionId) {
          useStore.getState().select(t.sessionId);
        } else if (t.kind === 'agent' && t.sessionId) {
          useStore.getState().select(t.sessionId, 'agents');
        } else if (t.kind === 'project') {
          useGraphUi.setState({ pinned: null });
          engine.focus(t.id);
        }
      },
    });
    engineRef.current = engine;
    return () => {
      engine.destroy();
      engineRef.current = null;
      useGraphUi.setState({ hover: null });
    };
  }, []);

  useEffect(() => { engineRef.current?.update(spec, sessions); }, [spec, sessions]);
  useEffect(() => { engineRef.current?.setSelectedSession(selectedId); }, [selectedId]);
  useEffect(() => {
    if (pinned && !files.has(pinned)) {
      useGraphUi.setState({ pinned: null });
      engineRef.current?.setPinned(null);
    }
  }, [files, pinned]);
  // Only push a file pin here; clearing happens where it is decided, so a project focus is not undone
  useEffect(() => { if (pinned) engineRef.current?.setPinned(fileId(pinned)); }, [pinned]);

  const focusFile = (key: string | null) => {
    useGraphUi.setState({ pinned: key });
    if (key) engineRef.current?.focus(fileId(key));
    else engineRef.current?.setPinned(null);
  };

  const counts = useMemo(() => {
    let agents = 0, running = 0, fileCount = 0;
    const projects = new Set<string>();
    for (const n of spec.nodes) {
      if (n.kind === 'agent') {
        agents++;
        if (n.agent?.status === 'working' && n.session?.live) running++;
      } else if (n.kind === 'file') fileCount++;
      else if (n.kind === 'project') projects.add(n.project);
    }
    return { projects: projects.size, agents, running, files: fileCount };
  }, [spec]);
  const sharedCount = useMemo(() => [...files.values()].filter((f) => f.shared).length, [files]);

  return (
    <div className={`gv${panel ? ' with-panel' : ''}`}>
      <div className="gv-stage">
        <canvas ref={canvasRef} className="gv-canvas" aria-label="Graph of projects, sessions, sub-agents and the files they touch" />
        <div className="gv-toolbar">
          <div className="gv-counts">
            <span><b className="num">{counts.projects}</b> projects</span>
            <span><b className="num">{sessions.length}</b> sessions</span>
            <span><b className="num">{counts.agents}</b> sub-agents{counts.running > 0 && <em className="st-working"> · {counts.running} running</em>}</span>
            <span><b className="num">{counts.files}</b> files</span>
          </div>
          <div className="segmented" role="radiogroup" aria-label="Which files to show">
            <button role="radio" aria-checked={!showAll} className={!showAll ? 'on' : ''} onClick={() => useGraphUi.setState({ showAll: false })}
              title="The 25 most recent files per session, plus every shared file">Recent files</button>
            <button role="radio" aria-checked={showAll} className={showAll ? 'on' : ''} onClick={() => useGraphUi.setState({ showAll: true })}>
              All files{!showAll && spec.hiddenFiles > 0 && <span className="seg-count num">+{spec.hiddenFiles}</span>}
            </button>
          </div>
        </div>
        <div className="gv-zoom">
          <IconButton label="Zoom in" onClick={() => engineRef.current?.zoomBy(1.3)}><Plus size={15} /></IconButton>
          <IconButton label="Zoom out" onClick={() => engineRef.current?.zoomBy(1 / 1.3)}><Minus size={15} /></IconButton>
          <IconButton label="Fit everything in view" onClick={() => engineRef.current?.fit()}><Scan size={15} /></IconButton>
          <span className="gv-zoom-sep" />
          <IconButton label={panel ? 'Hide shared files' : 'Show shared files'} onClick={() => useGraphUi.setState({ panel: !panel })}
            className={sharedCount ? 'gv-has' : ''}>
            {panel ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
          </IconButton>
        </div>
        <div className="gv-legend" aria-label="Legend">
          <span className="gv-lg"><i className="gv-lg-project" />Project</span>
          <span className="gv-lg"><i className="gv-lg-session" />Session</span>
          <span className="gv-lg"><i className="gv-lg-agent" />Sub-agent</span>
          <span className="gv-lg"><i className="gv-lg-file r" />Read</span>
          <span className="gv-lg"><i className="gv-lg-file w" />Changed</span>
          <span className="gv-lg"><i className="gv-lg-conflict" />Possible conflict</span>
          <span className="gv-lg"><i className="gv-lg-edge dashed" />Read</span>
          <span className="gv-lg"><i className="gv-lg-edge" />Changed</span>
        </div>
        <Tooltip files={files} />
        {!sessions.length && (
          <div className="gv-empty">
            <Empty icon={<Share2 size={20} />} title={scope === 'live' ? 'No sessions are running' : 'No sessions to show'}>
              {scope === 'live'
                ? 'The graph fills in as Claude Code sessions start. Switch to Recent to map earlier sessions.'
                : 'Nothing matches the current search or time range.'}
            </Empty>
          </div>
        )}
      </div>
      <AnimatePresence initial={false}>
        {panel && (
          <motion.div className="gv-panel-wrap" initial={{ width: 0, opacity: 0 }} animate={{ width: 'auto', opacity: 1 }} exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}>
            <Panel files={files} sessions={sessionMap} onFocus={focusFile} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
