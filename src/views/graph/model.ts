// Pure data for the graph: which files each session touched, which are shared,
// and which look like conflicts. Rebuilt when the visible sessions change.
import type { Agent, Session } from '../../types';

export const FILES_PER_SESSION = 25;
export const DONE_AGENTS_PER_SESSION = 4;

export interface Touch {
  sessionId: string;
  reads: number;
  writes: number;
  lastTs: number;
}

export interface FileInfo {
  key: string;
  path: string;
  /** Most recent first */
  touches: Touch[];
  written: boolean;
  shared: boolean;
  /** Written by 2+ sessions, or written by one and read by another live one */
  conflict: boolean;
  lastTs: number;
}

export function fileKey(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

export function analyzeFiles(sessions: Session[]): Map<string, FileInfo> {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const map = new Map<string, FileInfo>();
  for (const s of sessions) {
    for (const f of s.files) {
      const key = fileKey(f.path);
      let info = map.get(key);
      if (!info) {
        info = { key, path: f.path.replace(/\\/g, '/'), touches: [], written: false, shared: false, conflict: false, lastTs: 0 };
        map.set(key, info);
      }
      const prev = info.touches.find((t) => t.sessionId === s.id);
      if (prev) {
        prev.reads += f.reads;
        prev.writes += f.writes;
        prev.lastTs = Math.max(prev.lastTs, f.lastTs);
      } else {
        info.touches.push({ sessionId: s.id, reads: f.reads, writes: f.writes, lastTs: f.lastTs });
      }
    }
  }
  for (const info of map.values()) {
    info.touches.sort((a, b) => b.lastTs - a.lastTs);
    info.lastTs = info.touches[0]?.lastTs ?? 0;
    const writers = info.touches.filter((t) => t.writes > 0);
    info.written = writers.length > 0;
    info.shared = info.touches.length > 1;
    info.conflict = writers.length >= 2
      || (writers.length === 1 && info.touches.some((t) => t.sessionId !== writers[0].sessionId && t.reads > 0 && byId.get(t.sessionId)?.live));
  }
  return map;
}

export type NodeKind = 'project' | 'session' | 'agent' | 'file';

export interface NodeSpec {
  id: string;
  kind: NodeKind;
  /** Where a new node should appear */
  parent: string | null;
  project: string;
  session?: Session;
  agent?: Agent;
  file?: FileInfo;
}

export interface LinkSpec {
  id: string;
  kind: 'ps' | 'sf';
  source: string;
  target: string;
  write: boolean;
  lastTs: number;
}

export interface Spec {
  nodes: NodeSpec[];
  links: LinkSpec[];
  hiddenFiles: number;
}

export const projectId = (name: string) => `p:${name}`;
export const sessionId = (id: string) => `s:${id}`;
export const agentId = (id: string) => `a:${id}`;
export const fileId = (key: string) => `f:${key}`;

function agentsFor(s: Session): Agent[] {
  const working = s.agents.filter((a) => a.status === 'working' && s.live);
  const done = s.agents
    .filter((a) => !(a.status === 'working' && s.live))
    .sort((a, b) => (b.lastActivity ?? b.startedAt ?? 0) - (a.lastActivity ?? a.startedAt ?? 0))
    .slice(0, DONE_AGENTS_PER_SESSION);
  return [...working, ...done];
}

export function buildSpec(sessions: Session[], files: Map<string, FileInfo>, showAll: boolean): Spec {
  const nodes: NodeSpec[] = [];
  const links: LinkSpec[] = [];
  const seenProjects = new Set<string>();
  const fileNodes = new Set<string>();
  let hidden = 0;
  for (const s of sessions) {
    const pid = projectId(s.projectName);
    if (!seenProjects.has(pid)) {
      seenProjects.add(pid);
      nodes.push({ id: pid, kind: 'project', parent: null, project: s.projectName });
    }
    const sid = sessionId(s.id);
    nodes.push({ id: sid, kind: 'session', parent: pid, project: s.projectName, session: s });
    links.push({ id: `${pid}>${sid}`, kind: 'ps', source: pid, target: sid, write: false, lastTs: s.lastActivity ?? 0 });
    for (const a of agentsFor(s)) nodes.push({ id: agentId(a.id), kind: 'agent', parent: sid, project: s.projectName, session: s, agent: a });

    const recent = [...s.files].sort((a, b) => b.lastTs - a.lastTs);
    recent.forEach((f, i) => {
      const key = fileKey(f.path);
      const info = files.get(key);
      if (!info) return;
      // Shared files always stay visible: they are the point of this view
      if (!showAll && i >= FILES_PER_SESSION && !info.shared) { hidden++; return; }
      const fid = fileId(key);
      if (!fileNodes.has(fid)) {
        fileNodes.add(fid);
        nodes.push({ id: fid, kind: 'file', parent: sid, project: s.projectName, file: info });
      }
      links.push({ id: `${sid}>${fid}`, kind: 'sf', source: sid, target: fid, write: f.writes > 0, lastTs: f.lastTs });
    });
  }
  return { nodes, links, hiddenFiles: hidden };
}
