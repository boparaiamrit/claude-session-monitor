// Mirrors src-tauri/src/model.rs (camelCase on the wire).

export type SessionStatus = 'working' | 'blocked' | 'waiting' | 'idle';

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ToolCall {
  id: string;
  name: string;
  detail: string;
  ts: number;
  endTs: number | null;
  ok: boolean | null;
  file: string | null;
}

export interface Message {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
}

export interface FileTouch {
  path: string;
  reads: number;
  writes: number;
  lastTs: number;
}

export interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | string;
}

export interface HourStat {
  hour: number;
  tools: number;
  errors: number;
  output: number;
  input: number;
}

export interface Agent {
  id: string;
  toolUseId: string | null;
  agentType: string;
  description: string;
  model: string | null;
  background: boolean;
  startedAt: number | null;
  lastActivity: number | null;
  status: 'working' | 'done' | 'error';
  currentTool: ToolCall | null;
  toolCount: number;
  tools: ToolCall[];
  usage: Usage;
  lastText: string | null;
}

export interface ProcessInfo {
  pid: number;
  kind: string;
  entrypoint: string | null;
  /** App hosting the session: "VS Code", "Windows Terminal", "iTerm2", ... */
  host: string;
  hostChain: string[];
  name: string | null;
  version: string | null;
  machine: string;
  cpu: number;
  memMb: number;
  startedAt: number | null;
}

export interface PendingPermission {
  id: string;
  toolName: string;
  detail: string;
  input: Record<string, unknown>;
  ts: number;
  holdSecs: number;
  /** false once the hold expired and the terminal prompt took over */
  held: boolean;
}

export interface QueuedMessage {
  id: string;
  text: string;
  ts: number;
  /** Delivered at the next tool call (steer now) rather than when the turn ends */
  steer: boolean;
}

export interface ControlState {
  /** Hook events arrive from this session, so hook controls reach it */
  hooks: boolean;
  /** The monitor launched this session and owns its input */
  managed: boolean;
  managedBusy: boolean;
  paused: boolean;
  stopRequested: boolean;
  queued: QueuedMessage[];
  pending: PendingPermission | null;
  notification: string | null;
  lastHookAt: number | null;
}

export interface Counts {
  user: number;
  assistant: number;
  tools: number;
  errors: number;
}

export interface Session {
  id: string;
  project: string;
  projectName: string;
  cwd: string | null;
  title: string | null;
  model: string | null;
  version: string | null;
  gitBranch: string | null;
  permissionMode: string | null;
  effort: string | null;
  entrypoint: string | null;
  startedAt: number | null;
  lastActivity: number | null;
  status: SessionStatus;
  /** A Claude process for this session is running right now */
  live: boolean;
  process: ProcessInfo | null;
  control: ControlState;
  currentTool: ToolCall | null;
  thinking: string | null;
  lastPrompt: string | null;
  lastText: string | null;
  counts: Counts;
  usage: Usage;
  usageByModel: Record<string, Usage>;
  /** Prompt + output tokens of the latest main-thread turn: how full the context is */
  contextTokens: number;
  tools: ToolCall[];
  messages: Message[];
  agents: Agent[];
  files: FileTouch[];
  todos: Todo[];
  /** Tool calls per minute for the last 60 minutes, oldest first */
  activity: number[];
  hourly: HourStat[];
  fileSize: number;
  transcript: string;
}

export interface Delta {
  upserts: Session[];
  removed: string[];
  full: boolean;
}

export interface ControlInfo {
  hooksInstalled: boolean;
  port: number | null;
  approvalMode: 'monitor_first' | 'monitor_only' | 'terminal';
  approvalSecs: number;
  machine: string;
  settingsPath: string;
  windowHours: number;
}

/** A hook event as it arrives (live, sub-second) */
export interface HookEvent {
  sessionId: string;
  event: string;
  toolName: string | null;
  detail: string;
  ts: number;
}

/** One line of the unified activity feed (Stream view, ticker, 3D pulses) */
export interface FeedItem {
  key: string;
  sessionId: string;
  ts: number;
  kind: 'tool' | 'prompt' | 'reply' | 'agent' | 'hook' | 'error' | 'status';
  tool?: string;
  text: string;
  ok?: boolean | null;
}

export interface StartOpts {
  cwd: string;
  prompt: string;
  model?: string;
  permissionMode?: string;
  name?: string;
  mode: 'managed' | 'background' | 'terminal';
}

export type ViewId =
  | 'office' | 'command' | 'city' | 'galaxy' | 'timeline'
  | 'graph' | 'stream' | 'analytics' | 'classic';

export type Scope = 'live' | 'recent';
