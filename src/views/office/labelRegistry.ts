// Registry for office labels; LabelLayout (labels.tsx) places them each frame.
import type * as THREE from 'three';

export type LabelKind = 'float' | 'floor';

export interface LabelEntry {
  anchor: THREE.Object3D | null;
  el: HTMLElement | null;
  prio: number;
  kind: LabelKind;
  w: number;
  h: number;
  measuredAt: number;
  dy: number;
  dyT: number;
  op: number;
  opT: number;
}

export const labelEntries = new Set<LabelEntry>();

/** Label priority: higher is placed first and never pushed by lower ones */
export const PRIO = { hover: 6, blocked: 5, floor: 4, paused: 3, working: 2, waiting: 2 };

export const newLabelEntry = (prio: number, kind: LabelKind): LabelEntry => ({
  anchor: null, el: null, prio, kind, w: 0, h: 0, measuredAt: -1, dy: 0, dyT: 0, op: 0, opT: 1,
});
