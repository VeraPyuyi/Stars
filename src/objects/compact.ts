import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { lineResolution } from '../shared';
import { BLACKBODY, NOISE } from '../shaders/common';
import type { SimObject } from '../types';
import { Glow } from './glow';
import { PULSAR_PRESETS } from '../data/presets';
import { BeamUniforms, boundingCone, beamProfile, createBeam, createParticles, createTrappedParticles } from './pulsarBeam';

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
  for (const L of [1.8, 2.8, 4.5, 7.5]) {
    const th0 = Math.asin(Math.sqrt(1 / L));
    for (let k = 0; k < 8; k++) {
      const phi = (k / 8) * Math.PI * 2 + L;
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 240; i++) {
        const th = th0 + (Math.PI - 2 * th0) * (i / 240);
        const r = L * Math.sin(th) ** 2;
        pts.push(new THREE.Vector3(r * Math.sin(th) * Math.cos(phi), r * Math.cos(th), r * Math.sin(th) * Math.sin(phi)));
      }
      g.add(fatLine(pts, mat));
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

function buildCompact(pulsar: boolean): SimObject {
  const group = new THREE.Group();
  const spinNode = new THREE.Group();          // rotates about the spin axis (+y)
  const magNode = new THREE.Group();           // magnetic axis, tilted by α
  group.add(spinNode);
  spinNode.add(magNode);

  const { mat, uniforms } = surfaceMaterial();
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 72), mat);
  spinNode.add(body);

  const lines = fieldLines();
  magNode.add(lines);
  const trapped = createTrappedParticles(pulsar ? 7000 : 9000);
  magNode.add(trapped.points);

  const glow = new Glow(pulsar ? 9 : 7);
  glow.uniforms.uTemp.value = 40000;
  glow.uniforms.uIntensity.value = 0.4;
  glow.uniforms.uStreaks.value = 0.3;
  group.add(glow.mesh);

  // ---- pulsar emission ----
  const shared = {
    uTime: { value: 0 },
    uHalf: { value: THREE.MathUtils.degToRad(9) },
    uSparks: { value: 12 },
    uDrift: { value: 0.3 },
    uCore: { value: 1.0 },
    uIntensity: { value: 1.0 },
  };
  const beamSets: { mesh: THREE.Mesh; u: BeamUniforms; node: THREE.Group }[] = [];
  const particles = new THREE.Group();
  const openLines = openFieldLines();
  if (pulsar) {
    for (const flip of [false, true]) {
      const node = new THREE.Group();
      if (flip) node.rotation.z = Math.PI;
      const u: BeamUniforms = { ...shared, uCamLocal: { value: new THREE.Vector3() } };
      const mesh = createBeam(u);
      node.add(mesh);
      particles.add(node.clone(false).add(createParticles(u)));
      magNode.add(node);
      beamSets.push({ mesh, u, node });
    }
    magNode.add(particles, openLines);
  }

  let alpha = pulsar ? 35 : 20;
  let spin = pulsar ? 1.2 : 0.3;
  const setAlpha = (deg: number) => {
    alpha = deg;
    magNode.rotation.z = THREE.MathUtils.degToRad(deg);
    const axis = new THREE.Vector3(0, 1, 0).applyAxisAngle(new THREE.Vector3(0, 0, 1), magNode.rotation.z);
    uniforms.uMagAxis.value.copy(axis);
  };
  setAlpha(alpha);

  const params: SimObject['params'] = [
    { kind: 'range', key: 'alpha', label: '磁倾角 α', min: 0, max: 90, step: 1, value: alpha, unit: '°',
      format: (v) => `${v.toFixed(0)}°`, onChange: setAlpha },
    { kind: 'range', key: 'spin', label: pulsar ? '自转速度（慢放）' : '自转速度（演示）', min: 0, max: 6, step: 0.05, value: spin,
      onChange: (v) => (spin = v) },
    { kind: 'toggle', key: 'lines', label: '显示闭合磁力线', value: true, onChange: (v) => (lines.visible = v) },
    { kind: 'toggle', key: 'trapped', label: '磁层被俘粒子', value: true, onChange: (v) => (trapped.points.visible = v) },
  ];
  if (pulsar) {
    params.push(
      { kind: 'range', key: 'width', label: '光束半张角', min: 3, max: 20, step: 0.5, value: 9,
        format: (v) => `${v.toFixed(1)}°`,
        onChange: (v) => {
          shared.uHalf.value = THREE.MathUtils.degToRad(v);
          for (const b of beamSets) { b.mesh.geometry.dispose(); b.mesh.geometry = boundingCone(shared.uHalf.value); }
        } },
      { kind: 'range', key: 'core', label: '核心辐射强度', min: 0, max: 2, step: 0.05, value: 1, onChange: (v) => (shared.uCore.value = v) },
      { kind: 'range', key: 'sparks', label: '火花数（旋转木马）', min: 0, max: 24, step: 1, value: 12,
        format: (v) => (v === 0 ? '0（连续锥）' : v.toFixed(0)), onChange: (v) => (shared.uSparks.value = v) },
      { kind: 'range', key: 'drift', label: '火花漂移速度', min: -1.5, max: 1.5, step: 0.05, value: 0.3, onChange: (v) => (shared.uDrift.value = v) },
      { kind: 'toggle', key: 'particles', label: '显示等离子体粒子流', value: true, onChange: (v) => (particles.visible = v) },
      { kind: 'toggle', key: 'open', label: '显示开放磁力线', value: true, onChange: (v) => (openLines.visible = v) },
    );
  }

  // ---- pulse profile: what a distant observer along the current view direction would record ----
  const camDir = new THREE.Vector3();
  const mAxis = new THREE.Vector3();
  const halfOf = () => shared.uHalf.value;
  const pole = [0, 0];
  const intensityAt = (psi: number) => {
    const a = THREE.MathUtils.degToRad(alpha);
    // magnetic axis after spinning by psi about +y
    mAxis.set(-Math.sin(a) * Math.cos(psi), Math.cos(a), Math.sin(a) * Math.sin(psi));
    const c = THREE.MathUtils.clamp(mAxis.dot(camDir), -1, 1);
    const x1 = Math.acos(c) / halfOf();
    const x2 = Math.acos(-c) / halfOf();
    pole[0] = beamProfile(x1, shared.uCore.value);
    pole[1] = beamProfile(x2, shared.uCore.value);
    return pole[0] + pole[1];
  };
  let profileCanvas: HTMLCanvasElement | undefined;
  let profileCap: HTMLElement | undefined;
  const drawProfile = () => {
    if (!profileCanvas || !profileCanvas.isConnected) return;
    const cv = profileCanvas;
    const w = (cv.width = cv.clientWidth * devicePixelRatio);
    const h = (cv.height = cv.clientHeight * devicePixelRatio);
    const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    const n = 360;
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
      profileCap.textContent = max < 0.05
        ? '脉冲轮廓：从当前视角看，光束扫不到你，所以观测不到这颗脉冲星。'
        : both
          ? '脉冲轮廓：两个磁极的光束都扫过视线，出现主脉冲 + 中间脉冲。'
          : hasTwoPeaks(vals, max)
            ? '脉冲轮廓：视线切过空心锥，出现双峰（锥成分）。黄线为当前相位。'
            : '脉冲轮廓：视线穿过光束中心附近，单峰为主。黄线为当前相位。';
    }
  };
  const hasTwoPeaks = (vals: number[], max: number) => {
    let peaks = 0, above = false;
    for (const v of vals) { const a = v > max * 0.3; if (a && !above) peaks++; above = a; }
    if (above && vals[0] > max * 0.3 && peaks > 1) peaks--;
    return peaks >= 2;
  };

  let profileTimer = 0;
  return {
    id: pulsar ? 'pulsar' : 'neutron',
    name: pulsar ? '脉冲星' : '中子星',
    group,
    camera: { distance: pulsar ? 26 : 7, min: 1.4, max: 80 },
    presets: pulsar ? PULSAR_PRESETS : undefined,
    extraUI: pulsar ? () => {
      const box = document.createElement('div');
      box.className = 'profile';
      profileCap = document.createElement('div');
      profileCap.className = 'cap';
      profileCanvas = document.createElement('canvas');
      box.append(profileCap, profileCanvas);
      requestAnimationFrame(drawProfile);
      return box;
    } : undefined,
    bloom: { strength: pulsar ? 0.6 : 0.6, radius: 0.6, threshold: 0.9 },
    params,
    info: pulsar
      ? `
      <p><b>脉冲星</b>是快速自转、强磁化的中子星。磁极上方的<b>开放磁力线</b>（橙色）伸出光速圆柱，电子–正电子对沿它们向外飞出（粒子流），辐射出沿磁轴的两束光。</p>
      <p><b>光束结构</b>按观测总结的经验模型：中心有一个<b>核心</b>成分，外面套着<b>空心锥</b>。锥由极冠上方的若干<b>火花</b>供能，火花在 E×B 漂移下绕磁轴旋转（“旋转木马”），这就是观测到的<b>漂移子脉冲</b>。</p>
      <p>下方的<b>脉冲轮廓</b>是远处观测者（沿当前视线方向）在一个自转周期里记录到的亮度。旋转视角或改变磁倾角 α，可以看到单峰、双峰、主脉冲 + 中间脉冲，或者完全看不到脉冲。</p>
      <p class="approx">近似：光束为假彩色（射电波段肉眼不可见）；未计入相对论像差 / 推迟效应和光速圆柱处的电流片；时间大幅慢放。</p>`
      : `
      <p><b>中子星</b>是大质量恒星核心坍缩的遗骸：约 1.4 倍太阳质量压缩在半径 ~12 km 的球内，密度与原子核相当。</p>
      <p>新生中子星表面温度可达 10⁶ K，主要辐射 X 射线，可见光部分呈蓝白色。磁场可达 10⁸–10¹¹ T，图中为偶极磁力线；磁极处的热斑更亮。</p>
      <p class="approx">近似：尚未加入强引力光线弯曲（真实中子星可看到超过一半的表面），计划在后续版本加入。</p>`,
    update(dt, time, camera) {
      uniforms.uTime.value = time;
      shared.uTime.value = time;
      trapped.uniforms.uTime.value = time;
      spinNode.rotation.y += spin * dt;
      glow.update(camera, time);
      let boost = 1;
      if (pulsar) {
        group.updateMatrixWorld(true);
        for (const b of beamSets) b.u.uCamLocal.value.copy(b.mesh.worldToLocal(camera.position.clone()));
        camDir.copy(camera.position).normalize();
        // Lighthouse effect: brightness follows the beam profile at the current phase.
        boost = 1 + 1.2 * intensityAt(spinNode.rotation.y);
        profileTimer += dt;
        if (profileTimer > 0.1) { profileTimer = 0; drawProfile(); }
      }
      glow.uniforms.uIntensity.value = 0.4 * boost;
    },
  };
}

export const createNeutronStar = () => buildCompact(false);
export const createPulsar = () => buildCompact(true);
