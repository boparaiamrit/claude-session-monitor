// Screen-space label layout. Every office label registers in labelRegistry; once per frame the
// labels are projected, placed in priority order, and any that would collide are lifted just
// clear of the ones already placed (or faded if there is no room). Floor labels never move.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { Label3D } from '../../three/kit';
import { damp } from '../../three/motion';
import { labelEntries, newLabelEntry, type LabelEntry, type LabelKind } from './labelRegistry';

export function OfficeLabel({ position, prio, kind = 'float', onClick, children }: {
  position: [number, number, number];
  prio: number;
  kind?: LabelKind;
  onClick?: () => void;
  children: ReactNode;
}) {
  const [initial] = useState(() => newLabelEntry(prio, kind));
  const entry = useRef<LabelEntry>(initial);
  useLayoutEffect(() => {
    entry.current.prio = prio;
    entry.current.kind = kind;
  }, [prio, kind]);
  useEffect(() => {
    const e = entry.current;
    labelEntries.add(e);
    return () => {
      labelEntries.delete(e);
    };
  }, []);
  return (
    <group position={position}>
      <object3D ref={(o) => { entry.current.anchor = o; }} />
      <Label3D position={[0, 0, 0]} onClick={onClick}>
        <div
          className="of-lb"
          style={{ opacity: 0 }}
          ref={(el) => {
            entry.current.el = el;
            entry.current.measuredAt = -1;
          }}
        >
          {children}
        </div>
      </Label3D>
    </group>
  );
}

interface Placed {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

const v = new THREE.Vector3();
const GAP = 4;
const MAX_LIFT = 72;

/** Mount once inside the Canvas */
export function LabelLayout() {
  const frame = useRef(0);
  useFrame(({ camera, size }, dt) => {
    const f = ++frame.current;
    // Measure all labels on the same frame (one layout read), and new ones right away
    const remeasure = f % 30 === 0;
    const items: { e: LabelEntry; x: number; y: number }[] = [];
    for (const e of labelEntries) {
      if (!e.el || !e.anchor || !e.el.isConnected) continue;
      if (e.measuredAt < 0 || remeasure) {
        e.w = e.el.offsetWidth;
        e.h = e.el.offsetHeight;
        e.measuredAt = f;
      }
      e.anchor.getWorldPosition(v).project(camera);
      if (v.z > 1 || v.z < -1) {
        e.opT = 0;
        continue;
      }
      items.push({ e, x: (v.x * 0.5 + 0.5) * size.width, y: (-v.y * 0.5 + 0.5) * size.height });
    }
    // Highest priority first; among equals, the one nearer the bottom (closer to camera) wins
    items.sort((a, b) => b.e.prio - a.e.prio || b.y - a.y);
    const placed: Placed[] = [];
    for (const { e, x, y } of items) {
      const hw = e.w / 2 + GAP;
      const hh = e.h / 2 + GAP / 2;
      let lift = 0;
      if (e.kind === 'floor') {
        e.opT = 1;
      } else {
        for (let i = 0; i < 8; i++) {
          const r = { x0: x - hw, x1: x + hw, y0: y - lift - hh, y1: y - lift + hh };
          const hit = placed.find((p) => r.x0 < p.x1 && r.x1 > p.x0 && r.y0 < p.y1 && r.y1 > p.y0);
          if (!hit) break;
          lift += r.y1 - hit.y0 + 1;
        }
        e.opT = lift > MAX_LIFT ? 0 : 1;
      }
      if (e.opT) {
        e.dyT = lift;
        placed.push({ x0: x - hw, x1: x + hw, y0: y - lift - hh, y1: y - lift + hh });
      }
    }
    const k = damp(12, dt);
    const ko = damp(9, dt);
    for (const e of labelEntries) {
      if (!e.el) continue;
      const dy = e.dy + (e.dyT - e.dy) * k;
      const op = e.op + (e.opT - e.op) * ko;
      // Only touch the DOM when something visibly changed
      if (Math.abs(dy - e.dy) > 0.05 || e.measuredAt === f) {
        e.el.style.transform = dy > 0.3 ? `translateY(${-dy.toFixed(1)}px)` : '';
        e.el.style.setProperty('--lift', `${Math.max(0, dy - 6).toFixed(1)}px`);
      }
      if (Math.abs(op - e.op) > 0.002 || e.measuredAt === f) {
        e.el.style.opacity = op.toFixed(3);
        e.el.style.pointerEvents = op > 0.5 ? '' : 'none';
      }
      e.dy = dy;
      e.op = op;
    }
  });
  return null;
}
