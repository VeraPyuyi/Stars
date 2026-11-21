import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Sky } from '../sky';
import type { SimObject } from '../types';
import { TOUR_STOPS, displayedRotation, distanceAt, travelSeconds, type StopKind, type TourStop } from './stops';
import {
  clamp01, drift, flightPath, frameOf, isSolar, layoutRoute, restEye, smootherstep, smoothstep, updateOrbits,
  type KindFrame, type Placement,
} from './route';
import { createDust } from './dust';
import { createBeacons } from './beacons';
import { createOrbitLines } from './orbits';

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
  private lookQ = new THREE.Quaternion();
  private shownQuat = new THREE.Quaternion();
  private turnLeg = '';
  private lastYaw = 0;
  private lookM = new THREE.Matrix4();
  /** Pointer position (−1…1) for a gentle parallax at rest, smoothed, and the offset applied. */
  private pointer = new THREE.Vector2();
  private pointerSmooth = new THREE.Vector2();
  private parallax = new THREE.Vector3();
  private lastCenter = new THREE.Vector3();
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
    }
    return obj;
  }

  /** Planets are lit by the Sun; the light direction of an interstellar planet would be the next stop. */
  private lightDir(i: number) {
    const from = isSolar(this.stops[i]) ? this.sun : Math.min(i + 1, this.last);
    return this.tmp3.subVectors(this.placements[from].center, this.placements[i].center);
  }

  /** Turn the Sun's resting view towards `from` (keeping the preset's height above the plane). */
  private faceSun(from: THREE.Vector3) {
    const S = this.placements[this.sun];
    const el = Math.asin(THREE.MathUtils.clamp(S.view.y, -1, 1));
    const az = Math.atan2(from.x - S.center.x, from.z - S.center.z) + 0.35;
    S.view.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
  }

  /** Pointer position over the canvas, −1…1, for a slight parallax at rest. */
  setPointer(x: number, y: number) { this.pointer.set(x, y); }

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
    this.restTime = 0;
    this.index = i;
    this.leg = '';
    this.speed = 0;
    this.lastCenter.copy(this.placements[i].center);
    this.parallax.set(0, 0, 0);
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
      // Start turning from the pose shown last frame (OrbitControls may have re-aimed it since).
      this.camera.quaternion.copy(this.shownQuat);
      this.arriveBlend = 0;
      const c = this.placements[this.index].center;
      this.camera.position.sub(this.parallax);
      this.parallax.set(0, 0, 0);
      this.anchor = {
        index: this.index,
        eye: this.camera.position.clone().sub(c),
        target: this.controls.target.clone().sub(c),
      };
    }
    // The camera has inertia: it speeds up and slows down smoothly towards the speed that
    // would bring it to the target, never faster than the leg's real-distance pace
    // (far jumps, clicking a distant stop, are allowed to go proportionally faster).
    const i = Math.min(this.last - 1, Math.floor(gap > 0 ? this.progress : this.progress - 1e-6));
    const seconds = travelSeconds(this.stops[Math.max(0, i)], this.stops[Math.max(0, i) + 1]);
    const vmax = (1 / seconds) * Math.max(1, Math.abs(gap) / 2.5);
    let want = THREE.MathUtils.clamp(gap * 1.8, -vmax, vmax);
    // A minimum pace near the end, so arriving does not crawl forever.
    if (Math.abs(want) < 0.05) want = Math.sign(gap) * 0.05;
    const accel = (vmax / 0.9) * dt;
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

  /** Undo last frame's parallax offset, before OrbitControls reads the camera. */
  unparallax() {
    this.camera.position.sub(this.parallax);
    this.parallax.set(0, 0, 0);
  }

  update(dt: number, time: number) {
    const cam = this.camera;
    updateOrbits(this.stops, this.placements, time);
    if (this.resting) {
      // Ride along with a planet on its orbit (before leaving, so the flight starts from here).
      const c = this.placements[this.index].center;
      this.tmp.subVectors(c, this.lastCenter);
      cam.position.add(this.tmp);
      this.controls.target.add(this.tmp);
      this.lastCenter.copy(c);
    }
    this.advance(dt);

    if (!this.resting) {
      const p = this.progress;
      const i = Math.min(this.last - 1, Math.floor(p));
      const raw = p - i;
      // Linger a little near each stop, travel faster in between.
      const t = raw + (smootherstep(raw) - raw) * 0.35;
      const A = this.placements[i], B = this.placements[i + 1];
      const anchorA = this.anchor?.index === i ? this.anchor : null;
      const anchorB = this.anchor?.index === i + 1 ? this.anchor : null;
      // The Sun is approached (or left) from the side of the planet at the other end of the leg.
      // (Not on the arrival frame itself, which sits at the start of the following leg.)
      if (raw > 0 && i + 1 === this.sun) this.faceSun(A.center);
      else if (raw > 0 && i === this.sun) this.faceSun(B.center);
      const eyeA = anchorA ? A.center.clone().add(anchorA.eye) : restEye(A, this.frames[i], this.aspect);
      const eyeB = anchorB ? B.center.clone().add(anchorB.eye) : restEye(B, this.frames[i + 1], this.aspect);
      flightPath(A.center, eyeA, eyeB, B.center, t, cam.position);
      // Inside the solar system, fly over the Sun rather than through it.
      if (i + 1 <= this.lastSolar && i !== this.sun && i + 1 !== this.sun) {
        const S = this.placements[this.sun].center;
        const h = Math.hypot(cam.position.x - S.x, cam.position.z - S.z);
        cam.position.y += 4.5 * Math.exp(-((h / 4) ** 2));
      }
      // Never pass through either object.
      for (const k of [i, i + 1]) {
        const minR = this.frames[k].min * 1.4;
        const v = this.tmp.subVectors(cam.position, this.placements[k].center);
        if (v.length() < minR) cam.position.copy(this.placements[k].center).addScaledVector(v.normalize(), minR);
      }
      // Turn towards where the flight is heading early, while still close to the stop
      // being left, then fly facing it. The turn interpolates yaw and pitch, and keeps the
      // same turning direction for the whole leg, so it never flips half-way.
      const ahead = this.target >= p;
      const look = ahead ? smoothstep(clamp01((t - 0.03) / 0.6)) : 1 - smoothstep(clamp01((0.97 - t) / 0.6));
      const targetA = anchorA ? A.center.clone().add(anchorA.target) : A.center;
      const targetB = anchorB ? B.center.clone().add(anchorB.target) : B.center;
      const dA = this.tmp.subVectors(targetA, cam.position).normalize();
      const dB = this.tmp2.subVectors(targetB, cam.position).normalize();
      const yawA = Math.atan2(dA.x, dA.z), yawB = Math.atan2(dB.x, dB.z);
      let dyaw = Math.atan2(Math.sin(yawB - yawA), Math.cos(yawB - yawA));
      const legId = `${i}:${ahead}`;
      // Unwrap against last frame's value, so the turn stays continuous past ±180°.
      if (legId !== this.turnLeg) this.turnLeg = legId;
      else dyaw += 2 * Math.PI * Math.round((this.lastYaw - dyaw) / (2 * Math.PI));
      this.lastYaw = dyaw;
      const yaw = yawA + dyaw * look;
      const pitch = Math.asin(THREE.MathUtils.clamp(dA.y, -1, 1)) * (1 - look) + Math.asin(THREE.MathUtils.clamp(dB.y, -1, 1)) * look;
      const dir = this.tmp3.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
      this.wantQuat.setFromRotationMatrix(this.lookM.lookAt(cam.position, dir.add(cam.position), this.tmp.set(0, 1, 0)));
      // Bank gently while turning towards the next object.
      const turn = Math.sign(B.center.x - A.center.x) || 1;
      const bank = Math.sin(Math.PI * t) * 0.07 * turn;
      this.wantQuat.multiply(this.lookQ.setFromAxisAngle(this.tmp2.set(0, 0, 1), -bank));
      // The camera turns with a little lag, like a hand-held one, never instantly.
      cam.quaternion.slerp(this.wantQuat, 1 - Math.exp(-dt * 5));
      cam.up.set(0, 1, 0);

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
      // Ease from the pose the flight arrived with into the resting view.
      if (this.arriveBlend > 0) {
        this.arriveBlend = Math.max(0, this.arriveBlend - dt / 0.9);
        const k = smoothstep(this.arriveBlend);
        this.wantQuat.copy(cam.quaternion);
        cam.quaternion.copy(this.arriveQuat).slerp(this.wantQuat, 1 - k);
      }
      // Slight parallax with the pointer: the object shifts against the distant stars.
      this.pointerSmooth.lerp(this.pointer, 1 - Math.exp(-dt * 2.5));
      const dist = cam.position.distanceTo(this.controls.target);
      const right = this.tmp.set(1, 0, 0).applyQuaternion(cam.quaternion);
      const upv = this.tmp2.set(0, 1, 0).applyQuaternion(cam.quaternion);
      this.parallax.copy(right).multiplyScalar(this.pointerSmooth.x * dist * 0.025)
        .addScaledVector(upv, -this.pointerSmooth.y * dist * 0.018);
      cam.position.add(this.parallax);
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

    this.shownQuat.copy(cam.quaternion);

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
    this.unparallax();
    // Come back to the nearest stop next time.
    this.place(Math.round(this.progress));
    this.controls.enabled = true;
    this.camera.up.set(0, 1, 0);
  }

  placement(i: number) { return this.placements[i]; }
}
