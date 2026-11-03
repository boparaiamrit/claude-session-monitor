import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  Check, CircleStop, Code2, FolderOpen, Pause, Play, Power, SquareTerminal, Trash2, X, XCircle,
  Bot, GitBranch, Cpu, ShieldAlert, Clock3, RotateCcw,
} from 'lucide-react';
import type { Session } from '../types';
import { useSession, useStore, type DrawerTab } from '../lib/store';
import { api } from '../lib/bridge';
import { costByModel, contextWindow } from '../lib/pricing';
import { STATUS, toolColor } from '../lib/theme';
import {
  basename, clock, duration, fmtToolName, permissionModeLabel, sessionLabel, timeAgo, tokens, trimPath, truncate, usd,
} from '../lib/format';
import { Button, Empty, IconButton, Meter, ModelTag, Sparkline, StatusPill, ToolChip } from './ui';
import { hostLine } from '../lib/format';
import { useNow } from '../lib/hooks';
import { Composer } from './Composer';

const TABS: { id: DrawerTab; label: string }[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'activity', label: 'Activity' },
  { id: 'agents', label: 'Agents' },
  { id: 'files', label: 'Files' },
  { id: 'process', label: 'Where' },
];

export function SessionPanel() {
  const id = useStore((s) => s.selectedId);
  const session = useSession(id);
  const select = useStore((s) => s.select);
  const tab = useStore((s) => s.drawerTab);
  const setTab = useStore((s) => s.setDrawerTab);

  if (!session) return null;
  const counts: Partial<Record<DrawerTab, number>> = {
    activity: session.counts.tools,
    agents: session.agents.length,
    files: session.files.length,
  };

  return (
    <motion.aside
      className="drawer"
      initial={{ x: 40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 40, opacity: 0 }}
      transition={{ duration: 0.42, ease: [0.16, 1, 0.3, 1] }}
      aria-label="Session details"
    >
      <PanelHeader s={session} onClose={() => select(null)} />
      <ControlStrip s={session} />
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
            {counts[t.id] ? <span className="tab-count">{counts[t.id]! > 999 ? '999+' : counts[t.id]}</span> : null}
          </button>
        ))}
      </div>
      <div className="drawer-body">
        {tab === 'chat' && <ChatTab s={session} />}
        {tab === 'activity' && <ActivityTab s={session} />}
        {tab === 'agents' && <AgentsTab s={session} />}
        {tab === 'files' && <FilesTab s={session} />}
        {tab === 'process' && <WhereTab s={session} />}
      </div>
      {tab === 'chat' && <Composer key={session.id} session={session} />}
    </motion.aside>
  );
}

function PanelHeader({ s, onClose }: { s: Session; onClose: () => void }) {
  const now = useNow(5000);
  return (
    <header className="drawer-head">
      <div className="drawer-head-row">
        <StatusPill status={s.status} />
        <ModelTag model={s.model} />
        {s.control.paused && <span className="flag flag-warn">Paused</span>}
        {s.control.managed && <span className="flag">In monitor</span>}
        <div className="spacer" />
        <IconButton label="Close (Esc)" onClick={onClose}><X size={16} /></IconButton>
      </div>
      <h2 className="drawer-title" title={sessionLabel(s)}>{sessionLabel(s)}</h2>
      <div className="drawer-sub">
        <span>{s.projectName}</span>
        {s.gitBranch && <span className="sub-item"><GitBranch size={12} />{s.gitBranch}</span>}
        <span className="sub-item"><Cpu size={12} />{hostLine(s)}</span>
        <span className="sub-item"><Clock3 size={12} />{timeAgo(s.lastActivity, now)}</span>
      </div>
    </header>
  );
}

function ControlStrip({ s }: { s: Session }) {
  const { pause, stop, takeOver, kill } = useStore.getState();
  const cost = costByModel(s.usageByModel);
  const win = contextWindow(s.model);
  const canSteer = s.control.managed || s.control.hooks;
  const running = s.status === 'working' || s.status === 'blocked';
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);

  return (
    <div className="control-strip">
      {s.control.pending && <ApprovalInline s={s} />}
      <div className="strip-actions">
        {s.live && !s.control.managed && (
          <Button size="sm" variant={s.control.paused ? 'primary' : 'secondary'} disabled={!canSteer}
            icon={s.control.paused ? <Play size={14} /> : <Pause size={14} />}
            title={canSteer ? 'Hold the next tool call until you resume' : 'Turn on session control to pause sessions started outside the monitor'}
            onClick={() => pause(s.id, !s.control.paused)}>
            {s.control.paused ? 'Resume' : 'Pause'}
          </Button>
        )}
        {(s.live || s.control.managed) && (
          <Button size="sm" disabled={!canSteer || !running} icon={<CircleStop size={14} />}
            title={canSteer ? 'Stop the current turn' : 'Turn on session control to stop sessions started outside the monitor'}
            onClick={() => stop(s.id)}>
            Stop turn
          </Button>
        )}
        {!s.live && !s.control.managed && (
          <Button size="sm" variant="primary" icon={<RotateCcw size={14} />} onClick={() => takeOver(s.id)} title="Resume this session inside the monitor">
            Resume here
          </Button>
        )}
        <Button size="sm" variant="ghost" icon={<SquareTerminal size={14} />}
          title={s.process?.kind === 'background' ? 'Attach to this background session in a terminal'
            : s.live ? 'Open a terminal in this folder' : 'Resume this session in a terminal'}
          onClick={() => api().openTerminal(s.id, s.cwd)}>
          {s.process?.kind === 'background' ? 'Attach' : 'Terminal'}
        </Button>
        {(s.process || s.control.managed) && (
          <Button size="sm" variant={armed ? 'danger' : 'ghost'} icon={<Power size={14} />}
            onClick={() => { if (armed) { kill(s.id); setArmed(false); } else setArmed(true); }}
            title={s.control.managed ? 'Close the session the monitor is running' : 'End the Claude process'}>
            {armed ? 'Click to confirm' : s.control.managed ? 'Close' : 'End'}
          </Button>
        )}
      </div>
      <div className="strip-stats">
        <div className="strip-stat" title="How full the context window is">
          <div className="strip-stat-top"><span>Context</span><span className="num">{tokens(s.contextTokens)} / {tokens(win)}</span></div>
          <Meter value={s.contextTokens} max={win} />
        </div>
        <div className="strip-stat" title="API-equivalent cost of every token in this session">
          <div className="strip-stat-top"><span>Cost</span><span className="num">{usd(cost)}</span></div>
          <div className="strip-stat-sub">{tokens(s.usage.output)} out · {tokens(s.usage.cacheRead)} cached</div>
        </div>
        <div className="strip-stat" title="Tool calls per minute, last hour">
          <div className="strip-stat-top"><span>Last hour</span><span className="num">{s.activity.reduce((a, b) => a + b, 0)} calls</span></div>
          <Sparkline data={s.activity} width={120} height={18} />
        </div>
      </div>
    </div>
  );
}

function ApprovalInline({ s }: { s: Session }) {
  const p = s.control.pending!;
  const approve = useStore((st) => st.approve);
  const now = useNow(500);
  const left = Math.max(0, Math.ceil((p.ts + p.holdSecs * 1000 - now) / 1000));
  const cmd = (p.input?.command as string) || (p.input?.file_path as string) || p.detail;
  const why = p.input?.description as string | undefined;
  return (
    <div className="approval-inline">
      <div className="approval-inline-head">
        <ShieldAlert size={16} />
        <span>Claude wants to run <b>{fmtToolName(p.toolName)}</b></span>
        <div className="spacer" />
        {p.held ? <span className="countdown num">{left}s</span> : <span className="countdown">answer in terminal</span>}
      </div>
      <pre className="approval-cmd">{truncate(cmd, 600)}</pre>
      {why && <div className="approval-why">{why}</div>}
      {p.held ? (
        <div className="approval-actions">
          <Button size="sm" variant="primary" icon={<Check size={14} />} onClick={() => approve(s.id, true)}>Allow</Button>
          <Button size="sm" variant="danger" icon={<XCircle size={14} />} onClick={() => approve(s.id, false)}>Deny</Button>
        </div>
      ) : (
        <div className="approval-why">The hold expired, so the prompt moved to {s.process?.host ?? 'the terminal'}.</div>
      )}
    </div>
  );
}

function ChatTab({ s }: { s: Session }) {
  const live = useStore((st) => st.liveText[s.id]);
  const cancel = (mid: string) => api().cancelMessage(s.id, mid);
  const end = useRef<HTMLDivElement>(null);
  const count = s.messages.length + (live ? 1 : 0) + s.control.queued.length;
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [count, live]);

  return (
    <div className="chat">
      {s.thinking && s.status === 'working' && (
        <div className="thinking"><span className="thinking-label">Thinking</span>{truncate(s.thinking, 320)}</div>
      )}
      {s.messages.length === 0 && !live && <Empty title="No messages yet" />}
      {s.messages.map((m, i) => (
        <div key={`${m.ts}-${i}`} className={`msg msg-${m.role}`}>
          <div className="msg-meta">{m.role === 'user' ? 'You' : 'Claude'} · {clock(m.ts)}</div>
          <div className="msg-text">{m.text}</div>
        </div>
      ))}
      {live && (
        <div className="msg msg-assistant streaming">
          <div className="msg-meta">Claude · typing</div>
          <div className="msg-text">{live}<span className="caret" /></div>
        </div>
      )}
      {s.status === 'working' && !live && s.currentTool && (
        <div className="working-line">
          <span className="pulse-dot" />
          <ToolChip name={s.currentTool.name} />
          <span className="working-detail">{truncate(trimPath(s.currentTool.detail), 90)}</span>
        </div>
      )}
      {s.control.queued.map((q) => (
        <div key={q.id} className="msg msg-user queued">
          <div className="msg-meta">You · queued {clock(q.ts)}
            <button className="link-btn" onClick={() => cancel(q.id)}><Trash2 size={12} /> Cancel</button>
          </div>
          <div className="msg-text">{q.text}</div>
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}

function ActivityTab({ s }: { s: Session }) {
  const tools = [...s.tools].reverse();
  const now = useNow(1000);
  if (!tools.length) return <Empty title="No tool calls yet" />;
  return (
    <div className="activity">
      {s.todos.length > 0 && (
        <div className="todos">
          {s.todos.map((t, i) => (
            <div key={i} className={`todo todo-${t.status}`}>
              <span className="todo-box">{t.status === 'completed' ? <Check size={11} /> : null}</span>
              {t.content}
            </div>
          ))}
        </div>
      )}
      {tools.map((t) => {
        const running = t.endTs == null && t.ok == null;
        return (
          <div key={t.id} className={`act-row${t.ok === false ? ' failed' : ''}`} style={{ ['--c' as string]: toolColor(t.name) }}>
            <span className="act-time num">{clock(t.ts)}</span>
            <ToolChip name={t.name} />
            <span className="act-detail" title={t.detail}>{trimPath(t.detail)}</span>
            <span className="act-dur num">{running ? <span className="running">{duration(now - t.ts)}</span> : duration((t.endTs ?? t.ts) - t.ts)}</span>
          </div>
        );
      })}
    </div>
  );
}

function AgentsTab({ s }: { s: Session }) {
  const now = useNow(1000);
  if (!s.agents.length) return <Empty icon={<Bot size={22} />} title="No sub-agents">Agents this session spawns appear here as they start.</Empty>;
  const agents = [...s.agents].reverse();
  return (
    <div className="agents">
      {agents.map((a) => (
        <div key={a.id} className={`agent-card ag-${a.status}`}>
          <div className="agent-top">
            <span className={`status-dot solo ${a.status === 'working' ? 'st-working' : a.status === 'error' ? 'st-blocked' : 'st-done'}`} />
            <span className="agent-type">{a.agentType}</span>
            {a.background && <span className="flag">Background</span>}
            {a.model && <ModelTag model={a.model} />}
            <div className="spacer" />
            <span className="num agent-dur">{duration((a.status === 'working' ? now : a.lastActivity ?? now) - (a.startedAt ?? now))}</span>
          </div>
          <div className="agent-desc">{a.description || 'No description'}</div>
          {a.status === 'working' && a.currentTool && (
            <div className="working-line"><span className="pulse-dot" /><ToolChip name={a.currentTool.name} /><span className="working-detail">{truncate(trimPath(a.currentTool.detail), 70)}</span></div>
          )}
          <div className="agent-foot">
            <span>{a.toolCount} tool calls</span>
            <span>{tokens(a.usage.output)} out</span>
            {a.status !== 'working' && a.lastText && <span className="agent-last" title={a.lastText}>{truncate(a.lastText, 60)}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function FilesTab({ s }: { s: Session }) {
  const isTauri = useStore((st) => st.backendKind === 'tauri');
  if (!s.files.length) return <Empty title="No files touched yet" />;
  const changed = s.files.filter((f) => f.writes > 0);
  const read = s.files.filter((f) => f.writes === 0);
  const Row = ({ f }: { f: Session['files'][number] }) => (
    <button className="file-row" onClick={() => isTauri && api().openEditor(f.path)} title={f.path}>
      <span className="file-name">{basename(f.path)}</span>
      <span className="file-dir">{truncate(f.path.replace(/\/[^/]*$/, '').replace(s.cwd?.replace(/\\/g, '/') ?? '', '.'), 48)}</span>
      <span className="file-counts num">{f.writes > 0 && <span className="w">{f.writes}×edit</span>}{f.reads > 0 && <span className="r">{f.reads}×read</span>}</span>
    </button>
  );
  return (
    <div className="files">
      <div className="section-label">Changed · {changed.length}</div>
      {changed.map((f) => <Row key={f.path} f={f} />)}
      <div className="section-label">Read · {read.length}</div>
      {read.map((f) => <Row key={f.path} f={f} />)}
    </div>
  );
}

function WhereTab({ s }: { s: Session }) {
  const p = s.process;
  const isTauri = useStore((st) => st.backendKind === 'tauri');
  const rows: [string, string | null | undefined][] = [
    ['Runs in', s.control.managed ? 'Claude Session Monitor' : p ? (p.kind === 'background' ? 'Background session' : p.host) : s.live ? 'Unknown' : 'Not running'],
    ['Machine', p?.machine],
    ['Process', p ? `PID ${p.pid} · ${p.cpu.toFixed(0)}% CPU · ${p.memMb} MB` : null],
    ['Started from', p?.entrypoint ?? s.entrypoint],
    ['Session name', p?.name],
    ['Folder', s.cwd],
    ['Branch', s.gitBranch],
    ['Permissions', permissionModeLabel(s.permissionMode)],
    ['Effort', s.effort],
    ['Claude Code', s.version],
    ['Control', s.control.managed ? 'Full: the monitor runs this session' : s.control.hooks ? 'Hooks: approve, pause, stop and message' : 'Watch only'],
    ['Session id', s.id],
    ['Transcript', s.transcript],
  ];
  return (
    <div className="where">
      {p && p.hostChain.length > 0 && (
        <div className="host-chain" aria-label="Process tree">
          {[...p.hostChain].reverse().slice(-4).map((h, i) => (
            <span key={i} className="host-node">{h.replace(/\.exe$/i, '')}</span>
          ))}
          <span className="host-node claude">claude · {p.pid}</span>
        </div>
      )}
      <dl className="kv">
        {rows.filter(([, v]) => v).map(([k, v]) => (
          <div key={k} className="kv-row"><dt>{k}</dt><dd title={v ?? ''}>{v}</dd></div>
        ))}
      </dl>
      {s.cwd && isTauri && (
        <div className="where-actions">
          <Button size="sm" icon={<FolderOpen size={14} />} onClick={() => api().openFolder(s.cwd!)}>Open folder</Button>
          <Button size="sm" icon={<Code2 size={14} />} onClick={() => api().openEditor(s.cwd!)}>Open in VS Code</Button>
        </div>
      )}
      <div className="where-status" style={{ color: STATUS[s.status].color }}>{STATUS[s.status].hint}</div>
    </div>
  );
}
