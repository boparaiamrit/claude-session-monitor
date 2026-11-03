/* eslint-disable react-hooks/immutability -- R3F frame loops mutate three.js objects (materials, buffers, matrices) imperatively by design */
// Cinematic orbit camera: slow drift that never stops, drag to orbit, wheel to zoom,
// eased framing when the focus changes, and a projection shift so the focused thing
// sits in the free space left of the session drawer.
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { damp, smootherstep } from '../../three/motion';

export interface RigFocus {
  /** A new key starts an eased transition to this focus */
  key: string;
  target: THREE.Vector3;
  radius: number;
  polar: number;
  /** Live target for moving things (a planet); falls back to `target` */
  follow?: () => THREE.Vector3 | null;
}

export interface RigLimits {
  minR: number;
  maxR: number;
  minPolar: number;
  maxPolar: number;
  /** Idle orbit speed in radians per second */
  drift: number;
  /** Keep the target inside this radius on the ground plane */
  bound: number;
}

function drawerWidth(): number {
  try {
    const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--drawer-w'));
    return (Number.isFinite(v) ? v : 460) + 12;
  } catch {
    return 472;
  }
}

export function CameraRig({ focus, limits, drawerOpen, duration = 1.4, startAzimuth = 0.7 }:
  { focus: RigFocus; limits: RigLimits; drawerOpen: boolean; duration?: number; startAzimuth?: number }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const gl = useThree((s) => s.gl);
  const size = useThree((s) => s.size);
  const st = useRef({
    target: focus.target.clone(),
    radius: focus.radius * 1.5,
    polar: Math.max(limits.minPolar, focus.polar - 0.18),
    az: startAzimuth - 0.5,
    goalR: focus.radius,
    goalP: focus.polar,
    from: focus.target.clone(),
    rFrom: focus.radius * 1.5,
    pFrom: Math.max(limits.minPolar, focus.polar - 0.18),
    k: 0,
    t0: -1,
    pending: true,
    dragging: false,
    lastX: 0,
    lastY: 0,
    lastT: 0,
    vAz: 0,
    offset: 0,
    drawerW: drawerWidth(),
  });
  const focusRef = useRef(focus);
  const limitsRef = useRef(limits);
  useLayoutEffect(() => {
    focusRef.current = focus;
    limitsRef.current = limits;
  }, [focus, limits]);

  // A new focus key starts an eased transition from wherever the camera is now
  const firstKey = useRef(true);
  useEffect(() => {
    const s = st.current;
    if (firstKey.current) {
      firstKey.current = false;
      return;
    }
    s.from.copy(s.target);
    s.rFrom = s.radius;
    s.pFrom = s.polar;
    s.goalR = focus.radius;
    s.goalP = focus.polar;
    s.pending = true;
  }, [focus.key, focus.radius, focus.polar]);

  // Pointer drag and wheel on the canvas
  useEffect(() => {
    const el = gl.domElement;
    const s = st.current;
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      s.dragging = true;
      s.lastX = e.clientX;
      s.lastY = e.clientY;
      s.lastT = e.timeStamp;
      s.vAz = 0;
    };
    const move = (e: PointerEvent) => {
      if (!s.dragging) return;
      const L = limitsRef.current;
      const dx = e.clientX - s.lastX;
      const dy = e.clientY - s.lastY;
      const dts = Math.max(0.008, (e.timeStamp - s.lastT) / 1000);
      s.az -= dx * 0.0052;
      s.goalP = THREE.MathUtils.clamp(s.goalP - dy * 0.004, L.minPolar, L.maxPolar);
      s.vAz = THREE.MathUtils.clamp((-dx * 0.0052) / dts, -2.5, 2.5);
      s.lastX = e.clientX;
      s.lastY = e.clientY;
      s.lastT = e.timeStamp;
    };
    const up = () => {
      s.dragging = false;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const L = limitsRef.current;
      s.goalR = THREE.MathUtils.clamp(s.goalR * Math.exp(e.deltaY * 0.0011), L.minR, L.maxR);
    };
    el.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    el.addEventListener('wheel', wheel, { passive: false });
    el.style.touchAction = 'none';
    return () => {
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      el.removeEventListener('wheel', wheel);
    };
  }, [gl]);

  const tmp = useRef(new THREE.Vector3());
  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const s = st.current;
    const f = focusRef.current;
    const L = limitsRef.current;
    const t = state.clock.elapsedTime;
    const live = (f.follow && f.follow()) || f.target;

    if (s.pending) {
      s.pending = false;
      s.t0 = t;
      s.k = 0;
    }
    // Orbit drift never stops; drag inertia rides on top of it
    if (!s.dragging) {
      s.az += s.vAz * dt;
      s.vAz *= Math.exp(-dt * 2.6);
    }
    s.az += L.drift * dt;

    if (s.t0 >= 0) {
      const k = smootherstep((t - s.t0) / duration);
      // A small sweep sideways during the move reads as a camera crane, not a jump
      s.az += (k - s.k) * 0.35;
      s.k = k;
      s.target.lerpVectors(s.from, live, k);
      s.radius = THREE.MathUtils.lerp(s.rFrom, s.goalR, k);
      s.polar = THREE.MathUtils.lerp(s.pFrom, s.goalP, k);
      if (k >= 1) s.t0 = -1;
    } else {
      s.target.lerp(live, damp(6, dt));
      s.radius += (s.goalR - s.radius) * damp(5, dt);
      s.polar += (s.goalP - s.polar) * damp(5, dt);
    }
    const flat = Math.hypot(s.target.x, s.target.z);
    if (flat > L.bound) {
      s.target.x *= L.bound / flat;
      s.target.z *= L.bound / flat;
    }
    s.polar = THREE.MathUtils.clamp(s.polar, L.minPolar, L.maxPolar);
    // Very slow breathing on the elevation keeps the shot alive when nothing happens
    const breathe = Math.sin(t * 0.11) * 0.025;
    const p = s.polar + breathe;
    const sp = Math.sin(p);
    const pos = tmp.current.set(
      s.target.x + s.radius * sp * Math.sin(s.az),
      s.target.y + s.radius * Math.cos(p),
      s.target.z + s.radius * sp * Math.cos(s.az),
    );
    camera.position.copy(pos);
    camera.lookAt(s.target);

    // Shift the projection so the focus sits in the space left of the drawer
    const goalOff = drawerOpen && size.width > 900 ? s.drawerW : 0;
    s.offset += (goalOff - s.offset) * damp(4.5, dt);
    if (Math.abs(s.offset) < 0.5 && goalOff === 0) {
      if (camera.view?.enabled) {
        camera.clearViewOffset();
      }
      s.offset = 0;
      camera.aspect = size.width / size.height;
    } else {
      const fullW = size.width + s.offset;
      camera.aspect = fullW / size.height;
      camera.setViewOffset(fullW, size.height, s.offset, 0, size.width, size.height);
    }
    camera.updateProjectionMatrix();
  });

  return null;
}
