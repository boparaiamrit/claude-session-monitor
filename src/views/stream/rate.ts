import type { FeedItem } from '../../types';
import { useStore } from '../../lib/store';

// Events per 10-second slot, counted from feed timestamps. The feed itself keeps only
// the newest 600 lines, so this keeps counting as lines arrive and the history survives
// the cap. It starts when the Stream view is first opened and seeds from the feed.
const SLOT = 10_000;
const KEEP_SLOTS = 6 * 30; // half an hour

const slots = new Map<number, number>();
let prevKeys = new Set<string>();
/** Slots from here on were counted live; earlier ones only hold what the feed still had */
const liveFrom = Math.floor(Date.now() / SLOT);
/** Oldest slot the feed reached when counting started; older minutes are unknown */
let oldestSeen = Math.floor(Date.now() / SLOT);

function add(ts: number) {
  const k = Math.floor(ts / SLOT);
  slots.set(k, (slots.get(k) ?? 0) + 1);
}

/** Which feed update each line arrived in, for the insert animation (startup lines are batch 0) */
const arrivals = new Map<string, number>();
let batch = 0;

function ingest(feed: FeedItem[]) {
  const seed = prevKeys.size === 0;
  const keys = new Set<string>();
  let added = false;
  for (const f of feed) {
    keys.add(f.key);
    if (seed || !prevKeys.has(f.key)) {
      add(f.ts);
      if (!seed && !arrivals.has(f.key)) {
        if (!added) { batch++; added = true; }
        arrivals.set(f.key, batch);
      }
    }
  }
  prevKeys = keys;
  if (arrivals.size > 400) {
    for (const [k, b] of arrivals) if (batch - b > 4) arrivals.delete(k);
  }
  if (seed && feed.length) oldestSeen = Math.min(oldestSeen, Math.floor(feed[feed.length - 1].ts / SLOT));
  const floor = Math.floor(Date.now() / SLOT) - KEEP_SLOTS;
  for (const k of slots.keys()) if (k < floor) slots.delete(k);
}

ingest(useStore.getState().feed);
useStore.subscribe((s, prev) => {
  if (s.feed !== prev.feed) ingest(s.feed);
});

/** True while a line belongs to the latest feed update or the one before it */
export function isFresh(key: string): boolean {
  const b = arrivals.get(key);
  return b != null && batch - b < 2;
}

export interface RateBar {
  /** Start of the minute */
  t: number;
  count: number;
  /** false when this minute is older than anything the monitor has seen */
  known: boolean;
}

/**
 * Tool calls the sessions themselves recorded in the minute starting at `ts`
 * (Session.activity: per minute, last 60, oldest first). Used for minutes from
 * before live counting began, where the capped feed only holds part of the history.
 */
function recordedCalls(ts: number, now: number): number {
  const back = Math.floor(now / 60_000) - Math.floor(ts / 60_000);
  if (back < 0 || back > 59) return 0;
  let n = 0;
  for (const s of useStore.getState().list) {
    const a = s.activity;
    n += a[a.length - 1 - back] ?? 0;
  }
  return n;
}

/** Events in the rolling last minute, plus per-minute bars ending now, oldest first */
export function readRate(now: number, minutes = 10): { perMin: number; bars: RateBar[] } {
  const cur = Math.floor(now / SLOT);
  const bars: RateBar[] = [];
  for (let m = minutes - 1; m >= 0; m--) {
    const end = cur - m * 6;
    const start = end - 5;
    let count = 0;
    for (let i = 0; i < 6; i++) count += slots.get(end - i) ?? 0;
    let known = end >= oldestSeen;
    if (start < liveFrom) {
      const recorded = recordedCalls(start * SLOT, now);
      if (recorded > count) count = recorded;
      known = known || recorded > 0;
    }
    bars.push({ t: start * SLOT, count, known });
  }
  return { perMin: bars[bars.length - 1].count, bars };
}
