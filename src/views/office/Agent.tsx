// A sub-agent: a smaller teammate who pops in at the room's door, walks to a hot desk along the
// back wall, sits and types; when its task ends it stands, walks back out and fades. Its hot desk
// builds as it arrives and folds away after it leaves. Everything derives from two timestamps.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../../lib/store';
import { hash01, toolColor } from '../../lib/theme';
import { fmtToolName, truncate } from '../../lib/format';
import { damp, easeOutBack, easeOutCubic, smootherstep } from '../../three/motion';
import { OfficeLabel } from './labels';
import { PRIO } from './labelRegistry';
import { Chibi } from './Chibi';
import { Rig, poseStand, poseTyping, poseWalk } from './rig';
import { GEO, LAPTOP_SCREEN, MAT, TEX, cssColor, lookFor, stationGeo, stoolGeo } from './assets';
import { angleDelta, clamp01, easeInCubic, lerp, nowSec } from './anim';
import { burst } from './sparks';
import { AG, AISLE_Z, APPROACH_Z, ROOM_Y, STATION_Z, STOOL_Z, doorX, type StationSpot } from './model';

const POP = 0.38;
const SIT = 0.5;
const STAND = 0.45;
const FADE = 0.4;
const WALK_IN = 0.95;

type P2 = [number, number];

function pathFor(w: number, d: number, sx: number): P2[] {
  const dx = doorX(w);
  return [[dx, d - 0.08], [dx, AISLE_Z], [sx, AISLE_Z], [sx, APPROACH_Z]];
}

function lengthOf(p: P2[]) {
  let l = 0;
  for (let i = 1; i < p.length; i++) l += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return l;
}

/** Point and heading at distance `s` along a polyline */
function along(p: P2[], s: number): { x: number; z: number; yaw: number } {
  let left = Math.max(0, s);
  for (let i = 1; i < p.length; i++) {
    const ax = p[i - 1][0], az = p[i - 1][1], bx = p[i][0], bz = p[i][1];
    const seg = Math.hypot(bx - ax, bz - az);
    if (left <= seg || i === p.length - 1) {
      const u = seg > 0 ? Math.min(1, left / seg) : 1;
      return { x: lerp(ax, bx, u), z: lerp(az, bz, u), yaw: Math.atan2(bx - ax, bz - az) };
    }
    left -= seg;
  }
  return { x: p[0][0], z: p[0][1], yaw: Math.PI };
}

export interface RoomGeo {
  w: number;
  d: number;
  color: string;
  leavingAt: number | null;
}

const tmp = new THREE.Vector3();
const tmpC = new THREE.Color();

function AgentImpl({ spot, room }: { spot: StationSpot; room: RoomGeo }) {
  const agent = useStore((st) => st.sessions[spot.sessionId]?.agents.find((a) => a.id === spot.id) ?? null);
  const [hover, setHover] = useState(false);
  const geo = useRef(room);
  const look = useMemo(() => lookFor(spot.id, room.color, '', 'agent'), [spot.id, room.color]);
  const rig = useMemo(() => new Rig(hash01(spot.id)), [spot.id]);
  const mats = useMemo(() => {
    const tex = TEX.code.clone();
    tex.repeat.set(1, 0.32);
    tex.offset.y = hash01(spot.id);
    return { tex, screen: new THREE.MeshBasicMaterial({ map: tex, color: 0x000000, toneMapped: false }) };
  }, [spot.id]);
  useEffect(() => () => { mats.tex.dispose(); mats.screen.dispose(); }, [mats]);

  const [initial] = useState(() => ({ yaw: Math.PI, flash: -9, tool: new THREE.Color('#94a3b8'), t: 0, hover: false, first: true }));
  const live = useRef(initial);
  const toolId = agent?.currentTool?.id ?? '';
  const toolName = agent?.currentTool?.name;
  useLayoutEffect(() => {
    geo.current = room;
    live.current.hover = hover;
  });
  // Each new tool call flashes the laptop screen
  useEffect(() => {
    if (!toolId) return;
    live.current.flash = nowSec();
    live.current.tool.copy(cssColor(toolColor(toolName)));
  }, [toolId, toolName]);

  const station = useRef<THREE.Group>(null);
  const stationBuild = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const scaler = useRef<THREE.Group>(null);
  const screen = useRef<THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>>(null);
  const flashSeen = useRef(-9);

  useEffect(() => () => {
    if (live.current.hover) document.body.style.cursor = '';
  }, []);

  useFrame((_, dt) => {
    const st = station.current, sb = stationBuild.current, b = body.current, sc = scaler.current;
    if (!st || !sb || !b || !sc) return;
    const R = geo.current;
    const L = live.current;
    const now = nowSec();
    const tIn = now - spot.bornAt;
    if (tIn < 0) {
      st.visible = false;
      b.visible = false;
      return;
    }
    const path = pathFor(R.w, R.d, spot.x);
    const len = lengthOf(path);
    const walkIn = len / WALK_IN;
    const enter = POP + walkIn + SIT;
    const leaveStart = spot.leavingAt != null ? Math.max(spot.leavingAt, spot.bornAt + enter) : Infinity;
    const outSpeed = Math.max(1.15, len / 2.8);
    const walkOut = len / outSpeed;
    const tl = now - leaveStart;
    const roomOut = R.leavingAt != null ? clamp01((now - R.leavingAt) / 0.3) : 0;

    // Hot desk: drops in as the agent arrives, folds away once it has left
    const pIn = clamp01(tIn / 0.5);
    const deskOut = clamp01((tl - (STAND + walkOut + FADE * 0.5)) / 0.4);
    const ss = easeOutBack(pIn, 1.5) * (1 - easeInCubic(deskOut)) * (1 - roomOut);
    st.visible = ss > 0.003;
    sb.scale.setScalar(AG * Math.max(ss, 1e-4));
    sb.position.y = (1 - easeOutCubic(pIn)) * 0.6;

    let x = spot.x;
    let z = STOOL_Z;
    let yawT = Math.PI;
    let mode: 'type' | 'walk' | 'stand' = 'type';
    let s = 1;
    if (tl >= 0) {
      if (tl < STAND) {
        z = lerp(STOOL_Z, APPROACH_Z, smootherstep(tl / STAND));
        mode = 'stand';
      } else if (tl < STAND + walkOut) {
        const p = along(path, len - (tl - STAND) * outSpeed);
        x = p.x;
        z = p.z;
        yawT = p.yaw + Math.PI;
        mode = 'walk';
      } else {
        x = path[0][0];
        z = path[0][1];
        yawT = 0;
        mode = 'walk';
        s = 1 - easeInCubic((tl - STAND - walkOut) / FADE);
      }
    } else if (tIn < POP) {
      x = path[0][0];
      z = path[0][1];
      yawT = Math.PI;
      mode = 'stand';
      s = easeOutBack(tIn / POP, 2.2);
    } else if (tIn < POP + walkIn) {
      const p = along(path, (tIn - POP) * WALK_IN);
      x = p.x;
      z = p.z;
      yawT = p.yaw;
      mode = 'walk';
    } else if (tIn < enter) {
      z = lerp(APPROACH_Z, STOOL_Z, smootherstep((tIn - POP - walkIn) / SIT));
    }
    s *= 1 - roomOut;
    b.visible = s > 0.003;
    b.position.set(x, ROOM_Y, z);
    sc.scale.setScalar(AG * Math.max(s, 1e-4));

    L.t += dt;
    if (mode === 'walk') poseWalk(rig.tgt, L.t, rig.phase);
    else if (mode === 'stand') poseStand(rig.tgt, L.t, rig.phase);
    else poseTyping(rig.tgt, L.t, rig.phase);
    if (L.first) {
      rig.snap();
      L.yaw = yawT;
      L.first = false;
    }
    L.yaw += angleDelta(L.yaw, yawT) * damp(mode === 'walk' ? 9 : 6, dt);
    sc.rotation.y = L.yaw;
    rig.apply(dt, mode === 'walk' ? 16 : 11);
    rig.blink(L.t);

    // Laptop screen in the colour of the agent's current tool
    const seated = mode === 'type' && tl < 0;
    const fl = Math.exp(-(now - L.flash) * 5);
    const k = seated ? 0.95 + fl * 1.6 : 0.18;
    const scr = screen.current;
    if (scr) {
      scr.material.color.lerp(tmpC.copy(L.tool).multiplyScalar(k), damp(9, dt));
      if (seated && scr.material.map) scr.material.map.offset.y -= dt * (0.04 + fl * 0.2);
    }
    if (seated && L.flash !== flashSeen.current && now - L.flash < 0.2 && scr) {
      flashSeen.current = L.flash;
      scr.getWorldPosition(tmp);
      tmp.y += 0.08;
      burst(tmp, L.tool, 6);
    }
  });

  const select = () => useStore.getState().select(spot.sessionId, 'agents');

  return (
    <>
      <group ref={station} position={[spot.x, ROOM_Y, STATION_Z]} visible={false}>
        <group ref={stationBuild} scale={AG}>
          <mesh geometry={stationGeo()} material={MAT.furniture} castShadow receiveShadow />
          <mesh ref={screen} geometry={GEO.plane} material={mats.screen} position={LAPTOP_SCREEN.p} rotation-x={LAPTOP_SCREEN.rx} scale={LAPTOP_SCREEN.s} />
          <group position={[0, 0, 0.36]}>
            <mesh geometry={stoolGeo()} material={MAT.fabric} castShadow />
          </group>
        </group>
      </group>
      <group ref={body} visible={false}>
        <group ref={scaler}>
          <Chibi look={look} rig={rig} />
        </group>
        <mesh
          geometry={GEO.sphere}
          material={MAT.hit}
          position={[0, 0.34, 0]}
          scale={[0.2, 0.36, 0.2]}
          onPointerOver={(e) => {
            e.stopPropagation();
            setHover(true);
            document.body.style.cursor = 'pointer';
          }}
          onPointerOut={() => {
            setHover(false);
            document.body.style.cursor = '';
          }}
          onClick={(e) => {
            e.stopPropagation();
            select();
          }}
        />
        {hover && agent && (
          <OfficeLabel position={[0, 0.86, 0]} prio={PRIO.hover}>
            <div className="of-agent">
              <b>{agent.agentType}</b>
              <span>{truncate(agent.description, 44)}</span>
              {agent.currentTool && <em style={{ color: toolColor(agent.currentTool.name) }}>{fmtToolName(agent.currentTool.name)}</em>}
            </div>
          </OfficeLabel>
        )}
      </group>
    </>
  );
}

export const AgentMate = memo(AgentImpl, (a, b) =>
  a.spot.id === b.spot.id &&
  a.spot.x === b.spot.x &&
  a.spot.bornAt === b.spot.bornAt &&
  a.spot.leavingAt === b.spot.leavingAt &&
  a.room.w === b.room.w &&
  a.room.d === b.room.d &&
  a.room.color === b.room.color &&
  a.room.leavingAt === b.room.leavingAt,
);
