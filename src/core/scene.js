// 共同空间（Shared Space）—— App 打开后的首页，不是聊天列表。
//
// 这里只做一件事：把「时间 + AI状态 + 用户状态 + 当前项目」算成一份场景描述。
// 它不碰 DOM，输出的是一个纯对象，交给渲染层去画。
// 这样以后从 2D 换成 Live2D 或 3D，这份逻辑一行都不用改。

import { createClock, DAY, HOUR } from './clock.js';

export const PERIODS = ['dawn', 'day', 'dusk', 'night'];

export function periodOf(hour) {
  if (hour >= 5 && hour < 8) return 'dawn';
  if (hour >= 8 && hour < 17) return 'day';
  if (hour >= 17 && hour < 20) return 'dusk';
  return 'night';
}

const LIGHT = {
  dawn:  { level: 0.55, warmth: 0.75, desc: '天刚亮，光是淡的' },
  day:   { level: 1.00, warmth: 0.50, desc: '自然光照进房间' },
  dusk:  { level: 0.65, warmth: 0.85, desc: '光偏橙，屋里开始暗下来' },
  night: { level: 0.25, warmth: 0.30, desc: '房间灯光较暗' },
};

// 天气不能每次渲染都随机 —— 那样窗外一会儿下雨一会儿晴。
// 用「日期 + 半天」做种子，同一个半天里结果稳定。
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967295;
}

export function weatherOf(ymd, hour, { rainChance = 0.25 } = {}) {
  const r = hash(`${ymd}#${hour < 12 ? 'am' : 'pm'}`);
  if (r < rainChance) return 'rain';
  if (r < rainChance + 0.15) return 'cloudy';
  return 'clear';
}

/** 项目类型 → 桌面上该出现什么。规格里点名的两种：写小说、写软件。 */
const PROJECT_PROPS = {
  novel:    ['manuscript', 'books', 'pen'],        // 稿纸、书籍
  software: ['laptop', 'terminal', 'sticky_note'], // 电脑、终端
  study:    ['notebook', 'books'],
  default:  ['mug'],
};

/**
 * @param {object} input
 *  - clock        时间源
 *  - aiState      'idle'|'reading'|'working'|'thinking'|'sleeping'
 *  - user         { lastSeenAt, activity: 'novel'|'software'|'study'|null }
 *  - project      { id, kind, name, progress }  当前共同项目
 *  - mood         AI 心情 0–1
 */
export function resolveScene({
  clock = createClock(),
  aiState = 'idle',
  user = {},
  project = null,
  mood = 0.6,
  rainChance = 0.25,
} = {}) {
  const now = clock.now();
  const hour = clock.hour();
  const period = periodOf(hour);
  const weather = period === 'night' || period === 'dusk'
    ? weatherOf(clock.ymd(), hour, { rainChance })
    : weatherOf(clock.ymd(), hour, { rainChance: rainChance * 0.8 });

  const lastSeenAt = user.lastSeenAt || now;
  const awayMs = Math.max(0, now - lastSeenAt);
  const awayHours = awayMs / HOUR;

  // 用户离开多久，决定桌面上留下什么
  let absence = 'present';
  if (awayHours >= 72) absence = 'long';
  else if (awayHours >= 12) absence = 'medium';
  else if (awayHours >= 3) absence = 'short';

  const props = new Set(PROJECT_PROPS[project?.kind] || PROJECT_PROPS.default);
  if (period === 'night') props.add('lamp');
  if (weather === 'rain') props.add('window_rain');

  // 用户长时间没回来：桌面出现新的便签、日记，或者等待状态
  const leftovers = [];
  if (absence === 'short') leftovers.push({ kind: 'sticky_note', text: '你回来啦？' });
  if (absence === 'medium') {
    leftovers.push({ kind: 'sticky_note', text: '今天没等到你，先把该做的做了。' });
    leftovers.push({ kind: 'diary' });
  }
  if (absence === 'long') {
    leftovers.push({ kind: 'diary' });
    leftovers.push({ kind: 'dust' });
    leftovers.push({ kind: 'sticky_note', text: `${Math.floor(awayHours / 24)} 天没见了。` });
  }
  for (const l of leftovers) props.add(l.kind);

  // AI 在做什么，也会改变桌面
  if (aiState === 'reading') props.add('open_book');
  if (aiState === 'working') { props.add('laptop'); props.add('terminal'); }

  const light = { ...LIGHT[period] };
  if (weather === 'rain') light.level = Math.max(0.15, light.level - 0.15);
  if (weather === 'cloudy') light.level = Math.max(0.2, light.level - 0.08);

  return {
    at: now,
    hour,
    period,
    weather,
    light,
    mood,
    aiState,
    absence,
    awayHours: Math.round(awayHours * 10) / 10,
    project: project ? { id: project.id, kind: project.kind, name: project.name, progress: project.progress ?? null } : null,
    props: [...props],
    leftovers,
    /** 给渲染层的背景配色档位，2D / Live2D / 3D 都能用同一组 */
    palette: paletteFor(period, weather),
    describe() { return describeScene(this); },
  };
}

function paletteFor(period, weather) {
  const base = {
    dawn:  { bg: '#e9dfd4', far: '#cdbfae', near: '#8d7f70', glow: '#f3d9b5' },
    day:   { bg: '#e6ebef', far: '#c3cfd8', near: '#8d9aa5', glow: '#fff6e2' },
    dusk:  { bg: '#e6cfc0', far: '#c39c86', near: '#7d5f52', glow: '#f2b784' },
    night: { bg: '#1b1f27', far: '#262c38', near: '#39414f', glow: '#f0c987' },
  }[period];
  if (weather === 'rain') return { ...base, far: shade(base.far, -8), near: shade(base.near, -8) };
  return base;
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map(v => Math.min(255, Math.max(0, v + amt)));
  return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
}

export function describeScene(s) {
  const bits = [LIGHT[s.period].desc];
  if (s.weather === 'rain') bits.push('窗外在下雨');
  else if (s.weather === 'cloudy') bits.push('天阴着');
  if (s.project) bits.push(`桌上摊着${s.project.kind === 'novel' ? '稿纸' : s.project.kind === 'software' ? '电脑' : '本子'}，是《${s.project.name}》`);
  if (s.absence === 'medium') bits.push('桌角多了一张便签');
  if (s.absence === 'long') bits.push('桌上积了点灰，便签压在日记本上');
  return bits.join('，') + '。';
}

export const SCENE_REFRESH_MS = 5 * 60 * 1000;
export { DAY, HOUR };
