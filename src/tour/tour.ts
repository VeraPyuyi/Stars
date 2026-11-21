import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Sky } from '../sky';
import type { SimObject } from '../types';
import { TOUR_STOPS, displayedRotation, type Companion, distanceAt, LEG_SECONDS, type StopKind, type TourStop } from './stops';
import {
  centripetal, clamp01, drift, frameOf, isSolar, layoutRoute, restEye, smoothstep,
  type KindFrame, type Placement,
} from './route';
import { createDust } from './dust';
import { createBeacons } from './beacons';
import { createOrbitLines } from './orbits';

/** Closest approach of a fly-by, as a fraction of the resting distance. */
const FLYBY = 0.9;

export interface TourEvents {
  /** The camera settled at a stop. */
  arrive(index: number): void;
  /** The camera is heading from `from` towards `to` (sent when the leg or direction changes). */
  depart(from: number, to: number, seconds: number): void;
  /** Every frame away from a stop: distance from Earth (ly) and progress 0..1 along the leg from→to. */
  progress(ly: number, t: number, from: number, to: number): void;
  /** The stop nearest to the camera changed (it is the one the name tag and card describe). */
  near(index: number): void;
  /** Bloom settings to blend towards. */
  bloom(b: SimObject['bloom']): void;
}

/**
 * Where the camera was (possibly orbited) when it left a stop: the flight starts from
 * there. Kept relative to the stop, which may be moving along its orbit.
 */
interface Anchor {
  index: number;
  eye: THREE.Vector3;
  target: THREE.Vector3;
}

/** Diagram overlays that are off in the tour, to keep the views clean (they stay in custom mode). */
const TOUR_DEFAULTS: Record<StopKind, Record<string, boolean>> = { planet: {}, star: {}, pulsar: { lc: false }, blackhole: {}, belt: {} };

/** How the `spin` parameter maps to angular speed (rad/s) for each kind of object. */
const SPIN_RATE: Partial<Record<StopKind, number>> = { star: 1, planet: 0.3 };

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
 * The camera flies one smooth curve past all the objects and turns to the next one ahead.
 */
export class Tour {
  readonly stops: TourStop[] = TOUR_STOPS;
  readonly root = new THREE.Group();
  /** The stop the camera last rested at. */
  index = 0;
  /** Continuous position on the route (0 … stops − 1) and where it is heading. */
  progress = 0;
  target = 0;
  /** Cruise along the route without stopping (slowing down a little past each object). */
  autoplay = false;

  private placements: Placement[];
  private frames: KindFrame[];
  private objects: (SimObject | null)[];
  /** Index of the Sun and of the last stop inside the solar system. */
  private sun: number;
  private lastSolar: number;
  private orbits: ReturnType<typeof createOrbitLines>;
  /** Route speed (stops per second) of the camera. */
  private speed = 0;
  /** Camera pose when it arrived, blended into the resting view so arrival never snaps. */
  private arriveQuat = new THREE.Quaternion();
  private arriveBlend = 0;
  private wantQuat = new THREE.Quaternion();
  private shownQuat = new THREE.Quaternion();
  private e0 = new THREE.Vector3();
  /** Planets of other stars, moved round their star every frame. */
  private companions: { stop: number; c: Companion; planet: SimObject; ring: THREE.LineLoop; phase: number }[] = [];
  /** How far the path is being pulled in to the stop the camera was sent to (0…1). */
  private arriveAmt = 0;
  private e1 = new THREE.Vector3();
  private e2 = new THREE.Vector3();
  private e3 = new THREE.Vector3();
  private fa = new THREE.Vector3();
  private lookQ = new THREE.Quaternion();
  private lookM = new THREE.Matrix4();
  private nearest = -1;
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
    this.frames = this.stops.map(frameOf);
    this.objects = this.stops.map(() => null);
    this.sun = this.stops.findIndex((s) => s.id === 'sun');
    this.lastSolar = this.stops.reduce((m, s, i) => (isSolar(s) ? i : m), 0);
    this.root.add(this.dust.lines);
    this.beacons = createBeacons(this.stops, this.placements.map((p) => p.center));
    this.root.add(this.beacons.points);
    this.orbits = createOrbitLines(this.stops);
    this.root.add(this.orbits.lines);
  }

  private beacons: ReturnType<typeof createBeacons>;

  /**
   * Build every object and compile all their shaders up front. Done lazily, the first
   * frame an object appeared in would stall while its shaders compiled: a visible hitch
   * on arriving at each new kind of object.
   */
  prewarm(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
    this.stops.forEach((_, i) => { this.object(i).group.visible = true; });
    this.orbits.lines.visible = true;
    renderer.compileAsync(scene, this.camera).catch(() => { /* compiled on first use instead */ });
  }

  /**
   * The stop whose object is under the pointer (canvas pixels), nearest first, or −1.
   * Generous: anything within the object's disc, or 28 px of its centre, counts.
   */
  pick(x: number, y: number, w: number, h: number): number {
    let best = -1, bestDist = Infinity;
    const focal = (h / 2) * this.camera.projectionMatrix.elements[5];
    this.objects.forEach((o, i) => {
      const stop = this.stops[i];
      if (!o || !o.group.visible || stop.kind === 'belt') return;
      const c = this.placements[i].center;
      const v = this.tmp.copy(c).applyMatrix4(this.camera.matrixWorldInverse);
      if (v.z > -1e-3) return; // behind the camera
      const ring = stop.preset.values.type === 'saturn' || stop.preset.values.type === 'gas';
      const R = stop.kind === 'planet' ? stop.scale * (ring ? 2.4 : 1.1)
        : stop.kind === 'star' ? 1.2 : stop.kind === 'pulsar' ? 4 : 8;
      const p = this.tmp2.copy(c).project(this.camera);
      const sx = (p.x + 1) / 2 * w, sy = (1 - p.y) / 2 * h;
      const reach = Math.max((R / -v.z) * focal, 28);
      const d = Math.hypot(sx - x, sy - y);
      if (d < reach && -v.z < bestDist) { best = i; bestDist = -v.z; }
    });
    return best;
  }

  /** Device-pixel scale for the distant points of light. */
  setPixelRatio(r: number) { this.beacons.uniforms.uScale.value = r; }

  object(i: number): SimObject {
    let obj = this.objects[i];
    if (!obj) {
      const stop = this.stops[i];
      obj = this.factories[stop.kind]();
      const values: Record<string, number | string | boolean> = { ...TOUR_DEFAULTS[stop.kind], ...stop.preset.values };
      // Real rotation periods, sped up (and compressed) so that every body visibly turns.
      const rate = SPIN_RATE[stop.kind];
      if (stop.rotHours && rate) values.spin = (2 * Math.PI) / displayedRotation(stop.rotHours) / rate;
      applyValues(obj, values);
      obj.group.scale.setScalar(stop.scale);
      obj.group.position.copy(stop.kind === 'belt' ? this.placements[this.sun].center : this.placements[i].center);
      if (obj.setLightDir) obj.setLightDir(this.lightDir(i));
      this.root.add(obj.group);
      this.objects[i] = obj;
      for (const c of stop.companions ?? []) {
        const planet = this.factories.planet();
        applyValues(planet, { ...c.values, spin: 0.6 });
        planet.group.scale.setScalar(c.scale);
        const ring = new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(Array.from({ length: 128 }, (_, n) => {
            const a = (n / 128) * Math.PI * 2;
            return new THREE.Vector3(Math.cos(a) * c.r, 0, Math.sin(a) * c.r);
          })),
          new THREE.LineBasicMaterial({ color: 0x4a5a78, transparent: true, opacity: 0.35, depthWrite: false }),
        );
        this.root.add(planet.group, ring);
        this.companions.push({ stop: i, c, planet, ring, phase: this.companions.length * 2.1 });
      }
    }
    return obj;
  }

  /** Planets are lit by the Sun; the light direction of an interstellar planet would be the next stop. */
  private lightDir(i: number) {
    const from = isSolar(this.stops[i]) ? this.sun : Math.min(i + 1, this.last);
    return this.tmp3.subVectors(this.placements[from].center, this.placements[i].center);
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
    this.speed = 0;
    this.camera.position.copy(restEye(this.placements[i], this.frames[i], this.aspect));
    this.prevEye.copy(this.camera.position);
    this.settle(i);
    this.arriveBlend = 0;
    this.camera.lookAt(this.controls.target);
  }

  private settle(i: number) {
    const f = this.frames[i];
    this.resting = true;
    this.index = i;
    this.leg = '';
    this.speed = 0;
    // Arrive with the flight's pose and ease into the resting one (no snap of roll or aim).
    this.arriveQuat.copy(this.camera.quaternion);
    this.arriveBlend = 1;
    const back = this.anchor?.index === i ? this.anchor : null;
    this.controls.target.copy(this.placements[i].center);
    if (back) this.controls.target.add(back.target);
    this.controls.minDistance = f.min;
    this.controls.maxDistance = f.max;
    this.controls.enabled = true;
    this.camera.up.set(0, 1, 0);
    this.controls.update();
    this.camera.quaternion.copy(this.arriveQuat);
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
    // No snapping to stops: the camera flies straight past them while the input goes on.
    const t = THREE.MathUtils.clamp(this.target + delta, this.progress - lead, this.progress + lead);
    this.target = THREE.MathUtils.clamp(t, 0, this.last);
  }

  /** Stop where the camera is now (coasting to a halt rather than braking at once). */
  hold() {
    this.autoplay = false;
    this.target = THREE.MathUtils.clamp(this.progress + this.speed * 0.5, 0, this.last);
  }

  /** Cruise along the whole route, or stop cruising. */
  setAutoplay(on: boolean) {
    this.autoplay = on && this.progress < this.last;
    if (this.autoplay) this.target = this.last;
    else if (this.target !== Math.round(this.target)) this.hold();
  }

  /** Fly to stop i and stop there. */
  goTo(i: number) {
    this.autoplay = false;
    this.target = THREE.MathUtils.clamp(i, 0, this.last);
  }

  /** The stop ahead / behind in the direction asked, from wherever the camera is. */
  next() { const b = this.autoplay ? this.progress : this.target; this.goTo(Math.floor(b + 1e-6) + 1); }
  prev() { const b = this.autoplay ? this.progress : this.target; this.goTo(Math.ceil(b - 1e-6) - 1); }

  /** Index of the stop nearest along the route. */
  get current() { return Math.round(this.progress); }

  /** Where the fly-by passes stop k: in the direction of its resting view, a little closer. */
  private railAt(k: number, out: THREE.Vector3) {
    const pl = this.placements[k];
    restEye(pl, this.frames[k], this.aspect, out);
    return out.sub(pl.center).multiplyScalar(FLYBY).add(pl.center);
  }

  /** Point u (0–1, along the curve) of leg j of the rail. */
  private railPoint(j: number, u: number, out: THREE.Vector3) {
    const e0 = j > 0 ? this.railAt(j - 1, this.e0) : this.e0.copy(this.placements[j].center);
    const e1 = this.railAt(j, this.e1), e2 = this.railAt(j + 1, this.e2);
    const e3 = j + 2 <= this.last ? this.railAt(j + 2, this.e3) : this.e3.copy(this.placements[j + 1].center);
    return centripetal(e0, e1, e2, e3, u, out);
  }

  /** Speed of the rail along leg j, per unit of u, at its start (end = false) or end. */
  private railRate(j: number, end: boolean) {
    const u0 = end ? 1 - 1e-3 : 0, u1 = end ? 1 : 1e-3;
    const a = this.railPoint(j, u0, this.fa).clone();
    return a.distanceTo(this.railPoint(j, u1, this.fa)) / 1e-3;
  }

  /**
   * Speed of the fly-by past stop k, in world units per second: slow enough for the
   * object to drift across the view (about 20°/s), never faster than an even pace
   * along either neighbouring leg.
   */
  private passSpeed(k: number) {
    const d = this.railAt(k, this.fa).distanceTo(this.placements[k].center);
    let v = 0.35 * d;
    if (k > 0) v = Math.min(v, this.railRate(k - 1, true) / LEG_SECONDS);
    if (k < this.last) v = Math.min(v, this.railRate(k, false) / LEG_SECONDS);
    return v;
  }

  /**
   * Time to distance along leg j: every leg lasts the same, so a long leg cannot be
   * flown at an even pace. Instead the camera passes each object slowly (the speed
   * passSpeed gives, matched on both sides of it), speeds up in between and slows
   * down again for the next one: u'(t) runs from a to b with a smooth bump on top.
   */
  private warp(j: number, t: number) {
    const a = Math.min(1, (this.passSpeed(j) * LEG_SECONDS) / this.railRate(j, false));
    const b = Math.min(1, (this.passSpeed(j + 1) * LEG_SECONDS) / this.railRate(j, true));
    const m = Math.max(0, 1 - (a + b) / 2);
    const S = t * t * t - (t * t * t * t) / 2; // ∫ smoothstep
    // ∫ of the unit bump 140·t³(1−t)³: flat at both ends, so the camera eases away from an
    // object it has just passed instead of shooting off while still close to it.
    const t4 = t * t * t * t;
    const B = t4 * (35 + t * (-84 + t * (70 - 20 * t)));
    return a * (t - S) + b * S + m * B;
  }

  /** Resting eye of stop k (or the orbited view the camera left it from). */
  private eyeAt(k: number, out: THREE.Vector3) {
    const pl = this.placements[k];
    if (this.anchor?.index === k) return out.copy(pl.center).add(this.anchor.eye);
    return restEye(pl, this.frames[k], this.aspect, out);
  }

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
    let gap = this.target - this.progress;
    if (Math.abs(gap) < 1e-6) {
      this.speed = 0;
      // Came to a halt practically on a stop: settle there (only when really close, so
      // stopping the wheel near an object does not pull the camera onto it).
      const r = Math.round(this.progress);
      if (!this.resting && !this.autoplay && Math.abs(this.progress - r) < 0.025 && this.progress !== r) this.target = r;
      gap = this.target - this.progress;
      if (Math.abs(gap) < 1e-6) return;
    }
    if (this.resting) {
      // Leaving a stop: remember the (possibly orbited) view, the flight starts from it.
      this.resting = false;
      this.controls.enabled = false;
      // Start turning from the pose shown last frame (OrbitControls may have re-aimed it since).
      this.camera.quaternion.copy(this.shownQuat);
      this.arriveBlend = 0;
      const c = this.placements[this.index].center;
      this.anchor = {
        index: this.index,
        eye: this.camera.position.clone().sub(c),
        target: this.controls.target.clone().sub(c),
      };
    }
    // The camera has inertia: it speeds up and slows down smoothly towards the speed that
    // would bring it to the target, never faster than one leg per LEG_SECONDS (far jumps,
    // clicking a distant stop, are allowed to go proportionally faster).
    const seconds = LEG_SECONDS;
    // (Passing each object slowly is left to the rail's time warp, so cruising never stops.)
    const vmax = (1 / seconds) * (this.autoplay ? 1 : Math.max(1, Math.abs(gap) / 2.5));
    let want = THREE.MathUtils.clamp(gap * 1.8, -vmax, vmax);
    // A minimum pace near the end, so arriving does not crawl forever.
    if (Math.abs(want) < 0.05) want = Math.sign(gap) * 0.05;
    const accel = (1 / seconds / 0.9) * dt * (this.autoplay ? 1 : Math.max(1, Math.abs(gap) / 2.5));
    this.speed += THREE.MathUtils.clamp(want - this.speed, -accel, accel);
    const before = Math.sign(gap);
    this.progress += this.speed * dt;
    const after = Math.sign(this.target - this.progress);
    if (after !== before && before * this.speed > 0) {
      this.progress = this.target;
      this.speed = 0;
    }
    this.progress = THREE.MathUtils.clamp(this.progress, 0, this.last);
  }


  update(dt: number, time: number) {
    const cam = this.camera;
    this.advance(dt);

    if (!this.resting) {
      const p = this.progress;
      const i = Math.min(this.last - 1, Math.floor(p));
      const t = p - i;
      const A = this.placements[i], B = this.placements[i + 1];
      const anchorA = this.anchor?.index === i ? this.anchor : null;
      const anchorB = this.anchor?.index === i + 1 ? this.anchor : null;
      // The flight follows a planned "rail": one smooth curve (centripetal Catmull–Rom)
      // through points beside each object, about twice the resting distance away, so the
      // camera sweeps past objects instead of diving at each one. Only the stop it is leaving
      // and the stop it has been sent to (a stop, not a point between two) pull the path
      // in to their resting view, smoothly, over the last or first part of the leg.
      this.railPoint(i, this.warp(i, t), cam.position);
      if (this.anchor) {
        const w = 1 - smoothstep(clamp01(Math.abs(p - this.anchor.index) / 0.7));
        if (w > 0) cam.position.lerp(this.eyeAt(this.anchor.index, this.e0), w);
      }
      const docking = Number.isInteger(this.target);
      this.arriveAmt += ((docking ? 1 : 0) - this.arriveAmt) * (1 - Math.exp(-dt * 2.5));
      if (docking) {
        const w = this.arriveAmt * (1 - smoothstep(clamp01(Math.abs(p - this.target) / 0.7)));
        if (w > 0) cam.position.lerp(this.eyeAt(this.target, this.e0), w);
      }
      // Never pass through either object: inside twice the safety radius R the distance d is
      // eased to R + d²/4R (smooth, and the identity outside), so the path bends round it.
      for (const k of [i, i + 1]) {
        const R = this.frames[k].min * 1.4;
        const v = this.tmp.subVectors(cam.position, this.placements[k].center);
        const d = v.length();
        if (d < 2 * R) cam.position.copy(this.placements[k].center).addScaledVector(v.normalize(), R + (d * d) / (4 * R));
      }
      // Look at the object until it is passed, then turn smoothly to the next one ahead
      // (the camera is off to the side of the route, so the point looked at never comes near it).
      const ahead = this.target >= p;
      // The turn is a blend of the two view directions (not of the two points, whose
      // in-between point would swing round fast while the camera is close to the object),
      // spread over half the leg's time.
      const look = ahead ? smoothstep(clamp01(t / 0.5)) : 1 - smoothstep(clamp01((1 - t) / 0.5));
      const targetA = anchorA ? A.center.clone().add(anchorA.target) : A.center;
      const targetB = anchorB ? B.center.clone().add(anchorB.target) : B.center;
      this.wantQuat.setFromRotationMatrix(this.lookM.lookAt(cam.position, targetA, this.tmp.set(0, 1, 0)));
      this.lookQ.setFromRotationMatrix(this.lookM.lookAt(cam.position, targetB, this.tmp.set(0, 1, 0)));
      this.wantQuat.slerp(this.lookQ, look);
      // The camera turns with a little lag and a capped rate, never with a jerk.
      const gapAngle = cam.quaternion.angleTo(this.wantQuat);
      if (gapAngle > 1e-6) {
        const step = Math.min(gapAngle * (1 - Math.exp(-dt * 4)), 1.4 * dt);
        cam.quaternion.slerp(this.wantQuat, step / gapAngle);
      }
      cam.up.set(0, 1, 0);

      const forwardLeg = this.target >= p;
      const legKey = `${i}:${forwardLeg}`;
      if (legKey !== this.leg) {
        this.leg = legKey;
        const from = forwardLeg ? i : i + 1, to = forwardLeg ? i + 1 : i;
        this.events.depart(from, to, LEG_SECONDS);
      }
      this.events.progress(distanceAt(this.stops[i], this.stops[i + 1], t), t, i, i + 1);
      const a = this.object(i).bloom, b = this.object(i + 1).bloom;
      this.events.bloom({
        strength: a.strength + (b.strength - a.strength) * t,
        radius: a.radius + (b.radius - a.radius) * t,
        threshold: a.threshold + (b.threshold - a.threshold) * t,
      });
      if (this.progress === this.target && Number.isInteger(this.target) && this.arriveAmt > 0.98) {
        if (this.autoplay) this.autoplay = false;
        this.settle(this.target);
      }
    } else {
      if (this.autoplay) this.target = this.last;
      // Ease from the pose the flight arrived with into the resting view.
      if (this.arriveBlend > 0) {
        this.arriveBlend = Math.max(0, this.arriveBlend - dt / 0.9);
        const k = smoothstep(this.arriveBlend);
        this.wantQuat.copy(cam.quaternion);
        cam.quaternion.copy(this.arriveQuat).slerp(this.wantQuat, 1 - k);
      }
    }

    // Speed streaks of interstellar dust while flying (not inside the solar system).
    if (dt > 0) {
      this.tmp.subVectors(cam.position, this.prevEye).divideScalar(dt);
      this.velocity.lerp(this.tmp, 1 - Math.exp(-dt * 6));
    }
    this.prevEye.copy(cam.position);
    const here = this.resting ? this.index : Math.floor(this.progress);
    const inSolar = here <= this.lastSolar;
    this.dust.update(cam.position, this.velocity, !this.resting && Math.ceil(this.progress) > this.lastSolar ? 1 : 0, dt);

    const visible = this.visibleSet();
    // The Sun and the asteroid belt stay in view anywhere in the solar system.
    if (inSolar) {
      for (const k of this.stops.map((s, j) => (s.id === 'sun' || s.kind === 'belt' ? j : -1))) {
        if (k >= 0 && !visible.includes(k)) visible.push(k);
      }
    }
    this.orbits.lines.visible = inSolar;
    this.beacons.setPositions(this.placements.map((pl) => pl.center));
    this.objects.forEach((o, i) => { if (o) o.group.visible = visible.includes(i); });
    for (const i of visible) {
      const obj = this.object(i);
      const stop = this.stops[i];
      if (stop.kind === 'belt') obj.group.position.copy(this.placements[this.sun].center);
      else if (isSolar(stop)) obj.group.position.copy(this.placements[i].center);
      // Float gently, like the homepage galaxies (a hole stays put: its sky is ray-traced).
      else if (stop.kind !== 'blackhole') {
        obj.group.position.copy(this.placements[i].center).addScaledVector(drift(i, time, this.tmp), this.frames[i].extent * 0.08);
      }
      if (obj.setLightDir) obj.setLightDir(this.lightDir(i));
      obj.update(dt, time, cam);
    }
    // Planets of other stars: on orbits tilted 25° to the star's equator.
    for (const k of this.companions) {
      const star = this.objects[k.stop]!;
      const on = star.group.visible;
      k.planet.group.visible = on;
      k.ring.visible = on;
      if (!on) continue;
      const a = k.phase + (time * 2 * Math.PI) / k.c.seconds;
      const tilt = 0.44;
      k.ring.position.copy(star.group.position);
      k.ring.rotation.set(tilt, 0, 0);
      k.planet.group.position.set(Math.cos(a) * k.c.r, 0, Math.sin(a) * k.c.r)
        .applyEuler(k.ring.rotation).add(star.group.position);
      k.planet.setLightDir?.(this.tmp.subVectors(star.group.position, k.planet.group.position));
      k.planet.update(dt, time, cam);
    }

    this.shownQuat.copy(cam.quaternion);
    if (this.current !== this.nearest) {
      this.nearest = this.current;
      this.events.near(this.nearest);
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
