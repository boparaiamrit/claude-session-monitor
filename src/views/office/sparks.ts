// Particle pool shared by the whole office. burst() can be called from anywhere (store
// subscriptions included); <Particles> draws every live spark in one instanced call.
import * as THREE from 'three';
import { nowSec } from './anim';

export const MAX_PARTICLES = 320;

export const pool = {
  pos: new Float32Array(MAX_PARTICLES * 3),
  vel: new Float32Array(MAX_PARTICLES * 3),
  born: new Float32Array(MAX_PARTICLES).fill(-99),
  life: new Float32Array(MAX_PARTICLES).fill(1),
  size: new Float32Array(MAX_PARTICLES),
  /** Freshly spawned particles whose colour still has to be uploaded */
  pending: [] as { i: number; c: THREE.Color }[],
  next: 0,
};

/** Pop a small burst of glowing sparks at a world position */
export function burst(at: THREE.Vector3, color: THREE.Color, n = 10) {
  const now = nowSec();
  const c = color.clone().multiplyScalar(2.4);
  for (let k = 0; k < n; k++) {
    const i = pool.next;
    pool.next = (pool.next + 1) % MAX_PARTICLES;
    const a = Math.random() * Math.PI * 2;
    const sp = 0.08 + Math.random() * 0.22;
    pool.pos[i * 3] = at.x + (Math.random() - 0.5) * 0.22;
    pool.pos[i * 3 + 1] = at.y + Math.random() * 0.06;
    pool.pos[i * 3 + 2] = at.z + (Math.random() - 0.5) * 0.06;
    pool.vel[i * 3] = Math.cos(a) * sp;
    pool.vel[i * 3 + 1] = 0.45 + Math.random() * 0.55;
    pool.vel[i * 3 + 2] = Math.sin(a) * sp;
    pool.born[i] = now;
    pool.life[i] = 0.55 + Math.random() * 0.45;
    pool.size[i] = 0.011 + Math.random() * 0.01;
    pool.pending.push({ i, c });
  }
}
