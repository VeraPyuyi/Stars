import { BLACK_HOLE_PRESETS, PULSAR_PRESETS, STAR_PRESETS } from '../data/presets';
import type { Preset } from '../types';

export type StopKind = 'planet' | 'star' | 'pulsar' | 'blackhole';

export interface TourStop {
  id: string;
  /** Short name for the route bar. */
  short: string;
  kind: StopKind;
  preset: Preset;
  /** Distance from Earth in light years (ordering and travel time). */
  ly: number;
}

const find = (list: Preset[], id: string) => {
  const p = list.find((x) => x.id === id);
  if (!p) throw new Error(`unknown preset ${id}`);
  return p;
};

const EARTH: Preset = {
  id: 'earth',
  name: '地球 Earth',
  values: { type: 'rocky', sea: 0, cloud: 0.6, seed: 0, spin: 0.08 },
  facts: [['半径', '6371 km'], ['质量', '5.97×10²⁴ kg'], ['到太阳', '1 AU = 1.496 亿 km（光走 8.3 分钟）'], ['大气', '78% 氮、21% 氧']],
  note: '旅程的起点。光照方向就是下一站太阳所在的方向，所以晨昏线正对着我们要去的地方。地形与云层为程序生成，并非真实的大陆轮廓。',
};

/** Distances are rounded literature values; several (Deneb, the pulsars) are uncertain by tens of percent. */
const RAW: [StopKind, Preset, number][] = [
  ['planet', EARTH, 0],
  ['star', find(STAR_PRESETS, 'sun'), 1.581e-5],
  ['star', find(STAR_PRESETS, 'proxima'), 4.24],
  ['star', find(STAR_PRESETS, 'sirius'), 8.6],
  ['star', find(STAR_PRESETS, 'altair'), 16.7],
  ['star', find(STAR_PRESETS, 'vega'), 25],
  ['star', find(STAR_PRESETS, 'regulus'), 79],
  ['star', find(STAR_PRESETS, 'betelgeuse'), 548],
  ['star', find(STAR_PRESETS, 'antares'), 554],
  ['star', find(STAR_PRESETS, 'rigel'), 860],
  ['pulsar', find(PULSAR_PRESETS, 'vela'), 960],
  ['pulsar', find(PULSAR_PRESETS, 'b1919'), 1000],
  ['pulsar', find(PULSAR_PRESETS, 'b0943'), 2500],
  ['star', find(STAR_PRESETS, 'deneb'), 2600],
  ['pulsar', find(PULSAR_PRESETS, 'crab'), 6500],
  ['blackhole', find(BLACK_HOLE_PRESETS, 'cygx1'), 7200],
  ['pulsar', find(PULSAR_PRESETS, 'j1748'), 18000],
  ['blackhole', find(BLACK_HOLE_PRESETS, 'sgra'), 26700],
  ['blackhole', find(BLACK_HOLE_PRESETS, 'm87'), 5.5e7],
];

const SHORT: Record<string, string> = {
  earth: '地球', sun: '太阳', proxima: '比邻星', sirius: '天狼星', altair: '牛郎星', vega: '织女星', regulus: '轩辕十四',
  betelgeuse: '参宿四', antares: '心宿二', rigel: '参宿七', vela: '船帆座脉冲星', b1919: 'PSR B1919+21',
  b0943: 'PSR B0943+10', deneb: '天津四', crab: '蟹状星云脉冲星', cygx1: '天鹅座 X-1', j1748: 'J1748−2446ad',
  sgra: '人马座 A*', m87: 'M87*',
};

export const TOUR_STOPS: TourStop[] = RAW.map(([kind, preset, ly]) => ({ id: preset.id, short: SHORT[preset.id] ?? preset.name, kind, preset, ly }));

/** Human-readable distance from Earth. */
export function formatDistance(ly: number): string {
  if (ly <= 0) return '0';
  const lightMinutes = ly * 525960;
  if (lightMinutes < 60) return `${lightMinutes.toFixed(1)} 光分`;
  if (ly * 8766 < 48) return `${(ly * 8766).toFixed(1)} 光时`;
  if (ly * 365.25 < 60) return `${(ly * 365.25).toFixed(1)} 光日`;
  if (ly < 10) return `${ly.toFixed(2)} 光年`;
  if (ly < 1e4) return `${Math.round(ly).toLocaleString('zh-CN')} 光年`;
  if (ly < 1e8) return `${(ly / 1e4).toLocaleString('zh-CN', { maximumFractionDigits: ly < 1e5 ? 2 : 0 })} 万光年`;
  return `${(ly / 1e8).toFixed(2)} 亿光年`;
}

/** Travel time between two stops: grows with the logarithm of the distance covered. */
export function travelSeconds(a: TourStop, b: TourStop): number {
  const d = Math.abs(b.ly - a.ly);
  return Math.min(20, 3 + 2.2 * Math.log10(1 + d));
}

/** Distance from Earth part-way through a trip, interpolated on a log scale. */
export function distanceAt(a: TourStop, b: TourStop, t: number): number {
  const la = Math.log10(a.ly + 1e-6), lb = Math.log10(b.ly + 1e-6);
  return Math.max(0, 10 ** (la + (lb - la) * t) - 1e-6);
}
