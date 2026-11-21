import { BLACK_HOLE_PRESETS, PULSAR_PRESETS, STAR_PRESETS } from '../data/presets';
import type { Preset } from '../types';

export type StopKind = 'planet' | 'star' | 'pulsar' | 'blackhole' | 'belt';

export interface TourStop {
  id: string;
  /** Short name for the route bar. */
  short: string;
  kind: StopKind;
  preset: Preset;
  /** Distance used for ordering and travel time, in light years (from the Sun inside the solar system). */
  ly: number;
  /** World-space radius of the object (planets are drawn smaller than the Sun). */
  scale: number;
  /** Solar-system bodies orbit the Sun: semi-major axis (AU), period (years). */
  orbit?: { au: number; years: number };
  /** Sidereal rotation period in hours (negative: retrograde), if known. */
  rotHours?: number;
}

const AU_LY = 1.581e-5;

const find = (list: Preset[], id: string) => {
  const p = list.find((x) => x.id === id);
  if (!p) throw new Error(`unknown preset ${id}`);
  return p;
};

const planet = (id: string, name: string, type: string, facts: [string, string][], note: string, extra: Record<string, number> = {}): Preset =>
  ({ id, name, values: { type, ...extra }, facts, note });

const EARTH = planet('earth', '地球 Earth', 'rocky',
  [['半径', '6371 km'], ['到太阳', '1 AU = 1.496 亿 km（光走 8.3 分钟）'], ['公转', '365.25 天'], ['自转', '23.9 小时'], ['大气', '78% 氮、21% 氧']],
  '我们的家园，太阳系里唯一已知有液态水海洋和生命的行星。这里的地形与云层为程序生成，并非真实的大陆轮廓。', { sea: 0, cloud: 0.6, seed: 0 });
const MERCURY = planet('mercury', '水星 Mercury', 'mercury',
  [['半径', '2440 km'], ['到太阳', '0.39 AU'], ['公转', '88 天'], ['自转', '58.6 天（公转两圈自转三圈）'], ['表面温度', '−173 ~ 427 °C']],
  '离太阳最近、最小的行星。几乎没有大气，所以布满环形山，昼夜温差是太阳系之最。');
const VENUS = planet('venus', '金星 Venus', 'venus',
  [['半径', '6052 km'], ['到太阳', '0.72 AU'], ['公转', '225 天'], ['自转', '243 天，逆向'], ['表面', '464 °C、92 个大气压']],
  '浓厚的二氧化碳大气和硫酸云造成失控温室效应，比水星还热。自转方向与其他行星相反（自转轴几乎倒置）。');
const MARS = planet('mars', '火星 Mars', 'mars',
  [['半径', '3390 km'], ['到太阳', '1.52 AU'], ['公转', '687 天'], ['自转', '24.6 小时'], ['大气', '约 0.6% 地球气压，主要是 CO₂']],
  '红色来自表面的氧化铁尘土。两极有水冰和干冰组成的极冠，暗色区域是玄武岩平原。');
const JUPITER = planet('jupiter', '木星 Jupiter', 'jupiter',
  [['半径', '69,911 km（地球的 11 倍）'], ['到太阳', '5.2 AU'], ['公转', '11.9 年'], ['自转', '9.9 小时（最快）'], ['质量', '地球的 318 倍']],
  '最大的行星，快速自转把云层拉成明暗相间的带。大红斑是一个比地球还大、持续了几百年的反气旋风暴。');
const SATURN = planet('saturn', '土星 Saturn', 'saturn',
  [['半径', '58,232 km'], ['到太阳', '9.6 AU'], ['公转', '29.4 年'], ['自转', '10.7 小时'], ['光环', '宽约 28 万 km，厚度通常不到 1 km']],
  '平均密度比水还小。光环由无数冰块和岩石组成，被土星的影子遮住的部分清晰可见。');
const URANUS = planet('uranus', '天王星 Uranus', 'uranus',
  [['半径', '25,362 km'], ['到太阳', '19.2 AU'], ['公转', '84 年'], ['自转', '17.2 小时，逆向'], ['自转轴倾角', '97.8°（躺着转）']],
  '冰巨星，大气中的甲烷吸收红光，呈青色。自转轴几乎躺在轨道面上，每个极点会连续经历 42 年白昼和 42 年黑夜。');
const NEPTUNE = planet('neptune', '海王星 Neptune', 'neptune',
  [['半径', '24,622 km'], ['到太阳', '30.1 AU'], ['公转', '165 年'], ['自转', '16.1 小时'], ['风速', '最高约 2100 km/h']],
  '1846 年先由天王星轨道的偏差算出位置，再用望远镜找到。深蓝色的大气里有太阳系最快的风和时隐时现的暗斑。');
const BELT: Preset = {
  id: 'belt', name: '小行星带 Asteroid Belt', values: {},
  facts: [['位置', '约 2.2–3.3 AU，火星与木星之间'], ['总质量', '约月球的 3%'], ['最大成员', '谷神星（直径 940 km，矮行星）'], ['空隙', '柯克伍德空隙（与木星轨道共振）']],
  note: '天体之间平均相距上百万公里，探测器穿越时几乎不会撞上任何东西。这里的小行星为了好看画得很密，镜头附近的较大石块是按光照着色的不规则岩体。',
};

/** Distances are rounded literature values; several (Deneb, the pulsars) are uncertain by tens of percent. */
type Raw = [StopKind, Preset, number, Partial<Pick<TourStop, 'scale' | 'orbit' | 'rotHours'>>?];
const RAW: Raw[] = [
  // The solar system, from the Sun outwards (distance = from the Sun).
  ['star', find(STAR_PRESETS, 'sun'), 0, { rotHours: 609 }],
  ['planet', MERCURY, 0.387 * AU_LY, { scale: 0.16, orbit: { au: 0.387, years: 0.241 }, rotHours: 1408 }],
  ['planet', VENUS, 0.723 * AU_LY, { scale: 0.25, orbit: { au: 0.723, years: 0.615 }, rotHours: -5832 }],
  ['planet', EARTH, 1 * AU_LY, { scale: 0.26, orbit: { au: 1, years: 1 }, rotHours: 23.9 }],
  ['planet', MARS, 1.524 * AU_LY, { scale: 0.19, orbit: { au: 1.524, years: 1.881 }, rotHours: 24.6 }],
  ['belt', BELT, 2.7 * AU_LY, { scale: 1, orbit: { au: 2.7, years: 4.6 } }],
  ['planet', JUPITER, 5.2 * AU_LY, { scale: 0.9, orbit: { au: 5.2, years: 11.86 }, rotHours: 9.93 }],
  ['planet', SATURN, 9.58 * AU_LY, { scale: 0.78, orbit: { au: 9.58, years: 29.4 }, rotHours: 10.7 }],
  ['planet', URANUS, 19.2 * AU_LY, { scale: 0.5, orbit: { au: 19.2, years: 84 }, rotHours: -17.2 }],
  ['planet', NEPTUNE, 30.1 * AU_LY, { scale: 0.48, orbit: { au: 30.1, years: 164.8 }, rotHours: 16.1 }],
  // Beyond: stars, pulsars and black holes by distance from Earth.
  ['star', find(STAR_PRESETS, 'proxima'), 4.24, { rotHours: 83 * 24 }],
  ['star', find(STAR_PRESETS, 'sirius'), 8.6, { rotHours: 130 }],
  ['star', find(STAR_PRESETS, 'altair'), 16.7, { rotHours: 9 }],
  ['star', find(STAR_PRESETS, 'vega'), 25, { rotHours: 12.5 }],
  ['star', find(STAR_PRESETS, 'regulus'), 79, { rotHours: 15.9 }],
  ['star', find(STAR_PRESETS, 'betelgeuse'), 548, { rotHours: 36 * 8766 }],
  ['star', find(STAR_PRESETS, 'antares'), 554, { rotHours: 12 * 8766 }],
  ['star', find(STAR_PRESETS, 'rigel'), 860, { rotHours: 160 * 24 }],
  ['pulsar', find(PULSAR_PRESETS, 'vela'), 960],
  ['pulsar', find(PULSAR_PRESETS, 'b1919'), 1000],
  ['pulsar', find(PULSAR_PRESETS, 'b0943'), 2500],
  ['star', find(STAR_PRESETS, 'deneb'), 2600, { rotHours: 500 * 24 }],
  ['pulsar', find(PULSAR_PRESETS, 'crab'), 6500],
  ['blackhole', find(BLACK_HOLE_PRESETS, 'cygx1'), 7200],
  ['pulsar', find(PULSAR_PRESETS, 'j1748'), 18000],
  ['blackhole', find(BLACK_HOLE_PRESETS, 'sgra'), 26700],
  ['blackhole', find(BLACK_HOLE_PRESETS, 'm87'), 5.5e7],
];

const SHORT: Record<string, string> = {
  earth: '地球', sun: '太阳', mercury: '水星', venus: '金星', mars: '火星', belt: '小行星带', jupiter: '木星',
  saturn: '土星', uranus: '天王星', neptune: '海王星',
  proxima: '比邻星', sirius: '天狼星', altair: '牛郎星', vega: '织女星', regulus: '轩辕十四',
  betelgeuse: '参宿四', antares: '心宿二', rigel: '参宿七', vela: '船帆座脉冲星', b1919: 'PSR B1919+21',
  b0943: 'PSR B0943+10', deneb: '天津四', crab: '蟹状星云脉冲星', cygx1: '天鹅座 X-1', j1748: 'J1748−2446ad',
  sgra: '人马座 A*', m87: 'M87*',
};

export const TOUR_STOPS: TourStop[] = RAW.map(([kind, preset, ly, extra]) => ({
  id: preset.id, short: SHORT[preset.id] ?? preset.name, kind, preset, ly, scale: 1, ...extra,
}));

/** Inside the solar system distances are given from the Sun in AU, outside from Earth in light years. */
export function formatDistance(ly: number): string {
  if (ly <= 0) return '0';
  if (ly < 0.01) return `${(ly / AU_LY).toFixed(ly / AU_LY < 10 ? 2 : 1)} AU`;
  if (ly < 10) return `${ly.toFixed(2)} 光年`;
  if (ly < 1e4) return `${Math.round(ly).toLocaleString('zh-CN')} 光年`;
  if (ly < 1e8) return `${(ly / 1e4).toLocaleString('zh-CN', { maximumFractionDigits: ly < 1e5 ? 2 : 0 })} 万光年`;
  return `${(ly / 1e8).toFixed(2)} 亿光年`;
}

/** "距太阳 1.52 AU" inside the solar system, "距地球 860 光年" beyond it. */
export function distanceLabel(ly: number): string {
  if (ly <= 0) return '太阳系中心';
  return `${ly < 0.01 ? '距太阳' : '距地球'} ${formatDistance(ly)}`;
}

/** Travel time between two stops: grows with the logarithm of the distance covered. */
export function travelSeconds(a: TourStop, b: TourStop): number {
  const d = Math.abs(b.ly - a.ly);
  return Math.min(20, 3.5 + 2.2 * Math.log10(1 + d));
}

/** Distance part-way through a trip, interpolated on a log scale. */
export function distanceAt(a: TourStop, b: TourStop, t: number): number {
  const la = Math.log10(a.ly + 1e-6), lb = Math.log10(b.ly + 1e-6);
  return Math.max(0, 10 ** (la + (lb - la) * t) - 1e-6);
}

/**
 * Displayed rotation period (seconds) for a real one: every body visibly turns, slow
 * rotators turn slower, but the range is compressed (9.9 h → 15 s, 36 yr → 37 s).
 */
export function displayedRotation(hours: number): number {
  return 10 + 5 * Math.log10(Math.max(1, Math.abs(hours)));
}

/** Displayed orbital period (seconds): Earth takes four minutes, Neptune about 50. */
export function displayedOrbit(years: number): number {
  return 240 * Math.sqrt(years);
}
