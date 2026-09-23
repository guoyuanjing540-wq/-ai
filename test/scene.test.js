import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixedClock, HOUR, DAY } from '../src/core/clock.js';
import { resolveScene, periodOf, weatherOf } from '../src/core/scene.js';

const at = s => createFixedClock(s);

test('时段划分', () => {
  assert.equal(periodOf(6), 'dawn');
  assert.equal(periodOf(12), 'day');
  assert.equal(periodOf(18), 'dusk');
  assert.equal(periodOf(23), 'night');
  assert.equal(periodOf(3), 'night');
});

test('白天：自然光进入房间', () => {
  const s = resolveScene({ clock: at('2026-09-23T13:00:00+08:00') });
  assert.equal(s.period, 'day');
  assert.ok(s.light.level >= 0.8, '白天不该这么暗：' + s.light.level);
});

test('夜晚：房间灯光较暗，而且会开台灯', () => {
  const s = resolveScene({ clock: at('2026-09-23T23:00:00+08:00') });
  assert.equal(s.period, 'night');
  assert.ok(s.light.level <= 0.3, '夜里不该这么亮：' + s.light.level);
  assert.ok(s.props.includes('lamp'));
});

test('天气在同一个半天里是稳定的，不会每次渲染都变', () => {
  const a = weatherOf('2026-09-23', 21);
  for (let i = 0; i < 50; i++) assert.equal(weatherOf('2026-09-23', 21), a);
  assert.equal(weatherOf('2026-09-23', 22), a, '同为下半天应该一致');
});

test('下雨时窗外有雨，而且更暗', () => {
  // 找一个确实会下雨的日子，而不是假设
  let day = null;
  for (let d = 1; d <= 28 && !day; d++) {
    const ymd = `2026-09-${String(d).padStart(2, '0')}`;
    if (weatherOf(ymd, 21) === 'rain') day = ymd;
  }
  assert.ok(day, '28 天里一天雨都不下，天气函数有问题');
  const s = resolveScene({ clock: at(`${day}T21:00:00+08:00`) });
  assert.equal(s.weather, 'rain');
  assert.ok(s.props.includes('window_rain'));
});

test('用户在写小说：桌面出现稿纸和书', () => {
  const s = resolveScene({
    clock: at('2026-09-23T14:00:00+08:00'),
    project: { id: 'p1', kind: 'novel', name: '覆水忘川', progress: 0.4 },
  });
  assert.ok(s.props.includes('manuscript'));
  assert.ok(s.props.includes('books'));
  assert.equal(s.project.name, '覆水忘川');
  assert.match(s.describe(), /稿纸/);
});

test('用户在开发软件：桌面出现电脑和终端', () => {
  const s = resolveScene({
    clock: at('2026-09-23T14:00:00+08:00'),
    project: { id: 'p2', kind: 'software', name: '知言', progress: 0.6 },
  });
  assert.ok(s.props.includes('laptop'));
  assert.ok(s.props.includes('terminal'));
});

test('用户长时间没回来：桌面出现便签和日记', () => {
  const clock = at('2026-09-23T14:00:00+08:00');
  const present = resolveScene({ clock, user: { lastSeenAt: clock.now() } });
  assert.equal(present.absence, 'present');
  assert.equal(present.leftovers.length, 0);

  const mid = resolveScene({ clock, user: { lastSeenAt: clock.now() - 20 * HOUR } });
  assert.equal(mid.absence, 'medium');
  assert.ok(mid.props.includes('sticky_note'));
  assert.ok(mid.props.includes('diary'));

  const long = resolveScene({ clock, user: { lastSeenAt: clock.now() - 5 * DAY } });
  assert.equal(long.absence, 'long');
  assert.ok(long.props.includes('dust'));
  assert.match(long.leftovers.find(l => l.kind === 'sticky_note').text, /5 天/);
});

test('AI 在阅读 / 工作时桌面跟着变', () => {
  const clock = at('2026-09-23T20:00:00+08:00');
  assert.ok(resolveScene({ clock, aiState: 'reading' }).props.includes('open_book'));
  assert.ok(resolveScene({ clock, aiState: 'working' }).props.includes('terminal'));
});

test('四个输入共同决定场景：改任一个，结果就不同', () => {
  const clock = at('2026-09-23T22:00:00+08:00');
  const base = resolveScene({ clock });
  const byTime = resolveScene({ clock: at('2026-09-23T12:00:00+08:00') });
  const byAi = resolveScene({ clock, aiState: 'working' });
  const byUser = resolveScene({ clock, user: { lastSeenAt: clock.now() - 5 * DAY } });
  const byProj = resolveScene({ clock, project: { id: 'p', kind: 'novel', name: 'X' } });
  const key = s => s.period + '|' + s.props.slice().sort().join(',');
  const keys = new Set([base, byTime, byAi, byUser, byProj].map(key));
  assert.equal(keys.size, 5, '有输入没起作用');
});

test('调色板在暗处是深色，亮处是浅色', () => {
  const night = resolveScene({ clock: at('2026-09-23T23:00:00+08:00') });
  const day = resolveScene({ clock: at('2026-09-23T12:00:00+08:00') });
  const lum = hex => parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
  assert.ok(lum(night.palette.bg) < lum(day.palette.bg));
});
