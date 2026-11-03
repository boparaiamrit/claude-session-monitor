/* eslint-disable react-hooks/immutability -- R3F frame loops mutate three.js objects (materials, buffers, matrices) imperatively by design */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Stars } from '@react-three/drei';
import * as THREE from 'three';
import type { Session } from '../../types';
import { useStore } from '../../lib/store';
import { hash01 } from '../../lib/theme';
import { Label3D } from '../../three/kit';
import { damp } from '../../three/motion';
import { CameraRig, type RigFocus, type RigLimits } from '../city/rig';
import { cssColor, glowTexture, useLabelsReady } from '../city/gfx';
import { buildGalaxy, planetSize, type GalaxyLayout, type System } from './layout';
import { Planet, type Bodies } from './Planet';
import { Comets } from './Comets';
import { NEBULA_FRAG, NEBULA_VERT, POINTS_FRAG, POINTS_VERT, STAR_FRAG, STAR_VERT } from './shaders';

// ── Nebula: faint colored clouds on a sphere that rides with the camera ──
function Nebula() {
  const ref = useRef<THREE.Mesh>(null!);
  const mat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: NEBULA_VERT, fragmentShader: NEBULA_FRAG, side: THREE.BackSide, depthWrite: false,
    uniforms: {
      uA: { value: new THREE.Color('#2a1c5c') },
      uB: { value: new THREE.Color('#0f4a5c') },
      uC: { value: new THREE.Color('#5a1f4a') },
    },
  }), []);
  useFrame(({ camera }) => ref.current.position.copy(camera.position));
  return (
    <mesh ref={ref} material={mat} renderOrder={-10} frustumCulled={false} raycast={() => null}>
      <sphereGeometry args={[800, 48, 24]} />
    </mesh>
  );
}

// ── Dust: a slow spiral disc of faint motes that makes the space feel like a galaxy ──
function Dust({ center, extent, colors }: { center: THREE.Vector3; extent: number; colors: string[] }) {
  const ref = useRef<THREE.Points>(null!);
  const size = useThree((s) => s.size);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const colorKey = colors.join(',');
  const { geo, mat } = useMemo(() => {
    const N = 2000;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const sz = new Float32Array(N);
    const al = new Float32Array(N);
    const R = extent * 1.9 + 24;
    const palette = [new THREE.Color('#9fb2ff'), new THREE.Color('#c9b8ff'), new THREE.Color('#7fd6e8'), ...colors.map((c) => cssColor(c))];
    let seed = 1;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const gauss = () => (rnd() + rnd() + rnd() - 1.5) / 1.5;
    for (let i = 0; i < N; i++) {
      const arm = i % 3;
      const r = R * Math.pow(rnd(), 0.75) + 3;
      const a = arm * ((Math.PI * 2) / 3) + r * 0.075 + gauss() * (0.35 + 6 / r);
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = gauss() * (1.6 + r * 0.03) - 4;
      pos[i * 3 + 2] = Math.sin(a) * r;
      const c = palette[Math.floor(rnd() * palette.length)];
      const k = 0.2 + rnd() * 0.4;
      col[i * 3] = c.r * k; col[i * 3 + 1] = c.g * k; col[i * 3 + 2] = c.b * k;
      sz[i] = 0.1 + rnd() * rnd() * 0.4;
      al[i] = 0.2 + rnd() * 0.5;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(sz, 1));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(al, 1));
    const m = new THREE.ShaderMaterial({
      vertexShader: POINTS_VERT, fragmentShader: POINTS_FRAG, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, uniforms: { uScale: { value: 500 } }, toneMapped: false,
    });
    return { geo: g, mat: m };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extent, colorKey]);
  useEffect(() => () => { geo.dispose(); mat.dispose(); }, [geo, mat]);
  useFrame((_, dt) => {
    ref.current.rotation.y += Math.min(dt, 0.05) * 0.006;
    mat.uniforms.uScale.value = size.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  });
  return <points ref={ref} geometry={geo} material={mat} position={[center.x, 0, center.z]} frustumCulled={false} raycast={() => null} />;
}

// ── A project's star: boiling core plus two layers of corona ──
const STAR_GEO = new THREE.SphereGeometry(1, 48, 32);

function Star({ sys, busy }: { sys: System; busy: number }) {
  const core = useRef<THREE.Mesh>(null!);
  const inner = useRef<THREE.Sprite>(null!);
  const outer = useRef<THREE.Sprite>(null!);
  const color = useMemo(() => cssColor(sys.color), [sys.color]);
  const mat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: STAR_VERT, fragmentShader: STAR_FRAG, toneMapped: false,
    uniforms: { uColor: { value: color.clone() }, uTime: { value: 0 }, uHeat: { value: 1 } },
  }), [color]);
  const innerMat = useMemo(() => new THREE.SpriteMaterial({ map: glowTexture(), color: color.clone().multiplyScalar(1.15), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false, opacity: 0.9 }), [color]);
  const outerMat = useMemo(() => new THREE.SpriteMaterial({ map: glowTexture(), color: color.clone().multiplyScalar(0.9), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false, opacity: 0.2 }), [color]);
  useEffect(() => () => { mat.dispose(); innerMat.dispose(); outerMat.dispose(); }, [mat, innerMat, outerMat]);
  const born = useRef(-1);
  const seed = useMemo(() => hash01(sys.key) * 100, [sys.key]);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (born.current < 0) born.current = t + (t < 1.5 ? 0.2 : 0);
    const k = Math.min(1, Math.max(0, (t - born.current) / 1.2));
    const grow = 1 - Math.pow(1 - k, 3);
    mat.uniforms.uTime.value = t + seed;
    // A star burns a little hotter while its sessions are busy
    mat.uniforms.uHeat.value = 0.85 + 0.35 * busy + 0.05 * Math.sin(t * 1.3 + seed);
    core.current.scale.setScalar(sys.starR * grow);
    inner.current.scale.setScalar(sys.starR * (5.2 + 0.25 * Math.sin(t * 0.9 + seed)) * grow);
    outer.current.scale.setScalar(sys.starR * 14 * grow);
    innerMat.opacity = 0.75 + 0.15 * busy;
  });
  return (
    <group>
      <mesh ref={core} geometry={STAR_GEO} material={mat} raycast={() => null} />
      <sprite ref={inner} material={innerMat} raycast={() => null} />
      <sprite ref={outer} material={outerMat} raycast={() => null} />
    </group>
  );
}

/** A star system that glides to its new place when the layout changes */
function SystemNode({ sys, live, children }: { sys: System; live: THREE.Vector3; children: ReactNode }) {
  const ref = useRef<THREE.Group>(null!);
  const placed = useRef(false);
  useFrame((_, dt) => {
    const g = ref.current;
    if (!placed.current) { g.position.copy(sys.pos); placed.current = true; }
    else g.position.lerp(sys.pos, damp(2.6, Math.min(dt, 0.05)));
    live.copy(g.position);
  });
  return <group ref={ref}>{children}</group>;
}

// ── Scene ──
export function GalaxyScene({ sessions }: { sessions: Session[] }) {
  const selectedId = useStore((st) => st.selectedId);
  const [hover, setHover] = useState<string | null>(null);
  const onHover = useCallback((id: string | null) => setHover(id), []);
  const bodies = useMemo<Bodies>(() => new Map(), []);
  const labelsReady = useLabelsReady();
  // Live star positions (they glide on layout changes); planets light themselves from these
  const stars = useMemo(() => new Map<string, THREE.Vector3>(), []);
  const liveStar = (sys: System) => {
    let v = stars.get(sys.key);
    if (!v) { v = sys.pos.clone(); stars.set(sys.key, v); }
    return v;
  };

  const sig = sessions.map((s) => `${s.id}:${s.project}`).sort().join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layout: GalaxyLayout = useMemo(() => buildGalaxy(sessions), [sig]);

  // Forget bodies of sessions that left
  useEffect(() => {
    for (const id of [...bodies.keys()]) if (!layout.bySession.has(id)) bodies.delete(id);
  }, [layout, bodies]);

  useEffect(() => {
    document.body.style.cursor = hover ? 'pointer' : '';
    return () => { document.body.style.cursor = ''; };
  }, [hover]);

  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  const busyBySystem = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sessions) if (s.status === 'working') m.set(s.project, Math.min(1, (m.get(s.project) ?? 0) + 0.5));
    return m;
  }, [sessions]);

  const sel = selectedId ? byId.get(selectedId) : undefined;
  const selPlaced = sel ? layout.bySession.get(sel.id) : undefined;
  const overviewR = Math.min(150, Math.max(34, layout.extent * 1.6 + 12));
  const focus: RigFocus = useMemo(() => {
    if (sel && selPlaced) {
      const id = sel.id;
      const sz = planetSize(sel);
      return {
        key: `p:${id}`, target: selPlaced.system.pos.clone(), radius: 7 + sz * 9, polar: 1.12,
        follow: () => bodies.get(id)?.pos ?? null,
      };
    }
    return { key: `o:${Math.round(overviewR)}`, target: layout.center.clone(), radius: overviewR, polar: 1.08 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.id, selPlaced, overviewR, layout.center]);
  const limits: RigLimits = useMemo(() => ({
    minR: 4, maxR: Math.max(80, overviewR * 1.5), minPolar: 0.2, maxPolar: 1.45, drift: 0.018, bound: layout.extent + 20,
  }), [overviewR, layout.extent]);

  const colors = useMemo(() => layout.systems.map((s) => s.color), [layout]);

  return (
    <>
      <CameraRig focus={focus} limits={limits} drawerOpen={!!selectedId} startAzimuth={0.5} />
      <Nebula />
      <Stars radius={320} depth={140} count={5000} factor={5} saturation={0.4} fade speed={0.5} />
      <Dust center={layout.center} extent={layout.extent} colors={colors} />
      {layout.systems.map((sys) => {
        const live = liveStar(sys);
        return (
          <SystemNode key={sys.key} sys={sys} live={live}>
            <Star sys={sys} busy={busyBySystem.get(sys.key) ?? 0} />
            <group rotation={sys.tilt}>
              {sys.orbits.map((o) => {
                const s = byId.get(o.id);
                return s ? (
                  <Planet key={o.id} s={s} system={sys} star={live} orbit={o} bodies={bodies}
                    hovered={hover === o.id} selected={selectedId === o.id} onHover={onHover} />
                ) : null;
              })}
            </group>
            {labelsReady && (
              <Label3D position={[0, -sys.starR - 1.3, 0]} className={`galaxy-star${sel ? ' is-dim' : ''}`}>
                <span className="galaxy-star-name" style={{ color: sys.color }}>{sys.name}</span>
                <span className="galaxy-star-count">{sys.orbits.length} {sys.orbits.length === 1 ? 'session' : 'sessions'}</span>
              </Label3D>
            )}
          </SystemNode>
        );
      })}
      <Comets bodies={bodies} />
    </>
  );
}
