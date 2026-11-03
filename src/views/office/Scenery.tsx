// The night floor: polished slab floor that fades into fog, soft pools from the corridor
// ceiling lights, a cool moonlight key with a tight shadow frustum around the rooms, a warm rim
// and a dim sky/ground fill.
import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { GEO, MAT, TEX, glowMat } from './assets';
import { hash01 } from '../../lib/theme';
import type { Bounds } from './model';

const BG = '#07080b';
const FLOOR = 360;
const POOL_STEP = 3.1;

/** Ceiling-light pools on the corridor floor, one instanced draw call */
function LightPools({ bounds }: { bounds: Bounds }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const mat = useMemo(() => glowMat(new THREE.Color('#ffffff')), []);
  // Snapped to a world grid so pools stay put as rooms come and go; jittered so they never read as a pattern
  const spots = useMemo(() => {
    const out: [number, number, number, number][] = [];
    const i0 = Math.floor((bounds.minX - 7) / POOL_STEP);
    const i1 = Math.ceil((bounds.maxX + 7) / POOL_STEP);
    const j0 = Math.floor((bounds.minZ - 7) / POOL_STEP);
    const j1 = Math.ceil((bounds.maxZ + 7) / POOL_STEP);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const h1 = hash01(`p${i},${j}`);
        const h2 = hash01(`q${i},${j}`);
        const h3 = hash01(`r${i},${j}`);
        out.push([(i + 0.5 + (h1 - 0.5) * 0.5) * POOL_STEP, (j + 0.5 + (h2 - 0.5) * 0.5) * POOL_STEP, 3.4 + h3 * 2.2, 0.02 + h1 * h2 * 0.06]);
      }
    }
    return out;
  }, [bounds]);
  useLayoutEffect(() => {
    const m = ref.current!;
    const o = new THREE.Object3D();
    const c = new THREE.Color();
    const tint = new THREE.Color('#aebdff');
    spots.forEach(([x, z, s, k], i) => {
      o.position.set(x, 0.004, z);
      o.rotation.set(-Math.PI / 2, 0, 0);
      o.scale.set(s, s, 1);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
      m.setColorAt(i, c.copy(tint).multiplyScalar(k));
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [spots]);
  return <instancedMesh key={spots.length} ref={ref} args={[GEO.plane, mat, spots.length]} frustumCulled={false} renderOrder={-1} />;
}

export function Scenery({ bounds }: { bounds: Bounds }) {
  const key = useRef<THREE.DirectionalLight>(null);
  const fog = useRef<THREE.Fog>(null);
  const target = useMemo(() => new THREE.Object3D(), []);
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;

  useLayoutEffect(() => {
    TEX.floor.repeat.set(FLOOR / 2.5, FLOOR / 2.5);
    const l = key.current;
    if (!l) return;
    const span = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 2 + 2.5;
    l.position.set(cx - 9, 16, cz + 6);
    target.position.set(cx, 0, cz);
    target.updateMatrixWorld();
    l.target = target;
    const cam = l.shadow.camera;
    cam.left = -span;
    cam.right = span;
    cam.top = span;
    cam.bottom = -span;
    cam.near = 2;
    cam.far = 50;
    cam.updateProjectionMatrix();
    l.shadow.needsUpdate = true;
  }, [bounds, cx, cz, target]);

  // Keep the fog relative to the framing so near rooms stay crisp and the floor edge never shows
  useFrame(({ camera }) => {
    const f = fog.current;
    if (!f) return;
    const dist = Math.hypot(camera.position.x - cx, camera.position.y, camera.position.z - cz);
    f.near = dist * 0.9 + 3;
    f.far = dist * 2.3 + 20;
  });

  return (
    <>
      <fog ref={fog} attach="fog" args={[BG, 30, 90]} />
      <hemisphereLight args={['#8fa2d8', '#1c140d', 0.36]} />
      <directionalLight
        ref={key}
        castShadow
        intensity={1.75}
        color="#dfe6ff"
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
      />
      <directionalLight position={[cx + 12, 7, cz - 10]} intensity={0.7} color="#ffb27a" />
      <directionalLight position={[cx + 6, 9, cz + 14]} intensity={0.2} color="#8fa6ff" />
      <mesh rotation-x={-Math.PI / 2} material={MAT.floor} receiveShadow>
        <planeGeometry args={[FLOOR, FLOOR]} />
      </mesh>
      <LightPools bounds={bounds} />
    </>
  );
}
