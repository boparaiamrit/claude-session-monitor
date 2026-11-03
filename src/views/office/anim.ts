// Small timing helpers for the office. One clock (seconds since page load) is shared by
// React (entrance/exit timestamps) and useFrame (animation), so both always agree.
import { useEffect, useReducer } from 'react';

export const nowSec = () => performance.now() / 1000;
export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const easeInCubic = (x: number) => {
  const t = clamp01(x);
  return t * t * t;
};
export const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** Signed shortest turn from one heading to another */
export const angleDelta = (from: number, to: number) => wrapAngle(to - from);

/** True once the shared clock passes `at` (seconds). Re-renders exactly once when it does. */
export function useAfter(at: number | null): boolean {
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (at == null) return;
    const ms = (at - nowSec()) * 1000;
    if (ms <= 0) return;
    const id = setTimeout(tick, ms + 16);
    return () => clearTimeout(id);
  }, [at]);
  return at != null && nowSec() >= at;
}
