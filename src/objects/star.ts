import * as THREE from 'three';
import { BLACKBODY, NOISE, WORLEY, spectralClass } from '../shaders/common';
import type { SimObject } from '../types';
import { Glow } from './glow';
import { createProminences, createStellarWind } from './stellarParticles';
import { STAR_PRESETS } from '../data/presets';

export function createStar(): SimObject {
  const uniforms = {
    uTemp: { value: 5772 },
    uTime: { value: 0 },
    uSpots: { value: 0.5 },
    uGranulation: { value: 1.0 },
    uCell: { value: 28.0 },
    uOblate: { value: 1.0 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vObj; varying vec3 vN; varying vec3 vV;
      void main(){
        vObj = position;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vObj; varying vec3 vN; varying vec3 vV;
      uniform float uTemp, uTime, uSpots, uGranulation, uCell, uOblate;
      ${NOISE}
      ${WORLEY}
      ${BLACKBODY}
      void main(){
        vec3 p = normalize(vObj);
        float mu = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
        // Granulation: convection cells (bright hot upflows, dark cool intergranular lanes).
        // uCell ~ cell frequency: Sun-like stars have tiny cells, red supergiants only a
        // handful of giant ones (Schwarzschild 1975). Detail is level-of-detail filtered:
        // cells fade in as they become larger than a few pixels, so zooming in reveals more.
        float big = 1.0 - smoothstep(6.0, 14.0, uCell);       // 1 for supergiants
        float F = mix(uCell * 2.5, uCell * 1.1, big);
        vec3 w = vec3(snoise(p * F * 0.35), snoise(p * F * 0.35 + 17.0), snoise(p * F * 0.35 + 31.0));
        float px = length(fwidth(p));                          // surface units per pixel
        float lod1 = 1.0 - smoothstep(0.12, 0.45, px * F);
        float lod2 = 1.0 - smoothstep(0.12, 0.45, px * F * 3.1);
        vec3 c1 = worley(p * F + w * mix(0.65, 0.9, big), uTime * 0.15);
        // Bright hot centre, gradual darkening outward, narrow cool lane; each cell
        // has its own brightness (young expanding granules are brighter).
        float lane1 = smoothstep(0.0, mix(0.22, 0.45, big), c1.y - c1.x);
        float centre = 1.12 - 0.4 * smoothstep(0.0, 0.85, c1.x);
        float cell1 = mix(0.55, 1.0, lane1) * centre * mix(0.88 + 0.24 * c1.z, 1.0, big);
        // Small-scale turbulent texture inside granules (only when resolvable).
        float cell2 = 1.0 + 0.07 * fbm(p * F * 4.0 + w * 2.0 + uTime * 0.05, 3);
        // Supergiants: a hierarchy — smaller convective cells on top of the giant plumes.
        float lodB = 1.0 - smoothstep(0.12, 0.45, px * F * 5.0);
        vec3 cb = worley(p * F * 5.0 + w * 4.0 + 9.0, uTime * 0.3);
        float cellB = mix(0.86, 1.03, smoothstep(0.0, 0.55, cb.y - cb.x)) * (0.95 + 0.1 * cb.z);
        float sup = 0.94 + 0.08 * smoothstep(-0.2, 0.5, fbm(p * F * 0.18, 3));   // supergranulation / plumes
        float g3 = fbm(p * uCell * 0.6 + vec3(uTime * 0.01), 5);
        float plume = mix(1.0, 0.65 + 0.6 * smoothstep(-0.4, 0.6, g3), big);
        float cells = mix(0.9, cell1, lod1) * mix(1.0, cell2, lod2) * mix(1.0, cellB, lodB * big) * sup * plume;
        float gran = mix(1.0, cells, uGranulation);
        // Starspots: umbra + penumbra, confined to mid latitudes.
        float lat = abs(p.y);
        float belt = smoothstep(0.05, 0.2, lat) * (1.0 - smoothstep(0.45, 0.6, lat));
        float s = fbm(p * 3.0 + vec3(11.0, 0.0, uTime * 0.003), 5) * belt;
        float thr = mix(0.6, 0.25, uSpots);
        float penumbra = smoothstep(thr, thr + 0.06, s);
        float umbra = smoothstep(thr + 0.08, thr + 0.14, s);
        // Penumbral filaments: fine radial-looking striations in the penumbra.
        float fil = 0.75 + 0.25 * snoise(p * 140.0 + vec3(0.0, uTime * 0.01, 0.0)) * (1.0 - smoothstep(0.1, 0.4, px * 140.0));
        float spot = uSpots > 0.0 ? penumbra * (0.45 + 0.25 * (1.0 - fil)) + umbra * 0.4 : 0.0;
        // Faculae: bright network near the limb.
        float fac = smoothstep(0.3, 0.7, fbm(p * 9.0, 3) * 0.5 + 0.5) * pow(1.0 - mu, 2.0) * 0.25;
        // Limb darkening (quadratic law) and the limb's lower effective temperature.
        float limb = 1.0 - 0.6 * (1.0 - mu) - 0.15 * (1.0 - mu) * (1.0 - mu);
        // Gravity darkening (von Zeipel): fast rotators are oblate, with hot bright
        // poles and a cooler, dimmer equator. Amplitude tied to the oblateness.
        float delta = (uOblate - 1.0);
        float gd = 1.0 + delta * (p.y * p.y - 1.0 / 3.0);
        float T = uTemp * gd * (0.88 + 0.12 * pow(mu, 0.5)) * (1.0 - 0.3 * spot);
        float I = (limb * gran * (1.0 - spot) + fac) * pow(gd, 4.0);
        float bright = 0.72 * pow(uTemp / 5772.0, -0.25);
        gl_FragColor = vec4(blackbody(T) * I * bright, 1.0);
      }
    `,
  });

  const group = new THREE.Group();
  const tilt = new THREE.Group();          // rotation axis = +y of this node
  group.add(tilt);
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 256, 192), mat);
  tilt.add(body);
  const prom = createProminences();
  body.add(prom.points);
  const wind = createStellarWind();
  group.add(wind.points);
  const glow = new Glow(7);
  glow.uniforms.uIntensity.value = 0.35;
  group.add(glow.mesh);

  let spin = 0.05;
  const obj: SimObject = {
    id: 'star',
    name: '恒星',
    group,
    camera: { distance: 4, min: 1.3, max: 30 },
    bloom: { strength: 0.35, radius: 0.5, threshold: 0.95 },
    params: [
      {
        kind: 'range', key: 'temp', label: '有效温度', min: 2500, max: 40000, step: 100, value: 5772, unit: 'K',
        format: (v) => `${v.toFixed(0)} K（${spectralClass(v)} 型）`,
        onChange: (v) => { uniforms.uTemp.value = v; glow.uniforms.uTemp.value = v; wind.uniforms.uTemp.value = v; },
      },
      { kind: 'range', key: 'spots', label: '星斑活动', min: 0, max: 1, step: 0.01, value: 0.5, onChange: (v) => (uniforms.uSpots.value = v) },
      { kind: 'range', key: 'gran', label: '米粒组织对比度', min: 0, max: 1.5, step: 0.01, value: 1, onChange: (v) => (uniforms.uGranulation.value = v) },
      { kind: 'range', key: 'cell', label: '对流元胞密度', min: 3, max: 40, step: 0.5, value: 28,
        format: (v) => (v < 10 ? `${v.toFixed(1)}（巨型元胞）` : v.toFixed(1)), onChange: (v) => (uniforms.uCell.value = v) },
      { kind: 'range', key: 'oblate', label: '扁率 R赤/R极', min: 1, max: 1.35, step: 0.01, value: 1,
        format: (v) => v.toFixed(2), onChange: (v) => { uniforms.uOblate.value = v; body.scale.set(v, 1, v); } },
      { kind: 'range', key: 'spin', label: '自转速度（演示）', min: 0, max: 0.5, step: 0.01, value: spin, onChange: (v) => (spin = v) },
      { kind: 'toggle', key: 'prom', label: '日珥（磁弧上的等离子体）', value: true, onChange: (v) => (prom.points.visible = v) },
      { kind: 'toggle', key: 'wind', label: '星风粒子', value: true, onChange: (v) => (wind.points.visible = v) },
    ],
    presets: STAR_PRESETS,
    info: `
      <p><b>颜色</b>由黑体辐射决定：温度 → CIE 色度近似。太阳约 5772 K。</p>
      <p><b>临边昏暗</b>：视线斜穿大气时只能看到更浅、更冷的一层，所以盘面边缘更暗、更红（二次律近似）。</p>
      <p><b>米粒组织</b>是对流元胞，<b>星斑</b>是磁场抑制对流造成的低温区。</p>
      <p><b>快速自转</b>的恒星（织女星、牛郎星、轩辕十四）被甩成扁球，两极受到的有效重力更大、更热更亮，赤道更冷更暗，这叫<b>重力昏暗</b>。</p>
      <p><b>日珥</b>是被磁弧托在日冕中的较冷等离子体，在氢 Hα 线（656 nm）发出粉红色光，物质沿磁力线流动、滴落（“日冕雨”）。<b>星风</b>是持续向外加速的等离子体流，受自转影响卷成帕克螺旋。</p>
      <p class="approx">近似：表面纹理为程序噪声，未做辐射转移；日冕为屏幕空间光晕。</p>`,
    update(dt, time, camera) {
      uniforms.uTime.value = time;
      prom.uniforms.uTime.value = time;
      wind.uniforms.uTime.value = time;
      wind.uniforms.uTwist.value = 0.2 + spin * 3;
      body.rotation.y += spin * dt;
      glow.update(camera, time);
    },
  };
  return obj;
}
