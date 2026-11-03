// One backend surface for the UI: the Tauri app in production, a live simulator in a
// plain browser (vite dev / screenshots / demos).
import type { ControlInfo, Delta, HookEvent, StartOpts } from '../types';

type Unlisten = () => void;

declare global {
  interface Window {
    __TAURI__?: {
      core: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
      event: { listen: <T>(event: string, handler: (e: { payload: T }) => void) => Promise<Unlisten> };
    };
  }
}

export interface ManagedEvent {
  sessionId: string;
  data: Record<string, unknown> & { type: string };
}

export interface Events {
  'sessions-delta': Delta;
  'hook-event': HookEvent;
  'managed-event': ManagedEvent;
  'managed-exit': { sessionId: string };
  attention: { sessionId: string; kind: string; tool?: string; detail?: string };
}

export interface Backend {
  readonly kind: 'tauri' | 'demo';
  getSnapshot(): Promise<Delta>;
  controlInfo(): Promise<ControlInfo>;
  setWindow(hours: number): Promise<void>;
  installHooks(): Promise<ControlInfo>;
  uninstallHooks(): Promise<ControlInfo>;
  setApproval(mode: ControlInfo['approvalMode'], secs: number): Promise<ControlInfo>;
  /** Resolves to how it was delivered: sent | queued | resumed */
  sendMessage(sessionId: string, text: string, steer?: boolean): Promise<'sent' | 'queued' | 'resumed'>;
  cancelMessage(sessionId: string, messageId: string): Promise<void>;
  resolvePermission(sessionId: string, allow: boolean, message?: string): Promise<boolean>;
  setPaused(sessionId: string, paused: boolean): Promise<void>;
  stopTurn(sessionId: string): Promise<'interrupted' | 'stopping'>;
  startSession(opts: StartOpts): Promise<string>;
  takeOver(sessionId: string): Promise<string>;
  release(sessionId: string): Promise<boolean>;
  killProcess(pid: number): Promise<boolean>;
  stopBackground(name: string): Promise<void>;
  openTerminal(sessionId: string | null, cwd?: string | null): Promise<void>;
  openFolder(path: string): Promise<void>;
  openEditor(path: string): Promise<void>;
  on<K extends keyof Events>(event: K, cb: (payload: Events[K]) => void): Promise<Unlisten>;
}

function tauriBackend(): Backend {
  const t = window.__TAURI__!;
  const call = <T,>(cmd: string, args?: Record<string, unknown>) => t.core.invoke<T>(cmd, args);
  return {
    kind: 'tauri',
    getSnapshot: () => call('get_snapshot'),
    controlInfo: () => call('control_info'),
    setWindow: (hours) => call('set_window', { hours }),
    installHooks: () => call('install_hooks'),
    uninstallHooks: () => call('uninstall_hooks'),
    setApproval: (mode, secs) => call('set_approval', { mode, secs }),
    sendMessage: (sessionId, text, steer) => call('send_message', { sessionId, text, steer: steer ?? false }),
    cancelMessage: (sessionId, messageId) => call('cancel_message', { sessionId, messageId }),
    resolvePermission: (sessionId, allow, message) => call('resolve_permission', { sessionId, allow, message: message ?? null }),
    setPaused: (sessionId, paused) => call('set_paused', { sessionId, paused }),
    stopTurn: (sessionId) => call('stop_turn', { sessionId }),
    startSession: (opts) => call('start_session', { opts }),
    takeOver: (sessionId) => call('take_over', { sessionId }),
    release: (sessionId) => call('release', { sessionId }),
    killProcess: (pid) => call('kill_process', { pid }),
    stopBackground: (name) => call('stop_background', { name }),
    openTerminal: (sessionId, cwd) => call('open_terminal', { sessionId, cwd: cwd ?? null }),
    openFolder: (path) => call('open_folder', { path }),
    openEditor: (path) => call('open_editor', { path }),
    on: (event, cb) => t.event.listen(event, (e) => cb(e.payload as never)),
  };
}

let backend: Backend | null = null;

export async function getBackend(): Promise<Backend> {
  if (backend) return backend;
  if (window.__TAURI__?.core) {
    backend = tauriBackend();
  } else {
    // ?replay=<url> renders a saved `--dump` snapshot instead of the simulator
    const replay = new URLSearchParams(location.search).get('replay');
    const { demoBackend, replayBackend } = await import('./mock');
    backend = replay ? await replayBackend(replay) : demoBackend();
  }
  return backend;
}

/** Synchronous access once `getBackend()` has resolved (the store awaits it on boot). */
export function api(): Backend {
  if (!backend) throw new Error('backend not ready');
  return backend;
}
