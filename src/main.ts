import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import './style.css';
import { Sky } from './sky';
import type { Param, Preset, SimObject } from './types';
import { createStar } from './objects/star';
import { createPlanet } from './objects/planet';
import { createNeutronStar, createPulsar } from './objects/compact';
import { createBlackHole } from './objects/blackHole';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.6, 0.6, 0.9);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const objects: SimObject[] = [createStar(), createPlanet(), createNeutronStar(), createPulsar(), createBlackHole(sky)];
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
const bloomParam: Param = { kind: 'range', key: 'bloom', label: '辉光强度', min: 0, max: 2, step: 0.05, value: 0.6,
  onChange: (v) => (bloom.strength = v) };

function applyPreset(obj: SimObject, preset: Preset) {
  for (const p of obj.params) {
    if (!(p.key in preset.values)) continue;
    const v = preset.values[p.key];
    p.value = v as never;
    (p.onChange as (x: typeof v) => void)(v);
  }
  if (preset.view) {
    const d = new THREE.Vector3(...preset.view).normalize();
    camera.position.copy(d.multiplyScalar(camera.position.length()));
    controls.target.set(0, 0, 0);
  }
}

function renderFacts(preset: Preset | undefined): string {
  if (!preset) return '';
  const rows = preset.facts.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');
  return `<div class="facts"><div class="facts-title">${preset.name}</div><table>${rows}</table>` +
    (preset.note ? `<p>${preset.note}</p>` : '') + '</div>';
}

function renderPanel(obj: SimObject, preset?: Preset) {
  const params = $('params');
  params.innerHTML = `<h2>${obj.name} · 参数</h2>`;
  let presetSelect: HTMLSelectElement | undefined;
  const facts = document.createElement('div');
  if (obj.presets?.length) {
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('label');
    label.textContent = '知名天体（真实数据）';
    presetSelect = document.createElement('select');
    presetSelect.add(new Option('自定义', ''));
    for (const pr of obj.presets) presetSelect.add(new Option(pr.name, pr.id, false, pr.id === preset?.id));
    presetSelect.addEventListener('change', () => {
      const pr = obj.presets!.find((x) => x.id === presetSelect!.value);
      if (pr) applyPreset(obj, pr);
      renderPanel(obj, pr);
    });
    row.append(label, presetSelect);
    params.append(row);
    facts.innerHTML = renderFacts(preset);
    params.append(facts);
  }
  // Touching any slider turns the selection back into a custom object.
  const onUser = () => {
    if (presetSelect && presetSelect.value) { presetSelect.value = ''; facts.innerHTML = ''; setHash(obj); }
  };
  obj.params.forEach((p) => params.append(renderParam(p, onUser)));
  if (obj.extraUI) params.append(obj.extraUI());
  setHash(obj, preset);
}

function setHash(obj: SimObject, preset?: Preset) {
  history.replaceState(null, '', `#${obj.id}${preset ? '/' + preset.id : ''}`);
}

function select(obj: SimObject, presetId?: string) {
  scene.remove(current.group);
  current = obj;
  scene.add(obj.group);
  sky.uniforms.uMode.value = obj.skyMode === 'blackhole' ? 1 : 0;

  controls.minDistance = obj.camera.min;
  controls.maxDistance = obj.camera.max;
  const dir = camera.position.clone().normalize();
  if (dir.lengthSq() === 0) dir.set(0, 0.2, 1).normalize();
  camera.position.copy(dir.multiplyScalar(obj.camera.distance));
  controls.target.set(0, 0, 0);

  bloom.strength = obj.bloom.strength;
  bloom.radius = obj.bloom.radius;
  bloom.threshold = obj.bloom.threshold;
  bloomParam.value = obj.bloom.strength;

  document.querySelectorAll<HTMLButtonElement>('#objects button').forEach((b) => b.classList.toggle('active', b.dataset.id === obj.id));
  const preset = obj.presets?.find((p) => p.id === presetId);
  if (preset) applyPreset(obj, preset);
  renderPanel(obj, preset);
  const global = $('global');
  global.innerHTML = '<h2>画面</h2>';
  global.append(renderParam(exposure), renderParam(bloomParam));
  $('info').innerHTML = `<h2>物理说明</h2>${obj.info}`;
}

for (const obj of objects) {
  const b = document.createElement('button');
  b.textContent = obj.name;
  b.dataset.id = obj.id;
  b.addEventListener('click', () => select(obj));
  $('objects').append(b);
}

scene.add(current.group);
{
  const [id, presetId] = location.hash.slice(1).split('/');
  select(objects.find((o) => o.id === id) ?? objects[0], presetId);
}

// ---------- loop ----------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

const timer = new THREE.Timer();
timer.connect(document);
let frames = 0, fpsTime = 0;
renderer.setAnimationLoop((now) => {
  timer.update(now);
  const dt = Math.min(timer.getDelta(), 0.1);
  const t = timer.getElapsed();
  controls.update();
  current.update(dt, t, camera);
  sky.update(camera, t);
  composer.render();
  frames++; fpsTime += dt;
  if (fpsTime > 0.5) { $('fps').textContent = `${Math.round(frames / fpsTime)} fps`; frames = 0; fpsTime = 0; }
});

// Exposed for automated screenshots / debugging.
(window as unknown as { __sim: unknown }).__sim = { camera, controls, select, objects, renderer, bloom };
