import * as THREE from 'three';
import { orbitRadius, orbitSeconds } from '../objects/asteroidBelt';
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
  belt: { extent: 3, rest: 3, min: 0.5, max: 12 },
};

/** The frame of one stop: planets are drawn smaller than stars, and framed closer. */
export function frameOf(stop: TourStop): KindFrame {
  const f = KIND_FRAME[stop.kind], s = stop.scale;
  // Ringed planets are framed further out, so the whole ring fits.
  const ring = stop.preset.values.type === 'saturn' || stop.preset.values.type === 'gas' ? 1.8 : 1;
  return { extent: f.extent * s * ring, rest: f.rest * s * ring, min: f.min * s, max: f.max * s * ring };
}

export interface Placement {
  center: THREE.Vector3;
  /** Unit vector from the object towards the resting camera. */
  view: THREE.Vector3;
}

const UP = new THREE.Vector3(0, 1, 0);

/** Starting angle of each body on its orbit: staggered so the route spirals outwards. */
const PHASE0 = -3.95, PHASE_STEP = 0.35;

/** Inside the solar system: the Sun and everything orbiting it. */
export const isSolar = (s: TourStop) => !!s.orbit || s.id === 'sun';

/**
 * Sun at the origin, planets (and the belt) on circular orbits around it in the xz
 * plane; the interstellar stops are chained from there, the first one well above the
 * plane of the planets so that no flight out of the solar system crosses the Sun.
 */
export function layoutRoute(stops: TourStop[]): Placement[] {
  const placements: Placement[] = stops.map(() => ({ center: new THREE.Vector3(), view: new THREE.Vector3(0, 0.22, 1).normalize() }));
  let prev: TourStop | null = null;
  let k = 0;
  stops.forEach((s, i) => {
    if (isSolar(s)) return;
    const from = prev ? placements[stops.indexOf(prev)].center : new THREE.Vector3();
    const gap = (prev ? 40 + KIND_FRAME[prev.kind].extent : 130) + KIND_FRAME[s.kind].extent
      + 30 * Math.log10(1 + Math.abs(s.ly - (prev?.ly ?? 0)));
    const side = k % 2 === 0 ? 1 : -1;
    const lift = prev ? ((((k * 37) % 7) - 3) / 3) * 0.12 : 0.45;
    placements[i].center.copy(from).add(new THREE.Vector3(side * 0.45 * gap, lift * gap, -gap));
    prev = s;
    k++;
  });
  stops.forEach((stop, i) => {
    if (stop.orbit) return; // set every frame by updateOrbits
    const center = placements[i].center;
    let side = 1;
    if (stop.id !== 'sun') {
      const next = placements[i + 1]?.center ?? center.clone().add(center.clone().sub(placements[i - 1].center));
      side = Math.sign(next.x - center.x) || 1;
    }
    // The preset's line of sight keeps its inclination to the spin axis (+y);
    // it is only turned about +y towards the side the route leaves from.
    const base = stop.preset.view ? new THREE.Vector3(...stop.preset.view).normalize() : new THREE.Vector3(0, 0.22, 1).normalize();
    placements[i].view.copy(base.applyAxisAngle(UP, side * 0.7));
    // A pole-on view (Vega) is kept no steeper than 60°: looking straight down while
    // flying past would leave the camera's heading undefined and spin it round.
    const v = placements[i].view, maxY = Math.sin(THREE.MathUtils.degToRad(60));
    if (Math.abs(v.y) > maxY) {
      const h = Math.hypot(v.x, v.z) || 1;
      const k = Math.cos(THREE.MathUtils.degToRad(60)) / h;
      v.set(v.x * k || Math.cos(THREE.MathUtils.degToRad(60)), Math.sign(v.y) * maxY, v.z * k);
    }
  });
  updateOrbits(stops, placements, 0);
  return placements;
}

/** Move the orbiting stops to where they are at `time` (seconds of display time). */
export function updateOrbits(stops: TourStop[], placements: Placement[], time: number) {
  let k = 0;
  stops.forEach((s, i) => {
    if (!s.orbit) return;
    const R = orbitRadius(s.orbit.au);
    const th = PHASE0 + k * PHASE_STEP + (time * 2 * Math.PI) / orbitSeconds(s.orbit.au);
    const out = new THREE.Vector3(Math.cos(th), 0, Math.sin(th));
    const along = new THREE.Vector3(-Math.sin(th), 0, Math.cos(th));
    placements[i].center.copy(out).multiplyScalar(R);
    if (s.kind === 'belt') {
      // From just outside the belt and a little behind, looking along it towards the Sun's side.
      placements[i].view.copy(out).multiplyScalar(0.55).addScaledVector(along, -0.8).addScaledVector(UP, 0.32).normalize();
    } else {
      // From the side (along the orbit), a little towards the Sun: half of the planet is lit and the
      // route, which runs outwards, passes beside the planet rather than through it.
      const side = k % 2 === 0 ? 1 : -1;
      placements[i].view.copy(out).multiplyScalar(-0.2).addScaledVector(along, side).addScaledVector(UP, 0.3).normalize();
    }
    k++;
  });
}

/** Resting camera eye for a stop, a little further away on narrow (portrait) screens. */
export function restEye(p: Placement, frame: KindFrame, aspect: number, out = new THREE.Vector3()): THREE.Vector3 {
  const fit = aspect < 1 ? Math.pow(1 / aspect, 0.8) : 1;
  return out.copy(p.center).addScaledVector(p.view, frame.rest * fit);
}

/**
 * Centripetal Catmull–Rom (Barry–Goldman), between p1 and p2: unlike the uniform kind
 * it neither overshoots nor loops when neighbouring points are very unevenly spaced
 * (a planet's resting eye is a few units from it, the next stop tens of units away).
 */
export function centripetal(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, t: number, out: THREE.Vector3) {
  const k = (a: THREE.Vector3, b: THREE.Vector3) => Math.max(Math.sqrt(a.distanceTo(b)), 1e-4);
  const t0 = 0, t1 = t0 + k(p0, p1), t2 = t1 + k(p1, p2), t3 = t2 + k(p2, p3);
  const u = t1 + (t2 - t1) * t;
  const lerp = (o: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, ta: number, tb: number) =>
    o.copy(a).multiplyScalar((tb - u) / (tb - ta)).addScaledVector(b, (u - ta) / (tb - ta));
  const A1 = lerp(_a1, p0, p1, t0, t1), A2 = lerp(_a2, p1, p2, t1, t2), A3 = lerp(_a3, p2, p3, t2, t3);
  const B1 = lerp(_b1, A1, A2, t0, t2), B2 = lerp(_b2, A2, A3, t1, t3);
  return lerp(out, B1, B2, t1, t2);
}
const _a1 = new THREE.Vector3(), _a2 = new THREE.Vector3(), _a3 = new THREE.Vector3(), _b1 = new THREE.Vector3(), _b2 = new THREE.Vector3();

export const smoothstep = (t: number) => t * t * (3 - 2 * t);
export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Slow floating motion (offsets in units of the object's size), on long, unrelated periods. */
export function drift(index: number, time: number, out: THREE.Vector3) {
  const wave = (period: number, phase: number) => Math.sin((time * 2 * Math.PI) / period + phase);
  return out.set(0.013 * wave(19, index * 2.1), 0.032 * wave(13, index * 1.7) + 0.006 * wave(5.6, index * 0.9), 0);
}
