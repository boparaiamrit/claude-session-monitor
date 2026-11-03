// A chibi character, about 2.6 heads tall, built from capsules and spheres on a pivot rig:
// root → hips → torso → head, shoulders → upper arm → elbow → forearm, hips → thigh → knee → shin.
// It renders once; all motion is written straight to the joints by Rig.apply().
import { memo } from 'react';
import { GEO, HEAD_Y, MAT, eyeGeo, forearmGeo, type Look } from './assets';
import { SIT_Y, type Rig } from './rig';

function Arm({ side, rig, look }: { side: 1 | -1; rig: Rig; look: Look }) {
  return (
    <group ref={rig.bind(side > 0 ? 'shL' : 'shR')} position={[0.118 * side, 0.225, 0]}>
      <mesh geometry={look.upperArm} material={MAT.cloth} castShadow />
      <group ref={rig.bind(side > 0 ? 'elL' : 'elR')} position={[0, -0.11, 0]}>
        <mesh geometry={forearmGeo()} material={look.skin} castShadow />
      </group>
    </group>
  );
}

function Leg({ side, rig, look }: { side: 1 | -1; rig: Rig; look: Look }) {
  return (
    <group ref={rig.bind(side > 0 ? 'hipL' : 'hipR')} position={[0.052 * side, 0, 0]}>
      <mesh geometry={look.thigh} material={MAT.cloth} castShadow />
      <group ref={rig.bind(side > 0 ? 'knL' : 'knR')} position={[0, -0.12, 0]}>
        <mesh geometry={look.shinFoot} material={MAT.cloth} castShadow />
      </group>
    </group>
  );
}

export const Chibi = memo(function Chibi({ look, rig }: { look: Look; rig: Rig }) {
  return (
    <group ref={rig.bind('root')}>
      <group ref={rig.bind('hips')} position={[0, SIT_Y, 0]}>
        <mesh geometry={look.pelvis} material={MAT.cloth} castShadow />
        <Leg side={1} rig={rig} look={look} />
        <Leg side={-1} rig={rig} look={look} />
        <group ref={rig.bind('torso')}>
          <mesh geometry={look.torso} material={MAT.cloth} castShadow />
          <Arm side={1} rig={rig} look={look} />
          <Arm side={-1} rig={rig} look={look} />
          <group ref={rig.bind('head')} position={[0, 0.27, 0]}>
            <mesh geometry={GEO.sphere} material={look.skin} position={[0, HEAD_Y, 0]} scale={[0.17, 0.16, 0.165]} castShadow />
            <mesh geometry={look.extras} material={MAT.hair} castShadow />
            <group ref={rig.bind('eyeL')} position={[0.064, HEAD_Y - 0.01, 0.149]}>
              <mesh geometry={eyeGeo()} material={MAT.eye} />
            </group>
            <group ref={rig.bind('eyeR')} position={[-0.064, HEAD_Y - 0.01, 0.149]}>
              <mesh geometry={eyeGeo()} material={MAT.eye} />
            </group>
          </group>
        </group>
      </group>
    </group>
  );
});
