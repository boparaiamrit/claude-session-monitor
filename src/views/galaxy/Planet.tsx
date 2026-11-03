/* eslint-disable react-hooks/immutability -- R3F frame loops mutate three.js objects (materials, buffers, matrices) imperatively by design */
// One session as a planet: orbit speed follows recent activity, status tints the
// surface and atmosphere, sub-agents are moons, blocked planets ping red.
import { memo, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import type { Session } from '../../types';
import { useStore } from '../../lib/store';
import { STATUS, hash01, toolColor } from '../../lib/theme';
import { Label3D } from '../../three/kit';
import { damp, easeOutBack } from '../../three/motion';
import { sessionLabel, truncate } from '../../lib/format';
import { cssColor, recentCalls, useLabelsReady } from '../city/gfx';
import { planetSize, type Orbit, type System } from './layout';
import { ATMO_FRAG, ATMO_VERT, ORBIT_FRAG, ORBIT_VERT, PLANET_FRAG, PLANET_VERT } from './shaders';

export interface Body {
  pos: THREE.Vector3;
  star: THREE.Vector3;
  size: number;
}
export type Bodies = Map<string, Body>;

const SPHERE = new THREE.SphereGeometry(1, 48, 32);
const HIT_MAT = new THREE.MeshBasicMaterial({ visible: false });
const MOON_GEO = new THREE.SphereGeometry(0.075, 12, 8);
const MOON_MAT = new THREE.MeshBasicMaterial({ toneMapped: false });
const MAX_MOONS = 6;
const WHITE = new THREE.Color(1, 1, 1);
const IDLE_A = new THREE.Color('#4a505e');
const IDLE_B = new THREE.Color('#1c1f27');

let ringTex: THREE.Texture | null = null;
/** Thin glowing ring, used for the blocked ping and the selection halo */
function ringTexture(): THREE.Texture {
  if (ringTex) return ringTex;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0, 'rgba(255,255,255,0)');
  grd.addColorStop(0.7, 'rgba(255,255,255,0)');
  grd.addColorStop(0.8, 'rgba(255,255,255,0.35)');
  grd.addColorStop(0.86, 'rgba(255,255,255,1)');
  grd.addColorStop(0.9, 'rgba(255,255,255,0.3)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  ringTex = new THREE.CanvasTexture(c);
  return ringTex;
}

function orbitGeometry(r: number): THREE.BufferGeometry {
  const N = 160;
  const pos = new Float32Array(N * 3);
  const ang = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 2] = Math.sin(a) * r;
    ang[i] = a;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aAngle', new THREE.BufferAttribute(ang, 1));
  return g;
}

/** Angular speed: idle planets barely drift, busy ones swing round */
function orbitSpeed(s: Session, r: number): number {
  const recent = recentCalls(s.activity, 5);
  const busy = 1 - Math.exp(-recent / 22);
  const base = s.status === 'idle' ? 0.006 : s.status === 'working' ? 0.05 : 0.02;
  return (base + 0.5 * busy * (s.status === 'idle' ? 0.1 : 1)) * (2.4 / Math.sqrt(r));
}

interface Props {
  s: Session;
  system: System;
  /** Live position of this planet's star (it glides when the layout changes) */
  star: THREE.Vector3;
  orbit: Orbit;
  bodies: Bodies;
  hovered: boolean;
  selected: boolean;
  onHover: (id: string | null) => void;
}

export const Planet = memo(function Planet({ s, system, star, orbit, bodies, hovered, selected, onHover }: Props) {
  const seed = useMemo(() => hash01(s.id) * 10, [s.id]);
  const holder = useRef<THREE.Group>(null!);
  const body = useRef<THREE.Mesh>(null!);
  const atmo = useRef<THREE.Mesh>(null!);
  const ping = useRef<THREE.Sprite>(null!);
  const halo = useRef<THREE.Sprite>(null!);
  const focus = useRef<THREE.Sprite>(null!);
  const moons = useRef<THREE.InstancedMesh>(null!);

  const own = useMemo(() => new THREE.Color().setHSL(hash01(s.id + 'hue'), 0.45, 0.5), [s.id]);
  const planetMat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: PLANET_VERT, fragmentShader: PLANET_FRAG,
    uniforms: {
      uStar: { value: new THREE.Vector3() }, uA: { value: new THREE.Color() }, uB: { value: new THREE.Color() },
      uBandColor: { value: cssColor(STATUS.working.color).clone().multiplyScalar(2.2) },
      uBand: { value: 0 }, uTime: { value: 0 }, uSeed: { value: seed }, uLift: { value: 0 },
    },
  }), [seed]);
  const atmoMat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: ATMO_VERT, fragmentShader: ATMO_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color() }, uStar: { value: new THREE.Vector3() }, uStrength: { value: 1.6 } },
  }), []);
  const orbitMat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: ORBIT_VERT, fragmentShader: ORBIT_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color() }, uPlanet: { value: 0 }, uBase: { value: 0.06 }, uTrail: { value: 0.5 } },
  }), []);
  const pingMat = useMemo(() => new THREE.SpriteMaterial({ map: ringTexture(), color: cssColor(STATUS.blocked.color).clone().multiplyScalar(2), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false, opacity: 0 }), []);
  const haloMat = useMemo(() => new THREE.SpriteMaterial({ map: ringTexture(), color: cssColor(STATUS.blocked.color).clone().multiplyScalar(1.6), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false, opacity: 0 }), []);
  const focusMat = useMemo(() => new THREE.SpriteMaterial({ map: ringTexture(), color: new THREE.Color(1.3, 1.3, 1.3), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false, opacity: 0 }), []);
  const orbitGeo = useMemo(() => orbitGeometry(orbit.r), [orbit.r]);

  useLayoutEffect(() => {
    moons.current.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_MOONS * 3), 3);
    moons.current.count = 0;
  }, []);
  useLayoutEffect(() => () => {
    [planetMat, atmoMat, orbitMat, pingMat, haloMat, focusMat].forEach((m) => m.dispose());
    orbitGeo.dispose();
  }, [planetMat, atmoMat, orbitMat, pingMat, haloMat, focusMat, orbitGeo]);

  const live = useRef({
    angle: orbit.phase, born: -1, size: 0, band: 0,
    moons: new Map<string, { a: number; phase: number; color: THREE.Color }>(),
    a: new THREE.Color(), b: new THREE.Color(),
  });
  const tmpM = useMemo(() => new THREE.Matrix4(), []);
  const tmpC = useMemo(() => new THREE.Color(), []);
  const tmpV = useMemo(() => new THREE.Vector3(), []);

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const t = state.clock.elapsedTime;
    const L = live.current;
    const status = s.status;
    const idle = status === 'idle';

    // Orbit: integrate the angle so speed changes never jump the planet
    L.angle += orbitSpeed(s, orbit.r) * dt;
    holder.current.position.set(Math.cos(L.angle) * orbit.r, 0, Math.sin(L.angle) * orbit.r);

    // Entrance: pop in with a little overshoot, staggered by orbit
    if (L.born < 0) L.born = t + (t < 1.5 ? 0.5 + orbit.index * 0.12 + hash01(system.key) * 0.3 : 0);
    const k = Math.max(0, Math.min(1, (t - L.born) / 0.9));
    const goal = planetSize(s);
    L.size = k < 1 ? goal * Math.max(0, easeOutBack(k, 1.6)) : L.size + (goal - L.size) * damp(2, dt);
    const r = Math.max(0.001, L.size);
    body.current.scale.setScalar(r);
    body.current.rotation.y += dt * (idle ? 0.05 : 0.22);
    atmo.current.scale.setScalar(r * 1.16);

    // Surface: status color blended with the planet's own hue
    const sc = cssColor(STATUS[status].color);
    if (idle) { L.a.copy(IDLE_A); L.b.copy(IDLE_B); }
    else {
      L.a.copy(sc).lerp(own, 0.32);
      L.b.copy(sc).lerp(own, 0.55).multiplyScalar(0.32);
    }
    planetMat.uniforms.uA.value.copy(L.a);
    planetMat.uniforms.uB.value.copy(L.b);
    L.band += ((status === 'working' ? 1 : 0) - L.band) * damp(3, dt);
    planetMat.uniforms.uBand.value = L.band;
    planetMat.uniforms.uTime.value = t + seed;
    planetMat.uniforms.uLift.value += (((hovered || selected ? 0.08 : 0) + (idle ? 0.12 : 0)) - planetMat.uniforms.uLift.value) * damp(8, dt);

    // World position for the camera, comets and labels
    const b = bodies.get(s.id);
    holder.current.getWorldPosition(tmpV);
    if (b) { b.pos.copy(tmpV); b.star.copy(star); b.size = r; }
    else bodies.set(s.id, { pos: tmpV.clone(), star: star.clone(), size: r });
    planetMat.uniforms.uStar.value.copy(star);
    atmoMat.uniforms.uStar.value.copy(star);
    atmoMat.uniforms.uColor.value.copy(idle ? IDLE_A : sc);
    atmoMat.uniforms.uStrength.value = idle ? 0.7 : hovered || selected ? 2.4 : 1.7;

    // Orbit ring: faint, with a trail behind the planet in the status color
    orbitMat.uniforms.uPlanet.value = ((L.angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    orbitMat.uniforms.uColor.value.copy(idle ? IDLE_A : sc);
    const baseGoal = selected ? 0.22 : hovered ? 0.14 : idle ? 0.035 : 0.065;
    orbitMat.uniforms.uBase.value += (baseGoal - orbitMat.uniforms.uBase.value) * damp(6, dt);
    orbitMat.uniforms.uTrail.value = idle ? 0.15 : selected ? 1.1 : 0.6;

    // Blocked: a steady red ring plus a ping that keeps expanding outward
    const blocked = status === 'blocked';
    const ph = (t * 0.7) % 1;
    pingMat.opacity += ((blocked ? (1 - ph) * 0.9 : 0) - pingMat.opacity) * damp(blocked ? 30 : 6, dt);
    ping.current.scale.setScalar(r * (2.6 + ph * 5));
    haloMat.opacity += ((blocked ? 0.55 + 0.35 * Math.sin(t * 5) : 0) - haloMat.opacity) * damp(8, dt);
    halo.current.scale.setScalar(r * 2.9);
    ping.current.visible = pingMat.opacity > 0.01;
    halo.current.visible = haloMat.opacity > 0.01;
    focusMat.opacity += ((selected ? 0.6 : hovered ? 0.35 : 0) - focusMat.opacity) * damp(8, dt);
    focus.current.scale.setScalar(r * (selected ? 3.6 + Math.sin(t * 2) * 0.1 : 3.4));
    focus.current.visible = focusMat.opacity > 0.01;

    // Moons: one per working sub-agent
    const agents = s.agents.length > 10 ? s.agents.slice(-10) : s.agents;
    for (const a of agents) {
      let m = L.moons.get(a.id);
      if (!m && a.status === 'working') {
        m = { a: 0, phase: hash01(a.id) * Math.PI * 2, color: new THREE.Color() };
        L.moons.set(a.id, m);
      }
      if (!m) continue;
      const g = a.status === 'working' && !idle ? 1 : 0;
      m.a += (g - m.a) * damp(g ? 3 : 1.4, dt);
      m.color.copy(cssColor(toolColor(a.currentTool?.name ?? 'Agent'))).lerp(WHITE, 0.5);
    }
    const mm = moons.current;
    const mArr = (mm.instanceColor as THREE.InstancedBufferAttribute).array as Float32Array;
    let mi = 0;
    for (const [id, m] of L.moons) {
      if (m.a < 0.01 && !agents.some((a) => a.id === id && a.status === 'working')) { L.moons.delete(id); continue; }
      if (mi >= MAX_MOONS) continue;
      const rad = r * 1.9 + 0.35 + mi * 0.28;
      const sp = 1.6 / Math.sqrt(rad);
      const ang = m.phase + t * sp;
      const incl = (m.phase - Math.PI) * 0.25;
      const x = Math.cos(ang) * rad;
      const z = Math.sin(ang) * rad;
      const scl = m.a;
      tmpM.makeScale(scl, scl, scl);
      tmpM.setPosition(x, z * Math.sin(incl), z * Math.cos(incl));
      mm.setMatrixAt(mi, tmpM);
      tmpC.copy(m.color).multiplyScalar(2.4 * m.a);
      mArr[mi * 3] = tmpC.r; mArr[mi * 3 + 1] = tmpC.g; mArr[mi * 3 + 2] = tmpC.b;
      mi++;
    }
    mm.count = mi;
    mm.instanceMatrix.needsUpdate = true;
    if (mm.instanceColor) mm.instanceColor.needsUpdate = true;
  });

  const over = (e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); onHover(s.id); };
  const out = () => onHover(null);
  const click = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.delta > 6) return;
    useStore.getState().select(s.id);
  };

  return (
    <>
      <lineLoop geometry={orbitGeo} material={orbitMat} raycast={() => null} />
      <group ref={holder}>
        <mesh ref={body} geometry={SPHERE} material={planetMat} raycast={() => null} />
        <mesh ref={atmo} geometry={SPHERE} material={atmoMat} raycast={() => null} />
        <mesh geometry={SPHERE} material={HIT_MAT} scale={Math.max(1.1, planetSize(s) * 2.2)} onPointerOver={over} onPointerOut={out} onClick={click} />
        <sprite ref={halo} material={haloMat} raycast={() => null} />
        <sprite ref={ping} material={pingMat} raycast={() => null} />
        <sprite ref={focus} material={focusMat} raycast={() => null} />
        <instancedMesh ref={moons} args={[MOON_GEO, MOON_MAT, MAX_MOONS]} frustumCulled={false} raycast={() => null} />
        <PlanetLabel s={s} hovered={hovered} selected={selected} />
      </group>
    </>
  );
});

/**
 * One label per planet for its whole life; only the content switches.
 * Mounting and unmounting drei Html roots on every hover races in React 19.
 */
function PlanetLabel({ s, hovered, selected }: { s: Session; hovered: boolean; selected: boolean }) {
  const ready = useLabelsReady();
  const blocked = s.status === 'blocked';
  if (!ready) return null;
  const showTip = hovered || selected;
  const mode = blocked ? 'needs' : showTip ? 'tip' : 'off';
  const st = STATUS[s.status];
  const lift = planetSize(s) * (blocked ? 3 : 2.6) + (blocked ? 1.1 : 1.2);
  return (
    <Label3D
      position={[0, lift, 0]}
      className={`galaxy-label is-${mode}`}
      onClick={blocked ? () => useStore.getState().select(s.id) : undefined}
    >
      {blocked ? (
        <span className="galaxy-needs-pill">
          <span className="status-dot" />
          {st.label}
          {showTip ? <span className="galaxy-needs-title">{truncate(sessionLabel(s), 40)}</span> : null}
        </span>
      ) : showTip ? (
        <div className="galaxy-tip-card">
          <span className="galaxy-tip-title">{truncate(sessionLabel(s), 46)}</span>
          <span className={`galaxy-tip-status st-${s.status}`}>
            <span className="status-dot" />
            {st.label}
            {s.currentTool && s.status === 'working' ? <span className="galaxy-tip-tool">· {s.currentTool.name}</span> : null}
          </span>
        </div>
      ) : null}
    </Label3D>
  );
}
