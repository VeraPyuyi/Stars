import type * as THREE from 'three';

export type Param =
  | { kind: 'range'; key: string; label: string; min: number; max: number; step: number; value: number; unit?: string;
      format?: (v: number) => string; onChange: (v: number) => void }
  | { kind: 'select'; key: string; label: string; options: { value: string; label: string }[]; value: string;
      onChange: (v: string) => void }
  | { kind: 'toggle'; key: string; label: string; value: boolean; onChange: (v: boolean) => void };

export interface SimObject {
  id: string;
  name: string;
  group: THREE.Object3D;
  params: Param[];
  /** HTML shown in the info panel (physics notes + what is approximated). */
  info: string;
  camera: { distance: number; min: number; max: number };
  bloom: { strength: number; radius: number; threshold: number };
  /** Black hole is rendered entirely by the sky ray-tracer. */
  skyMode?: 'blackhole';
  update(dt: number, time: number, camera: THREE.PerspectiveCamera): void;
}
