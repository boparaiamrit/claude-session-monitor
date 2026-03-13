export interface AgentInfo {
  description: string;
  subagent_type: string;
  model?: string | null;
  background: boolean;
  timestamp?: string | null;
}

export interface ToolEntry {
  name: string;
  timestamp?: string | null;
  detail?: string;
  agent_info?: AgentInfo;
}

export interface MessageEntry {
  role: 'user' | 'assistant';
  text: string;
  timestamp?: string | null;
}

export interface MessageCount {
  user: number;
  assistant: number;
}

export interface Session {
  id: string;
  file: string;
  project: string;
  model: string | null;
  version: string | null;
  cwd: string | null;
  git_branch: string | null;
  started_at: string | null;
  last_activity: string | null;
  status: 'idle' | 'waiting' | 'working' | 'streaming';
  messages: MessageEntry[];
  tools_used: ToolEntry[];
  agents_spawned: AgentInfo[];
  current_tool: string | null;
  current_thinking: string | null;
  message_count: MessageCount;
  tool_count: number;
  file_size: number;
  mtime?: number;
}

export type ViewMode = 'classic' | 'office';
export type FilterMode = 'active' | 'all';
export type TabMode = 'tools' | 'agents' | 'messages' | 'files';
