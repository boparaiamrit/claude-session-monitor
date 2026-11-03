import { create } from 'zustand';
import { useMemo } from 'react';
import { api, getBackend } from './bridge';
import type { ControlInfo, Delta, FeedItem, Scope, Session, StartOpts, ViewId } from '../types';
import { fmtToolName, sessionLabel, trimPath, truncate } from './format';
import { registerProjects } from './theme';

export type DrawerTab = 'chat' | 'activity' | 'agents' | 'files' | 'process';

export interface Toast {
  id: number;
  kind: 'info' | 'ok' | 'error';
  text: string;
}

/** Latest tool start per session, sub-second when hooks are on (drives 3D reactions) */
export interface Pulse {
  ts: number;
  tool: string;
}

interface State {
  ready: boolean;
  backendKind: 'tauri' | 'demo' | null;
  sessions: Record<string, Session>;
  /** Every known session, most recent activity first */
  list: Session[];
  control: ControlInfo | null;
  view: ViewId;
  scope: Scope;
  query: string;
  selectedId: string | null;
  drawerTab: DrawerTab;
  feed: FeedItem[];
  pulses: Record<string, Pulse>;
  /** Assistant text streaming in right now, for sessions the monitor runs */
  liveText: Record<string, string>;
  toasts: Toast[];
  paletteOpen: boolean;
  newSessionOpen: boolean;
  setupOpen: boolean;

  boot(): Promise<void>;
  select(id: string | null, tab?: DrawerTab): void;
  setView(v: ViewId): void;
  setScope(s: Scope): void;
  setQuery(q: string): void;
  setDrawerTab(t: DrawerTab): void;
  setPalette(open: boolean): void;
  setNewSession(open: boolean): void;
  setSetup(open: boolean): void;
  toast(kind: Toast['kind'], text: string): void;
  dismissToast(id: number): void;

  send(sessionId: string, text: string, steer?: boolean): Promise<boolean>;
  approve(sessionId: string, allow: boolean, message?: string): Promise<void>;
  pause(sessionId: string, paused: boolean): Promise<void>;
  stop(sessionId: string): Promise<void>;
  start(opts: StartOpts): Promise<string | null>;
  takeOver(sessionId: string): Promise<void>;
  kill(sessionId: string): Promise<void>;
  setHooks(on: boolean): Promise<void>;
  setApproval(mode: ControlInfo['approvalMode'], secs: number): Promise<void>;
  setWindow(hours: number): Promise<void>;
}

const FEED_CAP = 600;
let toastSeq = 1;
/** When the user last stopped each session, so the interrupted turn isn't reported as a failure */
const stoppedAt = new Map<string, number>();

function sortList(map: Record<string, Session>): Session[] {
  return Object.values(map).sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1;
    return (b.lastActivity ?? 0) - (a.lastActivity ?? 0);
  });
}

/** Unique per message even when two share a timestamp */
function msgKey(sessionId: string, m: { ts: number; role: string; text: string }) {
  let h = 0;
  for (let i = 0; i < Math.min(64, m.text.length); i++) h = (h * 31 + m.text.charCodeAt(i)) | 0;
  return `m-${sessionId}-${m.ts}-${m.role}-${m.text.length}-${h}`;
}

function toolText(name: string, detail: string) {
  return `${fmtToolName(name)}  ${truncate(trimPath(detail), 140)}`;
}

/** Turn the difference between two versions of a session into feed lines */
function diffFeed(prev: Session | undefined, next: Session): FeedItem[] {
  const out: FeedItem[] = [];
  const seenTools = new Set(prev?.tools.map((t) => t.id) ?? []);
  const lastMsg = prev?.messages.length ? prev.messages[prev.messages.length - 1].ts : 0;
  for (const t of next.tools) {
    if (seenTools.has(t.id)) continue;
    if (prev && t.ts < (prev.lastActivity ?? 0) - 120_000) continue;
    out.push({ key: `t-${t.id}`, sessionId: next.id, ts: t.ts, kind: t.name === 'Agent' || t.name === 'Task' ? 'agent' : 'tool', tool: t.name, text: toolText(t.name, t.detail), ok: t.ok });
  }
  if (prev) {
    for (const t of next.tools) {
      const before = prev.tools.find((p) => p.id === t.id);
      if (before && before.ok == null && t.ok === false) {
        out.push({ key: `e-${t.id}`, sessionId: next.id, ts: t.endTs ?? t.ts, kind: 'error', tool: t.name, text: `${fmtToolName(t.name)} failed  ${truncate(trimPath(t.detail), 120)}`, ok: false });
      }
    }
    for (const m of next.messages) {
      if (m.ts <= lastMsg) continue;
      out.push({ key: msgKey(next.id, m), sessionId: next.id, ts: m.ts, kind: m.role === 'user' ? 'prompt' : 'reply', text: truncate(m.text, 220) });
    }
    for (const a of next.agents) {
      const before = prev.agents.find((p) => p.id === a.id);
      if (before && before.status === 'working' && a.status !== 'working') {
        out.push({ key: `a-${a.id}-done`, sessionId: next.id, ts: a.lastActivity ?? Date.now(), kind: 'agent', tool: 'Agent', text: `${a.agentType} finished  ${truncate(a.description, 120)}`, ok: a.status === 'done' });
      }
    }
    if (prev.status !== next.status) {
      const what = { working: 'started working', blocked: 'needs a permission decision', waiting: 'finished its turn', idle: 'closed' }[next.status];
      out.push({ key: `s-${next.id}-${next.status}-${Date.now()}`, sessionId: next.id, ts: Date.now(), kind: 'status', text: `${sessionLabel(next)} ${what}` });
    }
  }
  return out;
}

/** Newest first by event time, without duplicate keys */
function mergeFeed(fresh: FeedItem[], feed: FeedItem[]): FeedItem[] {
  const seen = new Set<string>();
  return [...fresh, ...feed]
    .filter((f) => (seen.has(f.key) ? false : (seen.add(f.key), true)))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, FEED_CAP);
}

/** Recent history across sessions so the feed isn't empty on launch */
function seedFeed(list: Session[]): FeedItem[] {
  const items: FeedItem[] = [];
  for (const s of list) {
    for (const t of s.tools.slice(-40)) {
      items.push({ key: `t-${t.id}`, sessionId: s.id, ts: t.ts, kind: t.name === 'Agent' || t.name === 'Task' ? 'agent' : t.ok === false ? 'error' : 'tool', tool: t.name, text: toolText(t.name, t.detail), ok: t.ok });
    }
    for (const m of s.messages.slice(-6)) {
      items.push({ key: msgKey(s.id, m), sessionId: s.id, ts: m.ts, kind: m.role === 'user' ? 'prompt' : 'reply', text: truncate(m.text, 220) });
    }
  }
  return items.sort((a, b) => b.ts - a.ts).slice(0, 300);
}

function readHash(): { view?: ViewId; id?: string } {
  const p = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));
  return { view: (p.get('view') as ViewId) || undefined, id: p.get('session') || undefined };
}

function writeHash(view: ViewId, id: string | null) {
  const p = new URLSearchParams();
  p.set('view', view);
  if (id) p.set('session', id);
  history.replaceState(null, '', `#${p.toString()}`);
}

function savedPref<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T) || fallback;
  } catch {
    return fallback;
  }
}

function savePref(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* storage unavailable */
  }
}

export const useStore = create<State>((set, get) => {
  const applyDelta = (d: Delta) => {
    const prev = get().sessions;
    const sessions = d.full ? {} as Record<string, Session> : { ...prev };
    let fresh: FeedItem[] = [];
    for (const s of d.upserts) {
      if (!d.full) fresh = fresh.concat(diffFeed(prev[s.id], s));
      sessions[s.id] = s;
    }
    for (const id of d.removed) delete sessions[id];
    const list = sortList(sessions);
    registerProjects(list.map((s) => s.projectName));
    const feed = d.full && !get().feed.length
      ? seedFeed(list)
      : fresh.length
        ? mergeFeed(fresh, get().feed)
        : get().feed;
    const pulses = { ...get().pulses };
    for (const s of d.upserts) {
      const t = s.currentTool;
      if (t && t.endTs == null && (!pulses[s.id] || pulses[s.id].ts < t.ts)) pulses[s.id] = { ts: t.ts, tool: t.name };
    }
    set({ sessions, list, feed, pulses });
  };

  const guard = async <T,>(fn: () => Promise<T>, fail: string): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      get().toast('error', `${fail}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };

  const initial = readHash();

  return {
    ready: false,
    backendKind: null,
    sessions: {},
    list: [],
    control: null,
    view: initial.view ?? savedPref<ViewId>('csm.view', 'office'),
    scope: savedPref<Scope>('csm.scope', 'live'),
    query: '',
    selectedId: initial.id ?? null,
    drawerTab: 'chat',
    feed: [],
    pulses: {},
    liveText: {},
    toasts: [],
    paletteOpen: false,
    newSessionOpen: false,
    setupOpen: false,

    async boot() {
      const be = await getBackend();
      set({ backendKind: be.kind });
      await be.on('sessions-delta', applyDelta);
      await be.on('hook-event', (e) => {
        if (e.event === 'PreToolUse' && e.toolName) {
          set({ pulses: { ...get().pulses, [e.sessionId]: { ts: e.ts, tool: e.toolName } } });
        }
      });
      await be.on('attention', (e) => {
        const s = get().sessions[e.sessionId];
        const who = s ? sessionLabel(s) : 'A session';
        get().toast('info', `${who} is asking to run ${e.tool ? fmtToolName(e.tool) : 'a tool'}${e.detail ? `: ${truncate(e.detail, 80)}` : ''}`);
      });
      await be.on('managed-event', ({ sessionId, data }) => {
        const lt = get().liveText;
        if (data.type === 'stream_event') {
          const ev = data.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
          if (ev?.delta?.type === 'text_delta' && ev.delta.text) {
            set({ liveText: { ...lt, [sessionId]: (lt[sessionId] ?? '') + ev.delta.text } });
          }
        } else if (data.type === 'assistant' || data.type === 'result') {
          if (lt[sessionId]) {
            const next = { ...lt };
            delete next[sessionId];
            set({ liveText: next });
          }
          // An interrupted turn also ends with is_error; only report real failures
          const stoppedRecently = Date.now() - (stoppedAt.get(sessionId) ?? 0) < 15_000;
          if (data.type === 'result' && data.is_error && !stoppedRecently) {
            get().toast('error', `Session ended its turn with an error${data.result ? `: ${truncate(String(data.result), 120)}` : ''}`);
          }
        }
      });
      await be.on('managed-exit', ({ sessionId }) => {
        const s = get().sessions[sessionId];
        get().toast('info', `${s ? sessionLabel(s) : 'Session'} is no longer running in the monitor`);
      });
      const [snap, control] = await Promise.all([be.getSnapshot(), be.controlInfo()]);
      applyDelta(snap);
      set({ control, ready: true });
      writeHash(get().view, get().selectedId);
    },

    select(id, tab) {
      set({ selectedId: id, ...(tab ? { drawerTab: tab } : {}) });
      writeHash(get().view, id);
    },
    setView(v) {
      set({ view: v });
      savePref('csm.view', v);
      writeHash(v, get().selectedId);
    },
    setScope(s) {
      set({ scope: s });
      savePref('csm.scope', s);
    },
    setQuery: (q) => set({ query: q }),
    setDrawerTab: (t) => set({ drawerTab: t }),
    setPalette: (open) => set({ paletteOpen: open }),
    setNewSession: (open) => set({ newSessionOpen: open }),
    setSetup: (open) => set({ setupOpen: open }),
    toast(kind, text) {
      const id = toastSeq++;
      set({ toasts: [...get().toasts.slice(-3), { id, kind, text }] });
      setTimeout(() => get().dismissToast(id), kind === 'error' ? 7000 : 4500);
    },
    dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

    async send(sessionId, text, steer) {
      const s = get().sessions[sessionId];
      const r = await guard(() => api().sendMessage(sessionId, text, steer), 'Could not send');
      if (!r) return false;
      if (r === 'sent') get().toast('ok', 'Sent');
      else if (r === 'resumed') get().toast('ok', 'Resumed this session in the monitor and sent your message');
      else if (!s?.control.hooks) get().toast('info', 'Queued, but this session is not reporting to the monitor yet. Turn on session control so the message can be delivered.');
      else if (steer) get().toast('ok', 'Queued. Claude reads it at its next tool call.');
      else get().toast('ok', 'Queued. Claude gets it when this turn ends, or with your next prompt.');
      return true;
    },
    async approve(sessionId, allow, message) {
      const ok = await guard(() => api().resolvePermission(sessionId, allow, message), 'Could not answer');
      if (ok === false) get().toast('info', 'That request was already answered in the terminal');
      else if (ok) get().toast('ok', allow ? 'Allowed' : 'Denied');
    },
    async pause(sessionId, paused) {
      await guard(() => api().setPaused(sessionId, paused), 'Could not pause');
      get().toast('ok', paused ? 'Paused. The next tool call will wait until you resume.' : 'Resumed');
    },
    async stop(sessionId) {
      stoppedAt.set(sessionId, Date.now());
      const r = await guard(() => api().stopTurn(sessionId), 'Could not stop');
      if (r === 'interrupted') get().toast('ok', 'Stopped the current turn');
      else if (r === 'stopping') get().toast('ok', 'Stopping at the next tool call');
    },
    async start(opts) {
      const id = await guard(() => api().startSession(opts), 'Could not start the session');
      if (id) {
        get().toast('ok', opts.mode === 'terminal' ? 'Opened a terminal with Claude' : opts.mode === 'background' ? 'Started a background session' : 'Session started');
        if (opts.mode === 'managed') get().select(id, 'chat');
      }
      return id;
    },
    async takeOver(sessionId) {
      const id = await guard(() => api().takeOver(sessionId), 'Could not resume');
      if (id) get().toast('ok', 'Resumed in the monitor. Type a message to continue.');
    },
    async kill(sessionId) {
      const s = get().sessions[sessionId];
      if (s?.control.managed) {
        await guard(() => api().release(sessionId), 'Could not close');
        get().toast('ok', 'Closed');
      } else if (s?.process) {
        const ok = await guard(() => api().killProcess(s.process!.pid), 'Could not end the process');
        get().toast(ok ? 'ok' : 'error', ok ? `Ended process ${s.process.pid}` : 'The process could not be ended');
      }
    },
    async setHooks(on) {
      const info = await guard(() => (on ? api().installHooks() : api().uninstallHooks()), on ? 'Could not turn on session control' : 'Could not turn off session control');
      if (info) {
        set({ control: info });
        get().toast('ok', on ? 'Session control is on. Sessions report to the monitor from their next action.' : 'Session control is off. settings.json was backed up first.');
      }
    },
    async setApproval(mode, secs) {
      const info = await guard(() => api().setApproval(mode, secs), 'Could not save');
      if (info) set({ control: info });
    },
    async setWindow(hours) {
      await guard(() => api().setWindow(hours), 'Could not change the time range');
      const c = get().control;
      if (c) set({ control: { ...c, windowHours: hours } });
    },
  };
});

/** Sessions after the scope and search filters, most relevant first */
export function useVisibleSessions(): Session[] {
  const list = useStore((s) => s.list);
  const scope = useStore((s) => s.scope);
  const query = useStore((s) => s.query);
  return useMemo(() => {
    const q = query.trim().toLowerCase();
    return list.filter((s) => {
      if (scope === 'live' && !s.live) return false;
      if (!q) return true;
      return [s.title, s.projectName, s.cwd, s.gitBranch, s.model, s.process?.host, s.id]
        .some((v) => v?.toLowerCase().includes(q));
    });
  }, [list, scope, query]);
}

export function useSession(id: string | null | undefined): Session | null {
  return useStore((s) => (id ? s.sessions[id] ?? null : null));
}

/** Sessions that need a human right now */
export function useAttention(): Session[] {
  const list = useStore((s) => s.list);
  return useMemo(() => list.filter((s) => s.status === 'blocked' || (s.control.pending != null)), [list]);
}
