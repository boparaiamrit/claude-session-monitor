// Where everything stands in the city. Positions depend only on which sessions exist
// and their projects, so the skyline stays put while the data ticks every second.
import * as THREE from 'three';
import type { Session } from '../../types';
import { hash01, projectColor } from '../../lib/theme';

/** Distance between tower centers inside a district */
export const CELL = 3.5;
export const ROAD = 3.4;

export interface Spot {
  id: string;
  x: number;
  z: number;
  w: number;
  d: number;
  /** Rise order on first load, center outwards */
  order: number;
  district: number;
}

export interface District {
  key: string;
  name: string;
  color: string;
  cx: number;
  cz: number;
  half: number;
  count: number;
}

export interface Filler {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
}

export interface Lane {
  axis: 'x' | 'z';
  c: number;
  dir: 1 | -1;
  L: number;
}

export interface CityLayout {
  spots: Map<string, Spot>;
  districts: District[];
  fillers: Filler[];
  lanes: Lane[];
  /** Centers of the background blocks (sidewalk plates) */
  blocks: [number, number][];
  /** Road intersections near downtown that get a street light */
  lamps: [number, number][];
  /** Block size without the road */
  inner: number;
  /** Block pitch: block plus road */
  pitch: number;
  /** Center of the occupied districts */
  cx: number;
  cz: number;
  /** Radius of the occupied area */
  extent: number;
}

/** Taller means more tool calls; log scale so a marathon session doesn't dwarf the rest */
export function towerHeight(s: Session): number {
  return Math.min(28, 3.2 + 2.55 * Math.log2(1 + s.counts.tools / 5));
}

/** Unit box with its base at y = 0, shared by towers, plates and background blocks */
export const BOX_GEO = (() => {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.translate(0, 0.5, 0);
  return g;
})();

export const antennaLen = (id: string) => 0.5 + hash01(id + 'ant') * 2.2;

/** Height of the rooftop beacon, where labels attach */
export const beaconTop = (s: Session) => towerHeight(s) + 0.44 + antennaLen(s.id);

/** Session id -> clock time a message courier landed on that tower */
export const towerKicks = new Map<string, number>();

function slots(R: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) out.push([i, j]);
  out.sort((a, b) => (a[0] ** 2 + a[1] ** 2) - (b[0] ** 2 + b[1] ** 2) || Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0]));
  return out;
}

type Lite = Pick<Session, 'id' | 'project' | 'projectName' | 'startedAt'>;

export function buildLayout(sessions: Lite[]): CityLayout {
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
  const maxCount = Math.max(1, ...[...groups.values()].map((g) => g.length));
  const k = Math.min(5, Math.max(2, Math.ceil(Math.sqrt(maxCount))));
  const inner = k * CELL;
  const pitch = inner + ROAD;
  const ringR = Math.ceil(Math.sqrt(Math.max(1, keys.length))) + 1;
  const order = slots(ringR);

  const spots = new Map<string, Spot>();
  const districts: District[] = [];
  const used = new Set<string>();
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;

  keys.forEach((key, di) => {
    const [gx, gz] = order[di];
    used.add(`${gx},${gz}`);
    const cx = gx * pitch;
    const cz = gz * pitch;
    minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
    minZ = Math.min(minZ, cz); maxZ = Math.max(maxZ, cz);
    const list = [...groups.get(key)!].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || (a.id < b.id ? -1 : 1));
    const n = list.length;
    const cols = Math.min(k, Math.ceil(Math.sqrt(n)));
    const rows = Math.ceil(n / cols);
    list.forEach((s, i) => {
      const r = Math.floor(i / cols);
      const inRow = r === rows - 1 ? n - r * cols : cols;
      const c = i - r * cols;
      const x = cx + (c - (inRow - 1) / 2) * CELL;
      const z = cz + (r - (rows - 1) / 2) * CELL;
      spots.set(s.id, {
        id: s.id, x, z,
        w: 1.45 + hash01(s.id + 'w') * 0.75,
        d: 1.45 + hash01(s.id + 'd') * 0.75,
        order: 0, district: di,
      });
    });
    districts.push({
      key, name: list[0].projectName, color: projectColor(list[0].projectName),
      cx, cz, half: inner / 2 + 0.55, count: n,
    });
  });

  if (!keys.length) { minX = maxX = minZ = maxZ = 0; }
  const ccx = (minX + maxX) / 2;
  const ccz = (minZ + maxZ) / 2;
  const extent = Math.max(maxX - minX, maxZ - minZ) / 2 + inner / 2 + 2;

  // Rise order: from the middle of the city outwards
  [...spots.values()]
    .sort((a, b) => Math.hypot(a.x - ccx, a.z - ccz) - Math.hypot(b.x - ccx, b.z - ccz))
    .forEach((s, i) => { s.order = i; });

  // Dark background blocks around the districts, lower near downtown, taller far out
  const R = ringR + 6;
  const fillers: Filler[] = [];
  const blocks: [number, number][] = [];
  const lamps: [number, number][] = [];
  for (let gx = -R; gx <= R; gx++) {
    for (let gz = -R; gz <= R; gz++) {
      const bx = gx * pitch;
      const bz = gz * pitch;
      if (Math.abs(gx) <= ringR + 1 && Math.abs(gz) <= ringR + 1) lamps.push([bx + pitch / 2, bz + pitch / 2]);
      if (used.has(`${gx},${gz}`)) continue;
      blocks.push([bx, bz]);
      const dist = Math.hypot(bx - ccx, bz - ccz) / pitch;
      const seed = `${gx}:${gz}`;
      const m = hash01(seed) < 0.45 ? 2 : 3;
      const sub = inner / m;
      for (let a = 0; a < m; a++) {
        for (let b = 0; b < m; b++) {
          const hs = `${seed}:${a}:${b}`;
          if (hash01(hs + 'skip') < (dist < 2.6 ? 0.5 : 0.18)) continue;
          // Low rise next to downtown so the session towers own the skyline,
          // taller silhouettes further out where the fog takes them
          const r = hash01(hs + 'h');
          const h = dist < 2.6
            ? 0.35 + r * r * 1.6
            : dist < 4
              ? 0.8 + r * r * 4
              : 1.4 + r * r * (6 + Math.min(7, (dist - 4) * 1.8));
          const slim = h > 4 ? 0.42 : 0.55;
          fillers.push({
            x: bx - inner / 2 + (a + 0.5) * sub + (hash01(hs + 'x') - 0.5) * sub * 0.2,
            z: bz - inner / 2 + (b + 0.5) * sub + (hash01(hs + 'z') - 0.5) * sub * 0.2,
            w: sub * (slim + hash01(hs + 'w') * 0.25),
            d: sub * (slim + hash01(hs + 'd') * 0.25),
            h: Math.min(16, h),
          });
        }
      }
    }
  }

  // Traffic lanes along the roads near downtown, running out into the fog
  const lanes: Lane[] = [];
  const Rr = ringR;
  const L = (ringR + 4.5) * pitch;
  for (let i = -Rr; i < Rr; i++) {
    const c = (i + 0.5) * pitch;
    lanes.push({ axis: 'x', c: c - 0.62, dir: 1, L }, { axis: 'x', c: c + 0.62, dir: -1, L });
    lanes.push({ axis: 'z', c: c - 0.62, dir: -1, L }, { axis: 'z', c: c + 0.62, dir: 1, L });
  }

  return { spots, districts, fillers, lanes, blocks, lamps, inner, pitch, cx: ccx, cz: ccz, extent };
}
