import * as THREE from 'three';
import type { Sky } from '../sky';
import type { SimObject } from '../types';
import { BLACK_HOLE_PRESETS } from '../data/presets';

export function createBlackHole(sky: Sky): SimObject {
  const u = sky.uniforms;
  return {
    id: 'blackhole',
    name: '黑洞',
    group: new THREE.Group(),
    skyMode: 'blackhole',
    presets: BLACK_HOLE_PRESETS,
    camera: { distance: 26, min: 3, max: 70 },
    bloom: { strength: 0.5, radius: 0.5, threshold: 0.9 },
    params: [
      { kind: 'range', key: 'temp', label: '吸积盘峰值温度', min: 3000, max: 30000, step: 100, value: u.uDiskTemp.value,
        format: (v) => `${v.toFixed(0)} K`, onChange: (v) => (u.uDiskTemp.value = v) },
      { kind: 'range', key: 'outer', label: '吸积盘外半径', min: 6, max: 30, step: 0.5, value: u.uDiskOuter.value,
        format: (v) => `${v.toFixed(1)} r_s`, onChange: (v) => (u.uDiskOuter.value = v) },
      { kind: 'range', key: 'doppler', label: '多普勒 + 引力红移', min: 0, max: 1, step: 0.01, value: u.uDoppler.value,
        onChange: (v) => (u.uDoppler.value = v) },
      { kind: 'range', key: 'bright', label: '吸积盘亮度', min: 0.5, max: 8, step: 0.1, value: u.uDiskBright.value,
        onChange: (v) => (u.uDiskBright.value = v) },
    ],
    info: `
      <p>每个像素的光线都沿<b>史瓦西时空的零测地线</b>反向积分（单位：史瓦西半径 r_s）。落入视界的光线为黑色，其余可能穿过吸积盘或逃逸到星空。</p>
      <p><b>引力透镜</b>：盘的背面被弯折到黑洞上下方可见；视界外 1.5 r_s 处的<b>光子球</b>形成细亮环；背景星空也被扭曲。</p>
      <p>吸积盘内缘在<b>最内稳定圆轨道</b> 3 r_s，温度剖面取薄盘模型；朝向我们运动的一侧因<b>相对论多普勒集束</b>更亮更蓝。把“多普勒”滑块拉到 0 可对比。</p>
      <p class="approx">近似：不自旋（非克尔黑洞）；薄盘、无体积；颜色为黑体近似。</p>`,
    update() {},
  };
}
