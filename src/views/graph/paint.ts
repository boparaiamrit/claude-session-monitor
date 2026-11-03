// Small canvas helpers for the graph: token-backed palette, cached rgba and text widths.

export interface Palette {
  bg0: string; bg1: string; bg2: string; bg3: string; bg4: string;
  fg: string; fg2: string; fg3: string; fg4: string;
  live: string; blocked: string; waiting: string; idle: string; ok: string; warn: string;
  read: string; edit: string; agent: string;
  font: string; mono: string;
}

/** Colors come from tokens.css so the canvas matches the rest of the app */
export function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    bg0: v('--bg-0'), bg1: v('--bg-1'), bg2: v('--bg-2'), bg3: v('--bg-3'), bg4: v('--bg-4'),
    fg: v('--fg'), fg2: v('--fg-2'), fg3: v('--fg-3'), fg4: v('--fg-4'),
    live: v('--live'), blocked: v('--blocked'), waiting: v('--waiting'), idle: v('--idle'), ok: v('--ok'), warn: v('--warn'),
    read: v('--tool-read'), edit: v('--tool-edit'), agent: v('--tool-agent'),
    font: v('--font'), mono: v('--mono'),
  };
}

const rgbaCache = new Map<string, string>();
/** #rrggbb + alpha → rgba(), cached */
export function rgba(hex: string, a: number): string {
  const q = Math.round(a * 100) / 100;
  const k = hex + q;
  let s = rgbaCache.get(k);
  if (!s) {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const n = parseInt(full.slice(0, 6), 16);
    s = `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${q})`;
    if (rgbaCache.size > 4000) rgbaCache.clear();
    rgbaCache.set(k, s);
  }
  return s;
}

const widthCache = new Map<string, number>();
if (typeof document !== 'undefined') document.fonts?.ready.then(() => widthCache.clear());
export function textW(ctx: CanvasRenderingContext2D, text: string): number {
  const k = ctx.font + '|' + text;
  let w = widthCache.get(k);
  if (w == null) {
    w = ctx.measureText(text).width;
    if (widthCache.size > 3000) widthCache.clear();
    widthCache.set(k, w);
  }
  return w;
}

/** Shorten text to fit `max` px, ending with an ellipsis */
export function fitText(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (textW(ctx, text) <= max) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (textW(ctx, text.slice(0, mid) + '…') <= max) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, Math.max(1, lo)) + '…';
}

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeOutBack = (t: number) => {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
