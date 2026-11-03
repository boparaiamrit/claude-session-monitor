/* eslint-disable react-hooks/immutability -- R3F frame loops mutate three.js objects (materials, buffers, matrices) imperatively by design */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Grid, MeshReflectorMaterial, Stars } from '@react-three/drei';
import * as THREE from 'three';
import type { Session } from '../../types';
import { useStore } from '../../lib/store';
import { Label3D } from '../../three/kit';
import { smootherstep } from '../../three/motion';
import { CameraRig, type RigFocus, type RigLimits } from './rig';
import { BOX_GEO, beaconTop, buildLayout, towerHeight, towerKicks, type CityLayout, type District, type Filler, type Lane } from './layout';
import { Tower } from './Tower';
import { cssColor, glowTexture, recentCalls, useLabelsReady } from './gfx';

export const FOG_COLOR = '#0a0c15';

// ── Sky: deep zenith, a faint violet haze on the horizon that matches the fog ──
const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
  }
`;
const SKY_FRAG = /* glsl */ `
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  uniform vec3 uGlow;
  varying vec3 vDir;
  void main() {
    float h = vDir.y;
    vec3 col = mix(uHorizon, uTop, smoothstep(0.0, 0.5, max(h, 0.0)));
    col += uGlow * exp(-max(h, 0.0) * 9.0) * step(0.0, h);
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function Sky() {
  const ref = useRef<THREE.Mesh>(null!);
  const mat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      uTop: { value: new THREE.Color('#020308') },
      uHorizon: { value: new THREE.Color(FOG_COLOR) },
      uGlow: { value: new THREE.Color('#1a1630') },
    },
  }), []);
  useFrame(({ camera }) => ref.current.position.copy(camera.position));
  return (
    <mesh ref={ref} material={mat} renderOrder={-10} frustumCulled={false} raycast={() => null}>
      <sphereGeometry args={[500, 32, 16]} />
    </mesh>
  );
}

// ── Background blocks: dark silhouettes with sparse procedural windows ──
function fillerMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: '#0a0d14', metalness: 0.7, roughness: 0.5, envMapIntensity: 0.16 });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWP;\nvarying vec3 vWN;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 wp = vec4(transformed, 1.0);
        vec3 wn = objectNormal;
        #ifdef USE_INSTANCING
          wp = instanceMatrix * wp;
          wn = mat3(instanceMatrix) * wn;
        #endif
        vWP = (modelMatrix * wp).xyz;
        vWN = normalize(mat3(modelMatrix) * wn);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWP;
        varying vec3 vWN;
        float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          float side = 1.0 - step(0.5, abs(vWN.y));
          vec2 fc = abs(vWN.x) > 0.5 ? vec2(vWP.z, vWP.y) : vec2(vWP.x, vWP.y);
          vec2 g = fc / vec2(0.4, 0.52);
          vec2 cell = floor(g);
          vec2 f = fract(g);
          float win = step(0.24, f.x) * step(f.x, 0.76) * step(0.3, f.y) * step(f.y, 0.8);
          float h = h21(cell + sign(vWN.x + vWN.z) * 17.0);
          float lit = step(0.955, h);
          float aa = clamp(1.6 - max(fwidth(g.x), fwidth(g.y)) * 2.0, 0.0, 1.0);
          vec3 wc = mix(vec3(0.42, 0.5, 0.78), vec3(0.4, 0.62, 0.66), step(0.985, h));
          float ground = smoothstep(0.5, 0.9, vWP.y);
          totalEmissiveRadiance += wc * mix(lit * 0.25, win * lit, aa) * side * ground * 0.32;
        }`);
  };
  return m;
}

// ── Sidewalk plates under every background block, so the roads read as roads ──
const PLATE_MAT = new THREE.MeshStandardMaterial({ color: '#0a0c12', metalness: 0.4, roughness: 0.7, envMapIntensity: 0.15 });

function Blocks({ blocks, size }: { blocks: [number, number][]; size: number }) {
  const ref = useRef<THREE.InstancedMesh>(null!);
  useLayoutEffect(() => {
    const m = new THREE.Matrix4();
    blocks.forEach(([x, z], i) => {
      m.makeScale(size, 0.08, size);
      m.setPosition(x, 0, z);
      ref.current.setMatrixAt(i, m);
    });
    ref.current.instanceMatrix.needsUpdate = true;
  }, [blocks, size]);
  return <instancedMesh key={blocks.length} ref={ref} args={[BOX_GEO, PLATE_MAT, blocks.length]} frustumCulled={false} raycast={() => null} />;
}

// ── Street lights: a cool pool of light at each downtown intersection ──
const LAMP_POOL_GEO = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
const LAMP_BULB_GEO = new THREE.SphereGeometry(0.07, 8, 6);
const LAMP_BULB_MAT = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 0.58, 0.75), toneMapped: false });

function Lamps({ lamps }: { lamps: [number, number][] }) {
  const pools = useRef<THREE.InstancedMesh>(null!);
  const bulbs = useRef<THREE.InstancedMesh>(null!);
  const poolMat = useMemo(() => new THREE.MeshBasicMaterial({
    map: glowTexture(), color: new THREE.Color(0.1, 0.13, 0.21), blending: THREE.AdditiveBlending,
    transparent: true, depthWrite: false, toneMapped: false,
  }), []);
  useLayoutEffect(() => {
    const m = new THREE.Matrix4();
    let i = 0;
    for (const [x, z] of lamps) {
      for (const [ox, oz] of [[-1.25, -1.25], [1.25, 1.25]]) {
        m.makeScale(4.2, 1, 4.2);
        m.setPosition(x + ox, 0.03, z + oz);
        pools.current.setMatrixAt(i, m);
        m.makeTranslation(x + ox, 2.1, z + oz);
        bulbs.current.setMatrixAt(i, m);
        i++;
      }
    }
    pools.current.instanceMatrix.needsUpdate = true;
    bulbs.current.instanceMatrix.needsUpdate = true;
  }, [lamps]);
  const n = lamps.length * 2;
  return (
    <group key={n}>
      <instancedMesh ref={pools} args={[LAMP_POOL_GEO, poolMat, n]} frustumCulled={false} raycast={() => null} renderOrder={1} />
      <instancedMesh ref={bulbs} args={[LAMP_BULB_GEO, LAMP_BULB_MAT, n]} frustumCulled={false} raycast={() => null} />
    </group>
  );
}

// District label that slides to the side of its district facing the camera,
// so it sits in front of the towers instead of behind them
function DistrictLabel({ d }: { d: District }) {
  const ref = useRef<THREE.Group>(null!);
  const ready = useLabelsReady();
  useFrame(({ camera }) => {
    const dx = camera.position.x - d.cx;
    const dz = camera.position.z - d.cz;
    const m = Math.max(Math.abs(dx), Math.abs(dz)) || 1;
    const r = d.half + 1.3;
    ref.current.position.set(d.cx + (dx / m) * r, 0.2, d.cz + (dz / m) * r);
  });
  return (
    <group ref={ref}>
      {ready && (
        <Label3D position={[0, 0, 0]} className="city-district">
          <span className="city-district-name" style={{ color: d.color }}>{d.name}</span>
          <span className="city-district-count">{d.count} {d.count === 1 ? 'session' : 'sessions'}</span>
        </Label3D>
      )}
    </group>
  );
}

function Fillers({ fillers }: { fillers: Filler[] }) {
  const ref = useRef<THREE.InstancedMesh>(null!);
  const mat = useMemo(() => fillerMaterial(), []);
  useLayoutEffect(() => {
    const m = new THREE.Matrix4();
    fillers.forEach((f, i) => {
      m.makeScale(f.w, f.h, f.d);
      m.setPosition(f.x, 0, f.z);
      ref.current.setMatrixAt(i, m);
    });
    ref.current.instanceMatrix.needsUpdate = true;
  }, [fillers]);
  return <instancedMesh key={fillers.length} ref={ref} args={[BOX_GEO, mat, fillers.length]} frustumCulled={false} raycast={() => null} />;
}

// ── Ground: wet asphalt with soft reflections, a faint grid, road lines on the sections ──
function Ground({ pitch }: { pitch: number }) {
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={() => null}>
        <planeGeometry args={[700, 700]} />
        <MeshReflectorMaterial
          resolution={512}
          blur={[220, 60]}
          mixBlur={0.7}
          mixStrength={40}
          mixContrast={1}
          roughness={1}
          depthScale={0.6}
          minDepthThreshold={0.25}
          maxDepthThreshold={1.2}
          color="#2a2f3c"
          metalness={0.15}
          mirror={1}
        />
      </mesh>
      <Grid
        position={[pitch / 2, 0.012, pitch / 2]}
        args={[10, 10]}
        infiniteGrid
        cellSize={pitch / 4}
        cellThickness={0.5}
        cellColor="#121827"
        sectionSize={pitch}
        sectionThickness={1.1}
        sectionColor="#24304a"
        fadeDistance={150}
        fadeStrength={2.2}
        followCamera={false}
        raycast={() => null}
      />
    </group>
  );
}

// ── Districts: a low plate per project with corner brackets in its color ──
function DistrictPlate({ d }: { d: District }) {
  const color = useMemo(() => cssColor(d.color).clone().multiplyScalar(1.1), [d.color]);
  const geo = useMemo(() => {
    const s = d.half;
    const k = Math.min(1.4, s * 0.35);
    const pts: number[] = [];
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      const x = sx * s, z = sz * s;
      pts.push(x, 0, z, x - sx * k, 0, z, x, 0, z, x, 0, z - sz * k);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, [d.half]);
  const frame = useMemo(() => {
    const s = d.half;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-s, 0, -s, s, 0, -s, s, 0, s, -s, 0, s], 3));
    return g;
  }, [d.half]);
  const glowColor = useMemo(() => cssColor(d.color).clone().multiplyScalar(0.16), [d.color]);
  return (
    <group position={[d.cx, 0, d.cz]}>
      <mesh position={[0, 0.06, 0]} scale={[d.half * 2, 0.12, d.half * 2]} raycast={() => null}>
        <boxGeometry />
        <meshStandardMaterial color="#0b0d14" metalness={0.5} roughness={0.55} envMapIntensity={0.3} />
      </mesh>
      <mesh position={[0, 0.125, 0]} rotation={[-Math.PI / 2, 0, 0]} scale={[d.half * 2.6, d.half * 2.6, 1]} raycast={() => null} renderOrder={1}>
        <planeGeometry />
        <meshBasicMaterial map={glowTexture()} color={glowColor} blending={THREE.AdditiveBlending} transparent depthWrite={false} toneMapped={false} />
      </mesh>
      <lineLoop geometry={frame} position={[0, 0.115, 0]} raycast={() => null}>
        <lineBasicMaterial color={color} transparent opacity={0.16} toneMapped={false} />
      </lineLoop>
      <lineSegments geometry={geo} position={[0, 0.12, 0]} raycast={() => null}>
        <lineBasicMaterial color={color} transparent opacity={0.85} toneMapped={false} />
      </lineSegments>
    </group>
  );
}

// ── Traffic: light streaks along the roads; density follows how busy Claude is ──
const TRAFFIC_MAX = 260;
const STREAK_GEO = new THREE.BoxGeometry(0.07, 0.04, 1);
const STREAK_MAT = new THREE.MeshBasicMaterial({ toneMapped: false });

function Traffic({ lanes, rate }: { lanes: Lane[]; rate: number }) {
  const ref = useRef<THREE.InstancedMesh>(null!);
  const rateRef = useRef(rate);
  useLayoutEffect(() => { rateRef.current = rate; }, [rate]);
  const P = useMemo(() => ({
    lane: new Int32Array(TRAFFIC_MAX), pos: new Float32Array(TRAFFIC_MAX), speed: new Float32Array(TRAFFIC_MAX),
    alive: new Uint8Array(TRAFFIC_MAX), len: new Float32Array(TRAFFIC_MAX), tint: new Float32Array(TRAFFIC_MAX),
    acc: 0, seeded: false,
  }), []);
  useLayoutEffect(() => {
    const col = new THREE.InstancedBufferAttribute(new Float32Array(TRAFFIC_MAX * 3), 3);
    col.setUsage(THREE.DynamicDrawUsage);
    ref.current.instanceColor = col;
    ref.current.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    P.alive.fill(0);
    P.seeded = false;
  }, [lanes, P]);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    if (!lanes.length) return;
    const target = Math.min(TRAFFIC_MAX, 26 + rateRef.current * 2.4);
    const spawn = (anywhere: boolean) => {
      for (let i = 0; i < TRAFFIC_MAX; i++) {
        if (P.alive[i]) continue;
        const li = Math.floor(Math.random() * lanes.length);
        const ln = lanes[li];
        P.alive[i] = 1;
        P.lane[i] = li;
        P.speed[i] = 6 + Math.random() * 8;
        P.len[i] = 0.9 + Math.random() * 1.1;
        P.tint[i] = Math.random();
        P.pos[i] = anywhere ? (Math.random() * 2 - 1) * ln.L : -ln.dir * ln.L;
        return;
      }
    };
    let alive = 0;
    for (let i = 0; i < TRAFFIC_MAX; i++) alive += P.alive[i];
    if (!P.seeded) {
      P.seeded = true;
      for (let k = alive; k < target; k++) spawn(true);
    }
    const life = (lanes[0].L * 2) / 8.5;
    P.acc += (target / life) * dt;
    while (P.acc >= 1) {
      P.acc -= 1;
      if (alive < target) { spawn(false); alive++; }
    }
    const arr = ref.current.instanceMatrix.array as Float32Array;
    const col = (ref.current.instanceColor as THREE.InstancedBufferAttribute).array as Float32Array;
    for (let i = 0; i < TRAFFIC_MAX; i++) {
      const o = i * 16;
      if (!P.alive[i]) { arr.fill(0, o, o + 16); continue; }
      const ln = lanes[P.lane[i]];
      P.pos[i] += ln.dir * P.speed[i] * dt;
      if (Math.abs(P.pos[i]) > ln.L) { P.alive[i] = 0; arr.fill(0, o, o + 16); continue; }
      const len = P.len[i];
      const x = ln.axis === 'x' ? P.pos[i] : ln.c;
      const z = ln.axis === 'x' ? ln.c : P.pos[i];
      arr.fill(0, o, o + 16);
      if (ln.axis === 'z') {
        arr[o] = 1; arr[o + 5] = 1; arr[o + 10] = len;
      } else {
        arr[o + 2] = -1; arr[o + 5] = 1; arr[o + 8] = len;
      }
      arr[o + 12] = x; arr[o + 13] = 0.07; arr[o + 14] = z; arr[o + 15] = 1;
      const tt = P.tint[i];
      const b = 1.8 + tt * 1.6;
      const j = i * 3;
      if (tt < 0.78) { col[j] = 0.75 * b; col[j + 1] = 0.85 * b; col[j + 2] = 1.0 * b; }
      else { col[j] = 0.35 * b; col[j + 1] = 0.95 * b; col[j + 2] = 1.0 * b; }
    }
    ref.current.instanceMatrix.needsUpdate = true;
    if (ref.current.instanceColor) ref.current.instanceColor.needsUpdate = true;
  });
  return <instancedMesh ref={ref} args={[STREAK_GEO, STREAK_MAT, TRAFFIC_MAX]} frustumCulled={false} raycast={() => null} />;
}

// ── Couriers: a message sent to a session flies in as a light and lands on its tower ──
const COURIER_GEO = new THREE.SphereGeometry(0.16, 10, 8);
const COURIER_MAT = new THREE.MeshBasicMaterial({ toneMapped: false });
const COURIER_MAX = 8;
const TRAIL = 16;

interface Courier { id: string; from: THREE.Vector3; ctrl: THREE.Vector3; to: THREE.Vector3; t0: number; landed: boolean }

function Couriers({ layout, byId }: { layout: CityLayout; byId: Map<string, Session> }) {
  const ref = useRef<THREE.InstancedMesh>(null!);
  const list = useRef<Courier[]>([]);
  const pending = useRef<string[]>([]);
  const ctx = useRef({ layout, byId });
  useLayoutEffect(() => { ctx.current = { layout, byId }; }, [layout, byId]);
  useLayoutEffect(() => {
    ref.current.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(COURIER_MAX * TRAIL * 3), 3);
    ref.current.count = 0;
  }, []);
  // New prompts in the feed become couriers
  useEffect(() => {
    const seen = new Set(useStore.getState().feed.slice(0, 80).map((f) => f.key));
    return useStore.subscribe((st, prev) => {
      if (st.feed === prev.feed) return;
      for (const f of st.feed.slice(0, 20)) {
        if (seen.has(f.key)) continue;
        seen.add(f.key);
        if (f.kind === 'prompt') pending.current.push(f.sessionId);
      }
    });
  }, []);
  const p = useMemo(() => ({ v: new THREE.Vector3(), m: new THREE.Matrix4(), c: new THREE.Color() }), []);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const { layout: lay, byId: map } = ctx.current;
    while (pending.current.length) {
      const id = pending.current.shift()!;
      const spot = lay.spots.get(id);
      const s = map.get(id);
      if (!spot || !s || list.current.length >= COURIER_MAX) continue;
      const to = new THREE.Vector3(spot.x, beaconTop(s), spot.z);
      const dir = new THREE.Vector3(state.camera.position.x - spot.x, 0, state.camera.position.z - spot.z).normalize();
      const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar((Math.random() - 0.5) * 30);
      const from = to.clone().addScaledVector(dir, 34).add(side).setY(to.y + 22);
      const ctrl = from.clone().lerp(to, 0.5).setY(Math.max(from.y, to.y) + 10);
      list.current.push({ id, from, ctrl, to, t0: t, landed: false });
    }
    const mesh = ref.current;
    const col = (mesh.instanceColor as THREE.InstancedBufferAttribute).array as Float32Array;
    let n = 0;
    const DUR = 1.9;
    for (let i = list.current.length - 1; i >= 0; i--) {
      const c = list.current[i];
      const age = (t - c.t0) / DUR;
      if (age >= 1 && !c.landed) { c.landed = true; towerKicks.set(c.id, t); }
      if (age > 1.35) { list.current.splice(i, 1); continue; }
      for (let k = 0; k < TRAIL; k++) {
        const u = Math.min(1, smootherstep(age - k * 0.018));
        if (age - k * 0.018 < 0) continue;
        const a = 1 - u;
        p.v.set(0, 0, 0)
          .addScaledVector(c.from, a * a)
          .addScaledVector(c.ctrl, 2 * a * u)
          .addScaledVector(c.to, u * u);
        const fadeOut = age > 1 ? Math.max(0, 1 - (age - 1) / 0.35) : 1;
        const sz = (1 - k / TRAIL) * (k === 0 ? 1.3 : 0.8) * fadeOut;
        p.m.makeScale(sz, sz, sz).setPosition(p.v);
        mesh.setMatrixAt(n, p.m);
        const b = (k === 0 ? 4 : 2.2 * (1 - k / TRAIL)) * fadeOut;
        col[n * 3] = 0.85 * b; col[n * 3 + 1] = 0.9 * b; col[n * 3 + 2] = 1.0 * b;
        n++;
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });
  return <instancedMesh ref={ref} args={[COURIER_GEO, COURIER_MAT, COURIER_MAX * TRAIL]} frustumCulled={false} raycast={() => null} />;
}

// ── Scene ──
export function CityScene({ sessions }: { sessions: Session[] }) {
  const selectedId = useStore((st) => st.selectedId);
  const [hover, setHover] = useState<string | null>(null);
  const onHover = useCallback((id: string | null) => setHover(id), []);

  const sig = sessions.map((s) => `${s.id}:${s.project}`).sort().join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layout: CityLayout = useMemo(() => buildLayout(sessions), [sig]);

  useEffect(() => {
    document.body.style.cursor = hover ? 'pointer' : '';
    return () => { document.body.style.cursor = ''; };
  }, [hover]);

  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  const rate = useMemo(() => sessions.reduce((n, s) => n + (s.live ? recentCalls(s.activity, 3) : 0), 0), [sessions]);

  const sel = selectedId ? byId.get(selectedId) : undefined;
  const selSpot = sel ? layout.spots.get(sel.id) : undefined;
  // Overview frames the whole downtown plus headroom for the tallest beacon. Bucketed so
  // a growing tower doesn't keep nudging the camera.
  const tallest = useMemo(() => sessions.reduce((m, s) => Math.max(m, towerHeight(s)), 6), [sessions]);
  const tallBucket = Math.ceil(tallest / 4) * 4;
  const overviewR = Math.min(120, Math.max(46, layout.extent * 2.3 + 22, tallBucket * 2.6 + 18));
  const overviewY = Math.max(6, tallBucket * 0.4);
  const focus: RigFocus = useMemo(() => {
    if (sel && selSpot) {
      const h = towerHeight(sel);
      return { key: `t:${sel.id}`, target: new THREE.Vector3(selSpot.x, h * 0.55 + 1, selSpot.z), radius: 17 + h * 1.4, polar: 1.14 };
    }
    return { key: `o:${Math.round(overviewR)}:${overviewY}`, target: new THREE.Vector3(layout.cx, overviewY, layout.cz), radius: overviewR, polar: 1.24 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.id, selSpot, overviewR, overviewY, layout.cx, layout.cz]);
  const limits: RigLimits = useMemo(() => ({
    minR: 9, maxR: Math.max(70, overviewR * 1.35), minPolar: 0.42, maxPolar: 1.33, drift: 0.022, bound: layout.extent + 12,
  }), [overviewR, layout.extent]);

  return (
    <>
      <CameraRig focus={focus} limits={limits} drawerOpen={!!selectedId} />
      <Sky />
      <Stars radius={300} depth={80} count={2600} factor={5} saturation={0} fade speed={0.35} />
      <hemisphereLight args={['#334066', '#05060a', 0.35]} />
      <directionalLight position={[-30, 40, 20]} intensity={0.35} color="#9fb0ff" />
      <Ground pitch={layout.pitch} />
      <Blocks blocks={layout.blocks} size={layout.inner + 0.6} />
      <Fillers fillers={layout.fillers} />
      <Lamps lamps={layout.lamps} />
      {layout.districts.map((d) => <DistrictPlate key={d.key} d={d} />)}
      <Traffic lanes={layout.lanes} rate={rate} />
      <Couriers layout={layout} byId={byId} />
      {sessions.map((s) => {
        const spot = layout.spots.get(s.id);
        if (!spot) return null;
        return <Tower key={s.id} s={s} spot={spot} hovered={hover === s.id} selected={selectedId === s.id} onHover={onHover} />;
      })}
      {layout.districts.map((d) => <DistrictLabel key={`l-${d.key}`} d={d} />)}
    </>
  );
}
