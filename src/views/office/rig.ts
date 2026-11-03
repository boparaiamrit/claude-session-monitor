// Joint rig for the chibi characters. Pose functions write target angles; Rig.apply() damps the
// current pose toward them, so every transition (sit → stand, type → wave) blends on its own.
// Conventions: the character faces +z, its left is +x. rotation.x > 0 swings a limb backward
// and tilts the torso forward; shoulder rotation.z > 0 lifts the left arm outward.
import type * as THREE from 'three';
import { damp } from '../../three/motion';

export interface Pose {
  hipsY: number;
  torsoX: number;
  torsoY: number;
  torsoZ: number;
  headX: number;
  headY: number;
  headZ: number;
  shLX: number;
  shLZ: number;
  shRX: number;
  shRZ: number;
  elL: number;
  elR: number;
  hipL: number;
  hipR: number;
  knL: number;
  knR: number;
}

export const SIT_Y = 0.195;
export const STAND_Y = 0.265;
const THIGH = 1.38;
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

const blank = (): Pose => ({
  hipsY: SIT_Y, torsoX: 0, torsoY: 0, torsoZ: 0, headX: 0, headY: 0, headZ: 0,
  shLX: -0.3, shLZ: 0.1, shRX: -0.3, shRZ: -0.1, elL: -0.9, elR: -0.9,
  hipL: -THIGH, hipR: -THIGH, knL: THIGH, knR: THIGH,
});
const KEYS = Object.keys(blank()) as (keyof Pose)[];

function sitLegs(p: Pose) {
  p.hipsY = SIT_Y;
  p.hipL = p.hipR = -THIGH;
  p.knL = p.knR = THIGH;
}

function standLegs(p: Pose) {
  p.hipsY = STAND_Y;
  p.hipL = p.hipR = 0;
  p.knL = p.knR = 0;
}

/** Breathing sway: body ±1.1° over 1.7 s, head ±1.7° over 2.3 s */
function sway(p: Pose, t: number, ph: number) {
  p.torsoZ = Math.sin((t / 1.7) * TAU + ph) * 1.1 * DEG;
  p.headZ = Math.sin((t / 2.3) * TAU + ph * 1.3) * 1.7 * DEG;
}

/** Seated at the keyboard, forearms tapping out of phase */
export function poseTyping(p: Pose, t: number, ph: number) {
  sitLegs(p);
  sway(p, t, ph);
  p.torsoX = 0.1 + Math.sin(t * 1.3 + ph) * 0.015;
  p.torsoY = Math.sin(t * 0.37 + ph) * 0.05;
  p.headX = 0.05 + Math.sin(t * 0.9 + ph) * 0.03;
  p.headY = Math.sin(t * 0.31 + ph * 2) * 0.14;
  const f = 19;
  const a = t * f + ph;
  p.shLX = -0.52 + Math.sin(a) * 0.05;
  p.shRX = -0.52 + Math.sin(a + 1.9) * 0.05;
  p.shLZ = 0.1;
  p.shRZ = -0.1;
  p.elL = -1.32 + Math.sin(a) * 0.26;
  p.elR = -1.32 + Math.sin(a * 1.07 + 1.9) * 0.26;
}

/** Smooth 0→1→0 bump for `dur` seconds once every `period` seconds */
function every(t: number, period: number, dur: number, ph: number) {
  const c = (((t + ph * period) % period) + period) % period;
  if (c > dur) return 0;
  const s = Math.sin((c / dur) * Math.PI);
  return s * s;
}

/**
 * Leaning back with the turn done: arms resting, head wandering, and every few seconds a big
 * two-armed stretch. (Chibi arms are too short to reach behind that head, so no hands-behind-head.)
 */
export function poseLean(p: Pose, t: number, ph: number) {
  sitLegs(p);
  sway(p, t, ph);
  p.hipL = p.hipR = -THIGH + 0.18;
  p.knL = p.knR = THIGH - 0.45;
  const st = every(t, 8.5, 2.2, ph / TAU);
  p.torsoX = -0.24 + Math.sin(t * 1.4 + ph) * 0.014 - st * 0.08;
  p.torsoY = 0;
  p.headX = -0.14 - st * 0.12;
  p.headY = Math.sin(t * 0.45 + ph) * 0.28 * (1 - st);
  // resting: elbows out on the armrests, forearms across the lap
  p.shLX = p.shRX = 0.1 * (1 - st) + 0.15 * st;
  p.shLZ = 0.3 + st * 2.2;
  p.shRZ = -(0.3 + st * 2.2);
  p.elL = p.elR = -1.05 * (1 - st) - 0.25 * st;
}

/** Standing, one arm up and out (clear of the big head), waving for attention */
export function poseRaise(p: Pose, t: number, ph: number) {
  standLegs(p);
  p.hipsY += Math.abs(Math.sin(t * 3.4 + ph)) * 0.012;
  p.torsoX = -0.05;
  p.torsoY = 0;
  p.torsoZ = -0.06 + Math.sin(t * 3.4 + ph) * 0.03;
  p.headX = -0.14;
  p.headY = 0;
  p.headZ = 0.05 + Math.sin(t * 3.4 + ph + 0.5) * 0.05;
  p.shRX = 0.28;
  p.shRZ = -2.5 + Math.sin(t * 7) * 0.22;
  p.elR = -0.45 + Math.sin(t * 7 + 0.7) * 0.35;
  p.shLX = 0.05;
  p.shLZ = 0.12;
  p.elL = -0.22;
}

/** Walk cycle: step = sin(t·8), thigh ±15°, shin max(0, step)·18°, bobbing body */
export function poseWalk(p: Pose, t: number, ph: number) {
  const a = t * 8 + ph;
  const s = Math.sin(a);
  p.hipsY = STAND_Y + Math.abs(Math.cos(a)) * 0.014 - 0.006;
  p.hipL = s * 15 * DEG;
  p.hipR = -s * 15 * DEG;
  p.knL = Math.max(0, s) * 18 * DEG;
  p.knR = Math.max(0, -s) * 18 * DEG;
  p.torsoX = 0.07;
  p.torsoY = s * 0.06;
  p.torsoZ = Math.cos(a) * 0.02;
  p.headX = -0.02;
  p.headY = -s * 0.05;
  p.headZ = 0;
  p.shLX = -s * 0.45;
  p.shRX = s * 0.45;
  p.shLZ = 0.1;
  p.shRZ = -0.1;
  p.elL = -0.3;
  p.elR = -0.3;
}

/** Standing still */
export function poseStand(p: Pose, t: number, ph: number) {
  standLegs(p);
  sway(p, t, ph);
  p.torsoX = 0;
  p.torsoY = 0;
  p.headX = -0.05;
  p.headY = Math.sin(t * 0.5 + ph) * 0.15;
  p.shLX = p.shRX = 0.03;
  p.shLZ = 0.1;
  p.shRZ = -0.1;
  p.elL = p.elR = -0.15;
}

type Obj = THREE.Object3D | null;
export type Joint = 'root' | 'hips' | 'torso' | 'head' | 'shL' | 'shR' | 'elL' | 'elR' | 'hipL' | 'hipR' | 'knL' | 'knR' | 'eyeL' | 'eyeR';

export class Rig {
  root: Obj = null;
  hips: Obj = null;
  torso: Obj = null;
  head: Obj = null;
  shL: Obj = null;
  shR: Obj = null;
  elL: Obj = null;
  elR: Obj = null;
  hipL: Obj = null;
  hipR: Obj = null;
  knL: Obj = null;
  knR: Obj = null;
  eyes: Obj[] = [null, null];
  cur = blank();
  tgt = blank();
  /** Per-character phase so a room never moves in lockstep */
  readonly phase: number;
  private blinkPeriod: number;

  private binders = new Map<string, (o: Obj) => void>();

  constructor(seed: number) {
    this.phase = seed * TAU;
    this.blinkPeriod = 3.2 + seed * 0.7;
  }

  /** Stable ref callback that attaches a scene object to a joint */
  bind(joint: Joint): (o: Obj) => void {
    let fn = this.binders.get(joint);
    if (!fn) {
      fn = (o: Obj) => {
        if (joint === 'eyeL') this.eyes[0] = o;
        else if (joint === 'eyeR') this.eyes[1] = o;
        else this[joint] = o;
      };
      this.binders.set(joint, fn);
    }
    return fn;
  }

  /** Jump straight to the target pose (first frame) */
  snap() {
    Object.assign(this.cur, this.tgt);
  }

  apply(dt: number, lambda = 12) {
    const k = damp(lambda, dt);
    const c = this.cur;
    const g = this.tgt;
    for (const key of KEYS) c[key] += (g[key] - c[key]) * k;
    if (!this.hips || !this.torso || !this.head) return;
    this.hips.position.y = c.hipsY;
    this.torso.rotation.set(c.torsoX, c.torsoY, c.torsoZ);
    this.head.rotation.set(c.headX, c.headY, c.headZ);
    this.shL?.rotation.set(c.shLX, 0, c.shLZ);
    this.shR?.rotation.set(c.shRX, 0, c.shRZ);
    if (this.elL) this.elL.rotation.x = c.elL;
    if (this.elR) this.elR.rotation.x = c.elR;
    if (this.hipL) this.hipL.rotation.x = c.hipL;
    if (this.hipR) this.hipR.rotation.x = c.hipR;
    if (this.knL) this.knL.rotation.x = c.knL;
    if (this.knR) this.knR.rotation.x = c.knR;
  }

  /** Blink every ~3.5 s for 0.13 s */
  blink(t: number) {
    const local = (t + this.phase) % this.blinkPeriod;
    const v = local < 0.13 ? 0.12 : 1;
    for (const e of this.eyes) if (e) e.scale.y = v;
  }
}
