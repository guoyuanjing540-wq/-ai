import test from 'node:test';
import assert from 'node:assert/strict';
import { createAvatarMachine, AVATAR_STATES, EXPRESSIONS } from '../src/core/avatar.js';
import { createFixedClock } from '../src/core/clock.js';

const mk = () => {
  const clock = createFixedClock('2026-09-23T21:00:00+08:00');
  return { clock, a: createAvatarMachine({ now: () => clock.now() }) };
};

test('规格要求的状态都在', () => {
  for (const s of ['idle', 'reading', 'working', 'looking_at_user', 'thinking', 'welcome']) {
    assert.ok(AVATAR_STATES.includes(s), '缺状态 ' + s);
  }
});

test('用户进入 → 欢迎动作', () => {
  const { a } = mk();
  a.send('user.enter');
  assert.equal(a.state, 'welcome');
});

test('欢迎是高优先级，能打断阅读', () => {
  const { a, clock } = mk();
  a.send('ai.read');
  assert.equal(a.state, 'reading');
  clock.advance(100);          // 远没到 reading 的最短停留
  a.send('user.enter');
  assert.equal(a.state, 'welcome', '欢迎没能打断阅读');
});

test('低优先级切换会等最短停留时间，不会一帧一个样', () => {
  const { a, clock } = mk();
  a.send('ai.read');
  clock.advance(200);
  a.send('ai.work');
  assert.equal(a.state, 'reading', '没等够就切了');
  clock.advance(3200);
  a.tick();
  assert.equal(a.state, 'working', '等够了却没切过去');
});

test('welcome 会自己回落到看向用户', () => {
  const { a, clock } = mk();
  a.send('user.enter');
  clock.advance(4000);
  a.tick();
  assert.equal(a.state, 'looking_at_user');
});

test('看向用户久了会回到待机', () => {
  const { a, clock } = mk();
  a.send('user.focus');
  clock.advance(9000);
  a.tick();
  assert.equal(a.state, 'idle');
});

test('呼吸一直在跑，任何状态下都有', () => {
  const { a, clock } = mk();
  for (const ev of ['idle', 'ai.read', 'ai.work', 'user.focus']) {
    a.force(({ idle: 'idle', 'ai.read': 'reading', 'ai.work': 'working', 'user.focus': 'looking_at_user' })[ev]);
    const seen = new Set();
    for (let i = 0; i < 60; i++) { clock.advance(200); seen.add(Math.round(a.pose().breath * 100)); }
    assert.ok(seen.size > 10, ev + ' 状态下呼吸是死的');
  }
});

test('呼吸幅度很小，不会看着像在喘', () => {
  const { a, clock } = mk();
  let max = 0;
  for (let i = 0; i < 200; i++) { clock.advance(100); max = Math.max(max, Math.abs(a.pose().breath)); }
  assert.ok(max <= 1.0001 && max > 0.9, '呼吸相位应该在 ±1 之间跑满，实际 ' + max);
});

test('会眨眼，但不是一直闭着', () => {
  const { a, clock } = mk();
  let blinked = 0, open = 0;
  for (let i = 0; i < 300; i++) {
    clock.advance(100);
    const p = a.pose();
    if (p.blink > 0.3) blinked++; else if (p.blink === 0) open++;
  }
  assert.ok(blinked > 0, '不眨眼');
  assert.ok(open > blinked * 5, '眨得太频繁了');
});

test('视线随状态变：阅读低头，看用户居中，思考看别处', () => {
  const { a } = mk();
  a.force('reading');
  assert.ok(a.pose().gaze.y > 0.1, '阅读时应该低头');
  a.force('looking_at_user');
  const g = a.pose().gaze;
  assert.equal(g.x, 0); assert.equal(g.y, 0);
  a.force('thinking');
  assert.ok(Math.abs(a.pose().gaze.x) > 0.1, '思考时应该看向别处');
});

test('表情能设，会自己回到 neutral', () => {
  const { a, clock } = mk();
  for (const e of EXPRESSIONS) assert.equal(a.setExpression(e), e);
  a.setExpression('smile', { durationMs: 1000 });
  assert.equal(a.expression, 'smile');
  clock.advance(1500);
  a.tick();
  assert.equal(a.expression, 'neutral');
});

test('非法表情被忽略', () => {
  const { a } = mk();
  a.setExpression('爆炸');
  assert.equal(a.expression, 'neutral');
});

test('状态变化会通知订阅者', () => {
  const { a } = mk();
  const log = [];
  a.onChange(e => log.push(`${e.from}->${e.to}`));
  a.send('user.enter');
  assert.deepEqual(log, ['idle->welcome']);
});

test('syncWithScene：场景说 AI 在工作，角色就切到工作', () => {
  const { a } = mk();
  a.syncWithScene({ absence: 'present', aiState: 'working' });
  assert.equal(a.state, 'working');
});

test('进入状态有缓动，不是硬跳', () => {
  const { a, clock } = mk();
  a.force('welcome');
  assert.ok(a.pose().enter < 0.2);
  clock.advance(500);
  assert.equal(a.pose().enter, 1);
});
