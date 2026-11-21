# Stars · 星体仿真渲染

> When you are depressed, just see the stars

在浏览器里实时渲染**恒星、行星、中子星、脉冲星和黑洞**，力求在物理上“说得通”，并且可以用鼠标/触屏拖动旋转、缩放查看。

A physically-inspired, interactive WebGL renderer for stars, planets, neutron stars, pulsars and black holes. Runs in any modern browser — no install needed.

![screenshots](docs/screenshots.jpg)

## 功能

| 天体 | 渲染要点 |
| --- | --- |
| 恒星 | 黑体辐射颜色（2500–40000 K，自动显示光谱型）、临边昏暗、米粒组织、星斑、光斑、日冕光晕 |
| 行星 | 类地行星（程序生成大陆/海洋/冰盖、海面高光、云层、夜面城市灯光、指数大气散射边缘）；气态巨行星（纬向云带、风暴涡旋、带行星投影的光环） |
| 中子星 | 10⁶ K 蓝白色表面、磁极热斑、偶极磁力线 |
| 脉冲星 | 倾斜磁轴、双锥辐射束、灯塔效应（光束扫过镜头时闪亮） |
| 黑洞 | 逐像素**史瓦西测地线光线追踪**：事件视界阴影、光子环、吸积盘引力透镜、背景星空畸变、相对论多普勒集束与引力红移 |

操作：左键拖动旋转 · 滚轮缩放 · 右键拖动平移（触屏：单指旋转、双指缩放）。

## 快速开始

```bash
npm install
npm run dev      # 打开 http://localhost:5173
npm run build    # 生成静态文件到 dist/，可直接部署到 GitHub Pages
```

需要支持 WebGL2 的浏览器。黑洞场景计算量较大，可在面板里调低“光线追踪质量”。

## 技术栈

- [Three.js](https://threejs.org/) + 自定义 GLSL 着色器
- TypeScript + [Vite](https://vite.dev/)
- 后期：UnrealBloom 辉光 + ACES 色调映射（HDR 线性光照）

```
src/
  main.ts            渲染器、相机控制、UI
  sky.ts             全屏背景：程序星空 / 黑洞光线追踪
  shaders/common.ts  噪声、黑体颜色等共享 GLSL
  objects/           各类天体（star / planet / compact / blackHole / glow）
```

## 物理近似说明

本项目追求“看起来对、原理上对”，而不是科研级精度。目前的主要近似：

- 颜色使用黑体温度 → RGB 拟合，未做完整光谱积分。
- 恒星表面纹理是程序噪声，不是磁流体模拟。
- 大气为单次散射的解析近似。
- 黑洞为不自旋的史瓦西黑洞，吸积盘为几何薄盘。
- 中子星暂未考虑引力光线弯曲。

## 路线图

- [ ] 克尔（自旋）黑洞与更真实的吸积盘（体积、喷流）
- [ ] 中子星引力光线弯曲（可见超过半个表面）
- [ ] 基于真实数据的预设：太阳、参宿四、天狼星 B、蟹状星云脉冲星、M87*、Sgr A*
- [ ] 真实星表背景（如 Hipparcos / Gaia 亮星）
- [ ] 双星、潮汐瓦解等动态场景
- [ ] 英文界面

欢迎 Issue 和 PR！

## License

[MIT](LICENSE)
