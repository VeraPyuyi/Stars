import * as THREE from 'three';
import { orbitRadius } from '../objects/asteroidBelt';
import type { StopKind, TourStop } from './stops';

/** Closest approach of a fly-by, as a fraction of the resting distance. */
export const FLYBY = 0.9;

/**
 * Every star is flown past at the same distance from its centre, the Earth–Sun distance of
 * the tour's solar system, so their sizes compare directly with the Sun's (or, for stars
 * too big for that, at 2.2 of their own radii).
 */
export const STAR_PASS = orbitRadius(1);

/**
 * Where each stop hangs in space and where the camera rests to look at it.
 * Positions are not to scale: the gap between two stops grows with the log of the
 * real distance between them. The route is nearly straight, outwards from the Sun,
 * and every object is passed on the same side, so the camera never has to wind round one.
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
  planet: { extent: 1.6, rest: 3.0, min: 1.2, max: 20 },
  star: { extent: 7, rest: 3.6, min: 1.3, max: 30 },
  pulsar: { extent: 22, rest: 30, min: 2, max: 90 },
  blackhole: { extent: 30, rest: 26, min: 4, max: 80 },
  belt: { extent: 3, rest: 3, min: 0.5, max: 12 },
};

/** The frame of one stop: planets are drawn smaller than stars, and framed closer. */
export function frameOf(stop: TourStop): KindFrame {
  const f = KIND_FRAME[stop.kind], s = stop.scale;
  // Ringed planets are framed further out, so the whole ring fits.
  const ring = stop.preset.values.type === 'saturn' || stop.preset.values.type === 'gas' ? 1.8 : 1;
  if (stop.kind === 'star') {
    const rest = Math.max(STAR_PASS, 2.2 * s) / FLYBY;
    return { extent: 7 + 2.5 * s, rest, min: f.min * s, max: Math.max(rest * 2, f.max * s) };
  }
  return { extent: f.extent * s * ring, rest: f.rest * s * ring, min: f.min * s, max: f.max * s * ring };
}

export interface Placement {
  center: THREE.Vector3;
  /** Unit vector from the object towards the resting camera. */
  view: THREE.Vector3;
}

const UP = new THREE.Vector3(0, 1, 0);

/** Inside the solar system: the Sun and everything orbiting it. */
export const isSolar = (s: TourStop) => !!s.orbit || s.id === 'sun';

/** Direction of the route out of the Sun (in the plane of the planets). */
const OUT = new THREE.Vector3(Math.cos(-1.0), 0, Math.sin(-1.0));

/**
 * The Sun at the origin and the planets (and the belt) on their orbits, lined up
 * along one direction out of the Sun, then the interstellar stops further out along
 * the same direction, with only a gentle drift up/down and sideways. The camera
 * rests a little before each object and off to its right, so flying on it simply
 * passes the object on its right-hand side and carries on straight ahead.
 */
export function layoutRoute(stops: TourStop[]): Placement[] {
  const centers = stops.map(() => new THREE.Vector3());
  const side0 = new THREE.Vector3().crossVectors(OUT, UP).normalize();
  let k = 0, prev: TourStop | null = null, last = new THREE.Vector3();
  stops.forEach((s, i) => {
    if (s.orbit) {
      // A few degrees apart from one another, so each planet is not hidden behind the last.
      const a = (k++ % 2 === 0 ? 1 : -1) * 0.025;
      centers[i].copy(OUT).applyAxisAngle(UP, a).multiplyScalar(orbitRadius(s.orbit.au));
    } else if (s.id !== 'sun') {
      const p: TourStop = prev ?? s;
      const first = !prev || isSolar(p);
      const gap = (first ? 110 : 40 + frameOf(p).extent) + frameOf(s).extent
        + 30 * Math.log10(1 + Math.abs(s.ly - (first ? 0 : p.ly)));
      const n = i * 1.7;
      const dir = OUT.clone().addScaledVector(side0, 0.12 * Math.sin(n)).addScaledVector(UP, 0.08 * Math.sin(n * 0.6 + 1)).normalize();
      centers[i].copy(last).addScaledVector(dir, gap);
    }
    last = centers[i];
    prev = s;
  });
  return stops.map((stop, i) => {
    // Direction of travel at this stop, flattened onto the plane of the route.
    const ahead = (centers[i + 1] ?? centers[i].clone().addScaledVector(OUT, 1)).clone().sub(centers[i - 1] ?? centers[i].clone().addScaledVector(OUT, -1));
    ahead.y = 0;
    ahead.normalize();
    const right = new THREE.Vector3().crossVectors(ahead, UP).normalize();
    // Horizontal direction of the resting eye: mostly to the right, a little behind.
    const h = right.multiplyScalar(0.88).addScaledVector(ahead, -0.48).normalize();
    // Height above the object's equator: the preset's inclination where it matters (the
    // disc of a black hole, a pulsar's spin axis, Vega seen pole-on), limited to 60°.
    const presetEl = stop.preset.view ? Math.asin(new THREE.Vector3(...stop.preset.view).normalize().y) : null;
    const ringed = stop.preset.values.type === 'saturn' || stop.preset.values.type === 'gas';
    const el = THREE.MathUtils.clamp(presetEl ?? THREE.MathUtils.degToRad(stop.kind === 'belt' || ringed ? 24 : 12), -Math.PI / 3, Math.PI / 3);
    const view = h.multiplyScalar(Math.cos(el)).addScaledVector(UP, Math.sin(el)).normalize();
    return { center: centers[i], view };
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
