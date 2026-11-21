import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Sky } from '../sky';
import type { SimObject } from '../types';
import { TOUR_STOPS, distanceAt, travelSeconds, type StopKind, type TourStop } from './stops';
import {
  KIND_FRAME, catmullRom, clamp01, drift, layoutRoute, restEye, smootherstep, smoothstep, type Placement,
} from './route';
import { createDust } from './dust';
import { createBeacons } from './beacons';

export interface TourEvents {
  /** The camera settled at a stop. */
  arrive(index: number): void;
  /** The camera is heading from `from` towards `to` (sent when the leg or direction changes). */
  depart(from: number, to: number, seconds: number): void;
  /** Every frame away from a stop: distance from Earth (ly) and progress 0..1 along the leg from→to. */
  progress(ly: number, t: number, from: number, to: number): void;
  /** Bloom settings to blend towards. */
  bloom(b: SimObject['bloom']): void;
}

/** Where the camera was (possibly orbited) when it left a stop: the flight starts from there. */
interface Anchor {
  index: number;
  eye: THREE.Vector3;
  target: THREE.Vector3;
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
 * and the camera's place on the route is one continuous number, `progress`
 * (integers are the stops). The wheel moves the target progress freely, so the
 * flight can be stopped half-way or reversed; the camera follows it with a speed
 * limit set by the real distance of each leg, so a long leg always takes longer.
 * Between stops the camera flies a Catmull–Rom curve, looks ahead, banks a little.
 */
export class Tour {
  readonly stops: TourStop[] = TOUR_STOPS;
  readonly root = new THREE.Group();
  /** The stop the camera last rested at. */
  index = 0;
  /** Continuous position on the route (0 … stops − 1) and where it is heading. */
  progress = 0;
  target = 0;
  autoplay = false;
  /** Seconds to linger at each stop while auto-playing. */
  dwell = 9;

  private placements: Placement[];
  private objects: (SimObject | null)[];
  private restTime = 0;
  private resting = true;
  private anchor: Anchor | null = null;
  private leg = '';
  private activeHole = -1;
  private dust = createDust();
  private prevEye = new THREE.Vector3();
  private velocity = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private tmp3 = new THREE.Vector3();

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
    this.beacons = createBeacons(this.stops, this.placements.map((p) => p.center));
    this.root.add(this.beacons.points);
  }

  private beacons: ReturnType<typeof createBeacons>;

  /** Device-pixel scale for the distant points of light. */
  setPixelRatio(r: number) { this.beacons.uniforms.uScale.value = r; }

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
  get last() { return this.stops.length - 1; }
  /** True while the camera is away from a stop (flying, or paused between two). */
  get moving() { return !this.resting; }

  /** Jump straight to a stop, without flying. */
  place(i: number) {
    this.progress = this.target = i;
    this.index = i;
    this.anchor = null;
    this.camera.position.copy(restEye(this.placements[i], this.stops[i].kind, this.aspect));
    this.prevEye.copy(this.camera.position);
    this.settle(i);
  }

  private settle(i: number) {
    const f = KIND_FRAME[this.stops[i].kind];
    this.resting = true;
    this.restTime = 0;
    this.index = i;
    this.leg = '';
    this.controls.target.copy(this.placements[i].center);
    this.controls.minDistance = f.min;
    this.controls.maxDistance = f.max;
    this.controls.enabled = true;
    this.camera.up.set(0, 1, 0);
    if (!this.anchor || this.anchor.index !== i) this.camera.lookAt(this.controls.target);
    this.controls.update();
    this.anchor = null;
    this.events.bloom(this.object(i).bloom);
    this.events.arrive(i);
  }

  /**
   * Manual control (wheel, hold buttons): move the target by `delta` stops, but keep
   * it close to the camera so the flight stops soon after the input stops.
   */
  nudge(delta: number, lead = 0.2) {
    this.autoplay = false;
    let t = THREE.MathUtils.clamp(this.target + delta, this.progress - lead, this.progress + lead);
    // Close to a stop: settle on it rather than hovering just short of it.
    if (Math.abs(t - Math.round(t)) < 0.03) t = Math.round(t);
    this.target = THREE.MathUtils.clamp(t, 0, this.last);
  }

  /** Stop where the camera is now. */
  hold() { this.target = this.progress; this.autoplay = false; }

  /** Fly to stop i. */
  goTo(i: number) {
    this.target = THREE.MathUtils.clamp(i, 0, this.last);
  }

  /** The stop ahead / behind in the direction asked, from wherever the camera is. */
  next() { this.goTo(Math.floor(this.target + 1e-6) + 1); }
  prev() { this.goTo(Math.ceil(this.target - 1e-6) - 1); }

  /** Which stops are drawn this frame. */
  private visibleSet(): number[] {
    if (!this.resting) {
      const i = Math.min(this.last - 1, Math.floor(this.progress));
      return [i, i + 1];
    }
    const i = this.index;
    // Resting at a black hole, nothing else is drawn: the ray-traced sky must stay unobstructed.
    if (this.stops[i].kind === 'blackhole' || i + 1 > this.last) return [i];
    return [i, i + 1];
  }

  private advance(dt: number) {
    const gap = this.target - this.progress;
    if (Math.abs(gap) < 1e-6) return;
    if (this.resting) {
      // Leaving a stop: remember the (possibly orbited) view, the flight starts from it.
      this.resting = false;
      this.controls.enabled = false;
      this.anchor = { index: this.index, eye: this.camera.position.clone(), target: this.controls.target.clone() };
    }
    // Follow the target smoothly, never faster than the leg's real-distance pace;
    // far jumps (clicking a distant stop) are allowed to go proportionally faster.
    const i = Math.min(this.last - 1, Math.floor(gap > 0 ? this.progress : this.progress - 1e-6));
    const seconds = travelSeconds(this.stops[Math.max(0, i)], this.stops[Math.max(0, i) + 1]);
    const maxStep = (dt / seconds) * Math.max(1, Math.abs(gap) / 2.5);
    let step = gap * (1 - Math.exp(-dt * 2.2));
    // A minimum pace near the end, so arriving does not crawl forever.
    if (Math.abs(step) < dt * 0.04) step = Math.sign(gap) * Math.min(Math.abs(gap), dt * 0.04);
    step = THREE.MathUtils.clamp(step, -maxStep, maxStep);
    this.progress += step;
    if (Math.abs(this.target - this.progress) < 1e-4) this.progress = this.target;
  }

  update(dt: number, time: number) {
    const cam = this.camera;
    this.advance(dt);

    if (!this.resting) {
      const p = this.progress;
      const i = Math.min(this.last - 1, Math.floor(p));
      const raw = p - i;
      // Linger a little near each stop, travel faster in between.
      const t = raw + (smootherstep(raw) - raw) * 0.6;
      const A = this.placements[i], B = this.placements[i + 1];
      const anchorA = this.anchor?.index === i ? this.anchor : null;
      const anchorB = this.anchor?.index === i + 1 ? this.anchor : null;
      const eyeA = anchorA?.eye ?? restEye(A, this.stops[i].kind, this.aspect);
      const eyeB = anchorB?.eye ?? restEye(B, this.stops[i + 1].kind, this.aspect);
      catmullRom(A.center, eyeA, eyeB, B.center, t, cam.position);
      // Never pass through either object.
      for (const [pl, k] of [[A, i], [B, i + 1]] as const) {
        const minR = KIND_FRAME[this.stops[k].kind].min * 1.4;
        const v = this.tmp.subVectors(cam.position, pl.center);
        if (v.length() < minR) cam.position.copy(pl.center).addScaledVector(v.normalize(), minR);
      }
      const look = smoothstep(clamp01((t - 0.12) / 0.7));
      const targetA = anchorA?.target ?? A.center, targetB = anchorB?.target ?? B.center;
      const target = this.tmp2.lerpVectors(targetA, targetB, look);
      // Bank gently while turning towards the next object.
      const forward = this.tmp.subVectors(target, cam.position).normalize();
      const side = this.tmp3.crossVectors(forward, cam.up.set(0, 1, 0)).normalize();
      const turn = Math.sign(B.center.x - A.center.x) || 1;
      const bank = Math.sin(Math.PI * t) * 0.07 * turn;
      cam.up.multiplyScalar(Math.cos(bank)).addScaledVector(side, Math.sin(bank)).normalize();
      cam.lookAt(target);

      const forwardLeg = this.target >= p;
      const legKey = `${i}:${forwardLeg}`;
      if (legKey !== this.leg) {
        this.leg = legKey;
        const from = forwardLeg ? i : i + 1, to = forwardLeg ? i + 1 : i;
        this.events.depart(from, to, travelSeconds(this.stops[i], this.stops[i + 1]));
      }
      this.events.progress(distanceAt(this.stops[i], this.stops[i + 1], t), t, i, i + 1);
      const a = this.object(i).bloom, b = this.object(i + 1).bloom;
      this.events.bloom({
        strength: a.strength + (b.strength - a.strength) * t,
        radius: a.radius + (b.radius - a.radius) * t,
        threshold: a.threshold + (b.threshold - a.threshold) * t,
      });
      if (this.progress === this.target && Number.isInteger(this.target)) this.settle(this.target);
    } else {
      this.restTime += dt;
      if (this.autoplay && this.restTime > this.dwell) {
        if (this.index < this.last) this.goTo(this.index + 1);
        else this.autoplay = false;
      }
    }

    // Speed streaks of interstellar dust while flying.
    if (dt > 0) {
      this.tmp.subVectors(cam.position, this.prevEye).divideScalar(dt);
      this.velocity.lerp(this.tmp, 1 - Math.exp(-dt * 6));
    }
    this.prevEye.copy(cam.position);
    this.dust.update(cam.position, this.velocity, this.resting ? 0 : 1, dt);

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
    // Come back to the nearest stop next time.
    this.place(Math.round(this.progress));
    this.controls.enabled = true;
    this.camera.up.set(0, 1, 0);
  }

  placement(i: number) { return this.placements[i]; }
}
