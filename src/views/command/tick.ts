import { useSyncExternalStore } from 'react';

// One shared 1s clock for every live timer in the view, so 30 cards don't each run
// their own interval and all timers tick in step.
let now = Date.now();
const subs = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(cb: () => void) {
  subs.add(cb);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      subs.forEach((f) => f());
    }, 1000);
  }
  return () => {
    subs.delete(cb);
    if (!subs.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const snapshot = () => now;

export function useTick(): number {
  return useSyncExternalStore(subscribe, snapshot);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 24-hour HH:MM:SS, fixed width for log columns */
export function hms(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Live stopwatch: 0:07, 3:42, 1:02:11 */
export function stopwatch(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
