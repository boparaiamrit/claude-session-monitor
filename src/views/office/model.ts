// The office model: which rooms, desks and hot desks exist, when each one appeared or started
// leaving, and where everything sits. Seats are assigned once and never reshuffle, rooms only
// grow while they live, and leavers stay in the layout until their exit animation has played.
import { useEffect, useMemo, useState } from 'react';
import type { Session } from '../../types';
import { projectColor } from '../../lib/theme';
import { nowSec } from './anim';

export const TILE = 0.5;
/** Room floors are raised tiles; everything inside a room stands on this height */
export const ROOM_Y = 0.05;
/** Sub-agents and their hot desks are drawn at this scale */
export const AG = 0.78;

/** Construction and teardown timeline, in seconds */
export const T = {
  tileStep: 0.04,
  tileDur: 0.5,
  wallsAt: 0.55,
  wallDur: 0.6,
  desksAt: 1.0,
  deskStep: 0.15,
  deskDur: 0.55,
  roomExit: 1.05,
  deskExit: 0.55,
  agentEnterMax: 6,
  agentExit: 5,
};

// Room-local geometry (origin at the back-left corner, +x right, +z toward the front/door)
const MARGIN_L = 0.45;
const DESK_W = 0.8;
const POD_PITCH = 1.3;
const POD_HALF = 0.76;
const POD_ROW = 1.95;
const PODS_Z0 = 1.25;
const FRONT_AISLE = 0.72;
const BENCH_X0 = 0.42;
export const BENCH_PITCH = 0.62;
export const STATION_Z = 0.3;
export const STOOL_Z = STATION_Z + 0.36 * AG;
export const APPROACH_Z = STOOL_Z + 0.21;
export const AISLE_Z = 0.98;
const GAP_X = 1.7;
const GAP_Z = 2.2;

export const doorSpan = (w: number) => [w - 1.05, w - 0.25] as const;
export const doorX = (w: number) => w - 0.65;

export interface DeskSpot {
  id: string;
  x: number;
  z: number;
  /** 0: occupant faces the back wall (screen toward the camera); π: faces the front */
  yaw: number;
  variant: number;
  bornAt: number;
  leavingAt: number | null;
}

export interface StationSpot {
  id: string;
  sessionId: string;
  x: number;
  bornAt: number;
  leavingAt: number | null;
}

export interface RoomLayout {
  name: string;
  color: string;
  x: number;
  z: number;
  w: number;
  d: number;
  bornAt: number;
  leavingAt: number | null;
  desks: DeskSpot[];
  stations: StationSpot[];
}

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface OfficeLayout {
  rooms: RoomLayout[];
  bounds: Bounds;
  /** Changes whenever the framing should change */
  key: string;
}

interface SeatE { seat: number; bornAt: number; leavingAt: number | null }
interface AgentE { sessionId: string; slot: number; bornAt: number; leavingAt: number | null }
interface RoomE {
  name: string;
  order: number;
  bornAt: number;
  leavingAt: number | null;
  seats: Map<string, SeatE>;
  agents: Map<string, AgentE>;
  hiPods: number;
  hiSlots: number;
}

const lowestFree = (used: Iterable<number>) => {
  const set = new Set(used);
  let i = 0;
  while (set.has(i)) i++;
  return i;
};

const busy = (list: Session[]) => list.reduce((n, s) => n + (s.status === 'working' ? 3 : s.status === 'blocked' ? 4 : s.status === 'waiting' ? 2 : 1), 0);

export class OfficeModel {
  rooms = new Map<string, RoomE>();
  private order = 0;
  private started = false;

  sync(sessions: Session[], now: number) {
    const intro = !this.started;
    this.started = true;
    const groups = new Map<string, Session[]>();
    for (const s of sessions) {
      const g = groups.get(s.projectName);
      if (g) g.push(s);
      else groups.set(s.projectName, [s]);
    }
    const names = [...groups.keys()].sort((a, b) => busy(groups.get(b)!) - busy(groups.get(a)!) || a.localeCompare(b));
    let fresh = 0;
    for (const name of names) {
      const list = groups.get(name)!.slice().sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.id.localeCompare(b.id));
      let r = this.rooms.get(name);
      let isNew = false;
      if (!r) {
        r = { name, order: this.order++, bornAt: now + (intro ? 0.45 + fresh * 0.24 : 0), leavingAt: null, seats: new Map(), agents: new Map(), hiPods: 1, hiSlots: 3 };
        this.rooms.set(name, r);
        isNew = true;
        fresh++;
      } else r.leavingAt = null;

      const present = new Set<string>();
      let k = 0;
      for (const s of list) {
        present.add(s.id);
        const seat = r.seats.get(s.id);
        if (!seat) {
          const idx = lowestFree([...r.seats.values()].map((x) => x.seat));
          r.seats.set(s.id, { seat: idx, bornAt: isNew ? r.bornAt + T.desksAt + k * T.deskStep : now, leavingAt: null });
        } else seat.leavingAt = null;
        k++;
      }
      for (const [id, seat] of r.seats) if (!present.has(id) && seat.leavingAt == null) seat.leavingAt = now;

      const working = new Set<string>();
      let j = 0;
      for (const s of list) {
        for (const a of s.agents) {
          if (a.status !== 'working') continue;
          working.add(a.id);
          const e = r.agents.get(a.id);
          if (!e) {
            const slot = lowestFree([...r.agents.values()].map((x) => x.slot));
            const bornAt = isNew ? r.bornAt + T.desksAt + list.length * T.deskStep + 0.6 + j * 0.7 : now;
            r.agents.set(a.id, { sessionId: s.id, slot, bornAt, leavingAt: null });
            j++;
          } else e.leavingAt = null;
        }
      }
      for (const [id, e] of r.agents) if (!working.has(id) && e.leavingAt == null) e.leavingAt = now;
    }
    for (const [name, r] of this.rooms) {
      if (groups.has(name) || r.leavingAt != null) continue;
      r.leavingAt = now;
      for (const s of r.seats.values()) s.leavingAt ??= now;
      for (const a of r.agents.values()) a.leavingAt ??= now;
    }
  }

  /** Drop everything whose exit animation has finished. Returns true if the layout changed. */
  purge(now: number): boolean {
    let changed = false;
    for (const [name, r] of this.rooms) {
      if (r.leavingAt != null && now - r.leavingAt > T.roomExit) {
        this.rooms.delete(name);
        changed = true;
        continue;
      }
      for (const [id, s] of r.seats) {
        if (s.leavingAt != null && now - s.leavingAt > T.deskExit) {
          r.seats.delete(id);
          changed = true;
        }
      }
      for (const [id, a] of r.agents) {
        if (a.leavingAt != null && now - Math.max(a.leavingAt, a.bornAt + T.agentEnterMax) > T.agentExit) {
          r.agents.delete(id);
          changed = true;
        }
      }
    }
    return changed;
  }
}

const snapUp = (v: number) => Math.ceil(v / TILE - 1e-6) * TILE;

const gridCols = (n: number) => (n <= 3 ? Math.max(1, n) : n === 4 ? 2 : n <= 6 ? 3 : n <= 12 ? 4 : Math.ceil(Math.sqrt(n * 1.6)));

export function computeLayout(m: OfficeModel): OfficeLayout {
  const entries = [...m.rooms.values()].sort((a, b) => a.order - b.order);
  const sized = entries.map((r) => {
    let maxSeat = 0;
    for (const s of r.seats.values()) maxSeat = Math.max(maxSeat, s.seat);
    let maxSlot = -1;
    for (const a of r.agents.values()) maxSlot = Math.max(maxSlot, a.slot);
    r.hiPods = Math.max(r.hiPods, Math.floor(maxSeat / 2) + 1);
    r.hiSlots = Math.max(r.hiSlots, maxSlot + 1);
    const podCols = Math.min(3, r.hiPods);
    const podRows = Math.ceil(r.hiPods / 3);
    const w = snapUp(Math.max(3.5, MARGIN_L + DESK_W + (podCols - 1) * POD_PITCH + 1.3, BENCH_X0 + r.hiSlots * BENCH_PITCH + 1.2));
    const d = snapUp(PODS_Z0 + POD_HALF * 2 + (podRows - 1) * POD_ROW + FRONT_AISLE);
    return { r, w, d };
  });

  const cols = gridCols(sized.length);
  const rows: (typeof sized)[] = [];
  for (let i = 0; i < sized.length; i += cols) rows.push(sized.slice(i, i + cols));

  const rooms: RoomLayout[] = [];
  let z = 0;
  for (const row of rows) {
    const rowW = row.reduce((s, x) => s + x.w, 0) + GAP_X * (row.length - 1);
    const rowD = Math.max(...row.map((x) => x.d));
    let x = -rowW / 2;
    for (const { r, w, d } of row) {
      const desks: DeskSpot[] = [];
      for (const [id, s] of r.seats) {
        const pod = s.seat >> 1;
        const front = (s.seat & 1) === 0;
        const c = pod % 3;
        const rr = Math.floor(pod / 3);
        const podZ = PODS_Z0 + POD_HALF + rr * POD_ROW;
        desks.push({
          id,
          x: MARGIN_L + DESK_W / 2 + c * POD_PITCH,
          z: front ? podZ + 0.24 : podZ - 0.24,
          yaw: front ? 0 : Math.PI,
          variant: Math.floor(hashStr(id) * 15),
          bornAt: s.bornAt,
          leavingAt: s.leavingAt,
        });
      }
      const stations: StationSpot[] = [];
      for (const [id, a] of r.agents) {
        stations.push({ id, sessionId: a.sessionId, x: BENCH_X0 + BENCH_PITCH / 2 + a.slot * BENCH_PITCH, bornAt: a.bornAt, leavingAt: a.leavingAt });
      }
      rooms.push({ name: r.name, color: projectColor(r.name), x, z: z + (rowD - d), w, d, bornAt: r.bornAt, leavingAt: r.leavingAt, desks, stations });
      x += w + GAP_X;
    }
    z += rowD + GAP_Z;
  }
  const totalD = z - GAP_Z;
  for (const r of rooms) r.z -= totalD / 2;

  const bounds: Bounds = rooms.length
    ? {
        minX: Math.min(...rooms.map((r) => r.x)),
        maxX: Math.max(...rooms.map((r) => r.x + r.w)),
        minZ: Math.min(...rooms.map((r) => r.z)),
        maxZ: Math.max(...rooms.map((r) => r.z + r.d)) + 0.9,
      }
    : { minX: -6.5, maxX: 6.5, minZ: -5, maxZ: 5 };
  const key = rooms.map((r) => `${r.name}:${r.x.toFixed(2)},${r.z.toFixed(2)},${r.w},${r.d}`).join('|');
  return { rooms, bounds, key };
}

function hashStr(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** Only membership matters for the layout: projects, sessions and working sub-agents */
function signature(sessions: Session[]): string {
  const parts: string[] = [];
  for (const s of sessions) {
    parts.push(`${s.projectName}\u0001${s.id}`);
    for (const a of s.agents) if (a.status === 'working') parts.push(`${s.id}\u0002${a.id}`);
  }
  return parts.sort().join('\u0003');
}

/** The office layout for the visible sessions, stable across live updates */
export function useOffice(sessions: Session[]): OfficeLayout {
  const [model] = useState(() => new OfficeModel());
  const [version, setVersion] = useState(0);
  const sig = useMemo(() => signature(sessions), [sessions]);

  // Membership (sig) and purges (version) are the only inputs that move things, so live
  // updates to a session's status or tool never re-run the layout.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layout = useMemo(() => syncLayout(model, sessions), [model, sig, version]);

  useEffect(() => {
    const id = setInterval(() => {
      if (model.purge(nowSec())) setVersion((v) => v + 1);
    }, 200);
    return () => clearInterval(id);
  }, [model]);
  return layout;
}

function syncLayout(model: OfficeModel, sessions: Session[]): OfficeLayout {
  model.sync(sessions, nowSec());
  return computeLayout(model);
}
