import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Sky } from '../sky';
import type { SimObject } from '../types';
import { TOUR_STOPS, distanceAt, travelSeconds, type StopKind, type TourStop } from './stops';
import {
  KIND_FRAME, catmullRom, clamp01, drift, layoutRoute, restEye, smootherstep, smoothstep, type Placement,
} from './route';
import { createDust } from './dust';

export interface TourEvents {
  /** The camera settled at a stop. */
  arrive(index: number): void;
  /** The camera left `from` for `to`. */
  depart(from: number, to: number, seconds: number): void;
  /** Every frame while travelling: distance from Earth (ly) and progress 0..1. */
  progress(ly: number, t: number, from: number, to: number): void;
  /** Bloom settings to blend towards. */
  bloom(b: SimObject['bloom']): void;
}

interface Trip {
  from: number;
  to: number;
  elapsed: number;
  seconds: number;
  eye0: THREE.Vector3;
  target0: THREE.Vector3;
  side: number;
}

/** Diagram overlays that are off in the tour, to keep the views clean (they stay in custom mode). */
const TOUR_DEFAULTS: Record<StopKind, Record<string, boolean>> = { planet: {}, star: {}, pulsar: { lc: false }, blackhole: {} };

export function applyValues(obj: SimObject, values: Record<string, number | string | boolean>) {
  for (const p of obj.params) {
    if (!(p.key in values)) continue;
    const v = values[p.key];
    p.value = v as never;
    (p.onChange as (x: typeof v) => void)(v);
  }
}

/**
 * The guided flight from Earth to the most distant object, in the manner of a
 * homepage "galaxy flight": every real object hangs at its own place in one space,
 * the camera rests in front of a stop (which may be orbited), then flies a
 * Catmull–Rom curve to the next, easing out and in, looking ahead, banking a little.
 */
export class Tour {
  readonly stops: TourStop[] = TOUR_STOPS;
  readonly root = new THREE.Group();
  index = 0;
  trip: Trip | null = null;
  autoplay = false;
  /** Seconds to linger at each stop while auto-playing. */
  dwell = 9;

  private placements: Placement[];
  private objects: (SimObject | null)[];
  private restTime = 0;
  private activeHole = -1;
  private dust = createDust();
  private prevEye = new THREE.Vector3();
  private velocity = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();

  constructor(
    private camera: THREE.PerspectiveCamera,
    private controls: OrbitControls,
    private sky: Sky,
    private factories: Record<StopKind, () => SimObject>,
    private events: TourEvents,
  ) {
    this.placements = layoutRoute(this.stops);
    this.objects = this.stops.map(() => null);
    this.root.add(this.dust.lines);
  }

  object(i: number): SimObject {
    let obj = this.objects[i];
    if (!obj) {
      const stop = this.stops[i];
      obj = this.factories[stop.kind]();
      applyValues(obj, { ...TOUR_DEFAULTS[stop.kind], ...stop.preset.values });
      obj.group.position.copy(this.placements[i].center);
      if (obj.setLightDir) {
        const sun = this.placements[Math.min(i + 1, this.stops.length - 1)].center;
        obj.setLightDir(sun.clone().sub(this.placements[i].center));
      }
      this.root.add(obj.group);
      this.objects[i] = obj;
    }
    return obj;
  }

  get aspect() { return this.camera.aspect; }

  /** Jump straight to a stop, without flying. */
  place(i: number) {
    this.trip = null;
    this.index = i;
    this.restTime = 0;
    const eye = restEye(this.placements[i], this.stops[i].kind, this.aspect);
    this.camera.up.set(0, 1, 0);
    this.camera.position.copy(eye);
    this.prevEye.copy(eye);
    this.settle(i);
    this.events.bloom(this.object(i).bloom);
    this.events.arrive(i);
  }

  private settle(i: number) {
    const f = KIND_FRAME[this.stops[i].kind];
    this.controls.target.copy(this.placements[i].center);
    this.controls.minDistance = f.min;
    this.controls.maxDistance = f.max;
    this.controls.enabled = true;
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
  }

  goTo(i: number) {
    if (i < 0 || i >= this.stops.length || i === this.index || this.trip) return;
    const seconds = travelSeconds(this.stops[this.index], this.stops[i]);
    this.trip = {
      from: this.index,
      to: i,
      elapsed: 0,
      seconds,
      eye0: this.camera.position.clone(),
      target0: this.controls.target.clone(),
      side: Math.sign(this.placements[i].center.x - this.placements[this.index].center.x) || 1,
    };
    this.controls.enabled = false;
    this.object(i);
    this.events.depart(this.index, i, seconds);
  }

  next() { this.goTo(this.index + 1); }
  prev() { this.goTo(this.index - 1); }

  /** Which stops are drawn this frame. */
  private visibleSet(): number[] {
    if (this.trip) return [this.trip.from, this.trip.to];
    const i = this.index;
    // Resting at a black hole, nothing else is drawn: the ray-traced sky must stay unobstructed.
    if (this.stops[i].kind === 'blackhole' || i + 1 >= this.stops.length) return [i];
    return [i, i + 1];
  }

  update(dt: number, time: number) {
    const cam = this.camera;
    if (this.trip) {
      const trip = this.trip;
      trip.elapsed += dt;
      const raw = clamp01(trip.elapsed / trip.seconds);
      const t = smootherstep(raw);
      const A = this.placements[trip.from], B = this.placements[trip.to];
      const eyeB = restEye(B, this.stops[trip.to].kind, this.aspect);
      catmullRom(A.center, trip.eye0, eyeB, B.center, t, cam.position);
      // Never pass through either object.
      for (const [p, k] of [[A, trip.from], [B, trip.to]] as const) {
        const minR = KIND_FRAME[this.stops[k].kind].min * 1.4;
        const v = this.tmp.subVectors(cam.position, p.center);
        if (v.length() < minR) cam.position.copy(p.center).addScaledVector(v.normalize(), minR);
      }
      const look = smoothstep(clamp01((t - 0.12) / 0.7));
      const target = this.tmp2.lerpVectors(trip.target0, B.center, look);
      // Bank gently while turning towards the next object.
      const forward = this.tmp.subVectors(target, cam.position).normalize();
      const side = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
      const bank = Math.sin(Math.PI * t) * 0.07 * trip.side;
      cam.up.set(0, 1, 0).multiplyScalar(Math.cos(bank)).addScaledVector(side, Math.sin(bank)).normalize();
      cam.lookAt(target);
      const ly = distanceAt(this.stops[trip.from], this.stops[trip.to], t);
      this.events.progress(ly, t, trip.from, trip.to);
      const a = this.object(trip.from).bloom, b = this.object(trip.to).bloom;
      this.events.bloom({
        strength: a.strength + (b.strength - a.strength) * t,
        radius: a.radius + (b.radius - a.radius) * t,
        threshold: a.threshold + (b.threshold - a.threshold) * t,
      });
      if (raw >= 1) {
        this.trip = null;
        this.index = trip.to;
        this.restTime = 0;
        this.settle(trip.to);
        this.events.arrive(trip.to);
      }
    } else {
      this.restTime += dt;
      if (this.autoplay && this.restTime > this.dwell) {
        if (this.index + 1 < this.stops.length) this.next();
        else this.autoplay = false;
      }
    }

    // Speed streaks of interstellar dust while flying.
    if (dt > 0) {
      this.tmp.subVectors(cam.position, this.prevEye).divideScalar(dt);
      this.velocity.lerp(this.tmp, 1 - Math.exp(-dt * 6));
    }
    this.prevEye.copy(cam.position);
    this.dust.update(cam.position, this.velocity, this.trip ? 1 : 0, dt);

    const visible = this.visibleSet();
    this.objects.forEach((o, i) => { if (o) o.group.visible = visible.includes(i); });
    for (const i of visible) {
      const obj = this.object(i);
      const f = KIND_FRAME[this.stops[i].kind];
      // Float gently, like the homepage galaxies (a hole stays put: its sky is ray-traced).
      if (this.stops[i].kind !== 'blackhole') {
        obj.group.position.copy(this.placements[i].center).addScaledVector(drift(i, time, this.tmp), f.extent * 0.08);
      }
      obj.update(dt, time, cam);
    }

    // The black hole (if any is drawn) lives in the sky shader.
    const hole = visible.filter((i) => this.stops[i].kind === 'blackhole')
      .sort((a, b) => this.placements[a].center.distanceTo(cam.position) - this.placements[b].center.distanceTo(cam.position))[0];
    if (hole === undefined) {
      this.sky.uniforms.uMode.value = 0;
      this.activeHole = -1;
    } else {
      this.sky.uniforms.uMode.value = 1;
      this.sky.uniforms.uHolePos.value.copy(this.placements[hole].center);
      if (this.activeHole !== hole) {
        applyValues(this.object(hole), this.stops[hole].preset.values);
        this.activeHole = hole;
      }
    }
  }

  /** Leave the tour: the sky goes back to the origin and the camera is freed. */
  dispose() {
    this.sky.uniforms.uHolePos.value.set(0, 0, 0);
    this.sky.uniforms.uMode.value = 0;
    this.activeHole = -1;
    this.trip = null;
    this.controls.enabled = true;
    this.camera.up.set(0, 1, 0);
  }

  placement(i: number) { return this.placements[i]; }
}
