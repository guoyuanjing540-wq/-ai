import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBackend } from '../src/core/store.js';
import { createProactiveGate, CATEGORIES, defaultPolicy } from '../src/core/proactive.js';
import { createFixedClock, inWindow, parseHM, MINUTE, HOUR } from '../src/core/clock.js';

const mk = (t = '2026-09-23T14:00:00+08:00') => {
  const clock = createFixedClock(t);
  return { clock, gate: createProactiveGate(createMemoryBackend(), { clock }) };
};

test('时间窗口支持跨零点', () => {
  assert.equal(parseHM('23:00'), 23 * 60);
  assert.equal(inWindow(23 * 60 + 30, '23:00', '08:00'), true);
  assert.equal(inWindow(2 * 60, '23:00', '08:00'), true);
  assert.equal(inWindow(12 * 60, '23:00', '08:00'), false);
  assert.equal(inWindow(10 * 60, '09:00', '18:00'), true);
  assert.equal(inWindow(20 * 60, '09:00', '18:00'), false);
});

test('规格要的四样默认都在', () => {
  const p = defaultPolicy();
  assert.equal(typeof p.enabled, 'boolean');       // 总开关
  assert.ok(p.dnd.from && p.dnd.to);               // 勿扰
  assert.ok(p.totalPerDay > 0 && p.minGapMinutes > 0); // 频率
  for (const k of Object.keys(CATEGORIES)) assert.ok(k in p.categories); // 分类
});

test('总开关一关，什么都发不出去', async () => {
  const { gate } = mk();
  await gate.setPolicy({ enabled: false });
  for (const k of Object.keys(CATEGORIES)) {
    const r = await gate.canSend(k);
    assert.equal(r.ok, false, k + ' 居然还能发');
  }
});

test('勿扰时间里发不出去，出了勿扰就能', async () => {
  const night = mk('2026-09-24T02:00:00+08:00');
  await night.gate.setPolicy({ dnd: { on: true, from: '23:00', to: '08:00' } });
  const r = await night.gate.canSend('greeting');
  assert.equal(r.ok, false);
  assert.match(r.reason, /勿扰/);

  night.clock.set('2026-09-24T10:00:00+08:00');
  assert.equal((await night.gate.canSend('greeting')).ok, true);
});

test('分类开关：关掉的那类发不出去，别的不受影响', async () => {
  const { gate } = mk();
  await gate.setCategory('moment', { on: false });
  assert.equal((await gate.canSend('moment')).ok, false);
  assert.equal((await gate.canSend('greeting')).ok, true);
});

test('私聊默认是关的（规格要求不能默认骚扰）', async () => {
  const { gate } = mk();
  assert.equal((await gate.canSend('dm')).ok, false);
});

test('每日总量上限', async () => {
  const { gate, clock } = mk('2026-09-23T09:00:00+08:00');
  await gate.setPolicy({ totalPerDay: 3, minGapMinutes: 0 });
  for (let i = 0; i < 3; i++) {
    assert.equal((await gate.canSend('remind')).ok, true, '第 ' + i + ' 条就被拦了');
    await gate.record('remind');
    clock.advance(30 * MINUTE);
  }
  const r = await gate.canSend('remind');
  assert.equal(r.ok, false);
  assert.match(r.reason, /上限/);
});

test('分类各自有每日上限', async () => {
  const { gate, clock } = mk('2026-09-23T09:00:00+08:00');
  await gate.setPolicy({ totalPerDay: 99, minGapMinutes: 0 });
  await gate.setCategory('greeting', { on: true, perDay: 1 });
  await gate.record('greeting');
  assert.equal((await gate.canSend('greeting')).ok, false);
  assert.equal((await gate.canSend('checkin')).ok, true, '一类满了不该拖累别类');
});

test('最小间隔', async () => {
  const { gate, clock } = mk('2026-09-23T09:00:00+08:00');
  await gate.setPolicy({ minGapMinutes: 45 });
  await gate.record('share');
  clock.advance(10 * MINUTE);
  const r = await gate.canSend('share');
  assert.equal(r.ok, false);
  assert.match(r.reason, /分钟/);
  clock.advance(40 * MINUTE);
  assert.equal((await gate.canSend('share')).ok, true);
});

test('跨天之后额度重置', async () => {
  const { gate, clock } = mk('2026-09-23T09:00:00+08:00');
  await gate.setPolicy({ totalPerDay: 1, minGapMinutes: 0, dnd: { on: false } });
  await gate.record('share');
  assert.equal((await gate.canSend('share')).ok, false);
  clock.set('2026-09-24T09:00:00+08:00');
  assert.equal((await gate.canSend('share')).ok, true);
});

test('用户长时间不回话时自动收声', async () => {
  const { gate, clock } = mk('2026-09-23T14:00:00+08:00');
  await gate.setPolicy({ quietAfterUserSilentHours: 24 });
  const r = await gate.canSend('checkin', { lastUserActiveAt: clock.now() - 40 * HOUR });
  assert.equal(r.ok, false);
  assert.match(r.reason, /不打扰/);
  assert.equal((await gate.canSend('checkin', { lastUserActiveAt: clock.now() - 2 * HOUR })).ok, true);
});

test('attempt：拦下就不执行，放行才记账', async () => {
  const { gate } = mk();
  let ran = 0;
  await gate.setCategory('moment', { on: false });
  let r = await gate.attempt('moment', async () => { ran++; return 'x'; });
  assert.equal(r.sent, false);
  assert.equal(ran, 0, '被拦下还是执行了');

  await gate.setCategory('moment', { on: true });
  r = await gate.attempt('moment', async () => { ran++; return 'x'; });
  assert.equal(r.sent, true);
  assert.equal(ran, 1);
  assert.equal(await gate.todayCount(), 1);
});

test('没内容可发时不占额度', async () => {
  const { gate } = mk();
  const r = await gate.attempt('share', async () => false);
  assert.equal(r.sent, false);
  assert.equal(await gate.todayCount(), 0);
});

test('不认识的分类直接拒绝', async () => {
  const { gate } = mk();
  assert.equal((await gate.canSend('乱写的')).ok, false);
});
