import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Activity, ArrowUpRight, Check, CircleStop, Cpu, Ellipsis, Eye, GitBranch, MessageSquare, MonitorDot,
  Pause, Play, Power, RotateCcw, Server, ShieldAlert, ShieldCheck, SquareCode, SquareTerminal, X, XCircle,
} from 'lucide-react';
import type { Agent, Session, ToolCall } from '../../types';
import { useStore } from '../../lib/store';
import { api } from '../../lib/bridge';
import { contextWindow, costByModel } from '../../lib/pricing';
import { projectColor } from '../../lib/theme';
import { duration, fmtToolName, sessionLabel, timeAgo, tokens, trimPath, truncate, usd } from '../../lib/format';
import { Button, IconButton, Meter, ModelTag, Sparkline, StatusPill, ToolChip } from '../../components/ui';
import { Composer } from '../../components/Composer';
import { deliveryNote } from '../../lib/delivery';
import { hms, stopwatch, useTick } from './tick';

const EASE_OUT = [0.16, 1, 0.3, 1] as const;
const EASE_IN = [0.6, 0, 0.9, 0.35] as const;

const isRunning = (t: ToolCall | null | undefined) => !!t && t.endTs == null && t.ok == null;

/** Shorten file paths only; search patterns and commands stay as typed */
const shortDetail = (t: ToolCall) => (t.file || /^([A-Za-z]:)?[\\/]/.test(t.detail) ? trimPath(t.detail) : t.detail);

/** Why a control can't reach this session, in plain words (null when it can) */
function blockedReason(s: Session, hooksInstalled: boolean): string | null {
  if (s.control.managed || s.control.hooks) return null;
  if (!s.live) return 'This session is closed. Send a message or resume it to run it here.';
  return hooksInstalled
    ? 'Session control is on, but this session has not reported in yet. It does from its next action.'
    : 'Watch only. This session was started outside the monitor. Turn on session control in the top bar to approve, pause, stop and message it from here.';
}

const ENTRY_HOST: Record<string, string> = {
  'claude-vscode': 'VS Code', 'claude-jetbrains': 'JetBrains', cli: 'a terminal', 'sdk-cli': 'a script', 'sdk-ts': 'a script',
};

function hostIcon(host: string): ReactNode {
  return /terminal|iterm|pwsh|powershell|cmd|bash|zsh|warp|alacritty|kitty|wezterm/i.test(host)
    ? <SquareTerminal size={12} />
    : <SquareCode size={12} />;
}

/* ───────────── Card ───────────── */

export const SessionConsole = memo(function SessionConsole({ id, compact }: { id: string; compact: boolean }) {
  const s = useStore((st) => st.sessions[id]);
  const selected = useStore((st) => st.selectedId === id);
  const hooksInstalled = useStore((st) => st.control?.hooksInstalled ?? false);
  const [composing, setComposing] = useState(false);
  if (!s) return null;

  const tone = s.control.pending ? 'blocked' : s.status;
  const open = () => useStore.getState().select(s.id, 'chat');
  const label = sessionLabel(s);

  return (
    <article
      id={`cc-${s.id}`}
      className={`cc cc--${tone}${compact ? ' cc--compact' : ''}${selected ? ' is-selected' : ''}${s.control.paused && s.live ? ' is-paused' : ''}`}
      style={{ ['--proj' as string]: projectColor(s.projectName) }}
      aria-label={`${label}, ${s.status}`}
    >
      <div className="cc-glow" aria-hidden />

      <header className="cc-head">
        {compact ? (
          <>
            <div className="cc-row">
              <StatusPill status={s.status} compact />
              <button className="cc-title" onClick={open} title={`${label} · open the chat`}>{label}</button>
              <ModelTag model={s.model} />
            </div>
            <div className="cc-sub">
              <span className="cc-proj"><span className="cc-proj-dot" />{s.projectName}</span>
              {s.gitBranch && <span className="cc-branch"><GitBranch size={11} />{s.gitBranch}</span>}
              <div className="spacer" />
              <HostBadge s={s} short />
              <ControlBadge s={s} hooksInstalled={hooksInstalled} iconOnly />
            </div>
          </>
        ) : (
          <>
            <div className="cc-row">
              <StatusPill status={s.status} compact />
              {s.control.paused && s.live && <span className="flag flag-warn">Paused</span>}
              <div className="spacer" />
              <HostBadge s={s} />
              <ControlBadge s={s} hooksInstalled={hooksInstalled} />
            </div>
            <button className="cc-title" onClick={open} title={`${label} · open the chat`}>{label}</button>
            <div className="cc-sub">
              <span className="cc-proj"><span className="cc-proj-dot" />{s.projectName}</span>
              {s.gitBranch && <span className="cc-branch"><GitBranch size={12} />{s.gitBranch}</span>}
              <div className="spacer" />
              <ModelTag model={s.model} />
            </div>
          </>
        )}
      </header>

      <AnimatePresence initial={false}>
        {s.control.pending && (
          <motion.div key={s.control.pending.id} className="cc-approval-wrap"
            initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1, transition: { duration: 0.5, ease: EASE_OUT } }}
            exit={{ height: 0, opacity: 0, transition: { duration: 0.24, ease: EASE_IN } }}>
            <Approval s={s} compact={compact} />
          </motion.div>
        )}
      </AnimatePresence>

      <Terminal s={s} rows={compact ? 2 : 5} />

      {!compact && <Agents agents={s.agents} />}
      {s.control.queued.length > 0 && (
        <div className="cc-queued" title={s.control.queued.map((q) => q.text).join('\n\n')}>
          <MessageSquare size={12} />
          <span>{s.control.queued.length === 1 ? '1 message queued' : `${s.control.queued.length} messages queued`}</span>
          <span className="cc-queued-text">{truncate(s.control.queued[s.control.queued.length - 1].text, 70)}</span>
        </div>
      )}

      <Stats s={s} compact={compact} />

      <Controls s={s} compact={compact} hooksInstalled={hooksInstalled} composing={composing} onCompose={() => setComposing((v) => !v)} onOpen={open} />

      <AnimatePresence initial={false}>
        {composing && (
          <motion.div className="cc-compose"
            initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1, transition: { duration: 0.42, ease: EASE_OUT } }}
            exit={{ height: 0, opacity: 0, transition: { duration: 0.2, ease: EASE_IN } }}>
            <div className="cc-compose-inner">
              <Composer session={s} compact autoFocus />
              <ComposeNote s={s} hooksInstalled={hooksInstalled} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  );
});

/* ───────────── Header badges ───────────── */

function HostBadge({ s, short }: { s: Session; short?: boolean }) {
  const where = () => useStore.getState().select(s.id, 'process');
  let icon: ReactNode = <Cpu size={12} />;
  let text: string;
  let tip: string;
  const p = s.process;
  if (s.control.managed) {
    icon = <MonitorDot size={12} />;
    text = 'In monitor';
    tip = 'The monitor runs this session and owns its input';
  } else if (p?.kind === 'background') {
    icon = <Server size={12} />;
    text = short ? 'Background' : `Background · PID ${p.pid}`;
    tip = `Background session, process ${p.pid} · ${p.cpu.toFixed(0)}% CPU · ${p.memMb} MB`;
  } else if (p) {
    icon = hostIcon(p.host);
    text = short ? p.host : `${p.host} · PID ${p.pid}`;
    tip = `Runs in ${p.host}, process ${p.pid} · ${p.cpu.toFixed(0)}% CPU · ${p.memMb} MB`;
  } else if (s.live) {
    text = 'Running';
    tip = 'Running, host app unknown';
  } else {
    const was = s.entrypoint ? ENTRY_HOST[s.entrypoint] : undefined;
    text = 'Not running';
    tip = was ? `Last ran in ${was}` : 'No Claude process is running for this session';
  }
  return (
    <button className={`cc-badge${!s.live && !s.control.managed ? ' is-off' : ''}`} title={`${tip} · details`} onClick={where}>
      {icon}<span>{text}</span>
    </button>
  );
}

function ControlBadge({ s, hooksInstalled, iconOnly }: { s: Session; hooksInstalled: boolean; iconOnly?: boolean }) {
  if (s.control.managed || s.control.hooks) {
    const tip = s.control.managed
      ? 'Control on: the monitor runs this session, so every control reaches it'
      : 'Control on: approve, pause, stop and message this session from here';
    return (
      <span className="cc-badge cc-badge-ok" title={tip}>
        <ShieldCheck size={12} />{!iconOnly && <span>Control on</span>}
      </span>
    );
  }
  if (!s.live) return null;
  return (
    <button className="cc-badge cc-badge-watch" title={`${blockedReason(s, hooksInstalled)}${hooksInstalled ? '' : ' Click to set it up.'}`}
      onClick={() => !hooksInstalled && useStore.getState().setSetup(true)}>
      <Eye size={12} />{!iconOnly && <span>Watch only</span>}
    </button>
  );
}

/* ───────────── Approval ───────────── */

function Approval({ s, compact }: { s: Session; compact: boolean }) {
  const p = s.control.pending!;
  const approve = useStore((st) => st.approve);
  const now = useTick();
  const left = Math.max(0, Math.ceil((p.ts + p.holdSecs * 1000 - now) / 1000));
  const cmd = (p.input?.command as string) || (p.input?.file_path as string) || p.detail;
  const why = p.input?.description as string | undefined;
  return (
    <div className="approval-inline cc-approval">
      <div className="approval-inline-head">
        <ShieldAlert size={15} />
        <span>Wants to run <b>{fmtToolName(p.toolName)}</b></span>
        <div className="spacer" />
        {p.held ? <span className="countdown num">{left}s left</span> : <span className="countdown">answer in terminal</span>}
      </div>
      <pre className="approval-cmd">{truncate(cmd, compact ? 140 : 320)}</pre>
      {why && !compact && <div className="approval-why">{why}</div>}
      {p.held ? (
        <div className="approval-actions">
          <Button size="sm" variant="primary" icon={<Check size={14} />} onClick={() => approve(s.id, true)}>Allow</Button>
          <Button size="sm" variant="danger" icon={<XCircle size={14} />} onClick={() => approve(s.id, false)}>Deny</Button>
          <div className="spacer" />
          <div className="cc-hold" title="Time left before the prompt moves to the terminal">
            <span style={{ transform: `scaleX(${Math.min(1, left / Math.max(1, p.holdSecs))})` }} />
          </div>
        </div>
      ) : (
        <div className="approval-why">The hold expired, so the prompt moved to {s.process?.host ?? 'the terminal'}.</div>
      )}
    </div>
  );
}

/* ───────────── Mini terminal ───────────── */

/** Extra history rendered beyond the minimum, revealed when the card is stretched taller by its row */
const OVERSCAN = 8;
/** Matches --row in command.css */
const ROW_PX = 24;

function Terminal({ s, rows }: { s: Session; rows: number }) {
  const current = s.currentTool;
  const history = useMemo(() => {
    const out: ToolCall[] = [];
    for (let i = s.tools.length - 1; i >= 0 && out.length < rows + OVERSCAN; i--) {
      const t = s.tools[i];
      // The tool running right now lives on the prompt line below, not in the history
      if (current && t.id === current.id && isRunning(current) && s.status !== 'idle') continue;
      out.push(t);
    }
    return out.reverse();
  }, [s.tools, current, rows, s.status]);

  // New lines push the history up: slide the whole block one row per new line, on the
  // compositor, instead of animating each (memoized) line
  const listRef = useRef<HTMLDivElement>(null);
  const prevIds = useRef<string[]>([]);
  useLayoutEffect(() => {
    const ids = history.map((t) => t.id);
    const prev = prevIds.current;
    prevIds.current = ids;
    const el = listRef.current;
    if (!el || !prev.length || !ids.length) return;
    const at = ids.lastIndexOf(prev[prev.length - 1]);
    const shift = at < 0 ? 0 : ids.length - 1 - at;
    if (shift < 1 || shift > 4) return;
    el.animate(
      [{ transform: `translateY(${shift * ROW_PX}px)` }, { transform: 'translateY(0)' }],
      { duration: 480, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    );
  }, [history]);

  return (
    <div className="cc-term" style={{ ['--rows' as string]: rows }}>
      <div className="cc-term-hist">
        {history.length === 0 && <div className="ct-empty">No tool calls yet</div>}
        <div className="cc-term-lines" ref={listRef}>
          {history.map((t) => <TermLine key={t.id} t={t} />)}
        </div>
      </div>
      <NowLine s={s} />
    </div>
  );
}

const TermLine = memo(function TermLine({ t }: { t: ToolCall }) {
  const running = isRunning(t);
  return (
    <div className={`ct${t.ok === false ? ' is-fail' : ''}${running ? ' is-run' : ''}`}>
      <span className="ct-time">{hms(t.ts)}</span>
      <ToolChip name={t.name} />
      <span className="ct-detail" title={t.detail}>{shortDetail(t)}</span>
      <span className="ct-dur">
        {running ? <Elapsed since={t.ts} /> : t.ok === false
          ? <span className="ct-failed"><X size={11} strokeWidth={3} />failed</span>
          : duration((t.endTs ?? t.ts) - t.ts)}
      </span>
    </div>
  );
}, (a, b) => a.t.id === b.t.id && a.t.endTs === b.t.endTs && a.t.ok === b.t.ok && a.t.detail === b.t.detail);

function Elapsed({ since, className = 'ct-live' }: { since: number | null | undefined; className?: string }) {
  const now = useTick();
  if (since == null) return null;
  return <span className={className}>{stopwatch(now - since)}</span>;
}

function NowLine({ s }: { s: Session }) {
  const t = s.currentTool;
  if (s.live && s.control.paused) {
    return (
      <div className="ct-now is-paused">
        <Pause size={12} className="ct-now-icon" />
        <span className="ct-now-text">Paused. The next tool call waits until you resume.</span>
      </div>
    );
  }
  if (s.status === 'blocked' || s.control.pending) {
    const since = s.control.pending?.ts ?? t?.ts ?? s.lastActivity;
    return (
      <div className="ct-now is-blocked">
        <ShieldAlert size={12} className="ct-now-icon" />
        <span className="ct-now-text">Needs your decision{t ? <> on <b>{fmtToolName(t.name)}</b></> : null}</span>
        <Elapsed since={since} />
      </div>
    );
  }
  if (s.status === 'working') {
    if (isRunning(t)) {
      return (
        <div className="ct-now is-working">
          <span className="pulse-dot" />
          <ToolChip name={t!.name} />
          <span className="ct-detail" title={t!.detail}>{shortDetail(t!)}</span>
          <Elapsed since={t!.ts} />
        </div>
      );
    }
    return (
      <div className="ct-now is-working">
        <span className="pulse-dot" />
        <span className="ct-now-text"><span className="ct-thinking">Thinking</span>{s.thinking ? ` ${truncate(s.thinking, 140)}` : ''}</span>
        <Elapsed since={t?.endTs ?? s.lastActivity} />
      </div>
    );
  }
  if (s.status === 'waiting') {
    return (
      <div className="ct-now is-waiting">
        <span className="ct-prompt">›</span>
        <span className="ct-now-text">Waiting for your next message<span className="ct-caret" /></span>
        <Since ts={s.lastActivity} />
      </div>
    );
  }
  return (
    <div className="ct-now is-idle">
      <span className="ct-prompt">·</span>
      <span className="ct-now-text">Closed</span>
      <Since ts={s.lastActivity} />
    </div>
  );
}

function Since({ ts }: { ts: number | null }) {
  const now = useTick();
  return <span className="ct-since">{timeAgo(ts, now)}</span>;
}

/* ───────────── Agents ───────────── */

const Agents = memo(function Agents({ agents }: { agents: Agent[] }) {
  const working = agents.filter((a) => a.status === 'working');
  if (!working.length) return null;
  const shown = working.slice(-3);
  return (
    <div className="cc-agents" aria-label="Working sub-agents">
      <AnimatePresence initial={false} mode="popLayout">
        {shown.map((a) => (
          <motion.span key={a.id} layout="position" className="cc-agent"
            title={`${a.agentType}: ${a.description}${a.currentTool ? `\nNow: ${fmtToolName(a.currentTool.name)} ${trimPath(a.currentTool.detail)}` : ''}`}
            initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.2, ease: EASE_IN } }}
            transition={{ duration: 0.42, ease: EASE_OUT }}>
            <span className="pulse-dot" />
            <span className="cc-agent-type">{a.agentType}</span>
            <span className="cc-agent-desc">{a.description}</span>
          </motion.span>
        ))}
      </AnimatePresence>
      {working.length > shown.length && <span className="cc-agent more">+{working.length - shown.length}</span>}
    </div>
  );
});

/* ───────────── Stats ───────────── */

function Stats({ s, compact }: { s: Session; compact: boolean }) {
  const cost = useMemo(() => costByModel(s.usageByModel), [s.usageByModel]);
  const calls = useMemo(() => s.activity.reduce((a, b) => a + b, 0), [s.activity]);
  const win = contextWindow(s.model);
  const winLabel = win % 1_000_000 === 0 ? `${win / 1_000_000}M` : tokens(win);
  const pct = Math.round((s.contextTokens / win) * 100);
  if (compact) {
    return (
      <div className="cc-stats is-compact">
        <div className="cc-stat-ctx" title={`Context: ${tokens(s.contextTokens)} of ${winLabel} tokens`}>
          <Meter value={s.contextTokens} max={win} />
          <span className="num">{pct}%</span>
        </div>
        <span className="num cc-stat-cost" title="API-equivalent cost">{usd(cost)}</span>
        <span className="cc-stat-spark" title={`${calls} tool calls in the last hour`}><Sparkline data={s.activity} width={60} height={14} color={s.status === 'working' ? 'var(--live)' : 'var(--fg-4)'} /></span>
      </div>
    );
  }
  return (
    <div className="cc-stats">
      <div className="cc-stat" title="How full the context window is">
        <div className="cc-stat-top"><span>Context</span><span className="num">{tokens(s.contextTokens)}<span className="cc-stat-of"> / {winLabel}</span></span></div>
        <Meter value={s.contextTokens} max={win} />
      </div>
      <div className="cc-stat" title="API-equivalent cost of every token in this session">
        <div className="cc-stat-top"><span>Cost</span><span className="num">{usd(cost)}</span></div>
        <div className="cc-stat-sub num">{tokens(s.usage.output)} out</div>
      </div>
      <div className="cc-stat" title="Tool calls per minute over the last hour">
        <div className="cc-stat-top"><span>Last hour</span><span className="num">{calls}</span></div>
        <Sparkline data={s.activity} width={112} height={16} color={s.status === 'working' || s.status === 'blocked' ? 'var(--live)' : 'var(--fg-4)'} />
      </div>
    </div>
  );
}

/* ───────────── Controls ───────────── */

/** Wraps a control so a disabled one still explains itself on hover */
function Ctl({ why, children }: { why: string | null; children: ReactNode }) {
  return <span className="cc-ctl" title={why ?? undefined}>{children}</span>;
}

function Controls({ s, compact, hooksInstalled, composing, onCompose, onOpen }: {
  s: Session; compact: boolean; hooksInstalled: boolean; composing: boolean; onCompose: () => void; onOpen: () => void;
}) {
  const { pause, stop, takeOver } = useStore.getState();
  const reason = blockedReason(s, hooksInstalled);
  const canSteer = reason == null;
  const running = s.status === 'working' || s.status === 'blocked';
  const showPause = s.live && !s.control.managed && (running || s.control.paused);
  const showStop = (s.live || s.control.managed) && running;
  const showResume = !s.live && !s.control.managed;
  const canMessage = s.control.managed || !s.live || s.control.hooks;
  const msgWhy = canMessage ? null : reason;

  const pauseWhy = canSteer ? (s.control.paused ? 'Let Claude continue' : 'Hold the next tool call until you resume') : reason;
  const stopWhy = canSteer ? 'Stop the current turn' : reason;

  return (
    <div className="cc-actions">
      {showResume && (
        compact
          ? <IconButton label="Resume here: run this session inside the monitor" onClick={() => takeOver(s.id)}><RotateCcw size={15} /></IconButton>
          : <Button size="sm" icon={<RotateCcw size={14} />} onClick={() => takeOver(s.id)} title="Run this session inside the monitor">Resume here</Button>
      )}
      {showPause && (
        <Ctl why={pauseWhy}>
          {compact ? (
            <IconButton label={s.control.paused ? 'Resume' : 'Pause'} disabled={!canSteer} className={s.control.paused ? 'is-on' : ''} onClick={() => pause(s.id, !s.control.paused)}>
              {s.control.paused ? <Play size={15} /> : <Pause size={15} />}
            </IconButton>
          ) : (
            <Button size="sm" variant={s.control.paused ? 'primary' : 'secondary'} disabled={!canSteer}
              icon={s.control.paused ? <Play size={14} /> : <Pause size={14} />} onClick={() => pause(s.id, !s.control.paused)}>
              {s.control.paused ? 'Resume' : 'Pause'}
            </Button>
          )}
        </Ctl>
      )}
      {showStop && (
        <Ctl why={stopWhy}>
          {compact ? (
            <IconButton label="Stop turn" disabled={!canSteer} onClick={() => stop(s.id)}><CircleStop size={15} /></IconButton>
          ) : (
            <Button size="sm" disabled={!canSteer} icon={<CircleStop size={14} />} onClick={() => stop(s.id)}>Stop turn</Button>
          )}
        </Ctl>
      )}
      <Ctl why={msgWhy ?? (composing ? 'Hide the message box' : 'Write to Claude from here')}>
        {compact ? (
          <IconButton label="Message" disabled={!canMessage} className={composing ? 'is-on' : ''} onClick={onCompose} aria-expanded={composing}>
            <MessageSquare size={15} />
          </IconButton>
        ) : (
          <Button size="sm" variant={composing ? 'secondary' : 'ghost'} className={composing ? 'is-on' : ''} disabled={!canMessage}
            icon={<MessageSquare size={14} />} onClick={onCompose} aria-expanded={composing}>
            Message
          </Button>
        )}
      </Ctl>
      <div className="spacer" />
      {compact
        ? <IconButton label="Open session" onClick={onOpen}><ArrowUpRight size={15} /></IconButton>
        : <Button size="sm" variant="ghost" className="cc-open" icon={<ArrowUpRight size={14} />} onClick={onOpen} title="Open the chat, activity and details">Open</Button>}
      <Overflow s={s} canSteer={canSteer} reason={reason} />
    </div>
  );
}

function Overflow({ s, canSteer, reason }: { s: Session; canSteer: boolean; reason: string | null }) {
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);

  const st = useStore.getState();
  const go = (fn: () => void) => () => { fn(); setOpen(false); };
  const canEnd = !!s.process || s.control.managed;
  const waitingPause = s.live && !s.control.managed && s.status === 'waiting' && !s.control.paused;

  return (
    <div className="cc-more" ref={ref}>
      <IconButton label="More actions" onClick={() => { setOpen((v) => !v); setArmed(false); }} aria-expanded={open} aria-haspopup="menu" className={open ? 'is-on' : ''}>
        <Ellipsis size={16} />
      </IconButton>
      <AnimatePresence>
        {open && (
          <motion.div className="cc-menu" role="menu"
            initial={{ opacity: 0, y: 6, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: 0.32, ease: EASE_OUT } }}
            exit={{ opacity: 0, y: 4, scale: 0.98, transition: { duration: 0.16, ease: EASE_IN } }}>
            <button role="menuitem" className="cc-menu-item" onClick={go(() => st.select(s.id, 'activity'))}><Activity size={14} />Activity</button>
            <button role="menuitem" className="cc-menu-item" onClick={go(() => st.select(s.id, 'process'))}><Cpu size={14} />Where it runs</button>
            <button role="menuitem" className="cc-menu-item" onClick={go(() => { void api().openTerminal(s.live ? null : s.id, s.cwd); })}>
              <SquareTerminal size={14} />{s.live ? 'Open a terminal here' : 'Resume in a terminal'}
            </button>
            {waitingPause && (
              <button role="menuitem" className="cc-menu-item" disabled={!canSteer} title={reason ?? undefined} onClick={go(() => st.pause(s.id, true))}>
                <Pause size={14} />Pause before the next tool call
              </button>
            )}
            {canEnd && (
              <>
                <div className="cc-menu-sep" />
                <button role="menuitem" className={`cc-menu-item is-danger${armed ? ' is-armed' : ''}`}
                  onClick={() => { if (armed) { st.kill(s.id); setArmed(false); setOpen(false); } else setArmed(true); }}>
                  <Power size={14} />
                  {armed ? 'Click again to confirm' : s.control.managed ? 'Close this session' : `End process ${s.process?.pid ?? ''}`}
                </button>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ComposeNote({ s, hooksInstalled }: { s: Session; hooksInstalled: boolean }) {
  const note = deliveryNote(s, hooksInstalled);
  return <div className={`cc-note tone-${note.tone}`}>{note.text}</div>;
}
