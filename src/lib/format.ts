import type { Session } from '../types';

export function modelInfo(m: string | null | undefined): { label: string; family: string } {
  if (!m) return { label: 'Unknown', family: '' };
  for (const family of ['fable', 'mythos', 'opus', 'sonnet', 'haiku']) {
    if (m.includes(family)) {
      const name = family[0].toUpperCase() + family.slice(1);
      const v = m.match(new RegExp(family + '[- ](\\d+)(?:[- ](\\d{1,2}))?(?![\\d])'));
      if (v) return { label: v[2] ? `${name} ${v[1]}.${v[2]}` : `${name} ${v[1]}`, family };
      return { label: name, family };
    }
  }
  return { label: m.split('-').pop() || m, family: '' };
}

export function fmtToolName(name: string): string {
  if (!name) return name;
  if (name.startsWith('mcp__')) {
    const parts = name.split('__').filter(Boolean);
    if (parts.length >= 3) return parts.slice(2).join(' ');
    if (parts.length === 2) return parts[1];
  }
  return name;
}

export function basename(s: string | null | undefined): string {
  if (!s) return '';
  const parts = s.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || s;
}

/** A file path rather than a regex or command: absolute, relative, or slash-separated */
function looksLikePath(s: string): boolean {
  if (/^([A-Za-z]:[\\/]|\/|\.{1,2}[\\/]|~[\\/])/.test(s)) return true;
  return s.includes('/') && !/[\s*?()[\]{}|^$]/.test(s);
}

/** Shorten paths inside a tool detail to their file name */
export function trimPath(s: string | null | undefined): string {
  if (!s) return '';
  const arrow = s.indexOf(': ');
  if (arrow > 0 && s.includes('→')) {
    const p = s.slice(0, arrow);
    return looksLikePath(p) ? basename(p) + s.slice(arrow) : s;
  }
  if (!s.includes(' ') && looksLikePath(s)) return basename(s);
  return s;
}

export function truncate(s: string | null | undefined, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function timeAgo(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '—';
  const d = Math.max(0, (now - ts) / 1000);
  if (d < 5) return 'now';
  if (d < 60) return `${Math.floor(d)}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

export function duration(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function tokens(n: number | null | undefined): string {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`;
  return `${(n / 1e9).toFixed(2)}B`;
}

export function usd(n: number): string {
  if (n < 0.01) return n === 0 ? '$0' : '<$0.01';
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString()}`;
}

export function bytes(b: number): string {
  if (!b) return '0 B';
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function sessionLabel(s: { title: string | null; projectName: string; id: string }): string {
  return s.title || `${s.projectName} · ${s.id.slice(0, 6)}`;
}

export function permissionModeLabel(m: string | null | undefined): string {
  switch (m) {
    case 'default': case 'manual': return 'Ask';
    case 'acceptEdits': return 'Auto-edit';
    case 'plan': return 'Plan';
    case 'auto': return 'Auto';
    case 'dontAsk': return "Don't ask";
    case 'bypassPermissions': return 'Bypass';
    default: return m || '—';
  }
}

/** Where a session runs, in one line: "VS Code · PID 1234" */
export function hostLine(s: Session): string {
  if (s.control.managed) return 'Running inside the monitor';
  if (!s.process) return s.live ? 'Running' : 'Not running';
  const kind = s.process.kind === 'background' ? 'Background session' : s.process.host;
  return `${kind} · PID ${s.process.pid}`;
}
