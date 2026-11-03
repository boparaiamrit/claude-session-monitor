// Small procedural graphics helpers shared by the City and Galaxy views.
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';

/**
 * drei <Html> (behind Label3D) appends to `events.connected || canvas.parentNode`.
 * R3F connects events after the first commit, so a label mounted on the first render
 * re-creates its React root on a new parent, and the old root's deferred unmount then
 * throws removeChild errors. Render labels only once events are connected.
 */
export function useLabelsReady(): boolean {
  return useThree((s) => !!s.events.connected);
}

const colorCache = new Map<string, THREE.Color>();

/** CSS color (hex or `hsl(h s% l%)` with spaces) to a linear THREE.Color, cached */
export function cssColor(css: string): THREE.Color {
  const hit = colorCache.get(css);
  if (hit) return hit;
  const m = css.match(/^hsla?\(\s*([\d.]+)[\s,]+([\d.]+)%[\s,]+([\d.]+)%/i);
  const c = m ? new THREE.Color().setHSL(+m[1] / 360, +m[2] / 100, +m[3] / 100) : new THREE.Color(css);
  colorCache.set(css, c);
  return c;
}

let glow: THREE.Texture | null = null;

/** Soft radial falloff used for halos, light pools and star coronas */
export function glowTexture(): THREE.Texture {
  if (glow) return glow;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.12, 'rgba(255,255,255,0.7)');
  grd.addColorStop(0.32, 'rgba(255,255,255,0.22)');
  grd.addColorStop(0.62, 'rgba(255,255,255,0.05)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  glow = new THREE.CanvasTexture(c);
  return glow;
}

/** Vertex snippet: view depth for fading additive geometry into fog */
export const FOG_DEPTH_VERT = /* glsl */ `
  varying float vViewDepth;
`;
/** Fragment snippet: multiply additive output by this so it fades with the scene fog */
export const FOG_FADE_FRAG = /* glsl */ `
  varying float vViewDepth;
  #ifdef USE_FOG
    uniform float fogNear;
    uniform float fogFar;
    float fogFade() { return 1.0 - smoothstep(fogNear, fogFar, vViewDepth); }
  #else
    float fogFade() { return 1.0; }
  #endif
`;

/** Shader material that adds light (glows, beams, bands) and fades into the fog */
export function additiveMaterial(opts: {
  vertex: string;
  fragment: string;
  uniforms?: Record<string, THREE.IUniform>;
  side?: THREE.Side;
  depthTest?: boolean;
}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...(opts.uniforms ?? {}) },
    vertexShader: opts.vertex,
    fragmentShader: opts.fragment,
    transparent: true,
    depthWrite: false,
    depthTest: opts.depthTest ?? true,
    blending: THREE.AdditiveBlending,
    side: opts.side ?? THREE.FrontSide,
    fog: true,
    toneMapped: false,
  });
}

/** Deterministic 0..1 noise for an integer index and seed */
export function rand01(i: number, seed: number): number {
  const x = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** Tool calls in the last `minutes` minutes */
export function recentCalls(activity: number[], minutes: number): number {
  let n = 0;
  for (let i = Math.max(0, activity.length - minutes); i < activity.length; i++) n += activity[i];
  return n;
}
