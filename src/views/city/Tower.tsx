/* eslint-disable react-hooks/immutability -- R3F frame loops mutate three.js objects (materials, buffers, matrices) imperatively by design */
// One session as a tower: instanced windows that flash per tool call, a scanning
// crown while working, a status beacon on the roof and drones for sub-agents.
import { memo, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import type { Session } from '../../types';
import { useStore } from '../../lib/store';
import { STATUS, toolColor, hash01 } from '../../lib/theme';
import { Label3D } from '../../three/kit';
import { smootherstep, damp } from '../../three/motion';
import { sessionLabel, truncate } from '../../lib/format';
import { additiveMaterial, cssColor, FOG_DEPTH_VERT, FOG_FADE_FRAG, glowTexture, rand01, recentCalls, useLabelsReady } from './gfx';
import { BOX_GEO, antennaLen, beaconTop, towerHeight, towerKicks, type Spot } from './layout';

const ROW = 0.52;
const ROW0 = 0.8;
const MAX_ROWS = 46;
const MAX_DRONES = 6;

const EDGE_GEO = new THREE.EdgesGeometry(BOX_GEO);
const WIN_GEO = new THREE.PlaneGeometry(1, 1);
const DRONE_GEO = new THREE.OctahedronGeometry(0.2, 0);
const BEACON_GEO = new THREE.SphereGeometry(0.14, 16, 12);
const ANTENNA_GEO = new THREE.CylinderGeometry(0.03, 0.05, 1, 6);
ANTENNA_GEO.translate(0, 0.5, 0);
const BEAM_GEO = (() => {
  const g = new THREE.CylinderGeometry(0.1, 0.34, 1, 20, 1, true);
  g.translate(0, 0.5, 0);
  return g;
})();
const POOL_GEO = new THREE.PlaneGeometry(1, 1);
POOL_GEO.rotateX(-Math.PI / 2);

const WIN_MAT = new THREE.MeshBasicMaterial({ toneMapped: false });
const DRONE_MAT = new THREE.MeshBasicMaterial({ toneMapped: false });

// Window light, linear HDR
const DIM = new THREE.Color(0.018, 0.022, 0.034);
const LIT = new THREE.Color(0.36, 0.43, 0.64);
const LIT_WARM = new THREE.Color(0.5, 0.46, 0.4);
const ERR = new THREE.Color(STATUS.blocked.color);
const WHITE = new THREE.Color(1, 1, 1);
const BODY = new THREE.Color('#0f131c');
const BODY_IDLE = new THREE.Color('#0b0c10');

const EDGE_VERT = /* glsl */ `
  ${FOG_DEPTH_VERT}
  varying float vY;
  void main() {
    vY = position.y;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;
const EDGE_FRAG = /* glsl */ `
  ${FOG_FADE_FRAG}
  uniform vec3 uColor;
  uniform float uIntensity;
  varying float vY;
  void main() {
    float a = mix(0.06, 1.0, pow(clamp(vY, 0.0, 1.0), 1.7));
    gl_FragColor = vec4(uColor * uIntensity * a * fogFade(), 1.0);
  }
`;

const BAND_VERT = /* glsl */ `
  ${FOG_DEPTH_VERT}
  varying vec2 vUv;
  varying vec3 vN;
  void main() {
    vUv = uv;
    vN = normal;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;
const BAND_FRAG = /* glsl */ `
  ${FOG_FADE_FRAG}
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uAlpha;
  uniform float uKick;
  varying vec2 vUv;
  varying vec3 vN;
  void main() {
    if (abs(vN.y) > 0.5) discard;
    float y = clamp(vUv.y, 0.0, 1.0);
    float glow = pow(y, 2.6) * 0.5;
    float scanY = 1.0 - fract(uTime * 0.32);
    // Square by multiplying: pow() with a negative base is NaN on Direct3D, and bloom
    // spreads a single NaN pixel across the whole frame
    float dy = (y - scanY) * 16.0;
    float scan = exp(-dy * dy) * (0.9 + uKick * 1.6);
    float crown = smoothstep(0.93, 1.0, y) * 1.6;
    float base = smoothstep(0.0, 0.25, y);
    gl_FragColor = vec4(uColor * (glow + scan + crown) * base * uAlpha * fogFade(), 1.0);
  }
`;

const BEAM_VERT = /* glsl */ `
  ${FOG_DEPTH_VERT}
  varying vec2 vUv;
  varying float vFacing;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec3 n = normalize(normalMatrix * normal);
    vFacing = abs(dot(n, normalize(-mv.xyz)));
    vViewDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;
const BEAM_FRAG = /* glsl */ `
  ${FOG_FADE_FRAG}
  uniform vec3 uColor;
  uniform float uAlpha;
  uniform float uTime;
  varying vec2 vUv;
  varying float vFacing;
  void main() {
    float up = pow(clamp(1.0 - vUv.y, 0.0, 1.0), 2.2);
    // vFacing is interpolated and can dip just below 0; pow() of that is NaN on Direct3D
    float soft = pow(clamp(vFacing, 0.0, 1.0), 1.6);
    float ripple = 0.75 + 0.25 * sin(vUv.y * 40.0 - uTime * 6.0);
    gl_FragColor = vec4(uColor * up * soft * ripple * uAlpha * fogFade(), 1.0);
  }
`;

/** Dark tower glass with a Fresnel rim that brightens toward the top */
function glassMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: '#0f131c', metalness: 0.78, roughness: 0.3, envMapIntensity: 0.6 });
  const rim = { value: new THREE.Color(0.05, 0.06, 0.09) };
  m.userData.rim = rim;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uRim = rim;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vLY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLY = position.y;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vLY;\nuniform vec3 uRim;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float fres = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 2.6);
        float side = 1.0 - step(0.6, abs(dot(normal, (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz)));
        totalEmissiveRadiance += uRim * fres * side * (0.15 + 0.85 * vLY * vLY);`);
  };
  return m;
}

function windowLayout(w: number, d: number) {
  const nx = Math.max(2, Math.round((w - 0.3) / 0.36));
  const nz = Math.max(2, Math.round((d - 0.3) / 0.36));
  const perRow = 2 * nx + 2 * nz;
  const total = perRow * MAX_ROWS;
  const mats = new Float32Array(total * 16);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const faces: { n: number; len: number; rot: number; at: (u: number) => [number, number] }[] = [
    { n: nx, len: w, rot: 0, at: (u) => [u, d / 2 + 0.012] },
    { n: nx, len: w, rot: Math.PI, at: (u) => [-u, -d / 2 - 0.012] },
    { n: nz, len: d, rot: Math.PI / 2, at: (u) => [w / 2 + 0.012, -u] },
    { n: nz, len: d, rot: -Math.PI / 2, at: (u) => [-w / 2 - 0.012, u] },
  ];
  const faceStart = [0, nx, 2 * nx, 2 * nx + nz];
  let i = 0;
  for (let r = 0; r < MAX_ROWS; r++) {
    const y = ROW0 + r * ROW;
    for (const f of faces) {
      const sx = (f.len - 0.34) / f.n;
      q.setFromAxisAngle(up, f.rot);
      for (let c = 0; c < f.n; c++) {
        const u = -f.len / 2 + 0.17 + (c + 0.5) * sx;
        const [x, z] = f.at(u);
        p.set(x, y, z);
        sc.set(sx * 0.56, 0.27, 1);
        m.compose(p, q, sc);
        m.toArray(mats, i * 16);
        i++;
      }
    }
  }
  return { nx, nz, perRow, total, mats, faceStart };
}

interface Props {
  s: Session;
  spot: Spot;
  hovered: boolean;
  selected: boolean;
  onHover: (id: string | null) => void;
}

export const Tower = memo(function Tower({ s, spot, hovered, selected, onHover }: Props) {
  const win = useMemo(() => windowLayout(spot.w, spot.d), [spot.w, spot.d]);
  const seed = useMemo(() => hash01(s.id) * 1000, [s.id]);
  const rnd = useMemo(() => {
    const a = new Float32Array(win.total);
    for (let i = 0; i < win.total; i++) a[i] = rand01(i, seed);
    return a;
  }, [win.total, seed]);
  // Per window flash: r, g, b, start time
  const flash = useMemo(() => new Float32Array(win.total * 4).fill(-99), [win.total]);
  const antenna = antennaLen(s.id);

  const group = useRef<THREE.Group>(null!);
  const body = useRef<THREE.Mesh>(null!);
  const edges = useRef<THREE.LineSegments>(null!);
  const wins = useRef<THREE.InstancedMesh>(null!);
  const cap = useRef<THREE.Mesh>(null!);
  const ant = useRef<THREE.Mesh>(null!);
  const beacon = useRef<THREE.Mesh>(null!);
  const halo = useRef<THREE.Sprite>(null!);
  const band = useRef<THREE.Mesh>(null!);
  const beam = useRef<THREE.Mesh>(null!);
  const pool = useRef<THREE.Mesh>(null!);
  const drones = useRef<THREE.InstancedMesh>(null!);

  const bodyMat = useMemo(() => glassMaterial(), []);
  const capMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#0a0d14', metalness: 0.6, roughness: 0.45, envMapIntensity: 0.4 }), []);
  const edgeMat = useMemo(() => additiveMaterial({
    vertex: EDGE_VERT, fragment: EDGE_FRAG,
    uniforms: { uColor: { value: new THREE.Color() }, uIntensity: { value: 0.5 } },
  }), []);
  const bandMat = useMemo(() => additiveMaterial({
    vertex: BAND_VERT, fragment: BAND_FRAG,
    uniforms: { uColor: { value: cssColor(STATUS.working.color).clone().multiplyScalar(1.6) }, uTime: { value: 0 }, uAlpha: { value: 0 }, uKick: { value: 0 } },
  }), []);
  const beamMat = useMemo(() => additiveMaterial({
    vertex: BEAM_VERT, fragment: BEAM_FRAG,
    uniforms: { uColor: { value: cssColor(STATUS.blocked.color).clone().multiplyScalar(1.4) }, uAlpha: { value: 0 }, uTime: { value: 0 } },
  }), []);
  const beaconMat = useMemo(() => new THREE.MeshBasicMaterial({ toneMapped: false }), []);
  const haloMat = useMemo(() => new THREE.SpriteMaterial({ map: glowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false, opacity: 0 }), []);
  const poolMat = useMemo(() => new THREE.MeshBasicMaterial({ map: glowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false, opacity: 0 }), []);

  useLayoutEffect(() => {
    const mesh = wins.current;
    mesh.instanceMatrix.array.set(win.mats);
    mesh.instanceMatrix.needsUpdate = true;
    const col = new THREE.InstancedBufferAttribute(new Float32Array(win.total * 3), 3);
    col.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = col;
    mesh.count = 0;
    const dm = drones.current;
    dm.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DRONES * 3), 3);
    dm.count = 0;
  }, [win]);

  useLayoutEffect(() => () => {
    [bodyMat, capMat, edgeMat, bandMat, beamMat, beaconMat, haloMat, poolMat].forEach((m) => m.dispose());
  }, [bodyMat, capMat, edgeMat, bandMat, beamMat, beaconMat, haloMat, poolMat]);

  const live = useRef({
    h: 0.01, born: -1, risen: false, lit: 0, pulseTs: -1, errId: '' as string, kick: 0, arrived: -99,
    edge: new THREE.Color(), beaconC: new THREE.Color(),
    drones: new Map<string, { a: number; phase: number; color: THREE.Color }>(),
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

    // Rise from the ground on first appearance, staggered from the center out
    if (L.born < 0) {
      L.born = t + (t < 1.5 ? 0.35 + spot.order * 0.075 : 0);
      group.current.position.set(spot.x, 0, spot.z);
    }
    // When the layout changes (scope, search), glide to the new lot instead of jumping
    const gp = group.current.position;
    const k = damp(3.2, dt);
    gp.x += (spot.x - gp.x) * k;
    gp.z += (spot.z - gp.z) * k;
    const goalH = towerHeight(s);
    const rise = smootherstep((t - L.born) / 1.2);
    if (rise < 1) L.h = Math.max(0.01, goalH * rise);
    else if (!L.risen) { L.risen = true; L.h = goalH; }
    else L.h += (goalH - L.h) * damp(1.5, dt);
    const h = L.h;
    const w = spot.w;
    const d = spot.d;

    body.current.scale.set(w, h, d);
    edges.current.scale.set(w * 1.003, h * 1.002, d * 1.003);
    cap.current.position.y = h;
    cap.current.scale.set(w * 0.62, 0.34, d * 0.62);
    const roof = h + 0.34;
    ant.current.position.y = roof;
    ant.current.scale.set(1, antenna, 1);
    const top = roof + antenna + 0.1;
    beacon.current.position.y = top;
    halo.current.position.y = top;
    beam.current.position.y = top;

    // Status lighting
    const pulse = 0.5 + 0.5 * Math.sin(t * 5.2);
    const breathe = 0.5 + 0.5 * Math.sin(t * 1.4 + seed);
    const stCol = cssColor(STATUS[status].color);
    let bI = 0.12, hO = 0, hS = 1.8, eI = 0.16;
    if (status === 'working') { bI = 2.6 + 0.4 * Math.sin(t * 9 + seed); hO = 0.55; hS = 2.2; eI = 0.55; }
    else if (status === 'blocked') { bI = 1.6 + 3.2 * pulse; hO = 0.35 + 0.55 * pulse; hS = 2.2 + 2.2 * pulse; eI = 0.55 + 0.6 * pulse; }
    else if (status === 'waiting') { bI = 1.1 + 0.5 * breathe; hO = 0.3 + 0.15 * breathe; hS = 1.9; eI = 0.32; }
    L.beaconC.copy(idle ? cssColor('#3a3f4b') : stCol).multiplyScalar(bI);
    beaconMat.color.copy(L.beaconC);
    haloMat.color.copy(stCol);
    haloMat.opacity = hO;
    halo.current.scale.setScalar(hS);

    // Edges: status tint, white when selected, brighter on hover
    L.edge.copy(stCol);
    if (selected) L.edge.lerp(WHITE, 0.55);
    const eGoal = (selected ? 1.6 : hovered ? Math.max(1.1, eI * 1.8) : eI) * (idle && !selected && !hovered ? 0.6 : 1);
    edgeMat.uniforms.uIntensity.value += (eGoal - edgeMat.uniforms.uIntensity.value) * damp(10, dt);
    edgeMat.uniforms.uColor.value.copy(L.edge);
    bodyMat.emissive.setRGB(0, 0, 0);
    bodyMat.color.copy(idle ? BODY_IDLE : BODY);
    const rimC = (bodyMat.userData.rim as { value: THREE.Color }).value;
    rimC.copy(idle ? BODY_IDLE : stCol).multiplyScalar(idle ? 0.6 : selected || hovered ? 0.3 : 0.2);

    // Working crown: steady glow band near the top with a scan line
    const working = status === 'working';
    const bandH = Math.max(1.6, h * 0.24);
    band.current.visible = working || bandMat.uniforms.uAlpha.value > 0.01;
    band.current.position.y = h - bandH;
    band.current.scale.set(w * 1.035, bandH, d * 1.035);
    bandMat.uniforms.uAlpha.value += ((working ? 1 : 0) * rise - bandMat.uniforms.uAlpha.value) * damp(4, dt);
    bandMat.uniforms.uTime.value = t + seed;
    L.kick *= Math.exp(-dt * 3);
    bandMat.uniforms.uKick.value = L.kick;

    // Blocked: a light beam straight up
    const blocked = status === 'blocked';
    beamMat.uniforms.uAlpha.value += ((blocked ? 0.5 + 0.4 * pulse : 0) - beamMat.uniforms.uAlpha.value) * damp(6, dt);
    beamMat.uniforms.uTime.value = t;
    beam.current.visible = beamMat.uniforms.uAlpha.value > 0.01;
    beam.current.scale.set(1, 70, 1);

    // Light pool at the base for focus
    const pGoal = selected ? 0.7 : hovered ? 0.4 : blocked ? 0.22 + 0.2 * pulse : 0;
    poolMat.opacity += (pGoal - poolMat.opacity) * damp(8, dt);
    poolMat.color.copy(selected ? WHITE : stCol);
    pool.current.visible = poolMat.opacity > 0.01;
    const ps = Math.max(w, d) * 3.4;
    pool.current.scale.set(ps, 1, ps);

    // Windows: lit share follows the last ten minutes of tool calls
    const recent = recentCalls(s.activity, 10);
    const litGoal = idle ? 0.012 : (0.07 + 0.36 * (1 - Math.exp(-recent / 90))) * (status === 'waiting' ? 0.75 : 1);
    L.lit += (litGoal - L.lit) * damp(1.2, dt);

    // A new tool call lights a run of windows in the tool's color
    const pz = useStore.getState().pulses[s.id];
    const rows = Math.max(0, Math.min(MAX_ROWS, Math.floor((h - ROW0 - 0.3) / ROW) + 1));
    if (pz && pz.ts !== L.pulseTs) {
      const first = L.pulseTs < 0;
      L.pulseTs = pz.ts;
      if (!first && rows > 0) {
        const c = cssColor(toolColor(pz.tool));
        const face = Math.floor(Math.random() * 4);
        const faceN = face < 2 ? win.nx : win.nz;
        const row = Math.max(0, rows - 1 - Math.floor(Math.random() * Math.max(1, rows * 0.7)));
        const run = Math.min(faceN, 2 + Math.floor(Math.random() * 3));
        const c0 = Math.floor(Math.random() * (faceN - run + 1));
        const light = (idx: number) => {
          const o = idx * 4;
          flash[o] = c.r; flash[o + 1] = c.g; flash[o + 2] = c.b; flash[o + 3] = t;
        };
        for (let k = 0; k < run; k++) light(row * win.perRow + win.faceStart[face] + c0 + k);
        for (let k = 0; k < 4; k++) light(Math.floor(Math.random() * rows * win.perRow));
        L.kick = 1;
      }
    }
    // A message courier landed: flare the beacon and light a burst of windows
    const kickAt = towerKicks.get(s.id);
    if (kickAt !== undefined && kickAt !== L.arrived) {
      L.arrived = kickAt;
      L.kick = 1.6;
      if (rows > 0) {
        for (let k = 0; k < 10; k++) {
          const o = Math.floor(Math.random() * rows * win.perRow) * 4;
          flash[o] = 0.9; flash[o + 1] = 0.95; flash[o + 2] = 1; flash[o + 3] = t;
        }
      }
    }
    const arrive = Math.max(0, 1 - (t - L.arrived) / 1.2);
    if (arrive > 0) {
      beaconMat.color.addScalar(arrive * 3);
      haloMat.opacity = Math.min(1, haloMat.opacity + arrive * 0.6);
      halo.current.scale.setScalar(hS + arrive * 3);
    }
    // A failed tool call flickers red
    const lastTool = s.tools[s.tools.length - 1];
    if (lastTool && lastTool.ok === false && lastTool.id !== L.errId) {
      const seen = L.errId !== '';
      L.errId = lastTool.id;
      if (seen && rows > 0) {
        for (let k = 0; k < 6; k++) {
          const o = Math.floor(Math.random() * rows * win.perRow) * 4;
          flash[o] = ERR.r; flash[o + 1] = ERR.g; flash[o + 2] = ERR.b; flash[o + 3] = t;
        }
      }
    } else if (!L.errId) L.errId = lastTool?.id ?? 'none';

    const mesh = wins.current;
    const n = rows * win.perRow;
    mesh.count = n;
    const arr = (mesh.instanceColor as THREE.InstancedBufferAttribute).array as Float32Array;
    const lit = L.lit;
    const drift = t * 0.004;
    const warmShare = 0.18;
    for (let i = 0; i < n; i++) {
      const r = rnd[i];
      let v = r + drift * (0.3 + r);
      v -= Math.floor(v);
      // Each lit window has its own brightness so the facade reads organic, not a grid
      const on = Math.min(1, Math.max(0, (lit - v) * 30 + 0.5)) * (0.35 + ((r * 91) % 1) * 0.75);
      const warm = (r * 37) % 1 < warmShare;
      const lr = warm ? LIT_WARM.r : LIT.r, lg = warm ? LIT_WARM.g : LIT.g, lb = warm ? LIT_WARM.b : LIT.b;
      let cr = DIM.r + (lr - DIM.r) * on;
      let cg = DIM.g + (lg - DIM.g) * on;
      let cb = DIM.b + (lb - DIM.b) * on;
      const o = i * 4;
      const age = t - flash[o + 3];
      if (age < 3.2) {
        const k = age < 0.08 ? (age / 0.08) * 3.4 : 3.4 * Math.exp(-(age - 0.08) * 1.25);
        cr += flash[o] * k; cg += flash[o + 1] * k; cb += flash[o + 2] * k;
      }
      const j = i * 3;
      arr[j] = cr; arr[j + 1] = cg; arr[j + 2] = cb;
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    // Drones: one per working sub-agent, fading in and out
    const dm = drones.current;
    const dArr = (dm.instanceColor as THREE.InstancedBufferAttribute).array as Float32Array;
    const agents = s.agents.length > 10 ? s.agents.slice(-10) : s.agents;
    for (const a of agents) {
      let dr = L.drones.get(a.id);
      if (!dr && a.status === 'working') {
        dr = { a: 0, phase: hash01(a.id) * Math.PI * 2, color: new THREE.Color() };
        L.drones.set(a.id, dr);
      }
      if (!dr) continue;
      const goal = a.status === 'working' && !idle ? 1 : 0;
      dr.a += (goal - dr.a) * damp(goal ? 3 : 1.6, dt);
      dr.color.copy(cssColor(toolColor(a.currentTool?.name ?? 'Agent'))).lerp(WHITE, 0.45);
    }
    let di = 0;
    const R0 = Math.max(w, d) * 0.5 + 0.85;
    for (const [id, dr] of L.drones) {
      if (dr.a < 0.01 && !agents.some((a) => a.id === id && a.status === 'working')) {
        L.drones.delete(id);
        continue;
      }
      if (di >= MAX_DRONES) continue;
      const ang = dr.phase + t * (0.55 + (dr.phase % 1) * 0.3);
      const rad = R0 + (di % 3) * 0.32;
      const y = h * 0.62 + Math.sin(t * 1.3 + dr.phase * 3) * 0.35 + di * 0.4;
      const sc = dr.a * (1 + 0.15 * Math.sin(t * 6 + dr.phase));
      tmpM.makeRotationY(t * 2 + dr.phase);
      tmpM.scale(tmpV.setScalar(sc));
      tmpM.setPosition(Math.cos(ang) * rad, y, Math.sin(ang) * rad);
      dm.setMatrixAt(di, tmpM);
      tmpC.copy(dr.color).multiplyScalar(4 * dr.a);
      dArr[di * 3] = tmpC.r; dArr[di * 3 + 1] = tmpC.g; dArr[di * 3 + 2] = tmpC.b;
      di++;
    }
    dm.count = di;
    dm.instanceMatrix.needsUpdate = true;
    if (dm.instanceColor) dm.instanceColor.needsUpdate = true;
  });

  const over = (e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); onHover(s.id); };
  const out = () => onHover(null);
  const click = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.delta > 6) return;
    useStore.getState().select(s.id);
  };

  return (
    <group ref={group}>
      <mesh ref={body} geometry={BOX_GEO} material={bodyMat} onPointerOver={over} onPointerOut={out} onClick={click} />
      <lineSegments ref={edges} geometry={EDGE_GEO} material={edgeMat} raycast={() => null} />
      <instancedMesh ref={wins} args={[WIN_GEO, WIN_MAT, win.total]} frustumCulled={false} raycast={() => null} />
      <mesh ref={cap} geometry={BOX_GEO} material={capMat} raycast={() => null} />
      <mesh ref={ant} geometry={ANTENNA_GEO} material={capMat} raycast={() => null} />
      <mesh ref={beacon} geometry={BEACON_GEO} material={beaconMat} raycast={() => null} />
      <sprite ref={halo} material={haloMat} raycast={() => null} />
      <mesh ref={band} geometry={BOX_GEO} material={bandMat} raycast={() => null} visible={false} />
      <mesh ref={beam} geometry={BEAM_GEO} material={beamMat} raycast={() => null} visible={false} />
      <mesh ref={pool} geometry={POOL_GEO} material={poolMat} position={[0, 0.03, 0]} raycast={() => null} visible={false} />
      <instancedMesh ref={drones} args={[DRONE_GEO, DRONE_MAT, MAX_DRONES]} frustumCulled={false} raycast={() => null} />
      <TowerLabel s={s} hovered={hovered} selected={selected} />
    </group>
  );
});

/**
 * One label per tower that lives as long as the tower and only switches content:
 * "Needs you" when blocked, title and status on hover or selection, else nothing.
 * Mounting and unmounting drei Html roots on every hover races in React 19.
 */
function TowerLabel({ s, hovered, selected }: { s: Session; hovered: boolean; selected: boolean }) {
  const ready = useLabelsReady();
  const blocked = s.status === 'blocked';
  if (!ready) return null;
  const showTip = hovered || selected;
  const mode = blocked ? 'needs' : showTip ? 'tip' : 'off';
  const st = STATUS[s.status];
  return (
    <Label3D
      position={[0, beaconTop(s) + (blocked ? 2.6 : 1.5), 0]}
      className={`city-label is-${mode}`}
      onClick={blocked ? () => useStore.getState().select(s.id) : undefined}
    >
      {blocked ? (
        <span className="city-needs-pill">
          <span className="status-dot" />
          {st.label}
          {showTip ? <span className="city-needs-title">{truncate(sessionLabel(s), 40)}</span> : null}
        </span>
      ) : showTip ? (
        <div className="city-tip-card">
          <span className="city-tip-title">{truncate(sessionLabel(s), 46)}</span>
          <span className={`city-tip-status st-${s.status}`}>
            <span className="status-dot" />
            {st.label}
            {s.currentTool && s.status === 'working' ? <span className="city-tip-tool">· {s.currentTool.name}</span> : null}
          </span>
        </div>
      ) : null}
    </Label3D>
  );
}
