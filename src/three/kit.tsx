// Shared 3D stage for the immersive views (Office, City, Galaxy).
// Rules: everything procedural, no network assets (CSP blocks them and the app works
// offline): no drei Environment presets, no drei <Text> (troika fetches fonts), no GLTF.
// Shaders: clamp every pow() base to >= 0. Interpolated varyings dip just below zero,
// pow() of that is NaN on Direct3D (WebView2 on Windows), and bloom spreads one NaN
// pixel across the whole frame (it renders black). Software GL hides this.
import { Suspense, useState, type ReactNode } from 'react';
import { Canvas, type CanvasProps } from '@react-three/fiber';
import { Environment, Lightformer, PerformanceMonitor, Html } from '@react-three/drei';
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing';
import * as THREE from 'three';
import { useLabelsReady } from './motion';

export interface StageProps {
  children: ReactNode;
  camera?: CanvasProps['camera'];
  background?: string;
  fog?: [string, number, number];
  bloom?: { intensity?: number; threshold?: number; radius?: number };
  /** Studio reflections for glossy materials (baked once, no network) */
  studio?: boolean;
  shadows?: boolean;
  onPointerMissed?: () => void;
}

/** Canvas + tone mapping + adaptive resolution + bloom/vignette, tuned for a live dashboard */
export function Stage({ children, camera, background = '#07080b', fog, bloom, studio = true, shadows = true, onPointerMissed }: StageProps) {
  const [dpr, setDpr] = useState(1.5);
  return (
    <Canvas
      className="stage-canvas"
      shadows={shadows ? 'percentage' : false}
      dpr={dpr}
      camera={camera ?? { position: [14, 12, 14], fov: 32, near: 0.1, far: 400 }}
      gl={{ antialias: true, powerPreference: 'high-performance', toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.0 }}
      onPointerMissed={onPointerMissed}
    >
      <color attach="background" args={[background]} />
      {fog && <fog attach="fog" args={fog} />}
      <PerformanceMonitor onIncline={() => setDpr(Math.min(2, window.devicePixelRatio || 1))} onDecline={() => setDpr(1)} flipflops={3} onFallback={() => setDpr(1)} />
      <Suspense fallback={null}>
        {studio && (
          <Environment resolution={128} frames={1}>
            <Lightformer intensity={2.2} position={[0, 10, 2]} scale={[12, 12, 1]} rotation={[Math.PI / 2, 0, 0]} />
            <Lightformer intensity={3} position={[-10, 3, 6]} scale={[3, 12, 1]} rotation={[0, Math.PI / 2, 0]} color="#ffd9c2" />
            <Lightformer intensity={1.6} position={[10, 3, -4]} scale={[3, 12, 1]} rotation={[0, -Math.PI / 2, 0]} color="#c9d6ff" />
          </Environment>
        )}
        {children}
      </Suspense>
      <EffectComposer multisampling={4}>
        <Bloom mipmapBlur intensity={bloom?.intensity ?? 0.85} luminanceThreshold={bloom?.threshold ?? 0.62} luminanceSmoothing={0.2} radius={bloom?.radius ?? 0.55} />
        <Vignette eskil={false} offset={0.25} darkness={0.65} />
      </EffectComposer>
    </Canvas>
  );
}

/** DOM label pinned to a 3D point, halo text instead of a box (teardown HUD style) */
export function Label3D({ position, children, className = '', onClick, distanceFactor }:
  { position: [number, number, number]; children: ReactNode; className?: string; onClick?: () => void; distanceFactor?: number }) {
  const ready = useLabelsReady();
  if (!ready) return null;
  return (
    <Html position={position} center distanceFactor={distanceFactor} zIndexRange={[20, 0]} className={`label3d ${className}`} style={{ pointerEvents: onClick ? 'auto' : 'none' }}>
      <div onClick={onClick}>{children}</div>
    </Html>
  );
}
