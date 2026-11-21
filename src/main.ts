import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import './style.css';
import { Sky } from './sky';
import type { Param, SimObject } from './types';
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

function renderParam(p: Param): HTMLElement {
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
    });
    row.append(label, input);
  } else if (p.kind === 'select') {
    const label = document.createElement('label');
    label.textContent = p.label;
    const sel = document.createElement('select');
    for (const o of p.options) sel.add(new Option(o.label, o.value, false, o.value === p.value));
    sel.addEventListener('change', () => { p.value = sel.value; p.onChange(p.value); });
    row.append(label, sel);
  } else {
    row.classList.add('toggle');
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = p.value;
    cb.addEventListener('change', () => { p.value = cb.checked; p.onChange(p.value); });
    label.append(cb, document.createTextNode(p.label));
    row.append(label);
  }
  return row;
}

const exposure: Param = { kind: 'range', key: 'exposure', label: '曝光', min: 0.2, max: 3, step: 0.05, value: 1,
  onChange: (v) => (renderer.toneMappingExposure = v) };
const bloomParam: Param = { kind: 'range', key: 'bloom', label: '辉光强度', min: 0, max: 2, step: 0.05, value: 0.6,
  onChange: (v) => (bloom.strength = v) };

function select(obj: SimObject) {
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
  const params = $('params');
  params.innerHTML = `<h2>${obj.name} · 参数</h2>`;
  obj.params.forEach((p) => params.append(renderParam(p)));
  const global = $('global');
  global.innerHTML = '<h2>画面</h2>';
  global.append(renderParam(exposure), renderParam(bloomParam));
  $('info').innerHTML = `<h2>物理说明</h2>${obj.info}`;
  history.replaceState(null, '', `#${obj.id}`);
}

for (const obj of objects) {
  const b = document.createElement('button');
  b.textContent = obj.name;
  b.dataset.id = obj.id;
  b.addEventListener('click', () => select(obj));
  $('objects').append(b);
}

scene.add(current.group);
select(objects.find((o) => `#${o.id}` === location.hash) ?? objects[0]);

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
(window as unknown as { __sim: unknown }).__sim = { camera, controls, select, objects };
