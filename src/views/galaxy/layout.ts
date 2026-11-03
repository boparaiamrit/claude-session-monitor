// Where the stars sit and how wide each orbit is. Depends only on which sessions
// exist, so systems hold still while the data ticks.
import * as THREE from 'three';
import type { Session } from '../../types';
import { hash01, projectColor } from '../../lib/theme';
import { contextWindow } from '../../lib/pricing';

export interface Orbit {
  id: string;
  /** Orbit radius around the star */
  r: number;
  /** Starting angle, stable per session */
  phase: number;
  /** Index within the system, used for speed falloff */
  index: number;
}

export interface System {
  key: string;
  name: string;
  color: string;
  pos: THREE.Vector3;
  starR: number;
  /** Orbital plane tilt */
  tilt: THREE.Euler;
  orbits: Orbit[];
  /** Outermost orbit radius */
  reach: number;
}

export interface GalaxyLayout {
  systems: System[];
  bySession: Map<string, { system: System; orbit: Orbit }>;
  center: THREE.Vector3;
  /** Radius that contains every system */
  extent: number;
}

const GOLDEN = 2.39996;

/** Planet radius from how full its context window is */
export function planetSize(s: Session): number {
  const fill = Math.min(1, Math.max(0, s.contextTokens / contextWindow(s.model)));
  return 0.42 + 0.58 * Math.sqrt(fill);
}

type Lite = Pick<Session, 'id' | 'project' | 'projectName' | 'startedAt'>;

export function buildGalaxy(sessions: Lite[]): GalaxyLayout {
  const groups = new Map<string, Lite[]>();
  for (const s of sessions) {
    const g = groups.get(s.project);
    if (g) g.push(s);
    else groups.set(s.project, [s]);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    const na = groups.get(a)![0].projectName.toLowerCase();
    const nb = groups.get(b)![0].projectName.toLowerCase();
    return na < nb ? -1 : na > nb ? 1 : a < b ? -1 : 1;
  });

  const systems: System[] = keys.map((key) => {
    const list = [...groups.get(key)!].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || (a.id < b.id ? -1 : 1));
    const n = list.length;
    const starR = 1.05 + 0.34 * Math.sqrt(n);
    const first = starR * 1.6 + 2.6;
    const orbits = list.map((s, i) => ({ id: s.id, r: first + i * 2.3, phase: hash01(s.id) * Math.PI * 2, index: i }));
    const name = list[0].projectName;
    return {
      key, name, color: projectColor(name), pos: new THREE.Vector3(), starR,
      tilt: new THREE.Euler((hash01(key + 'tx') - 0.5) * 0.42, 0, (hash01(key + 'tz') - 0.5) * 0.42),
      orbits, reach: orbits.length ? orbits[orbits.length - 1].r : starR,
    };
  });

  // Golden-angle spiral: first system in the middle, the rest wind outwards
  const maxReach = Math.max(6, ...systems.map((s) => s.reach));
  const spacing = Math.max(17, maxReach * 2 + 3.5);
  systems.forEach((sys, i) => {
    const r = i === 0 ? 0 : spacing * Math.sqrt(i) * 0.82;
    const a = i * GOLDEN + 0.6;
    sys.pos.set(Math.cos(a) * r, (hash01(sys.key + 'y') - 0.5) * 3.2, Math.sin(a) * r);
  });

  const center = new THREE.Vector3();
  systems.forEach((s) => center.add(s.pos));
  if (systems.length) center.divideScalar(systems.length);
  center.y = 0;
  let extent = 8;
  systems.forEach((s) => { extent = Math.max(extent, Math.hypot(s.pos.x - center.x, s.pos.z - center.z) + s.reach); });

  const bySession = new Map<string, { system: System; orbit: Orbit }>();
  systems.forEach((system) => system.orbits.forEach((orbit) => bySession.set(orbit.id, { system, orbit })));
  return { systems, bySession, center, extent };
}
