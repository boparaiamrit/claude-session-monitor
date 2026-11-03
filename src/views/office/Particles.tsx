// Draws the shared particle pool (sparks.ts) in a single instanced call.
import { useLayoutEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { GEO, MAT } from './assets';
import { nowSec } from './anim';
import { MAX_PARTICLES as MAX, pool } from './sparks';

const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const p = new THREE.Vector3();
const s = new THREE.Vector3();
const e = new THREE.Euler();
const zero = new THREE.Matrix4().makeScale(0, 0, 0);

export function Particles() {
  const ref = useRef<THREE.InstancedMesh>(null);
  const alive = useRef(new Uint8Array(MAX));

  useLayoutEffect(() => {
    const m = ref.current!;
    const black = new THREE.Color(0, 0, 0);
    for (let i = 0; i < MAX; i++) {
      m.setMatrixAt(i, zero);
      m.setColorAt(i, black);
    }
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, []);

  useFrame(() => {
    const m = ref.current;
    if (!m) return;
    const live = alive.current;
    const now = nowSec();
    let dirty = false;
    if (pool.pending.length) {
      for (const { i, c } of pool.pending) {
        m.setColorAt(i, c);
        live[i] = 1;
      }
      pool.pending.length = 0;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    for (let i = 0; i < MAX; i++) {
      if (!live[i]) continue;
      dirty = true;
      const t = now - pool.born[i];
      if (t > pool.life[i] || t < 0) {
        live[i] = 0;
        m.setMatrixAt(i, zero);
        continue;
      }
      const u = t / pool.life[i];
      const v = pool.vel;
      const o = pool.pos;
      p.set(o[i * 3] + v[i * 3] * t, o[i * 3 + 1] + v[i * 3 + 1] * t - 0.9 * t * t, o[i * 3 + 2] + v[i * 3 + 2] * t);
      s.setScalar(pool.size[i] * (1 - u * u) * (u < 0.1 ? u * 10 : 1));
      q.setFromEuler(e.set(t * 5 + i, t * 7, 0));
      m.setMatrixAt(i, m4.compose(p, q, s));
    }
    if (dirty) m.instanceMatrix.needsUpdate = true;
  });

  return <instancedMesh ref={ref} args={[GEO.octa, MAT.particle, MAX]} frustumCulled={false} />;
}
