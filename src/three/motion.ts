import { useThree } from '@react-three/fiber';

/**
 * True once R3F has connected pointer events. drei <Html> mounts into
 * `events.connected || canvas.parentNode`; R3F connects events after the first commit,
 * so a label rendered on the very first frame is re-parented and React 19 throws
 * removeChild errors. Labels wait for this.
 */
export function useLabelsReady(): boolean {
  return useThree((s) => !!s.events.connected);
}

/** Frame-rate independent exponential approach: x += (target - x) * damp(lambda, dt) */
export const damp = (lambda: number, dt: number) => 1 - Math.exp(-lambda * dt);

export const smootherstep = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
};

export const easeOutCubic = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
export const easeOutBack = (x: number, s = 1.9) => {
  const t = Math.min(1, Math.max(0, x)) - 1;
  return t * t * ((s + 1) * t + s) + 1;
};

/** Seconds since an epoch-ms timestamp, for "spawned 0.4s ago" entrance animations */
export const ageSec = (ts: number | null | undefined) => (ts ? (Date.now() - ts) / 1000 : 999);
