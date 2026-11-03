/* eslint-disable react-hooks/immutability -- R3F frame loops mutate three.js objects (materials, buffers, matrices) imperatively by design */
// Tool calls as comets: each new tool call launches a streak from its planet in the
// tool's color that arcs outward and fades. Failed calls throw a red spark burst.
// One pooled point cloud for everything, updated in place every frame.
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../../lib/store';
import { STATUS, toolColor } from '../../lib/theme';
import { cssColor } from '../city/gfx';
import { POINTS_FRAG, POINTS_VERT } from './shaders';
import type { Bodies } from './Planet';

const MAX = 2400;
const UP = new THREE.Vector3(0, 1, 0);

interface Comet {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  axis: THREE.Vector3;
  curl: number;
  color: THREE.Color;
  life: number;
  max: number;
  carry: number;
}

export function Comets({ bodies }: { bodies: Bodies }) {
  const size = useThree((s) => s.size);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const { geo, mat, P } = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(MAX * 3);
    const col = new Float32Array(MAX * 3);
    const sz = new Float32Array(MAX);
    const al = new Float32Array(MAX);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(sz, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(al, 1).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.ShaderMaterial({
      vertexShader: POINTS_VERT, fragmentShader: POINTS_FRAG, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, uniforms: { uScale: { value: 500 } }, toneMapped: false,
    });
    return {
      geo: g, mat: m,
      P: {
        pos, col, sz, al,
        vel: new Float32Array(MAX * 3), life: new Float32Array(MAX), max: new Float32Array(MAX).fill(1),
        size0: new Float32Array(MAX), next: 0,
      },
    };
  }, []);
  useEffect(() => () => { geo.dispose(); mat.dispose(); }, [geo, mat]);

  const comets = useRef<Comet[]>([]);
  const seen = useRef(new Map<string, number>());
  const errSeen = useRef(new Map<string, string>());
  const tmp = useMemo(() => ({ dir: new THREE.Vector3(), perp: new THREE.Vector3(), step: new THREE.Vector3() }), []);

  const emit = (x: number, y: number, z: number, vx: number, vy: number, vz: number, c: THREE.Color, k: number, life: number, s: number) => {
    const i = P.next;
    P.next = (P.next + 1) % MAX;
    P.pos[i * 3] = x; P.pos[i * 3 + 1] = y; P.pos[i * 3 + 2] = z;
    P.vel[i * 3] = vx; P.vel[i * 3 + 1] = vy; P.vel[i * 3 + 2] = vz;
    P.col[i * 3] = c.r * k; P.col[i * 3 + 1] = c.g * k; P.col[i * 3 + 2] = c.b * k;
    P.life[i] = life; P.max[i] = life; P.size0[i] = s;
  };

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    mat.uniforms.uScale.value = size.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    const st = useStore.getState();

    for (const [id, b] of bodies) {
      const p = st.pulses[id];
      const last = seen.current.get(id);
      if (p) {
        if (last === undefined) seen.current.set(id, p.ts);
        else if (p.ts !== last) {
          seen.current.set(id, p.ts);
          if (comets.current.length < 60) {
            const dir = tmp.dir.subVectors(b.pos, b.star).normalize();
            const perp = tmp.perp.crossVectors(dir, UP).normalize();
            const side = Math.random() < 0.5 ? -1 : 1;
            const vel = dir.clone().multiplyScalar(3.6 + Math.random() * 2)
              .addScaledVector(perp, side * (0.8 + Math.random() * 1.2))
              .addScaledVector(UP, (Math.random() - 0.35) * 1.6);
            comets.current.push({
              pos: b.pos.clone().addScaledVector(dir, b.size * 1.1), vel,
              axis: UP.clone(), curl: side * (0.9 + Math.random() * 0.8),
              color: cssColor(toolColor(p.tool)), life: 1.8, max: 1.8, carry: 0,
            });
          }
        }
      }
      const s = st.sessions[id];
      const lt = s?.tools[s.tools.length - 1];
      const prevErr = errSeen.current.get(id);
      if (lt && lt.ok === false && prevErr !== lt.id) {
        if (prevErr !== undefined) {
          const red = cssColor(STATUS.blocked.color);
          for (let k = 0; k < 18; k++) {
            const v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(2.5 + Math.random() * 2.5);
            emit(b.pos.x, b.pos.y, b.pos.z, v.x, v.y, v.z, red, 3.2, 0.5 + Math.random() * 0.4, 0.16);
          }
        }
        errSeen.current.set(id, lt.id);
      } else if (prevErr === undefined) errSeen.current.set(id, lt?.id ?? '');
    }

    // Advance comets and lay down their trails
    const list = comets.current;
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i];
      c.life -= dt;
      if (c.life <= 0) { list.splice(i, 1); continue; }
      c.vel.applyAxisAngle(c.axis, c.curl * dt);
      c.vel.multiplyScalar(Math.exp(-dt * 0.5));
      const step = tmp.step.copy(c.vel).multiplyScalar(dt);
      const fade = c.life / c.max;
      c.carry += dt * 90;
      const n = Math.floor(c.carry);
      c.carry -= n;
      for (let k = 0; k < n; k++) {
        const f = (k + 1) / n;
        emit(c.pos.x + step.x * f, c.pos.y + step.y * f, c.pos.z + step.z * f,
          (Math.random() - 0.5) * 0.15, (Math.random() - 0.5) * 0.15, (Math.random() - 0.5) * 0.15,
          c.color, 2.4 * fade, 0.7, 0.2 * (0.5 + fade * 0.6));
      }
      c.pos.add(step);
      // Bright head
      emit(c.pos.x, c.pos.y, c.pos.z, 0, 0, 0, c.color, 4 * fade + 0.8, 0.06, 0.4 * (0.6 + 0.4 * fade));
    }

    // Age every particle
    for (let i = 0; i < MAX; i++) {
      if (P.life[i] <= 0) { P.al[i] = 0; continue; }
      P.life[i] -= dt;
      const f = Math.max(0, P.life[i] / P.max[i]);
      P.pos[i * 3] += P.vel[i * 3] * dt;
      P.pos[i * 3 + 1] += P.vel[i * 3 + 1] * dt;
      P.pos[i * 3 + 2] += P.vel[i * 3 + 2] * dt;
      P.vel[i * 3] *= 0.97; P.vel[i * 3 + 1] *= 0.97; P.vel[i * 3 + 2] *= 0.97;
      P.al[i] = f * f;
      P.sz[i] = P.size0[i] * (0.4 + 0.6 * f);
    }
    (geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (geo.attributes.aColor as THREE.BufferAttribute).needsUpdate = true;
    (geo.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
    (geo.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
  });

  return <points geometry={geo} material={mat} frustumCulled={false} raycast={() => null} />;
}
