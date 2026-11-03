// Shared geometry, materials and procedural textures for the office. Built once and reused by
// every room, desk and character: static furniture is baked into one vertex-coloured mesh per
// piece, so a desk costs a handful of draw calls instead of thirty.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { hash01 } from '../../lib/theme';

export type V3 = [number, number, number];
const TAU = Math.PI * 2;

// ───────────── colour helpers ─────────────

/** Parses hex, names and the `hsl(204 70% 62%)` strings projectColor() returns */
export function cssColor(c: string): THREE.Color {
  const m = /hsla?\(\s*(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/.exec(c);
  if (m) return new THREE.Color().setHSL((((+m[1] % 360) + 360) % 360) / 360, +m[2] / 100, +m[3] / 100, THREE.SRGBColorSpace);
  return new THREE.Color(c);
}

/** sRGB hex for CSS custom properties */
export const cssHex = (c: string) => '#' + cssColor(c).getHexString(THREE.SRGBColorSpace);

/** Colour pushed past 1.0 so it blooms on a toneMapped:false material */
export const hot = (c: string | THREE.Color, k: number) => (typeof c === 'string' ? cssColor(c) : c.clone()).multiplyScalar(k);

const lazy = <T,>(make: () => T) => {
  let v: T | undefined;
  return () => (v ??= make());
};

// ───────────── procedural textures ─────────────

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function seeded(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export const TEX = {
  /** Soft radial falloff, for light pools and glows */
  glow: canvasTexture(128, 128, (g) => {
    const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    r.addColorStop(0, 'rgba(255,255,255,1)');
    r.addColorStop(0.22, 'rgba(255,255,255,0.62)');
    r.addColorStop(0.55, 'rgba(255,255,255,0.16)');
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, 128, 128);
  }),
  /** Rounded-rect floor halo: crisp rim with a soft bloom, for hover and selection */
  halo: canvasTexture(256, 256, (g) => {
    g.fillStyle = 'rgba(255,255,255,0.07)';
    g.beginPath();
    g.roundRect(40, 40, 176, 176, 40);
    g.fill();
    g.shadowColor = 'rgba(255,255,255,1)';
    g.shadowBlur = 26;
    g.strokeStyle = 'rgba(255,255,255,0.95)';
    g.lineWidth = 4;
    g.beginPath();
    g.roundRect(40, 40, 176, 176, 40);
    g.stroke();
    g.stroke();
  }),
  /** Rug: rounded rectangle with an inlaid border, tinted per room */
  rug: canvasTexture(256, 256, (g) => {
    g.fillStyle = '#d6d6d6';
    g.beginPath();
    g.roundRect(6, 6, 244, 244, 22);
    g.fill();
    g.strokeStyle = '#ffffff';
    g.lineWidth = 5;
    g.beginPath();
    g.roundRect(20, 20, 216, 216, 14);
    g.stroke();
    g.strokeStyle = '#a8a8a8';
    g.lineWidth = 2;
    g.beginPath();
    g.roundRect(30, 30, 196, 196, 10);
    g.stroke();
  }),
  /** Glowing ring for the "needs you" floor pulse */
  ring: canvasTexture(128, 128, (g) => {
    g.shadowColor = 'rgba(255,255,255,1)';
    g.shadowBlur = 14;
    g.strokeStyle = 'rgba(255,255,255,1)';
    g.lineWidth = 5;
    g.beginPath();
    g.arc(64, 64, 46, 0, TAU);
    g.stroke();
  }),
  /** Grayscale code editor, tinted per screen by the material colour. Tiles vertically for scrolling. */
  code: (() => {
    const rnd = seeded(7);
    const t = canvasTexture(256, 512, (g) => {
      g.fillStyle = '#1a1f2b';
      g.fillRect(0, 0, 256, 512);
      let y = 8;
      let indent = 0;
      while (y < 500) {
        if (rnd() < 0.13) {
          y += 12;
          indent = Math.max(0, Math.min(4, indent + (rnd() < 0.5 ? -1 : 1)));
          continue;
        }
        let x = 14 + indent * 16;
        const n = 1 + Math.floor(rnd() * 4);
        for (let k = 0; k < n; k++) {
          const len = 10 + rnd() * 52;
          if (x + len > 244) break;
          const v = rnd();
          g.fillStyle = v < 0.18 ? '#ffffff' : v < 0.55 ? '#b7bcc8' : '#737a8a';
          g.beginPath();
          g.roundRect(x, y, len, 5, 2.5);
          g.fill();
          x += len + 6;
        }
        y += 12;
        if (rnd() < 0.2) indent = Math.max(0, Math.min(4, indent + (rnd() < 0.55 ? 1 : -1)));
      }
      // gutter
      g.fillStyle = 'rgba(255,255,255,0.08)';
      g.fillRect(0, 0, 8, 512);
    });
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  })(),
  /** Corridor floor: large polished slabs with faint seams and speckle */
  floor: (() => {
    const rnd = seeded(31);
    const t = canvasTexture(512, 512, (g) => {
      const grad = g.createLinearGradient(0, 0, 512, 512);
      grad.addColorStop(0, '#191c23');
      grad.addColorStop(1, '#15181e');
      g.fillStyle = grad;
      g.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 3200; i++) {
        const v = rnd();
        g.fillStyle = v < 0.5 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.14)';
        g.fillRect(rnd() * 512, rnd() * 512, 1.5, 1.5);
      }
      g.fillStyle = 'rgba(0,0,0,0.7)';
      g.fillRect(0, 0, 512, 3);
      g.fillRect(0, 0, 3, 512);
      g.fillStyle = 'rgba(255,255,255,0.05)';
      g.fillRect(0, 3, 512, 1);
      g.fillRect(3, 0, 1, 512);
    });
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  })(),
};

// ───────────── shared primitive geometry ─────────────

export const GEO = {
  sphere: new THREE.SphereGeometry(1, 32, 20),
  sphereLo: new THREE.SphereGeometry(1, 14, 10),
  dome: new THREE.SphereGeometry(1, 24, 10, 0, TAU, 0, Math.PI / 2),
  plane: new THREE.PlaneGeometry(1, 1),
  box: new THREE.BoxGeometry(1, 1, 1),
  tile: new THREE.BoxGeometry(0.484, 0.05, 0.484),
  octa: new THREE.OctahedronGeometry(1, 0),
  ring: new THREE.TorusGeometry(1, 0.06, 8, 48),
  bang: new THREE.CapsuleGeometry(0.022, 0.07, 6, 12),
};

// ───────────── baking ─────────────

export interface Piece {
  g: THREE.BufferGeometry;
  c: string | THREE.Color;
  p?: V3;
  r?: V3;
  s?: V3 | number;
  q?: THREE.Quaternion;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Merge transformed, vertex-coloured pieces into one geometry */
export function bake(pieces: Piece[]): THREE.BufferGeometry {
  const parts = pieces.map(({ g, c, p = [0, 0, 0], r, s = 1, q }) => {
    const out = g.index ? g.toNonIndexed() : g.clone();
    for (const name of Object.keys(out.attributes)) if (name !== 'position' && name !== 'normal') out.deleteAttribute(name);
    if (q) _q.copy(q);
    else _q.setFromEuler(_e.set(r?.[0] ?? 0, r?.[1] ?? 0, r?.[2] ?? 0));
    if (typeof s === 'number') _s.setScalar(s);
    else _s.set(s[0], s[1], s[2]);
    out.applyMatrix4(_m.compose(_p.set(p[0], p[1], p[2]), _q, _s));
    const col = typeof c === 'string' ? cssColor(c) : c;
    const n = out.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      arr[i * 3] = col.r;
      arr[i * 3 + 1] = col.g;
      arr[i * 3 + 2] = col.b;
    }
    out.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return out;
  });
  const merged = mergeGeometries(parts, false)!;
  merged.computeBoundingSphere();
  return merged;
}

const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const rbox = (w: number, h: number, d: number, r: number) => new RoundedBoxGeometry(w, h, d, 2, r);
const cyl = (rt: number, rb: number, h: number, seg = 18) => new THREE.CylinderGeometry(rt, rb, h, seg);
const sph = (r: number, ws = 14, hs = 10) => new THREE.SphereGeometry(r, ws, hs);
const capsule = (r: number, len: number) => new THREE.CapsuleGeometry(r, len, 6, 14);
const UP = new THREE.Vector3(0, 1, 0);

/** Cylinder between two points */
function rod(a: V3, b: V3, r: number, c: string): Piece {
  const va = new THREE.Vector3(...a);
  const vb = new THREE.Vector3(...b);
  const dir = vb.clone().sub(va);
  const len = dir.length();
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize());
  const mid = va.add(vb).multiplyScalar(0.5);
  return { g: cyl(r, r, len, 8), c, p: [mid.x, mid.y, mid.z], q };
}

// ───────────── palette ─────────────

export const PAL = {
  wood: '#b48a62',
  metal: '#15171c',
  graphite: '#262a31',
  bezel: '#121419',
  plastic: '#cfd2d8',
  keys: '#7f8590',
  fabric: '#2b303b',
  fabric2: '#353c4b',
  pot: '#d8d1c4',
  soil: '#3a2a1e',
  leaf: '#3c8656',
  leaf2: '#5aa66f',
  rail: '#b9c2d0',
  base: '#1a1d24',
};

const MUGS = ['#ece7dd', '#4f7cff', '#34b38a', '#e0b94f', '#e35d6a'];

// ───────────── furniture ─────────────

/** Desk surface sits at y = 0.30; the occupant faces -z, the screen faces +z */
export const DESK_TOP = 0.3;

const deskCache = new Map<number, THREE.BufferGeometry>();
/** Wood, keyboard and desk clutter. `variant` picks the mug colour and prop. */
export function deskGeo(variant: number): THREE.BufferGeometry {
  const v = variant % (MUGS.length * 3);
  let g = deskCache.get(v);
  if (g) return g;
  const mug = MUGS[v % MUGS.length];
  const prop = Math.floor(v / MUGS.length) % 3;
  const parts: Piece[] = [
    { g: rbox(0.8, 0.03, 0.48, 0.008), c: PAL.wood, p: [0, 0.285, 0] },
    { g: rbox(0.29, 0.012, 0.085, 0.004), c: PAL.plastic, p: [0, 0.306, 0.165] },
    { g: box(0.268, 0.004, 0.066), c: PAL.keys, p: [0, 0.3125, 0.167] },
    { g: rbox(0.034, 0.016, 0.054, 0.007), c: PAL.plastic, p: [0.215, 0.308, 0.17] },
    { g: box(0.12, 0.003, 0.1), c: '#23262e', p: [0.215, 0.3015, 0.165] },
    { g: cyl(0.024, 0.021, 0.055), c: mug, p: [-0.3, 0.3275, 0.07] },
    { g: new THREE.TorusGeometry(0.014, 0.004, 6, 12), c: mug, p: [-0.277, 0.33, 0.07] },
    { g: cyl(0.02, 0.02, 0.002), c: '#3b2416', p: [-0.3, 0.354, 0.07] },
  ];
  if (prop === 0) {
    parts.push(
      { g: cyl(0.032, 0.025, 0.05), c: PAL.pot, p: [-0.31, 0.325, -0.15] },
      { g: new THREE.IcosahedronGeometry(0.045, 0), c: PAL.leaf, p: [-0.31, 0.375, -0.15], s: [1, 1.1, 1] },
      { g: new THREE.IcosahedronGeometry(0.03, 0), c: PAL.leaf2, p: [-0.29, 0.41, -0.135] },
    );
  } else if (prop === 1) {
    parts.push(
      { g: box(0.12, 0.022, 0.16), c: '#3d5a99', p: [-0.3, 0.311, -0.12], r: [0, 0.1, 0] },
      { g: box(0.11, 0.02, 0.15), c: '#b8553f', p: [-0.3, 0.332, -0.12], r: [0, -0.08, 0] },
      { g: box(0.1, 0.018, 0.14), c: '#e6dccb', p: [-0.3, 0.351, -0.12], r: [0, 0.2, 0] },
    );
  } else {
    parts.push(
      { g: box(0.13, 0.006, 0.17), c: '#ece6da', p: [-0.27, 0.303, -0.09], r: [0, 0.25, 0] },
      { g: box(0.13, 0.002, 0.004), c: '#9aa0ab', p: [-0.27, 0.3065, -0.12], r: [0, 0.25, 0] },
      { g: box(0.11, 0.002, 0.004), c: '#9aa0ab', p: [-0.27, 0.3065, -0.1], r: [0, 0.25, 0] },
      rod([-0.2, 0.306, -0.04], [-0.17, 0.306, -0.15], 0.005, '#2b5fd9'),
    );
  }
  g = bake(parts);
  deskCache.set(v, g);
  return g;
}

/** Desk frame, monitor body and lamp stem (the shiny parts) */
export const deskMetalGeo = lazy(() =>
  bake([
    { g: box(0.024, 0.272, 0.44), c: PAL.metal, p: [0.384, 0.136, 0] },
    { g: box(0.024, 0.272, 0.44), c: PAL.metal, p: [-0.384, 0.136, 0] },
    { g: box(0.75, 0.12, 0.012), c: PAL.metal, p: [0, 0.2, -0.2] },
    { g: rbox(0.13, 0.01, 0.085, 0.004), c: PAL.graphite, p: [0, 0.305, -0.135] },
    { g: box(0.03, 0.09, 0.012), c: PAL.graphite, p: [0, 0.35, -0.148] },
    { g: rbox(0.36, 0.22, 0.018, 0.006), c: PAL.bezel, p: [0, 0.48, -0.13] },
    { g: cyl(0.032, 0.038, 0.012), c: PAL.metal, p: [0.31, 0.306, -0.15] },
    rod([0.31, 0.31, -0.15], [0.31, 0.43, -0.15], 0.006, PAL.metal),
  ]),
);

/** Office chair. Faces +z like a character; the back rest sits at -z. Seat top at 0.16. */
export const chairGeo = lazy(() => {
  const parts: Piece[] = [
    { g: rbox(0.27, 0.045, 0.25, 0.016), c: PAL.fabric, p: [0, 0.1375, 0] },
    { g: rbox(0.25, 0.21, 0.034, 0.014), c: PAL.fabric, p: [0, 0.3, -0.14], r: [-0.1, 0, 0] },
    { g: box(0.03, 0.13, 0.018), c: PAL.metal, p: [0, 0.18, -0.13] },
    { g: cyl(0.014, 0.014, 0.1), c: PAL.metal, p: [0, 0.07, 0] },
  ];
  for (let i = 0; i < 5; i++) {
    const a = (i * TAU) / 5 + 0.3;
    parts.push(
      { g: box(0.13, 0.012, 0.022), c: PAL.metal, p: [Math.cos(a) * 0.06, 0.026, -Math.sin(a) * 0.06], r: [0, a, 0] },
      { g: sph(0.013, 8, 6), c: PAL.metal, p: [Math.cos(a) * 0.122, 0.013, -Math.sin(a) * 0.122] },
    );
  }
  return bake(parts);
});

/** Backless stool for sub-agents (built at full size, drawn at agent scale) */
export const stoolGeo = lazy(() =>
  bake([
    { g: cyl(0.11, 0.1, 0.035, 20), c: PAL.fabric2, p: [0, 0.1425, 0] },
    { g: cyl(0.014, 0.014, 0.12), c: PAL.metal, p: [0, 0.075, 0] },
    { g: cyl(0.085, 0.095, 0.014, 20), c: PAL.metal, p: [0, 0.007, 0] },
  ]),
);

/** Hot desk with a laptop for sub-agents. Screen plane is added separately. */
export const LAPTOP_SCREEN = { p: [0, 0.3915, 0.0264] as V3, rx: -0.22, s: [0.226, 0.142, 1] as V3 };
export const stationGeo = lazy(() => {
  const parts: Piece[] = [
    { g: rbox(0.62, 0.03, 0.42, 0.008), c: PAL.wood, p: [0, 0.285, 0] },
    { g: rbox(0.25, 0.012, 0.165, 0.005), c: '#b6bbc5', p: [0, 0.306, 0.12] },
    { g: box(0.21, 0.003, 0.08), c: '#6d727c', p: [0, 0.3125, 0.13] },
    { g: rbox(0.25, 0.165, 0.008, 0.004), c: '#b6bbc5', p: [0, 0.3905, 0.022], r: [-0.22, 0, 0] },
  ];
  for (const x of [-0.28, 0.28]) for (const z of [-0.18, 0.18]) parts.push({ g: cyl(0.012, 0.012, 0.272, 10), c: PAL.metal, p: [x, 0.136, z] });
  return bake(parts);
});

/** Floor plant in a ceramic pot (flat shaded) */
export const plantGeo = lazy(() => {
  const rnd = seeded(11);
  const parts: Piece[] = [
    { g: cyl(0.1, 0.075, 0.2, 20), c: PAL.pot, p: [0, 0.1, 0] },
    { g: cyl(0.092, 0.092, 0.01, 20), c: PAL.soil, p: [0, 0.196, 0] },
  ];
  const leaves: [number, number, number, number][] = [
    [0, 0.34, 0, 0.13], [0.08, 0.46, 0.03, 0.1], [-0.07, 0.5, -0.04, 0.095], [0.02, 0.61, -0.01, 0.08],
    [-0.09, 0.37, 0.07, 0.085], [0.1, 0.33, -0.06, 0.08], [-0.02, 0.44, 0.09, 0.08],
  ];
  leaves.forEach(([x, y, z, r], i) => parts.push({ g: new THREE.IcosahedronGeometry(r, 0), c: i % 2 ? PAL.leaf2 : PAL.leaf, p: [x, y, z], r: [rnd() * 3, rnd() * 3, rnd() * 3] }));
  return bake(parts);
});

/** Glass room walls for a w×d room with a door gap at the front-right */
export const WALL_H = 0.6;
export function wallGeos(w: number, d: number, door0: number, door1: number) {
  const segs: [number, number, number, number][] = [[0, 0, w, 0], [0, 0, 0, d], [w, 0, w, d], [0, d, door0, d], [door1, d, w, d]];
  const frame: Piece[] = [];
  const glass: Piece[] = [];
  const led: Piece[] = [];
  for (const [x0, z0, x1, z1] of segs) {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const a = -Math.atan2(z1 - z0, x1 - x0);
    const mx = (x0 + x1) / 2;
    const mz = (z0 + z1) / 2;
    glass.push({ g: box(len, WALL_H - 0.04, 0.016), c: '#ffffff', p: [mx, 0.03 + (WALL_H - 0.04) / 2, mz], r: [0, a, 0] });
    frame.push(
      { g: box(len + 0.012, 0.02, 0.032), c: PAL.rail, p: [mx, WALL_H, mz], r: [0, a, 0] },
      { g: box(len, 0.036, 0.04), c: PAL.base, p: [mx, 0.018, mz], r: [0, a, 0] },
      { g: box(len, 0.008, 0.02), c: '#8e98a8', p: [mx, 0.34, mz], r: [0, a, 0] },
    );
    led.push({ g: box(len, 0.006, 0.046), c: '#ffffff', p: [mx, 0.037, mz], r: [0, a, 0] });
  }
  const posts: [number, number][] = [[0, 0], [w, 0], [0, d], [w, d], [door0, d], [door1, d]];
  // Mullions about every 1.2 units give the glass an architectural rhythm
  for (const [x0, z0, x1, z1] of segs) {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.round(len / 1.2);
    for (let i = 1; i < n; i++) posts.push([x0 + ((x1 - x0) * i) / n, z0 + ((z1 - z0) * i) / n]);
  }
  for (const [x, z] of posts) {
    frame.push({ g: box(0.026, WALL_H + 0.006, 0.026), c: PAL.rail, p: [x, (WALL_H + 0.006) / 2, z] });
  }
  return { frame: bake(frame), glass: bake(glass), led: bake(led) };
}

// ───────────── materials ─────────────

export const MAT = {
  furniture: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.02 }),
  furnitureHi: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.02, emissive: new THREE.Color('#5a4630'), emissiveIntensity: 0.55 }),
  furnitureDim: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.02, color: new THREE.Color('#6d6d70') }),
  metal: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.65 }),
  fabric: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.05 }),
  foliage: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, flatShading: true }),
  cloth: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0 }),
  hair: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.48, metalness: 0.04, side: THREE.DoubleSide }),
  eye: new THREE.MeshBasicMaterial({ vertexColors: true }),
  tile: new THREE.MeshStandardMaterial({ roughness: 0.38, metalness: 0.12, envMapIntensity: 0.7 }),
  floor: (() => {
    const m = new THREE.MeshStandardMaterial({ map: TEX.floor, roughness: 0.24, metalness: 0.4, envMapIntensity: 0.8, color: new THREE.Color('#aab0bd') });
    return m;
  })(),
  glass: new THREE.MeshPhysicalMaterial({ color: '#9fc2ee', transparent: true, opacity: 0.075, roughness: 0.04, metalness: 0.1, envMapIntensity: 3.2, specularIntensity: 1, clearcoat: 1, clearcoatRoughness: 0.05, depthWrite: false, side: THREE.DoubleSide }),
  lampOn: new THREE.MeshBasicMaterial({ color: hot('#ffc58a', 2.6), toneMapped: false }),
  lampOff: new THREE.MeshStandardMaterial({ color: '#3a352e', roughness: 0.4 }),
  lampPool: new THREE.MeshBasicMaterial({ map: TEX.glow, color: new THREE.Color('#ffb36b').multiplyScalar(0.55), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
  beacon: new THREE.MeshBasicMaterial({ color: hot('#ff4d6d', 2.4), toneMapped: false }),
  hit: new THREE.MeshBasicMaterial({ visible: false }),
  particle: new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
};

/** A decal material: additive glow texture, tinted per use */
export const glowMat = (color: THREE.Color | string, map: THREE.Texture = TEX.glow) =>
  new THREE.MeshBasicMaterial({ map, color: typeof color === 'string' ? cssColor(color) : color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });

// ───────────── characters ─────────────

const SKIN = ['#f5d5bd', '#eabb98', '#d39b74', '#a9714b', '#70483a'];
const HAIR = ['#1d1918', '#3b2b22', '#5c3d29', '#8c4a2c', '#d8b26f', '#c4c6ce', '#2b3a5e', '#9a86d9'];
const PANTS = ['#252a35', '#2e3850', '#3b3530', '#1c1f27', '#44403a'];
const SHOES = ['#f0ede6', '#1c1d22', '#7a4b33', '#e8e8ec'];
const GEAR = ['#e9e5dc', '#2a2e38', '#3f68d8', '#d9534f', '#2e9d79'];
/** Shirts follow the model family, so a team's mix of models reads at a glance */
const FAMILY_SHIRT: Record<string, string> = { opus: '#d6a26e', sonnet: '#5d84d6', haiku: '#4daa88', fable: '#9a7bd9', mythos: '#9a7bd9' };
/** Sub-agents wear soft hoodies */
const HOODIES = ['#d3d8e2', '#e6d9c4', '#b8cfc0', '#bccae8', '#dcc4d0'];

export type Accessory = 'headphones' | 'glasses' | 'beanie' | 'cap' | 'hood' | null;

export interface Look {
  skin: THREE.Material;
  torso: THREE.BufferGeometry;
  upperArm: THREE.BufferGeometry;
  pelvis: THREE.BufferGeometry;
  thigh: THREE.BufferGeometry;
  shinFoot: THREE.BufferGeometry;
  extras: THREE.BufferGeometry;
}

const skinCache = new Map<string, THREE.Material>();
function skinMat(hex: string) {
  let m = skinCache.get(hex);
  if (!m) {
    m = new THREE.MeshPhysicalMaterial({ color: hex, roughness: 0.55, clearcoat: 0.15, clearcoatRoughness: 0.45, sheen: 0.25, sheenColor: new THREE.Color('#ffd9c7') });
    skinCache.set(hex, m);
  }
  return m;
}

const geoCache = new Map<string, THREE.BufferGeometry>();
const cached = (key: string, make: () => THREE.BufferGeometry) => {
  let g = geoCache.get(key);
  if (!g) {
    g = make();
    geoCache.set(key, g);
  }
  return g;
};

// Rig dimensions (see Chibi.tsx): head centre 0.155 above the neck pivot, radii 0.17/0.16/0.165
export const HEAD_Y = 0.155;

function headExtras(style: number, acc: Accessory, hair: string, gear: string, skin: string): THREE.BufferGeometry {
  return cached(`x${style}|${acc}|${hair}|${gear}|${skin}`, () => {
    const H = HEAD_Y;
    const blush = cssColor(skin).lerp(cssColor('#ff7f86'), 0.42);
    const parts: Piece[] = [
      // cheeks and a small smile
      { g: sph(1), c: blush, p: [0.098, H - 0.048, 0.124], s: [0.026, 0.015, 0.01] },
      { g: sph(1), c: blush, p: [-0.098, H - 0.048, 0.124], s: [0.026, 0.015, 0.01] },
      { g: sph(1), c: '#5a2e2a', p: [0, H - 0.058, 0.152], s: [0.016, 0.006, 0.006] },
    ];
    const cap = (thetaLen: number, r: number) => new THREE.SphereGeometry(r, 32, 16, 0, TAU, 0, Math.PI * thetaLen);
    if (acc !== 'beanie' && acc !== 'cap') {
      parts.push({ g: cap(style === 3 ? 0.6 : 0.56, 0.184), c: hair, p: [0, H + 0.006, -0.006], r: [-0.42, 0, 0] });
    } else {
      parts.push({ g: cap(0.6, 0.18), c: hair, p: [0, H, -0.012], r: [-0.55, 0, 0] });
    }
    if (style === 1) parts.push({ g: sph(0.068, 16, 12), c: hair, p: [0, H + 0.17, -0.075] });
    if (style === 2) parts.push({ g: sph(1, 16, 12), c: hair, p: [0.05, H + 0.125, 0.1], s: [0.11, 0.05, 0.08], r: [0.2, 0, 0.35] });
    if (style === 3) {
      parts.push(
        { g: sph(1, 16, 12), c: hair, p: [0.148, H - 0.035, -0.025], s: [0.06, 0.12, 0.11] },
        { g: sph(1, 16, 12), c: hair, p: [-0.148, H - 0.035, -0.025], s: [0.06, 0.12, 0.11] },
      );
    }
    if (style === 4) {
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU;
        parts.push({ g: sph(0.06, 12, 10), c: hair, p: [Math.cos(a) * 0.105, H + 0.125, Math.sin(a) * 0.105 - 0.025] });
      }
      parts.push({ g: sph(0.07, 12, 10), c: hair, p: [0, H + 0.175, -0.02] });
    }
    switch (acc) {
      case 'headphones':
        parts.push(
          { g: new THREE.TorusGeometry(0.192, 0.013, 8, 32, Math.PI), c: gear, p: [0, H + 0.008, -0.01] },
          { g: cyl(0.05, 0.05, 0.036, 20), c: gear, p: [0.186, H - 0.005, -0.01], r: [0, 0, Math.PI / 2] },
          { g: cyl(0.05, 0.05, 0.036, 20), c: gear, p: [-0.186, H - 0.005, -0.01], r: [0, 0, Math.PI / 2] },
          { g: cyl(0.036, 0.036, 0.04, 16), c: '#15171c', p: [0.172, H - 0.005, -0.01], r: [0, 0, Math.PI / 2] },
          { g: cyl(0.036, 0.036, 0.04, 16), c: '#15171c', p: [-0.172, H - 0.005, -0.01], r: [0, 0, Math.PI / 2] },
        );
        break;
      case 'glasses':
        parts.push(
          { g: new THREE.TorusGeometry(0.039, 0.0065, 8, 22), c: '#1b1d22', p: [0.064, H - 0.008, 0.168] },
          { g: new THREE.TorusGeometry(0.039, 0.0065, 8, 22), c: '#1b1d22', p: [-0.064, H - 0.008, 0.168] },
          { g: cyl(0.005, 0.005, 0.05, 6), c: '#1b1d22', p: [0, H - 0.0, 0.17], r: [0, 0, Math.PI / 2] },
        );
        break;
      case 'beanie':
        parts.push(
          { g: new THREE.SphereGeometry(1, 28, 12, 0, TAU, 0, Math.PI / 2), c: gear, p: [0, H + 0.02, -0.01], s: [0.19, 0.175, 0.19], r: [-0.22, 0, 0] },
          { g: new THREE.TorusGeometry(0.178, 0.026, 10, 32), c: gear, p: [0, H + 0.03, -0.004], r: [Math.PI / 2 - 0.22, 0, 0] },
          { g: sph(0.042, 14, 10), c: '#f1ede4', p: [0, H + 0.2, -0.05] },
        );
        break;
      case 'cap':
        parts.push(
          { g: new THREE.SphereGeometry(1, 28, 12, 0, TAU, 0, Math.PI / 2), c: gear, p: [0, H + 0.03, 0], s: [0.188, 0.15, 0.188], r: [-0.12, 0, 0] },
          { g: cyl(1, 1, 1, 24), c: gear, p: [0, H + 0.055, 0.16], s: [0.12, 0.012, 0.1] },
        );
        break;
      default:
        break;
    }
    return bake(parts);
  });
}

/**
 * A stable, varied character from a seed. Shirt carries the team (project) colour; the
 * accessory carries the model family: opus wears headphones, sonnet glasses, fable a beanie,
 * haiku a cap. Sub-agents wear a hoodie in a lighter team tone.
 */
export function lookFor(seed: string, shirtCss: string, family: string, kind: 'main' | 'agent'): Look {
  const h = (k: string) => hash01(seed + k);
  const skin = SKIN[Math.floor(h('s') * SKIN.length)];
  const hair = HAIR[Math.floor(h('h') * HAIR.length)];
  const pants = PANTS[Math.floor(h('p') * PANTS.length)];
  const shoe = SHOES[Math.floor(h('f') * SHOES.length)];
  const gear = GEAR[Math.floor(h('g') * GEAR.length)];
  const style = Math.floor(h('y') * 5);
  const shirtC = kind === 'agent'
    ? cssColor(HOODIES[Math.floor(h('o') * HOODIES.length)])
    : cssColor(FAMILY_SHIRT[family] ?? shirtCss).lerp(new THREE.Color('#8a8f9c'), 0.1);
  shirtC.offsetHSL((h('j') - 0.5) * 0.05, (h('k') - 0.5) * 0.12, (h('l') - 0.5) * 0.1);
  const shirt = '#' + shirtC.getHexString();
  const acc: Accessory = kind === 'agent'
    ? 'hood'
    : family === 'opus' ? 'headphones' : family === 'sonnet' ? 'glasses' : family === 'fable' || family === 'mythos' ? 'beanie' : family === 'haiku' ? 'cap' : null;
  const torso = cached(`t${shirt}|${acc === 'hood'}`, () => {
    const parts: Piece[] = [{ g: capsule(0.1, 0.1), c: shirt, p: [0, 0.13, 0], s: [1.06, 1, 0.86] }];
    if (acc === 'hood') parts.push({ g: new THREE.TorusGeometry(0.085, 0.034, 10, 24), c: shirt, p: [0, 0.255, -0.035], r: [Math.PI / 2 + 0.45, 0, 0] });
    else parts.push({ g: new THREE.TorusGeometry(0.052, 0.012, 8, 20), c: shirtC.clone().multiplyScalar(0.7), p: [0, 0.262, 0.005], r: [Math.PI / 2, 0, 0] });
    return bake(parts);
  });
  return {
    skin: skinMat(skin),
    torso,
    upperArm: cached(`u${shirt}`, () => bake([{ g: capsule(0.036, 0.06), c: shirt, p: [0, -0.05, 0] }])),
    pelvis: cached(`p${pants}`, () => bake([{ g: sph(1, 18, 12), c: pants, s: [0.102, 0.062, 0.087] }])),
    thigh: cached(`h${pants}`, () => bake([{ g: capsule(0.046, 0.05), c: pants, p: [0, -0.058, 0] }])),
    shinFoot: cached(`f${pants}|${shoe}`, () =>
      bake([
        { g: capsule(0.04, 0.05), c: pants, p: [0, -0.05, 0] },
        { g: sph(1, 16, 10), c: shoe, p: [0, -0.112, 0.022], s: [0.046, 0.032, 0.072] },
      ]),
    ),
    extras: headExtras(style, acc === 'hood' ? null : acc, hair, gear, skin),
  };
}

/** Forearm and hand in one piece (skin material) */
export const forearmGeo = lazy(() =>
  bake([
    { g: capsule(0.032, 0.05), c: '#ffffff', p: [0, -0.045, 0] },
    { g: sph(0.038, 14, 10), c: '#ffffff', p: [0, -0.1, 0] },
  ]),
);

/** Eye with its catch-light, unlit */
export const eyeGeo = lazy(() =>
  bake([
    { g: sph(1, 16, 12), c: '#16161c', s: [0.021, 0.029, 0.012] },
    { g: sph(1, 8, 6), c: '#d9dbe2', p: [0.007, 0.011, 0.009], s: 0.0068 },
  ]),
);
