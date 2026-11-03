import type { Usage } from '../types';

// API list prices in USD per million tokens (Anthropic first-party, cached 2026-10-06).
// Subscription users don't pay these; the UI labels results "API-equivalent".
interface Price { input: number; output: number; cacheRead?: number }

// First match wins, so more specific ids come first.
const PRICES: [RegExp, Price][] = [
  [/fable-5|mythos-5/, { input: 10, output: 50, cacheRead: 0.25 }],
  [/opus-5-5/, { input: 4, output: 20, cacheRead: 0.2 }],
  [/opus-5/, { input: 5, output: 25 }],
  [/opus-4-[5-9]/, { input: 5, output: 25 }],
  [/opus-4/, { input: 15, output: 75 }],
  [/sonnet-5/, { input: 2, output: 10, cacheRead: 0.2 }],
  [/sonnet-4/, { input: 3, output: 15 }],
  [/haiku-5/, { input: 0.1, output: 0.5 }],
  [/haiku-4/, { input: 1, output: 5 }],
  [/haiku/, { input: 0.8, output: 4 }],
];
const FALLBACK: Price = { input: 4, output: 20, cacheRead: 0.2 };

export function priceFor(model: string | null | undefined): Price {
  if (!model) return FALLBACK;
  for (const [re, p] of PRICES) if (re.test(model)) return p;
  return FALLBACK;
}

/** Cache writes are billed at 2x input (Claude Code writes 1-hour cache entries); reads default to 0.1x input. */
export function costOf(model: string | null | undefined, u: Usage): number {
  const p = priceFor(model);
  const read = p.cacheRead ?? p.input * 0.1;
  return (u.input * p.input + u.output * p.output + u.cacheWrite * p.input * 2 + u.cacheRead * read) / 1e6;
}

export function costByModel(byModel: Record<string, Usage>): number {
  let total = 0;
  for (const [m, u] of Object.entries(byModel)) total += costOf(m, u);
  return total;
}

/** Context window by model: every current model has 1M tokens; older Haiku has 200K. */
export function contextWindow(model: string | null | undefined): number {
  if (model && /haiku-4|haiku-3|claude-3/.test(model)) return 200_000;
  return 1_000_000;
}
