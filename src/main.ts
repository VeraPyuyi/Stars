import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import './style.css';
import { Sky } from './sky';
import { lineResolution, pixelScale, volumeSamples } from './shared';
import type { Param, SimObject } from './types';
import { TOUR_STOPS, type StopKind } from './tour/stops';
import { Tour, applyValues } from './tour/tour';
import { TourUI } from './tour/ui';
import { createStar } from './objects/star';
import { createPlanet } from './objects/planet';
import { createPulsar } from './objects/pulsar';
import { createBlackHole } from './objects/blackHole';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 1000);
camera.position.set(0, 1, 4);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.rotateSpeed = 0.6;

const sky = new Sky();
scene.add(sky.mesh);

// HDR render target with multisampling: the post-processing chain otherwise
// renders without anti-aliasing, which makes thin lines and limbs jagged.
const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, target);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.6, 0.6, 0.9);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ---------- quality ----------
type Quality = 'standard' | 'high' | 'ultra';
const QUALITY: Record<Quality, { ratio: number; steps: number; samples: number }> = {
  standard: { ratio: 1, steps: 300, samples: 48 },
  high: { ratio: Math.min(window.devicePixelRatio, 2), steps: 500, samples: 80 },
  ultra: { ratio: Math.min(window.devicePixelRatio * 1.5, 3), steps: 900, samples: 128 },
};
let quality: Quality = 'high';

function resize() {
  const q = QUALITY[quality];
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setPixelRatio(q.ratio);
  renderer.setSize(w, h);
  composer.setPixelRatio(q.ratio);
  composer.setSize(w, h);
  camera.aspect = w / h;
  // In the tour the object rests right of centre (the story is on the left), or above
  // the card on narrow screens: a lens shift, so orbiting still turns about the object.
  if (mode === 'tour') {
    const wide = THREE.MathUtils.clamp((w / h - 1.15) / 0.55, 0, 1);
    camera.setViewOffset(w, h, -w * 0.15 * wide, w / h < 0.9 ? h * 0.16 : 0, w, h);
  } else {
    camera.clearViewOffset();
  }
  camera.updateProjectionMatrix();
  sky.uniforms.uSteps.value = q.steps;
  volumeSamples.value = q.samples;
  pixelScale.value = (h * q.ratio) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  lineResolution.set(w * q.ratio, h * q.ratio);
}

const objects: SimObject[] = [createStar(), createPlanet(), createPulsar(), createBlackHole(sky)];
let current: SimObject = objects[0];

// ---------- UI ----------
const $ = (id: string) => document.getElementById(id)!;

function renderParam(p: Param, onUser?: () => void): HTMLElement {
  const row = document.createElement('div');
  row.className = 'row';
  if (p.kind === 'range') {
    const label = document.createElement('label');
    const name = document.createElement('span');
    const val = document.createElement('span');
    name.textContent = p.label;
    const fmt = (v: number) => (p.format ? p.format(v) : `${+v.toFixed(2)}${p.unit ?? ''}`);
    val.textContent = fmt(p.value);
    label.append(name, val);
    const input = document.createElement('input');
    Object.assign(input, { type: 'range', min: p.min, max: p.max, step: p.step, value: p.value });
    input.addEventListener('input', () => {
      p.value = Number(input.value);
      val.textContent = fmt(p.value);
      p.onChange(p.value);
      onUser?.();
    });
    row.append(label, input);
  } else if (p.kind === 'select') {
    const label = document.createElement('label');
    label.textContent = p.label;
    const sel = document.createElement('select');
    for (const o of p.options) sel.add(new Option(o.label, o.value, false, o.value === p.value));
    sel.addEventListener('change', () => { p.value = sel.value; p.onChange(p.value); onUser?.(); });
    row.append(label, sel);
  } else {
    row.classList.add('toggle');
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = p.value;
    cb.addEventListener('change', () => { p.value = cb.checked; p.onChange(p.value); onUser?.(); });
    label.append(cb, document.createTextNode(p.label));
    row.append(label);
  }
  return row;
}

const exposure: Param = { kind: 'range', key: 'exposure', label: '曝光', min: 0.2, max: 3, step: 0.05, value: 1,
  onChange: (v) => (renderer.toneMappingExposure = v) };
const qualityParam: Param = { kind: 'select', key: 'quality', label: '画质', value: quality,
  options: [
    { value: 'standard', label: '标准（流畅优先）' },
    { value: 'high', label: '高（默认）' },
    { value: 'ultra', label: '极致（超采样，吃显卡）' },
  ],
  onChange: (v) => { quality = v as Quality; resize(); } };
const bloomParam: Param = { kind: 'range', key: 'bloom', label: '辉光强度', min: 0, max: 2, step: 0.05, value: 0.6,
  onChange: (v) => (bloom.strength = v) };

// ---------- custom mode: free parameters, no real-object presets ----------
const customRoot = new THREE.Group();

function renderPanel(obj: SimObject) {
  const params = $('params');
  params.innerHTML = `<h2>${obj.name} · 参数</h2>`;
  obj.params.forEach((p) => params.append(renderParam(p)));
  if (obj.extraUI) params.append(obj.extraUI());
}

function select(obj: SimObject) {
  customRoot.remove(current.group);
  current = obj;
  customRoot.add(obj.group);
  // Re-apply the panel's values: the sky's black-hole uniforms are shared with the tour.
  for (const p of obj.params) (p.onChange as (v: typeof p.value) => void)(p.value);
  sky.uniforms.uMode.value = obj.skyMode === 'blackhole' ? 1 : 0;
  sky.uniforms.uHolePos.value.set(0, 0, 0);

  controls.minDistance = obj.camera.min;
  controls.maxDistance = obj.camera.max;
  const dir = camera.position.clone().sub(controls.target).normalize();
  if (!Number.isFinite(dir.x) || dir.lengthSq() === 0) dir.set(0, 0.2, 1).normalize();
  controls.target.set(0, 0, 0);
  camera.position.copy(dir.multiplyScalar(obj.camera.distance));

  setBloom(obj.bloom);
  document.querySelectorAll<HTMLButtonElement>('#objects button').forEach((b) => b.classList.toggle('active', b.dataset.id === obj.id));
  renderPanel(obj);
  const global = $('global');
  global.innerHTML = '<h2>画面</h2>';
  global.append(renderParam(qualityParam), renderParam(exposure), renderParam(bloomParam));
  $('info').innerHTML = `<h2>物理说明</h2>${obj.info}`;
  history.replaceState(null, '', `#custom/${obj.id}`);
}

function setBloom(b: SimObject['bloom']) {
  bloom.strength = b.strength;
  bloom.radius = b.radius;
  bloom.threshold = b.threshold;
  bloomParam.value = b.strength;
}

for (const obj of objects) {
  const b = document.createElement('button');
  b.textContent = obj.name;
  b.dataset.id = obj.id;
  b.addEventListener('click', () => select(obj));
  $('objects').append(b);
}

// ---------- tour mode: real objects, one route from Earth outwards ----------
const factories: Record<StopKind, () => SimObject> = {
  planet: createPlanet,
  star: createStar,
  pulsar: createPulsar,
  blackhole: () => createBlackHole(sky),
};
let tour: Tour | null = null;
let tourUI: TourUI | null = null;
type Mode = 'tour' | 'custom';
let mode: Mode = 'tour';

function ensureTour() {
  if (tour && tourUI) return { tour, ui: tourUI };
  const ui = new TourUI(TOUR_STOPS, {
    go: (i) => t.goTo(i),
    next: () => t.next(),
    prev: () => t.prev(),
    toggleAuto: () => { t.autoplay = !t.autoplay; ui.setAutoplay(t.autoplay); if (t.autoplay && !t.trip) t.next(); },
    openCustom: (i) => openInCustom(i),
  });
  const t = new Tour(camera, controls, sky, factories, {
    arrive: (i) => {
      ui.arrive(i, t.object(i));
      ui.setAutoplay(t.autoplay);
      if (mode === 'tour') history.replaceState(null, '', `#tour/${TOUR_STOPS[i].id}`);
    },
    depart: (from, to, seconds) => ui.depart(from, to, seconds),
    progress: (ly, p, from, to) => ui.progress(ly, p, from, to),
    bloom: setBloom,
  });
  document.body.append(ui.el);
  tour = t;
  tourUI = ui;
  return { tour: t, ui };
}

function setMode(m: Mode) {
  mode = m;
  document.body.dataset.mode = m;
  document.querySelectorAll<HTMLButtonElement>('#modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  if (m === 'tour') {
    scene.remove(customRoot);
    const { tour: t } = ensureTour();
    scene.add(t.root);
    controls.enableZoom = false;   // the wheel travels along the route, as on the homepage
    camera.near = 0.02;
    camera.far = 6000;
  } else {
    if (tour) { tour.dispose(); scene.remove(tour.root); }
    scene.add(customRoot);
    controls.enableZoom = true;
    controls.enabled = true;
    camera.near = 0.01;
    camera.far = 1000;
  }
  resize();
}

function enterTour(stopId?: string) {
  setMode('tour');
  const i = Math.max(0, TOUR_STOPS.findIndex((s) => s.id === stopId));
  tour!.place(i);
}

function enterCustom(objId?: string) {
  setMode('custom');
  select(objects.find((o) => o.id === objId) ?? current);
}

const KIND_TO_OBJECT: Record<StopKind, string> = { planet: 'planet', star: 'star', pulsar: 'pulsar', blackhole: 'blackhole' };

/** Carry a real object's parameters into custom mode, where they can be changed freely. */
function openInCustom(i: number) {
  const stop = TOUR_STOPS[i];
  const obj = objects.find((o) => o.id === KIND_TO_OBJECT[stop.kind])!;
  if (tour) { tour.autoplay = false; tourUI?.setAutoplay(false); }
  setMode('custom');
  applyValues(obj, stop.preset.values);
  select(obj);
  if (stop.preset.view) {
    camera.position.copy(new THREE.Vector3(...stop.preset.view).normalize().multiplyScalar(obj.camera.distance));
  }
}

document.querySelectorAll<HTMLButtonElement>('#modes button').forEach((b) =>
  b.addEventListener('click', () => {
    if (b.dataset.mode === mode) return;
    if (b.dataset.mode === 'tour') enterTour(tour ? TOUR_STOPS[tour.index].id : undefined);
    else enterCustom();
  }),
);

// Wheel / keys travel along the route; with Ctrl (trackpad pinch), Shift or Alt the wheel zooms.
let wheelAcc = 0;
canvas.addEventListener('wheel', (e) => {
  if (mode !== 'tour' || !tour) return;
  e.preventDefault();
  if (e.ctrlKey || e.shiftKey || e.altKey) {
    if (tour.trip) return;
    const d = camera.position.clone().sub(controls.target);
    const len = THREE.MathUtils.clamp(d.length() * Math.exp((e.deltaY || e.deltaX) * 0.0015), controls.minDistance, controls.maxDistance);
    camera.position.copy(controls.target).addScaledVector(d.normalize(), len);
    return;
  }
  if (tour.trip) { wheelAcc = 0; return; }
  wheelAcc += e.deltaY;
  if (wheelAcc > 80) { wheelAcc = 0; tour.next(); }
  else if (wheelAcc < -80) { wheelAcc = 0; tour.prev(); }
}, { passive: false });
window.addEventListener('keydown', (e) => {
  if (mode !== 'tour' || !tour || (e.target as HTMLElement).closest('input, select, textarea')) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown') tour.next();
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') tour.prev();
  else if (e.key === ' ') { e.preventDefault(); tourUI?.el.querySelector<HTMLButtonElement>('[data-a=auto]')?.click(); }
});

{
  const [a, b] = location.hash.slice(1).split('/');
  const legacy = TOUR_STOPS.find((s) => s.id === b);
  if (a === 'custom') enterCustom(b);
  else if (a === 'tour') enterTour(b);
  else if (legacy) enterTour(legacy.id);                 // old links such as #star/betelgeuse
  else if (objects.some((o) => o.id === a)) enterCustom(a);
  else enterTour();
}

// ---------- loop ----------
window.addEventListener('resize', resize);
resize();

const timer = new THREE.Timer();
timer.connect(document);
let frames = 0, fpsTime = 0;
renderer.setAnimationLoop((now) => {
  timer.update(now);
  const dt = Math.min(timer.getDelta(), 0.1);
  const t = timer.getElapsed();
  if (mode === 'tour' && tour) {
    if (!tour.trip) controls.update();
    tour.update(dt, t);
  } else {
    controls.update();
    current.update(dt, t, camera);
  }
  sky.update(camera, t);
  composer.render();
  frames++; fpsTime += dt;
  if (fpsTime > 0.5) { $('fps').textContent = `${Math.round(frames / fpsTime)} fps`; frames = 0; fpsTime = 0; }
});

// Exposed for automated screenshots / debugging.
(window as unknown as { __sim: unknown }).__sim = { camera, controls, select, objects, renderer, bloom, get tour() { return tour; }, enterTour, enterCustom };
