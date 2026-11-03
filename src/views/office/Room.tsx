// A project's glass-walled room. It constructs itself in real time: floor tiles rise in a wave
// from the door, the glass walls extrude, then desks drop in one by one. Teardown runs in reverse.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../../lib/store';
import { damp, easeOutBack, easeOutCubic } from '../../three/motion';
import { OfficeLabel } from './labels';
import { PRIO } from './labelRegistry';
import type { Session } from '../../types';
import { GEO, MAT, TEX, cssColor, cssHex, glowMat, hot, plantGeo, wallGeos } from './assets';
import { clamp01, easeInCubic, nowSec, useAfter } from './anim';
import { SessionDesk } from './Desk';
import { AgentMate, type RoomGeo } from './Agent';
import { ROOM_Y, T, TILE, doorSpan, type RoomLayout } from './model';

const dummy = new THREE.Object3D();

function Tiles({ w, d, bornAt, leavingAt, tint }: { w: number; d: number; bornAt: number; leavingAt: number | null; tint: string }) {
  const cols = Math.round(w / TILE);
  const rows = Math.round(d / TILE);
  const n = cols * rows;
  const ref = useRef<THREE.InstancedMesh>(null);
  // Birth time per tile, kept across growth so only new tiles animate when the room grows
  const births = useRef(new Map<number, number>());
  const done = useRef(false);
  const metaRef = useRef<{ born: Float32Array; diag: Float32Array; maxDiag: number } | null>(null);

  useLayoutEffect(() => {
    const now = nowSec();
    const first = births.current.size === 0;
    const born = new Float32Array(n);
    const diag = new Float32Array(n);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const key = i * 1000 + j;
        const dg = cols - 1 - i + (rows - 1 - j);
        let b = births.current.get(key);
        if (b == null) {
          b = (first ? bornAt : Math.max(bornAt, now)) + dg * T.tileStep;
          births.current.set(key, b);
        }
        born[j * cols + i] = b;
        diag[j * cols + i] = dg;
      }
    }
    metaRef.current = { born, diag, maxDiag: cols + rows - 2 };
    done.current = false;
  }, [cols, rows, n, bornAt]);

  useEffect(() => {
    done.current = false;
  }, [leavingAt]);

  useLayoutEffect(() => {
    const m = ref.current!;
    const base = cssColor('#2b2a2c');
    const t = cssColor(tint);
    const c = new THREE.Color();
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const v = 0.9 + ((i * 7 + j * 13) % 5) * 0.035;
        c.copy(base).lerp(t, 0.04).multiplyScalar(v);
        m.setColorAt(j * cols + i, c);
      }
    }
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [cols, rows, tint]);

  useFrame(() => {
    const m = ref.current;
    const meta = metaRef.current;
    if (!m || !meta || (done.current && leavingAt == null)) return;
    const now = nowSec();
    let all = true;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const idx = j * cols + i;
        const p = clamp01((now - meta.born[idx]) / T.tileDur);
        if (p < 1) all = false;
        let y = -(1 - easeOutBack(p, 1.6)) * 0.32;
        let sxz = 0.35 + 0.65 * easeOutCubic(p);
        let sy = p;
        if (leavingAt != null) {
          const q = clamp01((now - leavingAt - 0.4 - (meta.maxDiag - meta.diag[idx]) * 0.012) / 0.3);
          y -= easeInCubic(q) * 0.35;
          sxz *= 1 - q;
          sy *= 1 - q;
        }
        dummy.position.set((i + 0.5) * TILE, ROOM_Y - 0.025 + y, (j + 0.5) * TILE);
        dummy.scale.set(Math.max(sxz, 1e-4), Math.max(sy, 1e-4), Math.max(sxz, 1e-4));
        dummy.updateMatrix();
        m.setMatrixAt(idx, dummy.matrix);
      }
    }
    m.instanceMatrix.needsUpdate = true;
    if (all && leavingAt == null) done.current = true;
  });

  return <instancedMesh key={n} ref={ref} args={[GEO.tile, MAT.tile, n]} receiveShadow frustumCulled={false} />;
}

function statsKey(sessions: Record<string, Session>, ids: string[]): string {
  let w = 0, b = 0, y = 0, p = 0, c = 0, a = 0;
  for (const id of ids) {
    const s = sessions[id];
    if (!s) continue;
    if (s.control.paused && s.status !== 'idle') p++;
    else if (s.status === 'working') w++;
    else if (s.status === 'blocked') b++;
    else if (s.status === 'waiting') y++;
    else c++;
    for (const ag of s.agents) if (ag.status === 'working') a++;
  }
  return `${w}|${b}|${y}|${p}|${c}|${a}`;
}

function RoomLabel({ room }: { room: RoomLayout }) {
  const ids = useMemo(() => room.desks.filter((d) => d.leavingAt == null).map((d) => d.id), [room.desks]);
  const key = useStore((st) => statsKey(st.sessions, ids));
  const shown = useAfter(room.bornAt + T.wallsAt + 0.4);
  if (!shown || room.leavingAt != null) return null;
  const [w, b, y, p, c, a] = key.split('|').map(Number);
  const parts: { cls: string; text: string }[] = [];
  if (b) parts.push({ cls: 'st-blocked', text: `${b} needs you` });
  if (w) parts.push({ cls: 'st-working', text: `${w} working` });
  if (y) parts.push({ cls: 'st-waiting', text: `${y} your turn` });
  if (p) parts.push({ cls: 'st-paused', text: `${p} paused` });
  if (c) parts.push({ cls: 'st-idle', text: `${c} closed` });
  if (a) parts.push({ cls: 'st-agents', text: `${a} agent${a === 1 ? '' : 's'}` });
  return (
    <OfficeLabel position={[room.w / 2, ROOM_Y, room.d + 0.62]} prio={PRIO.floor} kind="floor">
      <div className="of-room" style={{ '--c': cssHex(room.color) } as CSSProperties}>
        <div className="of-room-name"><i />{room.name}</div>
        <div className="of-room-stats">
          {parts.map((x, i) => (
            <span key={x.cls} className={x.cls}>{i > 0 && <em>·</em>}{x.text}</span>
          ))}
        </div>
      </div>
    </OfficeLabel>
  );
}

/** A rug under the desk pods, in a deep tone of the project colour. Grows with the pods. */
function Rug({ room }: { room: RoomLayout }) {
  const ref = useRef<THREE.Mesh>(null);
  const mat = useMemo(() => {
    const c = cssColor(room.color);
    const hsl = { h: 0, s: 0, l: 0 };
    c.getHSL(hsl);
    return new THREE.MeshStandardMaterial({ map: TEX.rug, color: new THREE.Color().setHSL(hsl.h, hsl.s * 0.45, 0.16), roughness: 1, alphaTest: 0.5 });
  }, [room.color]);
  useEffect(() => () => mat.dispose(), [mat]);
  const box = useMemo(() => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const d of room.desks) {
      if (d.leavingAt != null) continue;
      const pz = d.yaw === 0 ? d.z - 0.24 : d.z + 0.24;
      x0 = Math.min(x0, d.x - 0.66);
      x1 = Math.max(x1, d.x + 0.66);
      z0 = Math.min(z0, pz - 0.98);
      z1 = Math.max(z1, pz + 0.98);
    }
    return Number.isFinite(x0) ? { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, w: x1 - x0, d: z1 - z0 } : null;
  }, [room.desks]);
  const cur = useRef({ cx: 0, cz: 0, w: 0, d: 0, init: false });
  useFrame((_, dt) => {
    const m = ref.current;
    if (!m) return;
    const now = nowSec();
    const c = cur.current;
    const grow = clamp01((now - room.bornAt - T.desksAt + 0.25) / 0.5);
    const out = room.leavingAt != null ? clamp01((now - room.leavingAt - 0.2) / 0.3) : 0;
    const tgt = box ?? { cx: c.cx, cz: c.cz, w: 0, d: 0 };
    if (!c.init && box) {
      Object.assign(c, box, { init: true });
    }
    const k = damp(6, dt);
    c.cx += (tgt.cx - c.cx) * k;
    c.cz += (tgt.cz - c.cz) * k;
    c.w += (tgt.w - c.w) * k;
    c.d += (tgt.d - c.d) * k;
    const s = easeOutCubic(grow) * (1 - out);
    m.visible = s > 0.002 && c.w > 0.05;
    m.position.set(c.cx, ROOM_Y + 0.003, c.cz);
    m.scale.set(Math.max(1e-4, c.w * s), Math.max(1e-4, c.d * s), 1);
  });
  return <mesh ref={ref} geometry={GEO.plane} material={mat} rotation-x={-Math.PI / 2} receiveShadow visible={false} />;
}

function RoomImpl({ room }: { room: RoomLayout }) {
  const g = useRef<THREE.Group>(null);
  const walls = useRef<THREE.Group>(null);
  const inner = useRef<THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>>(null);
  const outer = useRef<THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>>(null);
  const plants = useRef<THREE.Group>(null);
  const placed = useRef(false);
  const [door0, door1] = doorSpan(room.w);

  const wallGeo = useMemo(() => wallGeos(room.w, room.d, door0, door1), [room.w, room.d, door0, door1]);
  useEffect(() => () => {
    wallGeo.frame.dispose();
    wallGeo.glass.dispose();
    wallGeo.led.dispose();
  }, [wallGeo]);

  const mats = useMemo(() => {
    const c = cssColor(room.color);
    return {
      led: new THREE.MeshBasicMaterial({ color: hot(c, 1.2), toneMapped: false }),
      inner: glowMat(cssColor('#ffcf9e').multiplyScalar(0.0)),
      outer: glowMat(c.clone().lerp(cssColor('#ffcf9e'), 0.55).multiplyScalar(0.0)),
    };
  }, [room.color]);
  useEffect(() => () => {
    mats.led.dispose();
    mats.inner.dispose();
    mats.outer.dispose();
  }, [mats]);
  const innerTarget = useMemo(() => cssColor('#ffcf9e').multiplyScalar(0.25), []);
  const outerTarget = useMemo(() => cssColor(room.color).lerp(cssColor('#ffcf9e'), 0.5).multiplyScalar(0.2), [room.color]);

  useFrame((_, dt) => {
    const o = g.current;
    if (!o) return;
    if (!placed.current) {
      o.position.set(room.x, 0, room.z);
      placed.current = true;
    }
    const k = damp(4, dt);
    o.position.x += (room.x - o.position.x) * k;
    o.position.z += (room.z - o.position.z) * k;

    const now = nowSec();
    const pw = clamp01((now - room.bornAt - T.wallsAt) / T.wallDur);
    const out = room.leavingAt != null ? clamp01((now - room.leavingAt - 0.15) / 0.3) : 0;
    const wy = easeOutBack(pw, 1.3) * (1 - easeInCubic(out));
    if (walls.current) {
      walls.current.visible = wy > 0.002;
      walls.current.scale.y = Math.max(wy, 1e-4);
    }
    const light = clamp01((now - room.bornAt - T.wallsAt) / 1.2) * (1 - out);
    inner.current?.material.color.copy(innerTarget).multiplyScalar(light);
    outer.current?.material.color.copy(outerTarget).multiplyScalar(light);
    if (plants.current) {
      const pp = clamp01((now - room.bornAt - T.desksAt + 0.2) / 0.5);
      const s = easeOutBack(pp, 1.6) * (1 - easeInCubic(out));
      plants.current.visible = s > 0.002;
      plants.current.children.forEach((c) => c.scale.setScalar(Math.max(s, 1e-4)));
    }
  });

  const geo: RoomGeo = useMemo(() => ({ w: room.w, d: room.d, color: room.color, leavingAt: room.leavingAt }), [room.w, room.d, room.color, room.leavingAt]);

  return (
    <group ref={g}>
      <Tiles w={room.w} d={room.d} bornAt={room.bornAt} leavingAt={room.leavingAt} tint={room.color} />
      <Rug room={room} />
      <mesh ref={inner} geometry={GEO.plane} material={mats.inner} position={[room.w / 2, ROOM_Y + 0.002, room.d / 2]} rotation-x={-Math.PI / 2} scale={[room.w * 1.15, room.d * 1.15, 1]} />
      <mesh ref={outer} geometry={GEO.plane} material={mats.outer} position={[room.w / 2, 0.003, room.d / 2]} rotation-x={-Math.PI / 2} scale={[room.w * 2.1, room.d * 2.1, 1]} />
      <group ref={walls} position={[0, ROOM_Y, 0]} visible={false}>
        <mesh geometry={wallGeo.frame} material={MAT.metal} castShadow receiveShadow />
        <mesh geometry={wallGeo.led} material={mats.led} />
        <mesh geometry={wallGeo.glass} material={MAT.glass} renderOrder={2} />
      </group>
      <group ref={plants} visible={false}>
        <mesh geometry={plantGeo()} material={MAT.foliage} position={[0.3, ROOM_Y, room.d - 0.3]} castShadow />
        <mesh geometry={plantGeo()} material={MAT.foliage} position={[room.w - 0.28, ROOM_Y, 0.28]} rotation-y={1.7} castShadow />
      </group>
      <RoomLabel room={room} />
      {room.desks.map((d) => (
        <SessionDesk key={d.id} spot={d} color={room.color} roomLeavingAt={room.leavingAt} />
      ))}
      {room.stations.map((a) => (
        <AgentMate key={a.id} spot={a} room={geo} />
      ))}
    </group>
  );
}

export const Room = memo(RoomImpl);
