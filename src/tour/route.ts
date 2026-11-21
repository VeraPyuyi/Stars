import * as THREE from 'three';
import type { StopKind, TourStop } from './stops';

/**
 * Where each stop hangs in space and where the camera rests to look at it.
 * Positions are not to scale: the gap between two stops grows with the log of the
 * real distance between them, and the route zig-zags so the camera never has to
 * fly through an object to reach the next one.
 */
export interface KindFrame {
  /** Rough visual radius (glow, beam, disk), used for spacing. */
  extent: number;
  /** Resting camera distance. */
  rest: number;
  min: number;
  max: number;
}

export const KIND_FRAME: Record<StopKind, KindFrame> = {
  planet: { extent: 1.6, rest: 3.6, min: 1.2, max: 20 },
  star: { extent: 7, rest: 4.4, min: 1.3, max: 30 },
  pulsar: { extent: 22, rest: 36, min: 2, max: 90 },
  blackhole: { extent: 30, rest: 30, min: 4, max: 80 },
};

export interface Placement {
  center: THREE.Vector3;
  /** Unit vector from the object towards the resting camera. */
  view: THREE.Vector3;
}

const UP = new THREE.Vector3(0, 1, 0);

export function layoutRoute(stops: TourStop[]): Placement[] {
  const centers: THREE.Vector3[] = [new THREE.Vector3()];
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1], b = stops[i];
    const gap = 40 + KIND_FRAME[a.kind].extent + KIND_FRAME[b.kind].extent + 30 * Math.log10(1 + Math.abs(b.ly - a.ly));
    const side = i % 2 === 1 ? 1 : -1;
    const lift = (((i * 37) % 7) - 3) / 3;
    centers.push(centers[i - 1].clone().add(new THREE.Vector3(side * 0.45 * gap, lift * 0.12 * gap, -gap)));
  }
  return stops.map((stop, i) => {
    const center = centers[i];
    const next = centers[i + 1] ?? center.clone().add(center.clone().sub(centers[i - 1]));
    const side = Math.sign(next.x - center.x) || 1;
    let view: THREE.Vector3;
    if (stop.kind === 'planet') {
      // Look at the planet from the side so that half of it is lit by the next stop, the Sun.
      const toSun = next.clone().sub(center).normalize();
      const across = new THREE.Vector3().crossVectors(toSun, UP).normalize();
      view = toSun.multiplyScalar(0.25).add(across.multiplyScalar(side)).add(UP.clone().multiplyScalar(0.3)).normalize();
    } else {
      // The preset's line of sight keeps its inclination to the spin axis (+y);
      // it is only turned about +y towards the side the route leaves from.
      const base = stop.preset.view ? new THREE.Vector3(...stop.preset.view).normalize() : new THREE.Vector3(0, 0.22, 1).normalize();
      view = base.applyAxisAngle(UP, side * 0.7);
    }
    return { center, view };
  });
}

/** Resting camera eye for a stop, a little further away on narrow (portrait) screens. */
export function restEye(p: Placement, kind: StopKind, aspect: number): THREE.Vector3 {
  const fit = aspect < 1 ? Math.pow(1 / aspect, 0.7) : 1;
  return p.center.clone().addScaledVector(p.view, KIND_FRAME[kind].rest * fit);
}

export function catmullRom(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, t: number, out: THREE.Vector3) {
  const t2 = t * t, t3 = t2 * t;
  const f = (a: number, b: number, c: number, d: number) =>
    0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return out.set(f(p0.x, p1.x, p2.x, p3.x), f(p0.y, p1.y, p2.y, p3.y), f(p0.z, p1.z, p2.z, p3.z));
}

export const smoothstep = (t: number) => t * t * (3 - 2 * t);
/** Slow out of the stop, fast in between, slow into the next one. */
export const smootherstep = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Slow floating motion (offsets in units of the object's size), on long, unrelated periods. */
export function drift(index: number, time: number, out: THREE.Vector3) {
  const wave = (period: number, phase: number) => Math.sin((time * 2 * Math.PI) / period + phase);
  return out.set(0.013 * wave(19, index * 2.1), 0.032 * wave(13, index * 1.7) + 0.006 * wave(5.6, index * 0.9), 0);
}
