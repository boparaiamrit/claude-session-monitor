// Office: every project is a glass-walled room on a night-time office floor, every session a
// person at a desk, every running sub-agent a smaller teammate at a hot desk.
import { useCallback } from 'react';
import { Line } from '@react-three/drei';
import { useStore, useVisibleSessions } from '../../lib/store';
import { Stage } from '../../three/kit';
import { useOffice } from './model';
import { Room } from './Room';
import { Scenery } from './Scenery';
import { Particles } from './Particles';
import { CameraDirector } from './CameraDirector';
import { EmptyOffice, OfficeHud } from './Hud';
import { LabelLayout } from './labels';
import './office.css';

/** Faint floor outline where the first room will build */
function Blueprint() {
  const w = 3.5, d = 3.5, x = -w / 2, z = -d / 2;
  const pts: [number, number, number][] = [[x, 0.01, z], [x + w, 0.01, z], [x + w, 0.01, z + d], [x + w - 0.25, 0.01, z + d], [x + w - 1.05, 0.01, z + d], [x, 0.01, z + d], [x, 0.01, z]];
  return (
    <group>
      <Line points={pts.slice(0, 5)} color="#3a4256" lineWidth={1.2} dashed dashSize={0.18} gapSize={0.12} />
      <Line points={pts.slice(4)} color="#3a4256" lineWidth={1.2} dashed dashSize={0.18} gapSize={0.12} />
    </group>
  );
}

export default function OfficeView() {
  const sessions = useVisibleSessions();
  const { rooms, bounds, key } = useOffice(sessions);
  const onMissed = useCallback(() => {
    const st = useStore.getState();
    if (st.selectedId) st.select(null);
  }, []);

  return (
    <div className="office">
      <Stage
        camera={{ position: [14, 13, 22], fov: 30, near: 0.1, far: 300 }}
        bloom={{ intensity: 0.9, radius: 0.6 }}
        onPointerMissed={onMissed}
      >
        <Scenery bounds={bounds} />
        {rooms.map((r) => (
          <Room key={r.name} room={r} />
        ))}
        {!rooms.length && <Blueprint />}
        <Particles />
        <LabelLayout />
        <CameraDirector rooms={rooms} bounds={bounds} layoutKey={key} />
      </Stage>
      <OfficeHud sessions={sessions} />
      {!sessions.length && <EmptyOffice />}
    </div>
  );
}
