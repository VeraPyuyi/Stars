import type { SimObject } from '../types';
import { formatDistance, type TourStop } from './stops';

export interface TourUIHandlers {
  go(i: number): void;
  next(): void;
  prev(): void;
  toggleAuto(): void;
  openCustom(i: number): void;
  /** Hold-to-move along the route: +1 forward, −1 back, 0 released. */
  hold(dir: number): void;
  /** Stop where the camera is. */
  stop(): void;
}

const KIND_LABEL: Record<TourStop['kind'], string> = { planet: '行星', star: '恒星', pulsar: '脉冲星', blackhole: '黑洞' };

/**
 * The tour's overlay, laid out like the homepage flight: the story of the current
 * stop on the left (the object rests right of centre), the route along the bottom,
 * and a distance read-out while travelling.
 */
export class TourUI {
  readonly el: HTMLElement;
  private card: HTMLElement;
  private hud: HTMLElement;
  private hudName: HTMLElement;
  private hudDist: HTMLElement;
  private rail: HTMLOListElement;
  private fill: HTMLElement;
  private autoBtn!: HTMLButtonElement;
  private lastCur = -1;

  constructor(private stops: TourStop[], private h: TourUIHandlers) {
    this.el = document.createElement('section');
    this.el.id = 'tour-ui';
    this.card = document.createElement('article');
    this.card.id = 'stop-card';
    this.hud = document.createElement('div');
    this.hud.id = 'travel-hud';
    this.hudName = document.createElement('div');
    this.hudName.className = 'to';
    this.hudDist = document.createElement('div');
    this.hudDist.className = 'dist';
    this.hud.append(this.hudName, this.hudDist);

    const route = document.createElement('nav');
    route.id = 'route';
    this.rail = document.createElement('ol');
    const track = document.createElement('div');
    track.className = 'track';
    this.fill = document.createElement('div');
    this.fill.className = 'fill';
    track.append(this.fill);
    stops.forEach((s, i) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.innerHTML = `<i></i><span>${s.short}</span>`;
      b.title = `${s.preset.name} · ${formatDistance(s.ly)}`;
      b.addEventListener('click', () => h.go(i));
      li.append(b);
      this.rail.append(li);
    });
    const inner = document.createElement('div');
    inner.className = 'inner';
    inner.style.setProperty('--n', String(stops.length));
    inner.append(track, this.rail);
    route.append(inner);
    // Manual drive: hold to creep forward / back along the route, or stop half-way.
    const drive = document.createElement('div');
    drive.id = 'drive';
    const holdBtn = (label: string, dir: number, title: string) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      const release = () => h.hold(0);
      b.addEventListener('pointerdown', (e) => { b.setPointerCapture(e.pointerId); h.hold(dir); });
      b.addEventListener('pointerup', release);
      b.addEventListener('pointercancel', release);
      b.addEventListener('lostpointercapture', release);
      b.addEventListener('contextmenu', (e) => e.preventDefault());
      return b;
    };
    const stopBtn = document.createElement('button');
    stopBtn.className = 'stop';
    stopBtn.textContent = '■ 停在这里';
    stopBtn.addEventListener('click', () => h.stop());
    drive.append(holdBtn('◀ 后退', -1, '按住后退（或按住 ↓）'), stopBtn, holdBtn('前进 ▶', 1, '按住前进（或按住 ↑）'));
    this.el.append(this.card, this.hud, drive, route);
  }

  /** Fill the card for stop i and mark it on the route. */
  arrive(i: number, obj: SimObject) {
    const s = this.stops[i];
    const p = s.preset;
    const rows = p.facts.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');
    this.card.innerHTML = `
      <p class="plate">✦ 第 ${i + 1} / ${this.stops.length} 站 · ${KIND_LABEL[s.kind]} · ${i === 0 ? '起点' : `距地球 ${formatDistance(s.ly)}`}</p>
      <h2>${p.name}</h2>
      ${p.note ? `<p class="note">${p.note}</p>` : ''}
      <table class="facts-table">${rows}</table>
      <details><summary>物理说明</summary><div class="info">${obj.info}</div></details>
      <div class="extra"></div>
      <div class="actions">
        <button data-a="prev" ${i === 0 ? 'disabled' : ''}>← 上一站</button>
        <button data-a="next" class="primary" ${i === this.stops.length - 1 ? 'disabled' : ''}>下一站 →</button>
        <button data-a="auto"></button>
        <button data-a="custom" class="link">用这组参数自定义</button>
      </div>`;
    if (obj.extraUI) this.card.querySelector('.extra')!.append(obj.extraUI());
    const on = (a: string, f: () => void) => this.card.querySelector<HTMLButtonElement>(`[data-a=${a}]`)!.addEventListener('click', f);
    on('prev', this.h.prev);
    on('next', this.h.next);
    on('auto', this.h.toggleAuto);
    on('custom', () => this.h.openCustom(i));
    this.autoBtn = this.card.querySelector<HTMLButtonElement>('[data-a=auto]')!;
    this.el.classList.remove('travelling');
    this.mark(i, i, 0);
  }

  setAutoplay(on: boolean) {
    if (this.autoBtn) this.autoBtn.textContent = on ? '⏸ 暂停漫游' : '▶ 自动漫游';
    this.el.classList.toggle('auto', on);
  }

  depart(from: number, to: number, seconds: number) {
    this.el.classList.add('travelling');
    this.hudName.textContent = `${to > from ? '前往' : '返回'} ${this.stops[to].preset.name} · 这一段约 ${seconds.toFixed(0)} 秒`;
  }

  progress(ly: number, t: number, from: number, to: number) {
    this.hudDist.textContent = ly <= 0 ? '地球' : `距地球 ${formatDistance(ly)}`;
    this.mark(from, to, t);
  }

  private mark(from: number, to: number, t: number) {
    const items = [...this.rail.children] as HTMLElement[];
    items.forEach((li, k) => {
      li.classList.toggle('current', k === (t < 0.5 ? from : to));
      li.classList.toggle('visited', k <= Math.min(from, to));
    });
    const n = this.stops.length - 1;
    const pos = (from + (to - from) * t) / n;
    this.fill.style.width = `${(pos * 100).toFixed(2)}%`;
    const k = t < 0.5 ? from : to;
    if (k !== this.lastCur) {
      this.lastCur = k;
      // Keep the current stop in view when the route is wider than the screen.
      items[k]?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    }
  }
}
