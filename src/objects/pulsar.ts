import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { lineResolution } from '../shared';
import { BLACKBODY, NOISE } from '../shaders/common';
import type { SimObject } from '../types';
import { Glow } from './glow';
import { PULSAR_PRESETS } from '../data/presets';
import { BEAM_LENGTH, BeamUniforms, beamProfile, createBeam, createParticles, createTrappedParticles } from './pulsarBeam';
import { Flare } from './flare';

/** Anti-aliased, constant-pixel-width line (WebGL lines are always 1 px and aliased). */
function fatLineMaterial(color: THREE.Color, opacity: number, width: number) {
  const m = new LineMaterial({ color: color.getHex(), linewidth: width, transparent: true, opacity, depthWrite: false });
  m.blending = THREE.AdditiveBlending;
  m.uniforms.resolution.value = lineResolution;
  return m;
}
function fatLine(pts: THREE.Vector3[], mat: LineMaterial) {
  const g = new LineGeometry();
  g.setPositions(pts.flatMap((p) => [p.x, p.y, p.z]));
  const l = new Line2(g, mat);
  l.computeLineDistances();
  return l;
}

/** Dipole magnetic field lines r = L·sin²θ, magnetic axis along +y. */
function fieldLines(): THREE.Group {
  const g = new THREE.Group();
  const mat = fatLineMaterial(new THREE.Color(0.35, 0.6, 1.0), 0.3, 1.6);
  for (const L of [1.8, 2.8, 4.5, 7.5, 12]) {
    const th0 = Math.asin(Math.sqrt(1 / L));
    for (let k = 0; k < 8; k++) {
      const phi = (k / 8) * Math.PI * 2 + L;
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 240; i++) {
        const th = th0 + (Math.PI - 2 * th0) * (i / 240);
        const r = L * Math.sin(th) ** 2;
        pts.push(new THREE.Vector3(r * Math.sin(th) * Math.cos(phi), r * Math.cos(th), r * Math.sin(th) * Math.sin(phi)));
      }
      const line = fatLine(pts, mat);
      line.userData.L = L;
      g.add(line);
    }
  }
  return g;
}

/** Open field lines rising from the polar caps (the ones that feed the beams). */
function openFieldLines(): THREE.Group {
  const g = new THREE.Group();
  const mat = fatLineMaterial(new THREE.Color(1.0, 0.6, 0.3), 0.45, 1.4);
  for (const L of [40, 120]) {
    for (let k = 0; k < 6; k++) {
      const phi = (k / 6) * Math.PI * 2 + L * 0.1;
      for (const sign of [1, -1]) {
        const pts: THREE.Vector3[] = [];
        const th0 = Math.asin(Math.sqrt(1 / L));
        for (let i = 0; i <= 80; i++) {
          const th = th0 + i * 0.006;
          const r = L * Math.sin(th) ** 2;
          if (r > 7) break;
          pts.push(new THREE.Vector3(r * Math.sin(th) * Math.cos(phi), sign * r * Math.cos(th), r * Math.sin(th) * Math.sin(phi)));
        }
        if (pts.length > 1) g.add(fatLine(pts, mat));
      }
    }
  }
  return g;
}

function surfaceMaterial() {
  const uniforms = {
    uTime: { value: 0 },
    uMagAxis: { value: new THREE.Vector3(0, 1, 0) }, // in the body's local frame
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vObj; varying vec3 vN; varying vec3 vV;
      void main(){
        vObj = position;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vObj; varying vec3 vN; varying vec3 vV;
      uniform float uTime; uniform vec3 uMagAxis;
      ${NOISE}
      ${BLACKBODY}
      void main(){
        vec3 p = normalize(vObj);
        float mu = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
        float c = abs(dot(p, normalize(uMagAxis)));
        float cap = smoothstep(0.9, 0.99, c);                 // polar caps heated by returning currents
        float n = fbm(p * 12.0 + vec3(uTime * 0.2), 4) * 0.5 + 0.5;
        float T = mix(30000.0, 40000.0, cap);                  // ~10^6 K saturates to blue-white
        float I = (0.9 + 0.2 * n) * (0.7 + 0.3 * mu) * (1.0 + 2.5 * cap);
        gl_FragColor = vec4(blackbody(T) * I, 1.0);
      }
    `,
  });
  return { mat, uniforms };
}

/** Light-cylinder radius in stellar radii (R_ns = 12 km): R_LC = c·P / (2π·R_ns). */
const lightCylinder = (periodMs: number) => (299792 * periodMs * 1e-3) / (2 * Math.PI * 12);

function lightCylinderMesh() {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying float vY;
      void main(){
        vY = position.y;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying float vY;
      void main(){
        float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 3.0);
        float fade = 1.0 - smoothstep(0.5, 1.0, abs(vY));
        gl_FragColor = vec4(vec3(1.0, 0.65, 0.35) * rim * fade * 0.12, 1.0);
      }
    `,
  });
  const geo = new THREE.CylinderGeometry(1, 1, 2, 96, 1, true);
  return new THREE.Mesh(geo, mat);
}

export function createPulsar(): SimObject {
  const group = new THREE.Group();
  const spinNode = new THREE.Group();          // rotates about the spin axis (+y)
  const magNode = new THREE.Group();           // magnetic axis, tilted by α
  group.add(spinNode);
  spinNode.add(magNode);

  const { mat, uniforms } = surfaceMaterial();
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 96), mat);
  spinNode.add(body);

  const lines = fieldLines();
  magNode.add(lines);
  lines.visible = false; // field lines are a diagram: off until asked for
  const trapped = createTrappedParticles(7000);
  magNode.add(trapped.points);

  const glow = new Glow(6);
  glow.uniforms.uTemp.value = 40000;
  glow.uniforms.uIntensity.value = 0.3;
  glow.uniforms.uStreaks.value = 0.2;
  group.add(glow.mesh);
  const flare = new Flare(16);
  group.add(flare.mesh);

  const lc = lightCylinderMesh();
  group.add(lc);

  // ---- emission ----
  const shared: BeamUniforms = {
    uTime: { value: 0 },
    uHalf: { value: THREE.MathUtils.degToRad(9) },
    uSparks: { value: 12 },
    uDrift: { value: 0.3 },
    uCore: { value: 1.0 },
    uIntensity: { value: 1.0 },
    uLag: { value: 0 },
    uSpinAxis: { value: new THREE.Vector3(0, 1, 0) },
    uCamLocal: { value: new THREE.Vector3() },
  };
  const beam = createBeam(shared);
  magNode.add(beam);
  const particles = createParticles(shared);
  magNode.add(particles);
  const openLines = openFieldLines();
  magNode.add(openLines);
  openLines.visible = false;

  let alpha = 35;
  let spin = 1.2;
  let periodMs = 33.7;
  const setAlpha = (deg: number) => {
    alpha = deg;
    magNode.rotation.z = THREE.MathUtils.degToRad(deg);
    const axis = new THREE.Vector3(0, 1, 0).applyAxisAngle(new THREE.Vector3(0, 0, 1), magNode.rotation.z);
    uniforms.uMagAxis.value.copy(axis);
    // Spin axis (+y of spinNode) expressed in the magnetic frame.
    shared.uSpinAxis.value.set(0, 1, 0).applyAxisAngle(new THREE.Vector3(0, 0, 1), -magNode.rotation.z);
  };
  setAlpha(alpha);
  const setPeriod = (logMs: number) => {
    periodMs = 10 ** logMs;
    const rlc = lightCylinder(periodMs);
    shared.uLag.value = 1 / rlc;
    trapped.uniforms.uMaxL.value = rlc;
    for (const l of lines.children) l.visible = (l.userData.L as number) < rlc;
    lc.scale.set(rlc, BEAM_LENGTH * 1.2, rlc);
    lc.visible = showLC && rlc < BEAM_LENGTH * 2.5;
  };
  let showLC = true;
  const fmtPeriod = (logMs: number) => {
    const p = 10 ** logMs;
    const rlc = lightCylinder(p);
    const ps = p >= 1000 ? `${(p / 1000).toFixed(3)} s` : `${p.toFixed(p < 10 ? 2 : 1)} ms`;
    const rkm = rlc * 12;
    return `${ps}（R_LC ≈ ${rkm >= 1000 ? (rkm / 1000).toFixed(1) + ' 千公里' : rkm.toFixed(0) + ' km'}）`;
  };
  setPeriod(Math.log10(periodMs));

  const params: SimObject['params'] = [
    { kind: 'range', key: 'alpha', label: '磁倾角 α', min: 0, max: 90, step: 1, value: alpha, unit: '°',
      format: (v) => `${v.toFixed(0)}°`, onChange: setAlpha },
    { kind: 'range', key: 'period', label: '真实自转周期', min: 0, max: 3.5, step: 0.01, value: Math.log10(periodMs),
      format: fmtPeriod, onChange: setPeriod },
    { kind: 'range', key: 'spin', label: '动画转速（慢放）', min: 0, max: 6, step: 0.05, value: spin,
      onChange: (v) => (spin = v) },
    { kind: 'range', key: 'width', label: '光束半张角', min: 3, max: 20, step: 0.5, value: 9,
      format: (v) => `${v.toFixed(1)}°`, onChange: (v) => (shared.uHalf.value = THREE.MathUtils.degToRad(v)) },
    { kind: 'range', key: 'core', label: '核心辐射强度', min: 0, max: 2, step: 0.05, value: 1, onChange: (v) => (shared.uCore.value = v) },
    { kind: 'range', key: 'sparks', label: '火花数（旋转木马）', min: 0, max: 24, step: 1, value: 12,
      format: (v) => (v === 0 ? '0（连续锥）' : v.toFixed(0)), onChange: (v) => (shared.uSparks.value = v) },
    { kind: 'range', key: 'drift', label: '火花漂移速度', min: -1.5, max: 1.5, step: 0.05, value: 0.3, onChange: (v) => (shared.uDrift.value = v) },
    { kind: 'toggle', key: 'lines', label: '闭合磁力线', value: false, onChange: (v) => { lines.visible = v; } },
    { kind: 'toggle', key: 'open', label: '开放磁力线', value: false, onChange: (v) => (openLines.visible = v) },
    { kind: 'toggle', key: 'particles', label: '外流等离子体粒子', value: true, onChange: (v) => (particles.visible = v) },
    { kind: 'toggle', key: 'trapped', label: '磁层被俘粒子', value: true, onChange: (v) => (trapped.points.visible = v) },
    { kind: 'toggle', key: 'lc', label: '光速圆柱', value: true, onChange: (v) => { showLC = v; setPeriod(Math.log10(periodMs)); } },
  ];

  // ---- pulse profile: what a distant observer along the current view direction would record ----
  const camDir = new THREE.Vector3();
  const worldPos = new THREE.Vector3();
  const mAxis = new THREE.Vector3();
  const pole = [0, 0];
  const intensityAt = (psi: number) => {
    const a = THREE.MathUtils.degToRad(alpha);
    // magnetic axis after spinning by psi about +y
    mAxis.set(-Math.sin(a) * Math.cos(psi), Math.cos(a), Math.sin(a) * Math.sin(psi));
    const c = THREE.MathUtils.clamp(mAxis.dot(camDir), -1, 1);
    const half = shared.uHalf.value;
    pole[0] = beamProfile(Math.acos(c) / half, shared.uCore.value);
    pole[1] = beamProfile(Math.acos(-c) / half, shared.uCore.value);
    return pole[0] + pole[1];
  };
  let profileCanvas: HTMLCanvasElement | undefined;
  let profileCap: HTMLElement | undefined;
  const hasTwoPeaks = (vals: number[], max: number) => {
    let peaks = 0, above = false;
    for (const v of vals) { const a = v > max * 0.3; if (a && !above) peaks++; above = a; }
    if (above && vals[0] > max * 0.3 && peaks > 1) peaks--;
    return peaks >= 2;
  };
  const drawProfile = () => {
    if (!profileCanvas || !profileCanvas.isConnected) return;
    const cv = profileCanvas;
    const w = (cv.width = cv.clientWidth * devicePixelRatio);
    const h = (cv.height = cv.clientHeight * devicePixelRatio);
    const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    const n = 720;
    const vals: number[] = [];
    let max = 0;
    const poleMax = [0, 0];
    for (let i = 0; i < n; i++) {
      const v = intensityAt((i / n) * Math.PI * 2);
      vals.push(v); max = Math.max(max, v);
      poleMax[0] = Math.max(poleMax[0], pole[0]); poleMax[1] = Math.max(poleMax[1], pole[1]);
    }
    const scale = Math.max(max, 0.6);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath(); ctx.moveTo(0, h - 4); ctx.lineTo(w, h - 4); ctx.stroke();
    ctx.strokeStyle = '#7fb2ff';
    ctx.lineWidth = 1.5 * devicePixelRatio;
    ctx.beginPath();
    vals.forEach((v, i) => { const x = (i / (n - 1)) * w; const y = h - 4 - (v / scale) * (h - 12); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
    const phase = ((spinNode.rotation.y % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    ctx.fillStyle = '#ffcc66';
    ctx.fillRect((phase / (Math.PI * 2)) * w - devicePixelRatio, 0, 2 * devicePixelRatio, h);
    if (profileCap) {
      const both = Math.min(poleMax[0], poleMax[1]) > 0.05;
      const duty = vals.filter((v) => v > max * 0.5).length / n;
      profileCap.textContent = max < 0.05
        ? '脉冲轮廓：从当前视角看，光束扫不到你，所以观测不到这颗脉冲星。'
        : (both
          ? '脉冲轮廓：两个磁极的光束都扫过视线，出现主脉冲 + 中间脉冲。'
          : hasTwoPeaks(vals, max)
            ? '脉冲轮廓：视线切过空心锥，出现双峰（锥成分）。'
            : '脉冲轮廓：视线穿过光束中心附近，单峰为主。') + ` 占空比约 ${(duty * 100).toFixed(1)}%，黄线为当前相位。`;
    }
  };

  let profileTimer = 0;
  return {
    id: 'pulsar',
    name: '脉冲星',
    group,
    camera: { distance: 34, min: 1.4, max: 90 },
    presets: PULSAR_PRESETS,
    extraUI: () => {
      const box = document.createElement('div');
      box.className = 'profile';
      profileCap = document.createElement('div');
      profileCap.className = 'cap';
      profileCanvas = document.createElement('canvas');
      box.append(profileCap, profileCanvas);
      requestAnimationFrame(drawProfile);
      return box;
    },
    bloom: { strength: 0.6, radius: 0.6, threshold: 0.9 },
    params,
    info: `
      <p><b>脉冲星</b>是快速自转、强磁化的中子星：约 1.4 倍太阳质量压缩在半径 ~12 km 的球内。磁极上方的<b>开放磁力线</b>（橙色）伸出<b>光速圆柱</b>（共转速度达到光速的半径 R_LC = cP/2π），电子–正电子对沿它们外流，辐射出沿磁轴的两束光。光速圆柱内是闭合磁力线和被俘等离子体。</p>
      <p><b>光束结构</b>按观测总结的经验模型：中心<b>核心</b> + <b>空心锥</b>。锥由极冠上方绕磁轴旋转的<b>火花</b>供能（“旋转木马”），对应观测到的<b>漂移子脉冲</b>。</p>
      <p><b>光传播延迟</b>：此刻位于半径 r 处的辐射是 r/c 之前发出的，那时星体还没转到现在的角度，所以光束的“快照”是一条每经过一个 R_LC 就弯一弧度的<b>阿基米德螺线</b>。毫秒脉冲星（R_LC 只有几个星体半径）弯曲非常明显，慢脉冲星几乎是直的——弯曲量按真实周期计算，与动画慢放无关。</p>
      <p><b>脉冲</b>：只有光束扫过视线的那一小段相位才能看到闪光（占空比通常只有几个百分点），下方的脉冲轮廓就是远处观测者记录到的亮度曲线。</p>
      <p class="approx">近似：光束为假彩色（射电波段肉眼不可见）；未计入相对论像差、光速圆柱处的电流片与强引力光线弯曲；时间大幅慢放。</p>`,
    update(dt, time, camera) {
      uniforms.uTime.value = time;
      shared.uTime.value = time;
      trapped.uniforms.uTime.value = time;
      spinNode.rotation.y += spin * dt;
      glow.update(camera, time);
      flare.update(camera);
      group.updateMatrixWorld(true);
      shared.uCamLocal.value.copy(beam.worldToLocal(camera.position.clone()));
      camDir.copy(camera.position).sub(group.getWorldPosition(worldPos)).normalize();
      // The flash follows the beam profile at the current phase: short and sharp.
      const I = intensityAt(spinNode.rotation.y);
      flare.uniforms.uIntensity.value = Math.min(I, 2.5) * 0.9;
      flare.uniforms.uRot.value = 0.3;
      profileTimer += dt;
      if (profileTimer > 0.1) { profileTimer = 0; drawProfile(); }
    },
  };
}
