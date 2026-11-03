// One session = one desk with a monitor, keyboard, lamp, chair and its person.
// The desk subscribes to its own session only; every motion runs in useFrame from refs.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../../lib/store';
import { STATUS, hash01, toolColor } from '../../lib/theme';
import { fmtToolName, modelInfo, sessionLabel, trimPath, truncate } from '../../lib/format';
import { damp, easeOutBack, easeOutCubic } from '../../three/motion';
import { OfficeLabel } from './labels';
import { PRIO } from './labelRegistry';
import type { Session } from '../../types';
import { Chibi } from './Chibi';
import { Rig, poseLean, poseRaise, poseTyping } from './rig';
import { GEO, MAT, TEX, chairGeo, cssColor, deskGeo, deskMetalGeo, glowMat, hot, lookFor, type V3 } from './assets';
import { angleDelta, clamp01, easeInCubic, nowSec, useAfter } from './anim';
import { burst } from './sparks';
import { ROOM_Y, T, type DeskSpot } from './model';

export const CHAIR_Z = 0.36;
const SCREEN_P: V3 = [0, 0.48, -0.1205];

const C_BLOCKED = cssColor(STATUS.blocked.color);
const C_WAITING = cssColor(STATUS.waiting.color);
const C_PAUSED = cssColor('#f5c451');
const C_OFF = cssColor('#0d1018');
const C_SELECT = cssColor('#ffe3c8');
const tmp = new THREE.Vector3();
const tmpC = new THREE.Color();

type BasicMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;

/** Per-desk animation state, written after each render and read by the frame loop */
interface Live {
  status: Session['status'];
  paused: boolean;
  selected: boolean;
  hover: boolean;
  tool: THREE.Color;
  screen: THREE.Color;
  t: number;
  flash: number;
  yaw: number;
  cz: number;
  cx: number;
  chz: number;
  chx: number;
  chy: number;
  halo: number;
  pres: number;
  first: boolean;
}

const makeLive = (seed: number, idle: boolean): Live => ({
  status: 'idle', paused: false, selected: false, hover: false,
  tool: new THREE.Color(), screen: new THREE.Color(0, 0, 0),
  t: seed * 20, flash: -10, yaw: Math.PI, cz: 0, cx: 0, chz: 0, chx: 0, chy: 0, halo: 0, pres: idle ? 0 : 1, first: true,
});

function detailOf(s: Session): string {
  const p = s.control.pending;
  if (p) return `${fmtToolName(p.toolName)}: ${truncate(trimPath(p.detail), 46)}`;
  const t = s.currentTool;
  return t ? `${fmtToolName(t.name)}: ${truncate(trimPath(t.detail), 46)}` : 'Permission';
}

/** Red "!" over the head plus a pulsing ring, for sessions waiting on a permission */
function Beacon({ y, z }: { y: number; z: number }) {
  const g = useRef<THREE.Group>(null);
  const ring = useRef<BasicMesh>(null);
  const floor = useRef<BasicMesh>(null);
  const mats = useMemo(() => ({
    ring: new THREE.MeshBasicMaterial({ color: hot(C_BLOCKED, 2.2), transparent: true, toneMapped: false, depthWrite: false }),
    floor: glowMat(C_BLOCKED.clone().multiplyScalar(1.4), TEX.ring),
  }), []);
  useEffect(() => () => { mats.ring.dispose(); mats.floor.dispose(); }, [mats]);
  useFrame(() => {
    const t = nowSec();
    if (g.current) {
      g.current.position.y = y + Math.sin(t * 3) * 0.035;
      g.current.rotation.y = t * 1.6;
    }
    const p = (t * 0.75) % 1;
    const r = ring.current;
    if (r) {
      r.scale.setScalar(0.07 + p * 0.2);
      r.material.opacity = (1 - p) * 0.95;
    }
    const f = (t * 0.75 + 0.5) % 1;
    const fl = floor.current;
    if (fl) {
      fl.scale.setScalar(0.35 + f * 0.75);
      fl.material.opacity = (1 - f) * 0.9;
    }
  });
  return (
    <>
      <group ref={g} position={[0, y, z]}>
        <mesh geometry={GEO.bang} material={MAT.beacon} position={[0, 0.05, 0]} />
        <mesh geometry={GEO.sphere} material={MAT.beacon} position={[0, -0.055, 0]} scale={0.024} />
        <mesh ref={ring} geometry={GEO.ring} material={mats.ring} rotation-x={Math.PI / 2} />
      </group>
      <mesh ref={floor} geometry={GEO.plane} material={mats.floor} position={[0, 0.006, z]} rotation-x={-Math.PI / 2} />
    </>
  );
}

interface Props {
  spot: DeskSpot;
  color: string;
  roomLeavingAt: number | null;
}

function DeskImpl({ spot, color, roomLeavingAt }: Props) {
  const s = useStore((st) => st.sessions[spot.id]) as Session | undefined;
  const selected = useStore((st) => st.selectedId === spot.id);
  const [hover, setHover] = useState(false);
  const family = modelInfo(s?.model).family;
  const look = useMemo(() => lookFor(spot.id, color, family, 'main'), [spot.id, color, family]);
  const rig = useMemo(() => new Rig(hash01(spot.id)), [spot.id]);
  const mats = useMemo(() => {
    const tex = TEX.code.clone();
    tex.repeat.set(1, 0.3);
    tex.offset.y = hash01(spot.id + 'scroll');
    return {
      tex,
      screen: new THREE.MeshBasicMaterial({ map: tex, color: 0x000000, toneMapped: false }),
      spill: glowMat(new THREE.Color(0, 0, 0)),
      halo: glowMat(C_SELECT.clone(), TEX.halo),
    };
  }, [spot.id]);
  useEffect(() => () => {
    mats.tex.dispose();
    mats.screen.dispose();
    mats.spill.dispose();
    mats.halo.dispose();
  }, [mats]);

  const status = s?.status ?? 'idle';
  const paused = !!s?.control.paused && status !== 'idle';
  const tool = s?.currentTool ?? null;
  const lastTool = tool?.name ?? s?.tools[s.tools.length - 1]?.name ?? null;

  const [initial] = useState(() => makeLive(hash01(spot.id), status === 'idle'));
  const live = useRef<Live>(initial);
  useLayoutEffect(() => {
    const l = live.current;
    l.status = status;
    l.paused = paused;
    l.selected = selected;
    l.hover = hover;
    l.tool.copy(cssColor(toolColor(lastTool)));
  });

  const unit = useRef<THREE.Group>(null);
  const build = useRef<THREE.Group>(null);
  const chair = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const halo = useRef<BasicMesh>(null);
  const screen = useRef<BasicMesh>(null);
  const spill = useRef<BasicMesh>(null);

  // A tool call just started: flash the screen and pop a few sparks
  useEffect(() => useStore.subscribe((st, prev) => {
    const p = st.pulses[spot.id];
    if (!p || p === prev.pulses[spot.id]) return;
    const l = live.current;
    l.flash = nowSec();
    if (l.status === 'working' && !l.paused && screen.current) {
      screen.current.getWorldPosition(tmp);
      tmp.y += 0.12;
      burst(tmp, cssColor(toolColor(p.tool)), 10);
    }
  }), [spot.id]);

  useEffect(() => () => {
    if (live.current.hover) document.body.style.cursor = '';
  }, []);

  useFrame((state, dt) => {
    const g = unit.current;
    const b = build.current;
    const ch = chair.current;
    const bd = body.current;
    if (!g || !b || !ch || !bd) return;
    const L = live.current;
    const now = nowSec();
    const pIn = clamp01((now - spot.bornAt) / T.deskDur);
    const leave = spot.leavingAt ?? roomLeavingAt;
    const pOut = leave != null ? clamp01((now - leave) / 0.45) : 0;
    if (pIn <= 0 || pOut >= 1) {
      g.visible = false;
      return;
    }
    g.visible = true;

    // Drop in with a back-out pop; leave by lifting and shrinking after the person pops out
    const deskOut = clamp01((pOut - 0.3) / 0.7);
    const sc = Math.max(1e-4, easeOutBack(pIn, 1.5) * (1 - easeInCubic(deskOut)));
    b.scale.set(sc, sc, sc);
    b.position.y = (1 - easeOutCubic(pIn)) * 0.85 + easeInCubic(deskOut) * 0.3;

    const present = L.status !== 'idle';
    L.pres += ((present ? 1 : 0) - L.pres) * damp(7, dt);
    const pc = clamp01((now - spot.bornAt - 0.42) / 0.42);
    const cs = easeOutBack(pc, 1.7) * (1 - easeInCubic(clamp01(pOut / 0.3))) * L.pres;
    bd.visible = cs > 0.003;
    bd.scale.setScalar(Math.max(cs, 1e-4));

    if (!L.paused) L.t += dt;
    const t = L.t;

    // Facing the camera, in this desk's local frame
    bd.getWorldPosition(tmp);
    const camYaw = Math.atan2(state.camera.position.x - tmp.x, state.camera.position.z - tmp.z) - spot.yaw;
    let yawT = Math.PI;
    let cz = 0, cx = 0, chz = 0, chx = 0, chy = 0;
    switch (L.status) {
      case 'working':
        poseTyping(rig.tgt, t, rig.phase);
        break;
      case 'blocked':
        poseRaise(rig.tgt, t, rig.phase);
        yawT = camYaw;
        cz = 0.16;
        cx = -0.06;
        chz = 0.1;
        chx = 0.26;
        chy = 0.7;
        break;
      case 'waiting': {
        poseLean(rig.tgt, t, rig.phase);
        const sw = Math.max(-0.55, Math.min(0.55, angleDelta(Math.PI, camYaw)));
        yawT = Math.PI + sw;
        chy = sw;
        cz = chz = 0.03;
        break;
      }
      default:
        poseTyping(rig.tgt, t, rig.phase);
        chz = -0.13;
        chy = (hash01(spot.id + 'c') - 0.5) * 0.5;
        break;
    }
    if (L.first) {
      rig.snap();
      L.yaw = yawT;
      L.first = false;
    }
    if (!L.paused) {
      const k = damp(6, dt);
      L.cz += (cz - L.cz) * k;
      L.cx += (cx - L.cx) * k;
      L.chz += (chz - L.chz) * k;
      L.chx += (chx - L.chx) * k;
      L.chy += angleDelta(L.chy, chy) * k;
      L.yaw += angleDelta(L.yaw, yawT) * damp(5, dt);
      rig.apply(dt);
      rig.blink(t);
    }
    bd.position.set(L.cx, 0, CHAIR_Z + L.cz);
    bd.rotation.y = L.yaw;
    ch.position.set(L.chx, 0, CHAIR_Z + L.chz);
    ch.rotation.y = Math.PI + L.chy;

    // Screen: tool colour while working, flashes on every tool call
    const fl = Math.exp(-(now - L.flash) * 5);
    let k = 0.02;
    let col = C_OFF;
    if (L.paused) { col = C_PAUSED; k = 0.42; }
    else if (L.status === 'working') { col = L.tool; k = 1.05 + fl * 1.9; }
    else if (L.status === 'blocked') { col = C_BLOCKED; k = 0.75 + 0.45 * (0.5 + 0.5 * Math.sin(now * 5)); }
    else if (L.status === 'waiting') { col = C_WAITING; k = 0.5; }
    else { col = C_OFF; k = 1; }
    tmpC.copy(col).multiplyScalar(k);
    L.screen.lerp(tmpC, damp(10, dt));
    const scr = screen.current;
    if (scr) {
      scr.material.color.copy(L.screen);
      if (L.status === 'working' && !L.paused && scr.material.map) scr.material.map.offset.y -= dt * (0.035 + fl * 0.25);
    }
    spill.current?.material.color.copy(L.screen).multiplyScalar(0.3);

    // Floor halo: soft on hover, warm and steady when selected
    const hT = L.selected ? 0.9 : L.hover ? 0.42 : 0;
    L.halo += (hT - L.halo) * damp(10, dt);
    const h = halo.current;
    if (h) {
      h.material.opacity = L.halo;
      h.visible = L.halo > 0.01;
    }
  });

  const built = useAfter(spot.bornAt + T.deskDur + 0.35);
  const leaving = spot.leavingAt != null || roomLeavingAt != null;
  const idle = status === 'idle';
  const select = (tab?: 'chat') => useStore.getState().select(spot.id, tab);
  const showLabels = built && !leaving && !!s;
  const pending = s?.control.pending;

  return (
    <group ref={unit} position={[spot.x, ROOM_Y, spot.z]} rotation-y={spot.yaw} visible={false}>
      <group ref={build}>
        <mesh geometry={deskGeo(spot.variant)} material={hover || selected ? MAT.furnitureHi : idle ? MAT.furnitureDim : MAT.furniture} castShadow receiveShadow />
        <mesh geometry={deskMetalGeo()} material={MAT.metal} castShadow />
        <mesh ref={screen} geometry={GEO.plane} material={mats.screen} position={SCREEN_P} scale={[0.338, 0.198, 1]} />
        <mesh geometry={GEO.plane} material={mats.screen} position={[0, 0.556, -0.1396]} rotation-y={Math.PI} scale={[0.1, 0.008, 1]} />
        <mesh geometry={GEO.dome} material={idle ? MAT.lampOff : MAT.lampOn} position={[0.31, 0.425, -0.15]} scale={[0.066, 0.05, 0.066]} />
        {!idle && <mesh geometry={GEO.plane} material={MAT.lampPool} position={[0.25, 0.3014, -0.06]} rotation-x={-Math.PI / 2} scale={0.5} />}
        <mesh ref={spill} geometry={GEO.plane} material={mats.spill} position={[0, 0.3017, 0.03]} rotation-x={-Math.PI / 2} scale={[0.66, 0.44, 1]} />
        <group ref={chair} position={[0, 0, CHAIR_Z]} rotation-y={Math.PI}>
          <mesh geometry={chairGeo()} material={MAT.fabric} castShadow receiveShadow />
        </group>
        <group ref={body} position={[0, 0, CHAIR_Z]} rotation-y={Math.PI}>
          <Chibi look={look} rig={rig} />
        </group>
        <mesh ref={halo} geometry={GEO.plane} material={mats.halo} position={[0, 0.005, 0.14]} rotation-x={-Math.PI / 2} scale={[1.2, 1.08, 1]} visible={false} />
        <mesh
          geometry={GEO.box}
          material={MAT.hit}
          position={[0, 0.45, 0.13]}
          scale={[0.86, 0.9, 0.98]}
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
            select(status === 'blocked' ? 'chat' : undefined);
          }}
        />
        {status === 'blocked' && built && !leaving && <Beacon y={1.1} z={CHAIR_Z + 0.16} />}
      </group>

      {showLabels && s && (hover ? (
        <OfficeLabel position={[0, 1.16, CHAIR_Z]} prio={PRIO.hover}>
          <div className="of-card">
            <div className="of-card-title">{truncate(sessionLabel(s), 54)}</div>
            <div className="of-card-row">
              <span className={`of-card-status st-${status}`}><i />{paused ? 'Paused' : STATUS[status].label}</span>
              <span>{modelInfo(s.model).label}</span>
              {s.process?.host && <span>{s.process.host}</span>}
            </div>
            {tool && status === 'working' && <div className="of-card-tool"><b style={{ color: toolColor(tool.name) }}>{fmtToolName(tool.name)}</b> {truncate(trimPath(tool.detail), 60)}</div>}
            <div className="of-card-hint">Click to open</div>
          </div>
        </OfficeLabel>
      ) : status === 'blocked' ? (
        <OfficeLabel position={[0, 1.44, CHAIR_Z + 0.16]} prio={PRIO.blocked} onClick={() => select('chat')}>
          <div className="of-need" title="Open the approval">
            <span className="of-need-dot" />
            <span>Needs you</span>
            <span className="of-need-sep">·</span>
            <code>{s ? detailOf(s) : pending?.toolName}</code>
          </div>
        </OfficeLabel>
      ) : paused ? (
        <OfficeLabel position={[0, 1.0, CHAIR_Z]} prio={PRIO.paused}>
          <div className="of-paused"><span className="of-paused-icon" />Paused</div>
        </OfficeLabel>
      ) : status === 'working' && tool ? (
        <OfficeLabel position={[0, 1.0, CHAIR_Z]} prio={PRIO.working}>
          <div className="of-tool" style={{ '--c': toolColor(tool.name) } as CSSProperties}>
            <span className="of-tool-name">{fmtToolName(tool.name)}</span>
            <span className="of-tool-detail">{truncate(trimPath(tool.detail), 26)}</span>
          </div>
        </OfficeLabel>
      ) : status === 'waiting' ? (
        <OfficeLabel position={[0, 1.02, CHAIR_Z]} prio={PRIO.waiting}>
          <div className="of-bubble">Your turn</div>
        </OfficeLabel>
      ) : null)}
    </group>
  );
}

export const SessionDesk = memo(DeskImpl, (a, b) =>
  a.color === b.color &&
  a.roomLeavingAt === b.roomLeavingAt &&
  a.spot.id === b.spot.id &&
  a.spot.x === b.spot.x &&
  a.spot.z === b.spot.z &&
  a.spot.yaw === b.spot.yaw &&
  a.spot.bornAt === b.spot.bornAt &&
  a.spot.leavingAt === b.spot.leavingAt,
);
