// Camera: a near-isometric three-quarter view with a slow idle drift. Selecting a session flies
// to its room (framed to the left of the drawer); deselecting flies back to the overview.
// Orbit and zoom are allowed but clamped so the floor's edge and underside never show.
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { CameraControls } from '@react-three/drei';
import * as THREE from 'three';
import { useStore } from '../../lib/store';
import type { Bounds, RoomLayout } from './model';
import { officeBus } from './bus';

export const BASE_AZ = 0.62;
const OVERVIEW_POLAR = 0.98;
const ROOM_POLAR = 0.92;
const DRAWER_PX = 484;
const UP = new THREE.Vector3(0, 1, 0);
/** Pixels per world unit above which labels show their details */
const NEAR_PPU = 82;

/** Query params survive the store's hash rewrite: `?focus=<project>` and `?still` (no intro glide) */
const PARAMS = new URLSearchParams(location.search);

interface Shot {
  pos: THREE.Vector3;
  target: THREE.Vector3;
  dist: number;
}

/**
 * Camera that fits every point for a fixed orientation, with the points centred in the
 * frame (or in the part of it the drawer leaves free). Perspective makes the near side
 * look bigger, so the target is nudged across the floor until the extents balance.
 */
function frame(points: THREE.Vector3[], az: number, polar: number, fovDeg: number, w: number, h: number, drawer: boolean, pad: number): Shot {
  const dir = new THREE.Vector3(Math.sin(polar) * Math.sin(az), Math.cos(polar), Math.sin(polar) * Math.cos(az));
  const f = dir.clone().negate();
  const r = new THREE.Vector3().crossVectors(f, UP).normalize();
  const u = new THREE.Vector3().crossVectors(r, f);
  const g = new THREE.Vector3(u.x, 0, u.z).normalize();
  const gu = Math.max(0.2, g.dot(u));
  const tanV = Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2);
  const tanH = tanV * (w / Math.max(1, h));
  const avail = drawer ? Math.max(0.4, (w - DRAWER_PX) / w) : 1;
  const tv = tanV * (1 - pad * 1.6);
  const th = tanH * avail * (1 - pad);
  const target = new THREE.Vector3();
  for (const p of points) target.add(p);
  target.divideScalar(Math.max(1, points.length));
  target.y = 0.4;
  const v = new THREE.Vector3();
  let dist = 10;
  for (let it = 0; it < 6; it++) {
    dist = 0;
    for (const p of points) {
      v.copy(p).sub(target);
      const pz = v.dot(f);
      dist = Math.max(dist, Math.abs(v.dot(r)) / th - pz, Math.abs(v.dot(u)) / tv - pz);
    }
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of points) {
      v.copy(p).sub(target);
      const depth = dist + v.dot(f);
      const nx = v.dot(r) / (depth * th);
      const ny = v.dot(u) / (depth * tv);
      x0 = Math.min(x0, nx);
      x1 = Math.max(x1, nx);
      y0 = Math.min(y0, ny);
      y1 = Math.max(y1, ny);
    }
    target.addScaledVector(r, ((x0 + x1) / 2) * dist * th);
    target.addScaledVector(g, (((y0 + y1) / 2) * dist * tv) / gu);
  }
  const shifted = target.clone().addScaledVector(r, drawer ? (1 - avail) * dist * tanH : 0);
  return { pos: shifted.clone().addScaledVector(dir, dist), target: shifted, dist };
}

/** Floor and head-height corners of each room, plus its floor label */
function roomPoints(rooms: RoomLayout[]): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (const r of rooms) {
    for (const [x, z] of [[r.x, r.z], [r.x + r.w, r.z], [r.x, r.z + r.d], [r.x + r.w, r.z + r.d]]) {
      pts.push(new THREE.Vector3(x, 0, z), new THREE.Vector3(x, 1.05, z));
    }
    pts.push(new THREE.Vector3(r.x + r.w / 2 - 1, 0, r.z + r.d + 0.85), new THREE.Vector3(r.x + r.w / 2 + 1, 0, r.z + r.d + 0.85));
  }
  return pts;
}

const boundsPoints = (b: Bounds) => [
  new THREE.Vector3(b.minX, 0, b.minZ), new THREE.Vector3(b.maxX, 0, b.minZ),
  new THREE.Vector3(b.minX, 0, b.maxZ), new THREE.Vector3(b.maxX, 0, b.maxZ),
];

export function CameraDirector({ rooms, bounds, layoutKey }: { rooms: RoomLayout[]; bounds: Bounds; layoutKey: string }) {
  const ref = useRef<CameraControls>(null);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);
  const host = useThree((s) => s.gl.domElement);
  const selectedId = useStore((s) => s.selectedId);
  const intro = useRef(true);
  const zoom = useRef('');

  const roomOf = useMemo(() => {
    const m = new Map<string, RoomLayout>();
    for (const r of rooms) for (const d of r.desks) if (d.leavingAt == null) m.set(d.id, r);
    return m;
  }, [rooms]);
  // `?focus=<project>` frames one room without opening the drawer (deep link)
  const linkFocus = PARAMS.get('focus');
  const focus = selectedId ? roomOf.get(selectedId) ?? null : linkFocus ? rooms.find((r) => r.name === linkFocus) ?? null : null;
  const focusKey = focus ? `room:${focus.name}:${focus.x.toFixed(2)}:${focus.z.toFixed(2)}:${focus.w}:${focus.d}` : `all:${layoutKey}`;
  const drawer = !!selectedId;

  const latest = useRef({ focus, bounds, drawer, rooms });
  useLayoutEffect(() => {
    latest.current = { focus, bounds, drawer, rooms };
  });

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    let timer = 0;
    const fly = (instant = false) => {
      const { focus: fr, bounds: b, drawer: dr, rooms: all } = latest.current;
      const live = all.filter((r) => r.leavingAt == null);
      const pts = live.length ? roomPoints(live) : boundsPoints(b);
      const over = frame(pts, BASE_AZ, OVERVIEW_POLAR, camera.fov, width, height, dr, 0.05);
      c.maxDistance = over.dist * 1.5;
      const bb = new THREE.Box3(new THREE.Vector3(b.minX - 2, 0, b.minZ - 2), new THREE.Vector3(b.maxX + 2, 1.5, b.maxZ + 2));
      bb.expandByPoint(over.target);
      c.setBoundary(bb);
      const shot = fr ? frame(roomPoints([fr]), BASE_AZ, ROOM_POLAR, camera.fov, width, height, dr, 0.08) : over;
      if (intro.current && PARAMS.has('still')) {
        intro.current = false;
        instant = true;
      } else if (intro.current) {
        intro.current = false;
        const far = shot.target.clone().add(new THREE.Vector3(Math.sin(BASE_AZ + 0.35) * 0.45, 0.85, Math.cos(BASE_AZ + 0.35) * 0.45).normalize().multiplyScalar(shot.dist * 1.55));
        void c.setLookAt(far.x, far.y, far.z, shot.target.x, shot.target.y, shot.target.z, false);
        c.smoothTime = 0.95;
        timer = window.setTimeout(() => {
          if (ref.current) ref.current.smoothTime = 0.42;
        }, 2800);
      } else {
        c.smoothTime = 0.42;
      }
      void c.setLookAt(shot.pos.x, shot.pos.y, shot.pos.z, shot.target.x, shot.target.y, shot.target.z, !instant);
    };
    fly();
    const onRecenter = () => fly();
    officeBus.addEventListener('recenter', onRecenter);
    return () => {
      officeBus.removeEventListener('recenter', onRecenter);
      clearTimeout(timer);
    };
  }, [focusKey, drawer, width, height, camera]);

  // Keyboard: arrows orbit and zoom, + and - zoom; clamps still apply
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const c = ref.current;
      const t = e.target;
      if (!c || e.ctrlKey || e.metaKey || e.altKey) return;
      if (t instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      const st = useStore.getState();
      if (st.paletteOpen || st.newSessionOpen || st.setupOpen) return;
      if (e.key === 'ArrowLeft') void c.rotate(-0.16, 0, true);
      else if (e.key === 'ArrowRight') void c.rotate(0.16, 0, true);
      else if (e.key === 'ArrowUp' || e.key === '+' || e.key === '=') void c.dolly(c.distance * 0.2, true);
      else if (e.key === 'ArrowDown' || e.key === '-') void c.dolly(-c.distance * 0.25, true);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useFrame((state, dt) => {
    const c = ref.current;
    if (!c) return;
    // Label density follows on-screen scale: details only when a room is large enough to read
    const ppu = height / (2 * c.distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    const z = ppu > NEAR_PPU ? 'near' : 'far';
    if (z !== zoom.current) {
      zoom.current = z;
      host.closest('.office')?.setAttribute('data-zoom', z);
    }
    // Idle drift: a slow, small orbit so the scene never sits dead-still
    if (c.currentAction !== 0) return;
    const t = state.clock.elapsedTime;
    const wa = (Math.PI * 2) / 38;
    const wp = (Math.PI * 2) / 23;
    void c.rotate(0.032 * wa * Math.cos(t * wa) * dt, 0.01 * wp * Math.cos(t * wp) * dt, true);
  });

  return (
    <CameraControls
      ref={ref}
      makeDefault
      minPolarAngle={0.4}
      maxPolarAngle={1.18}
      minAzimuthAngle={BASE_AZ - 1.1}
      maxAzimuthAngle={BASE_AZ + 1.1}
      minDistance={2.2}
      dollyToCursor
      draggingSmoothTime={0.12}
    />
  );
}
