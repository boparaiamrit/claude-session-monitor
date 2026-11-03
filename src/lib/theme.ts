// Colors shared by the 2D UI and the 3D scenes. CSS mirrors these in tokens.css.
import type { SessionStatus } from '../types';

export const STATUS: Record<SessionStatus, { label: string; hint: string; color: string }> = {
  working: { label: 'Working', hint: 'Claude is running a turn', color: '#ff9254' },
  blocked: { label: 'Needs you', hint: 'Waiting for a permission decision', color: '#ff4d6d' },
  waiting: { label: 'Your turn', hint: 'Turn finished, waiting for your next message', color: '#7c9cff' },
  idle: { label: 'Closed', hint: 'No Claude process is running for this session', color: '#5d6475' },
};

export const OK = '#3ddc97';
export const ERR = '#ff4d6d';

const TOOL_COLORS: Record<string, string> = {
  Read: '#60a5fa', NotebookRead: '#60a5fa',
  Edit: '#a78bfa', MultiEdit: '#a78bfa', NotebookEdit: '#a78bfa',
  Write: '#f472b6',
  Bash: '#34d399', PowerShell: '#34d399', Monitor: '#34d399',
  Grep: '#22d3ee', Glob: '#fbbf24',
  Agent: '#fb923c', Task: '#fb923c', SendMessage: '#fb923c',
  WebFetch: '#2dd4bf', WebSearch: '#2dd4bf',
  TodoWrite: '#f87171', TaskCreate: '#f87171', TaskUpdate: '#f87171',
  Skill: '#e879f9', ToolSearch: '#94a3b8',
};

export function toolColor(name: string | null | undefined): string {
  if (!name) return '#94a3b8';
  if (name.startsWith('mcp__')) return '#818cf8';
  return TOOL_COLORS[name] ?? '#94a3b8';
}

export type ToolKind = 'read' | 'write' | 'run' | 'search' | 'agent' | 'web' | 'plan' | 'mcp' | 'other';

export function toolKind(name: string | null | undefined): ToolKind {
  switch (name) {
    case 'Read': case 'NotebookRead': return 'read';
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': return 'write';
    case 'Bash': case 'PowerShell': case 'Monitor': return 'run';
    case 'Grep': case 'Glob': case 'ToolSearch': return 'search';
    case 'Agent': case 'Task': case 'SendMessage': return 'agent';
    case 'WebFetch': case 'WebSearch': return 'web';
    case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate': case 'Skill': return 'plan';
  }
  if (name?.startsWith('mcp__')) return 'mcp';
  return 'other';
}

/** Stable pseudo-random number in [0,1) from a string (layout jitter, phases). */
export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

// Twelve well-separated hues. Each project prefers the hue its name hashes to and
// takes the next free one if that's already used, so up to twelve projects never share.
const HUES = [204, 28, 160, 262, 340, 48, 188, 300, 96, 12, 230, 130];
const projectHues = new Map<string, number>();

function projectHue(name: string): number {
  const known = projectHues.get(name);
  if (known != null) return known;
  const used = new Set(projectHues.values());
  const start = Math.floor(hash01(name) * HUES.length);
  let hue = HUES[start];
  for (let i = 0; i < HUES.length; i++) {
    const h = HUES[(start + i) % HUES.length];
    if (!used.has(h)) { hue = h; break; }
  }
  projectHues.set(name, hue);
  return hue;
}

/** Claim hues in name order so the same set of projects gets the same colors every launch */
export function registerProjects(names: string[]) {
  [...new Set(names)].sort().forEach(projectHue);
}

/** A distinct hue per project */
export function projectColor(name: string): string {
  return `hsl(${projectHue(name)} 70% 62%)`;
}
