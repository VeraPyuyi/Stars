import type { Preset } from '../types';

/*
 * Presets for well-known objects. Values are rounded literature figures
 * (summarised from SIMBAD / published interferometry and timing papers);
 * many of them carry large uncertainties, noted where relevant.
 * Rendering-only knobs (spin speed, cell density, brightness) are chosen to
 * convey the physics visually, not measured quantities.
 */

const deg = (d: number) => (d * Math.PI) / 180;
/** Camera direction for an inclination i between the rotation axis (+y) and our line of sight. */
const incl = (i: number): [number, number, number] => [0, Math.cos(deg(i)), Math.sin(deg(i))];

export const STAR_PRESETS: Preset[] = [
  {
    id: 'sun', name: '太阳 Sun',
    values: { temp: 5772, spots: 0.5, gran: 1, cell: 28, oblate: 1, spin: 0.05 },
    facts: [['光谱型', 'G2V'], ['有效温度', '5772 K'], ['半径', '1 R☉ = 696,000 km'], ['质量', '1 M☉'], ['距离', '1 AU（8.3 光分）']],
    note: '主序星的参照。外对流层产生米粒组织，磁活动产生黑子（约 11 年周期）。',
  },
  {
    id: 'betelgeuse', name: '参宿四 Betelgeuse',
    values: { temp: 3600, spots: 0, gran: 1.3, cell: 4, oblate: 1, spin: 0.01 , prom: false},
    facts: [['光谱型', 'M1–M2 Ia-ab 红超巨星'], ['有效温度', '≈3600 K'], ['半径', '≈640–1000 R☉（常取 ≈760）'], ['质量', '≈16–19 M☉'], ['距离', '≈550 光年']],
    note: '表面只有少数几个巨型对流元胞，VLTI/ALMA 已直接看到其不均匀的盘面；2019–2020 年“大暗化”与一次表面物质抛射形成的尘埃有关。若放在太阳位置，表面会延伸到小行星带附近。',
  },
  {
    id: 'antares', name: '心宿二 Antares',
    values: { temp: 3570, spots: 0, gran: 1.25, cell: 4.5, oblate: 1, spin: 0.01 , prom: false},
    facts: [['光谱型', 'M1.5 Iab 红超巨星'], ['有效温度', '≈3600 K'], ['半径', '≈680 R☉'], ['质量', '≈12–13 M☉'], ['距离', '≈550 光年']],
    note: '与参宿四类似的红超巨星，ALMA 测得其延展大气。有一颗蓝白色伴星心宿二 B。',
  },
  {
    id: 'rigel', name: '参宿七 Rigel',
    values: { temp: 12100, spots: 0, gran: 0.4, cell: 18, oblate: 1, spin: 0.03 , prom: false},
    facts: [['光谱型', 'B8 Ia 蓝超巨星'], ['有效温度', '≈12,100 K'], ['半径', '≈79 R☉'], ['质量', '≈21 M☉'], ['距离', '≈860 光年']],
    note: '猎户座最亮的星，光度约为太阳的 12 万倍。热星的外层以辐射为主，没有太阳式的黑子。',
  },
  {
    id: 'deneb', name: '天津四 Deneb',
    values: { temp: 8525, spots: 0, gran: 0.4, cell: 16, oblate: 1, spin: 0.02 , prom: false},
    facts: [['光谱型', 'A2 Ia 白超巨星'], ['有效温度', '≈8500 K'], ['半径', '≈200 R☉'], ['质量', '≈19 M☉'], ['距离', '≈1500–2600 光年（不确定）']],
    note: '夏季大三角之一，是肉眼可见最远的亮星之一。距离不确定导致半径和光度的误差都很大。',
  },
  {
    id: 'sirius', name: '天狼星 Sirius A',
    values: { temp: 9940, spots: 0, gran: 0.3, cell: 35, oblate: 1, spin: 0.08 , prom: false},
    facts: [['光谱型', 'A1V'], ['有效温度', '≈9940 K'], ['半径', '1.71 R☉'], ['质量', '2.06 M☉'], ['距离', '8.6 光年']],
    note: '夜空中最亮的恒星。伴星天狼星 B 是一颗白矮星（地球大小，约 1 个太阳质量）。',
  },
  {
    id: 'vega', name: '织女星 Vega',
    values: { temp: 9600, spots: 0, gran: 0.3, cell: 35, oblate: 1.16, spin: 0.5 , prom: false},
    facts: [['光谱型', 'A0V'], ['平均温度', '≈9600 K（极 ≈10,000 K / 赤道 ≈8900 K）'], ['半径', '赤道 2.73 R☉ / 极 2.36 R☉'], ['质量', '≈2.1 M☉'], ['距离', '25 光年'], ['自转轴倾角', '≈5°（几乎正对极区）']],
    note: '快速自转使其成为扁球，我们几乎正对着它的极区看，所以长期以来被当作“标准星”时没人察觉它的重力昏暗。预设镜头会对准极区。',
    view: incl(5),
  },
  {
    id: 'altair', name: '牛郎星 Altair',
    values: { temp: 7550, spots: 0, gran: 0.3, cell: 35, oblate: 1.25, spin: 0.6 , prom: false},
    facts: [['光谱型', 'A7V'], ['温度', '极 ≈8450 K / 赤道 ≈6860 K'], ['半径', '赤道 2.03 R☉ / 极 1.63 R☉'], ['质量', '≈1.86 M☉'], ['距离', '16.7 光年'], ['自转周期', '≈9 小时'], ['自转轴倾角', '≈57°']],
    note: '2007 年 CHARA 干涉仪拍下的第一张主序星表面图像就是牛郎星，清楚显示了扁球外形与亮极、暗赤道。',
    view: incl(57),
  },
  {
    id: 'regulus', name: '轩辕十四 Regulus',
    values: { temp: 12460, spots: 0, gran: 0.3, cell: 30, oblate: 1.32, spin: 0.7 , prom: false},
    facts: [['光谱型', 'B8 IVn'], ['温度', '极 ≈15,400 K / 赤道 ≈10,300 K'], ['半径', '赤道 4.16 R☉ / 极 3.14 R☉'], ['质量', '≈3.8 M☉'], ['距离', '79 光年'], ['自转', '约为临界速度的 96%']],
    note: '自转快到接近被甩散的极限；我们几乎从赤道方向看它。',
    view: incl(86),
  },
  {
    id: 'proxima', name: '比邻星 Proxima Centauri',
    values: { temp: 3042, spots: 1, gran: 1, cell: 30, oblate: 1, spin: 0.05 },
    facts: [['光谱型', 'M5.5Ve 红矮星'], ['有效温度', '≈3040 K'], ['半径', '0.154 R☉'], ['质量', '0.122 M☉'], ['距离', '4.24 光年（离太阳最近）'], ['已知行星', 'b：≥1.07 地球质量，0.049 AU，11.2 天；d：≥0.26 地球质量，0.029 AU，5.1 天']],
    note: '活跃的耀星，表面星斑覆盖率高。漫游中可以看到它的两颗已确认行星绕它运行：宜居带内的比邻星 b，以及更近、更小的比邻星 d（轨道与大小均不按比例）。',
  },
];

export const PULSAR_PRESETS: Preset[] = [
  {
    id: 'crab', name: '蟹状星云脉冲星 Crab',
    values: { alpha: 50, period: Math.log10(33.7), spin: 3, sparks: 12, drift: 0.3, core: 1.0 },
    facts: [['编号', 'PSR B0531+21'], ['周期', '33.7 ms（每秒约 30 转）'], ['年龄', '约 970 年（公元 1054 年超新星）'], ['距离', '≈6500 光年'], ['表面磁场', '≈4×10⁸ T'], ['磁倾角 α', '≈45–60°（模型估计）']],
    note: '少数能在可见光波段看到脉冲的脉冲星。射电轮廓有主脉冲和相隔约 145° 的中间脉冲。',
  },
  {
    id: 'vela', name: '船帆座脉冲星 Vela',
    values: { alpha: 60, period: Math.log10(89.3), spin: 2, sparks: 10, drift: 0.2, core: 1.2 },
    facts: [['编号', 'PSR B0833−45'], ['周期', '89.3 ms（每秒约 11 转）'], ['年龄', '≈11,000 年'], ['距离', '≈960 光年'], ['表面磁场', '≈3.4×10⁸ T'], ['磁倾角 α', '≈43–70°（模型估计）']],
    note: '以频繁的“自转突变”（glitch）闻名，也是天空中最亮的持续伽马射线源之一。',
  },
  {
    id: 'b1919', name: 'PSR B1919+21（第一颗脉冲星）',
    values: { alpha: 30, period: Math.log10(1337), spin: 0.6, sparks: 8, drift: 0.6, core: 0.4 },
    facts: [['周期', '1.337 s'], ['发现', '1967 年，Jocelyn Bell Burnell'], ['距离', '≈1000 光年'], ['表面磁场', '≈1.4×10⁸ T'], ['磁倾角 α', '未精确测定（此处取 30°）']],
    note: '有明显的“漂移子脉冲”：单个脉冲里的子结构逐周期平移，被解释为火花在磁极附近绕磁轴旋转。',
  },
  {
    id: 'b0943', name: 'PSR B0943+10（火花“旋转木马”）',
    values: { alpha: 15, period: Math.log10(1098), spin: 0.7, sparks: 20, drift: 0.4, core: 0.2 },
    facts: [['周期', '1.098 s'], ['火花数', '20 个，约 37 个周期绕磁轴转一圈'], ['磁倾角 α', '≈11–15°（近乎对齐）'], ['距离', '≈2000–3000 光年（由色散量估计，不确定）']],
    note: 'Deshpande & Rankin (1999) 从漂移子脉冲中重建出 20 个火花组成的环——这是“旋转木马”模型最著名的证据。',
  },
  {
    id: 'j1748', name: 'PSR J1748−2446ad（转得最快）',
    values: { alpha: 40, period: Math.log10(1.396), spin: 6, sparks: 0, drift: 0, core: 1.0 },
    facts: [['周期', '1.396 ms（每秒 716 转）'], ['位置', '球状星团 Terzan 5'], ['距离', '≈18,000 光年'], ['类型', '毫秒脉冲星（被伴星吸积“加速”）']],
    note: '赤道线速度约为光速的 24%，光速圆柱半径只有约 67 km，所以光束的快照被光传播延迟卷成明显的螺旋，闭合磁力线也被压缩在很小的区域里。毫秒脉冲星磁场弱得多（≈10⁴–10⁵ T），但计时极其稳定。',
  },
];

export const BLACK_HOLE_PRESETS: Preset[] = [
  {
    id: 'm87', name: 'M87*',
    values: { temp: 7000, outer: 14, doppler: 1, bright: 2 },
    facts: [['质量', '≈6.5×10⁹ M☉'], ['距离', '≈5500 万光年'], ['史瓦西半径', '≈130 AU'], ['观测', '2019 年 EHT 首张黑洞照片（1.3 mm 射电）'], ['视线倾角', '≈17°（接近正对盘面）']],
    note: '镜头按 17° 倾角放置。真实 M87* 是快速自转的克尔黑洞，吸积流是厚而稀薄的热等离子体，并有喷流；这里用的是史瓦西薄盘近似。',
    view: incl(17),
  },
  {
    id: 'sgra', name: '人马座 A* Sgr A*',
    values: { temp: 6000, outer: 12, doppler: 1, bright: 1.8 },
    facts: [['质量', '≈4.3×10⁶ M☉'], ['距离', '≈26,700 光年（银河系中心）'], ['史瓦西半径', '≈0.08 AU'], ['观测', '2022 年 EHT 发布图像'], ['视线倾角', '≲50°（此处取 30°）']],
    note: '质量来自对 S2 等恒星轨道的长期跟踪（2020 年诺贝尔物理学奖）。',
    view: incl(30),
  },
  {
    id: 'cygx1', name: '天鹅座 X-1 Cygnus X-1',
    values: { temp: 30000, outer: 10, doppler: 1, bright: 2.5 },
    facts: [['质量', '≈21 M☉'], ['距离', '≈7200 光年'], ['伴星', 'HDE 226868 蓝超巨星'], ['吸积盘温度', '≈10⁷ K（X 射线）'], ['视线倾角', '≈27°']],
    note: '第一个被广泛认可的恒星级黑洞。真实盘温远超滑块上限，主要辐射 X 射线，此处颜色已饱和为蓝白色。',
    view: incl(27),
  },
];
