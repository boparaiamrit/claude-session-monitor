export function modelInfo(m: string | null): { label: string; cls: string } {
  if (!m) return { label: '???', cls: '' };
  // Parse version from model IDs like "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"
  const families: [string, string][] = [['opus', 'model-opus'], ['sonnet', 'model-sonnet'], ['haiku', 'model-haiku']];
  for (const [family, cls] of families) {
    if (m.includes(family)) {
      const name = family.charAt(0).toUpperCase() + family.slice(1);
      // Extract version: match digits after the family name, e.g. "opus-4-6" → "4.6"
      const versionMatch = m.match(new RegExp(family + '[- ](\\d+)[- ](\\d+)'));
      if (versionMatch) {
        return { label: `${name} ${versionMatch[1]}.${versionMatch[2]}`, cls };
      }
      return { label: name, cls };
    }
  }
  return { label: m.split('-').pop() || m, cls: '' };
}

export function chipClass(name: string): string {
  const known = ['Agent', 'Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'TodoWrite', 'Skill', 'WebSearch', 'WebFetch', 'ToolSearch', 'TaskOutput', 'TaskStop'];
  return known.includes(name) ? name : 'default';
}

export function stickyClass(name: string): string {
  const known = ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'Agent', 'TodoWrite', 'Skill', 'WebSearch', 'WebFetch'];
  return known.includes(name) ? name : 'default';
}

export function fmtToolName(name: string): string {
  if (!name) return name;
  if (name.startsWith('mcp__') || name.startsWith('mcp_')) {
    const parts = name.split('__').filter(Boolean);
    if (parts.length >= 3) return parts.slice(2).join(' ');
    if (parts.length === 2) return parts[1];
  }
  return name;
}

export function agentTypeClass(t: string | null | undefined): string {
  if (!t) return 'general';
  const lower = t.toLowerCase();
  if (lower.includes('explore') || lower === 'explore') return 'explore';
  if (lower.includes('research')) return 'researcher';
  if (lower.includes('review')) return 'reviewer';
  if (lower.includes('execut')) return 'executor';
  if (lower.includes('plan')) return 'planner';
  return 'general';
}

export function fmtProject(p: string): string {
  if (!p) return 'Unknown';
  return p.replace(/^C--Users-[^-]+-/, '').replace(/-/g, '/').replace(/^C--/, '');
}

export function fmtProjectShort(p: string, cwd: string | null): string {
  if (cwd) {
    const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  const full = fmtProject(p);
  const parts = full.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : full;
}

export function fmtTimeAgo(ts: string | null): string {
  if (!ts) return '';
  const d = (Date.now() - new Date(ts).getTime()) / 1000;
  if (d < 60) return Math.floor(d) + 's ago';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  return Math.floor(d / 86400) + 'd ago';
}

export function fmtBytes(b: number): string {
  if (!b) return '0B';
  if (b < 1024) return b + 'B';
  if (b < 1048576) return (b / 1024).toFixed(1) + 'KB';
  return (b / 1048576).toFixed(1) + 'MB';
}

export function truncate(s: string, n: number): string {
  return !s ? '' : s.length > n ? s.slice(0, n) + '...' : s;
}

export function basename(s: string): string {
  if (!s) return '';
  // Extract basename from file paths (Windows or Unix)
  const parts = s.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || s;
}

export function trimPath(s: string): string {
  if (!s) return '';
  // Edit detail format: "path: old → new" — trim the path part
  const arrowIdx = s.indexOf(': ');
  if (arrowIdx > 0 && s.includes('→')) {
    const pathPart = s.slice(0, arrowIdx);
    const rest = s.slice(arrowIdx);
    if (pathPart.includes('/') || pathPart.includes('\\')) return basename(pathPart) + rest;
    return s;
  }
  // If it looks like a file path, show only basename
  if (s.includes('/') || s.includes('\\')) return basename(s);
  return s;
}

export function esc(s: string): string {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
