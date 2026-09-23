// 衣柜 / 朋友圈 / 看书 / 自主性 / 渲染层 / 整体装配
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBackend } from '../src/core/store.js';
import { createFixedClock, HOUR, DAY } from '../src/core/clock.js';
import { createWardrobe, SLOTS } from '../src/core/wardrobe.js';
import { createFeed, DEFAULT_RESIDENTS, templateComposer } from '../src/core/residents.js';
import { createLibrary, splitChapters, parseRss, SOURCE_NOTE } from '../src/core/reading.js';
import { createAutonomy, INTENTS } from '../src/core/autonomy.js';
import { createProactiveGate } from '../src/core/proactive.js';
import { resolveScene } from '../src/core/scene.js';
import { createAvatarMachine } from '../src/core/avatar.js';
import { buildDrawList, defaultRegistry, particleKind, RESERVED_RENDERERS } from '../src/core/renderer.js';
import { createCompanion } from '../src/core/companion.js';

const clockAt = s => createFixedClock(s);

// ------------------------------------------------------------------ 衣柜
test('衣柜：部位齐全，示例资产能解析', async () => {
  const w = createWardrobe(createMemoryBackend(), { clock: clockAt('2026-09-23T14:00:00+08:00') });
  assert.deepEqual(SLOTS, ['hair', 'top', 'bottom', 'shoes', 'accessory', 'outer']);
  const cur = await w.resolveCurrent();
  assert.ok(cur.outfit);
  assert.ok(cur.pieces.length > 0);
  assert.ok(cur.pieces.every(p => SLOTS.includes(p.slot)));
});

test('衣柜：场景自动换装 —— 深夜换睡衣', async () => {
  const clock = clockAt('2026-09-23T23:30:00+08:00');
  const w = createWardrobe(createMemoryBackend(), { clock });
  const r = await w.autoSelect(resolveScene({ clock }));
  assert.equal(r.changed, true);
  assert.equal(r.current.outfitId, 'o_sleep');
});

test('衣柜：下雨天加外套', async () => {
  const clock = clockAt('2026-09-23T14:00:00+08:00');
  const w = createWardrobe(createMemoryBackend(), { clock });
  const scene = { ...resolveScene({ clock }), weather: 'rain', hour: 14, period: 'day', aiState: 'idle' };
  const r = await w.autoSelect(scene);
  assert.equal(r.current.outfitId, 'o_rain');
});

test('【关键】用户指定搭配后，AI 不再自作主张', async () => {
  const clock = clockAt('2026-09-23T14:00:00+08:00');
  const w = createWardrobe(createMemoryBackend(), { clock });
  await w.wear('o_work', { byUser: true });
  clock.set('2026-09-23T23:30:00+08:00');
  const r = await w.autoSelect(resolveScene({ clock }));
  assert.equal(r.changed, false);
  assert.match(r.reason, /用户指定/);
  assert.equal((await w.current()).outfitId, 'o_work');

  await w.unlock();
  const r2 = await w.autoSelect(resolveScene({ clock }));
  assert.equal(r2.changed, true, '解锁后应该能自动换');
});

test('Outfit Memory：记历史，夸过的会加分', async () => {
  const clock = clockAt('2026-09-23T14:00:00+08:00');
  const w = createWardrobe(createMemoryBackend(), { clock });
  await w.wear('o_work', { byUser: true });
  await w.favorite('o_work');
  const m = await w.memory();
  assert.ok(m.history.length >= 1);
  assert.equal(m.history[0].by, 'user');
  assert.deepEqual(m.favorites, ['o_work']);
  assert.equal(m.counts['o_work'], 1);
});

test('衣柜里没有商城和抽卡', async () => {
  const w = createWardrobe(createMemoryBackend());
  for (const bad of ['buy', 'purchase', 'gacha', 'shop', 'draw', 'price']) {
    assert.equal(typeof w[bad], 'undefined', '不该有 ' + bad);
  }
});

// ------------------------------------------------------------------ 朋友圈
test('朋友圈：预置住户有男有女', () => {
  const g = new Set(DEFAULT_RESIDENTS.map(r => r.gender));
  assert.ok(g.has('male'));
  assert.ok(g.has('female'));
});

test('朋友圈：用户发帖带图，住户来评论', async () => {
  const clock = clockAt('2026-09-23T14:00:00+08:00');
  const feed = createFeed(createMemoryBackend(), { clock, composer: templateComposer, rng: () => 0 });
  const p = await feed.post({ text: '今天把小说第九章改完了', images: ['data:image/png;base64,AAA'] });
  assert.equal(p.images.length, 1);

  const made = await feed.reactToUserPosts();
  assert.ok(made.length > 0, '没人来评论');
  const tl = await feed.timeline();
  assert.ok(tl[0].comments.length > 0);
  assert.ok(tl[0].comments[0].author.name, '评论没带作者信息');
});

test('朋友圈：同一个人对同一条不会评两次', async () => {
  const clock = clockAt('2026-09-23T14:00:00+08:00');
  const feed = createFeed(createMemoryBackend(), { clock, composer: templateComposer, rng: () => 0 });
  await feed.post({ text: '测试' });
  await feed.reactToUserPosts({ max: 10 });
  const first = (await feed.timeline())[0].comments.length;
  await feed.reactToUserPosts({ max: 10 });
  assert.equal((await feed.timeline())[0].comments.length, first, '重复评论了');
});

test('朋友圈：住户只在自己的活跃时间出现', async () => {
  const feed = createFeed(createMemoryBackend(), {
    clock: clockAt('2026-09-23T05:00:00+08:00'), composer: templateComposer, rng: () => 0,
  });
  await feed.post({ text: '凌晨五点发的' });
  const made = await feed.reactToUserPosts();
  assert.equal(made.length, 0, '凌晨五点不该有人冒出来（保底也不能把人从床上挖起来）');
});

test('【关键】用户发的动态一定有人回 —— 哪怕运气差', async () => {
  const clock = clockAt('2026-09-23T14:00:00+08:00');
  // rng 恒返回 1：所有概率判定全部落空
  const feed = createFeed(createMemoryBackend(), { clock, composer: templateComposer, rng: () => 1 });
  await feed.post({ text: '有人吗' });
  const made = await feed.reactToUserPosts();
  assert.equal(made.length, 1, '一个人都没回，看着就像坏了');
  // 关掉保底就真的没人回
  const feed2 = createFeed(createMemoryBackend(), { clock, composer: templateComposer, rng: () => 1 });
  await feed2.post({ text: '有人吗' });
  assert.equal((await feed2.reactToUserPosts({ atLeastOne: false })).length, 0);
});

test('保底不会重复触发：已经有人评论过就不再补', async () => {
  const clock = clockAt('2026-09-23T14:00:00+08:00');
  const feed = createFeed(createMemoryBackend(), { clock, composer: templateComposer, rng: () => 1 });
  await feed.post({ text: '测试' });
  await feed.reactToUserPosts();
  const after = await feed.reactToUserPosts();
  assert.equal(after.length, 0, '又补了一次');
});

test('朋友圈：住户自己发动态，同一时间段不刷屏', async () => {
  const clock = clockAt('2026-09-23T14:00:00+08:00');
  const feed = createFeed(createMemoryBackend(), { clock, composer: templateComposer, rng: () => 0 });
  const a = await feed.residentsPost({ max: 5 });
  assert.ok(a.length > 0);
  const b = await feed.residentsPost({ max: 5 });
  assert.equal(b.length, 0, '同一个时间段又发了一轮');
});

test('朋友圈：私聊会进收件箱并能标已读', async () => {
  const clock = clockAt('2026-09-23T14:00:00+08:00');
  const feed = createFeed(createMemoryBackend(), { clock, composer: templateComposer, rng: () => 0 });
  const dms = await feed.maybeDM({ max: 1 });
  assert.equal(dms.length, 1);
  assert.equal((await feed.unreadDMs()).length, 1);
  await feed.markDMRead(dms[0].id);
  assert.equal((await feed.unreadDMs()).length, 0);
});

test('朋友圈：可以自己加住户、删住户', async () => {
  const feed = createFeed(createMemoryBackend(), { clock: clockAt('2026-09-23T14:00:00+08:00') });
  const r = await feed.addResident({ name: '小舟', gender: 'female', interests: ['画画'] });
  assert.ok((await feed.residents()).some(x => x.id === r.id));
  await feed.removeResident(r.id);
  assert.ok(!(await feed.residents()).some(x => x.id === r.id));
});

test('朋友圈：空动态发不出去', async () => {
  const feed = createFeed(createMemoryBackend(), { clock: clockAt('2026-09-23T14:00:00+08:00') });
  await assert.rejects(() => feed.post({ text: '   ' }));
});

// ------------------------------------------------------------------ 看书
test('分章：认得「第 N 章」', () => {
  const ch = splitChapters('第一章 开头\n正文一\n\n第二章 转折\n正文二');
  assert.equal(ch.length, 2);
  assert.match(ch[0].title, /第一章/);
});

test('分章：认不出标记时按长度切', () => {
  const ch = splitChapters(Array.from({ length: 20 }, (_, i) => '段落'.repeat(120) + i).join('\n\n'), { maxChars: 1000 });
  assert.ok(ch.length > 1);
});

test('一起看书：粘贴正文 → 记进度 → 变成项目记忆', async () => {
  const clock = clockAt('2026-09-23T21:00:00+08:00');
  const lib = createLibrary(createMemoryBackend(), { clock });
  const b = await lib.addFromText({ title: '覆水忘川', text: '第一章 起\n甲\n\n第二章 承\n乙\n\n第三章 转\n丙' });
  assert.equal(b.chapters.length, 3);
  await lib.setProgress(b.id, { chapter: 1 });
  const pm = await lib.asProjectMemory();
  assert.equal(pm.type, 'project');
  assert.match(pm.content, /覆水忘川/);
  assert.match(pm.content, /第 2 \/ 3 章/);
});

test('一起看书：书签', async () => {
  const lib = createLibrary(createMemoryBackend(), { clock: clockAt('2026-09-23T21:00:00+08:00') });
  const b = await lib.addFromText({ title: 'X', text: '第一章 起\n甲\n\n第二章 承\n乙' });
  const bm = await lib.bookmark(b.id, { chapter: 0, text: '这句好' });
  assert.ok(bm.id);
  assert.equal((await lib.get(b.id)).bookmarks.length, 1);
});

test('一起看书：接了模型才有批注，没接就老实说没有', async () => {
  const clock = clockAt('2026-09-23T21:00:00+08:00');
  const bare = createLibrary(createMemoryBackend(), { clock });
  const b1 = await bare.addFromText({ title: 'X', text: '第一章 起\n甲' });
  const r1 = await bare.annotate(b1.id, 0);
  assert.equal(r1.pending, true);

  const withAI = createLibrary(createMemoryBackend(), { clock, composer: async () => '这一章的收尾有点急。' });
  const b2 = await withAI.addFromText({ title: 'X', text: '第一章 起\n甲' });
  const r2 = await withAI.annotate(b2.id, 0);
  assert.match(r2.text, /收尾/);
});

test('外部内容：三条路都能走，不做抓取', async () => {
  const lib = createLibrary(createMemoryBackend(), { clock: clockAt('2026-09-23T21:00:00+08:00') });
  assert.ok(SOURCE_NOTE.length > 0);
  // 路 1：粘贴正文
  const pasted = await lib.addFromText({ title: '一篇长文', text: '正文正文正文。', origin: 'paste' });
  assert.equal(pasted.kind, 'paste');
  // 路 2：只存链接
  const linked = await lib.addLink({ title: '原文', url: 'https://example.com/a/1' });
  assert.equal(linked.kind, 'link');
  assert.equal(linked.chapters.length, 0, '不该假装抓到了正文');
  await assert.rejects(() => lib.addLink({ title: 'x', url: '不是链接' }));
  // 路 3：通用 RSS
  await assert.rejects(() => lib.addRss('https://example.com/feed'), /没有注入 fetch/);
});

test('RSS 解析：RSS 2.0 和 Atom 都认', () => {
  const rss = `<rss><channel><title>某博客</title>
    <item><title>第一篇</title><link>https://a/1</link><description><![CDATA[<p>摘要一</p>]]></description></item>
    <item><title>第二篇</title><link>https://a/2</link><description>摘要二</description></item>
  </channel></rss>`;
  const items = parseRss(rss);
  assert.equal(items.length, 2);
  assert.equal(items.feedTitle, '某博客');
  assert.equal(items[0].summary, '摘要一');

  const atom = `<feed><title>Atom 源</title>
    <entry><title>甲</title><link href="https://b/1"/><summary>乙</summary></entry></feed>`;
  const a = parseRss(atom);
  assert.equal(a.length, 1);
  assert.equal(a[0].link, 'https://b/1');
});

test('RSS 拉取失败时报错清楚', async () => {
  const lib = createLibrary(createMemoryBackend(), {
    clock: clockAt('2026-09-23T21:00:00+08:00'),
    fetchImpl: async () => ({ ok: false, status: 403 }),
  });
  await assert.rejects(() => lib.addRss('https://x/feed'), /HTTP 403/);
});

// ------------------------------------------------------------------ 自主性
function autonomyRig(t = '2026-09-23T21:00:00+08:00', sceneOverride = {}) {
  const clock = clockAt(t);
  const gate = createProactiveGate(createMemoryBackend(), { clock });
  const acted = [];
  const handlers = Object.fromEntries(
    Object.keys(INTENTS).map(i => [i, async () => { acted.push(i); return { i }; }])
  );
  const autonomy = createAutonomy({
    clock, gate, rng: () => 0.5, handlers,
    scene: () => ({ ...resolveScene({ clock }), ...sceneOverride }),
  });
  return { clock, gate, autonomy, acted };
}

test('自主性：会自己挑事情做', async () => {
  const { autonomy, acted } = autonomyRig();
  const r = await autonomy.tick();
  assert.equal(r.acted, true);
  assert.ok(acted.length === 1);
});

test('【关键】会打扰人的行为必须过闸门；总开关一关就只剩不打扰的', async () => {
  const { autonomy, gate, acted } = autonomyRig();
  await gate.setPolicy({ enabled: false });
  for (let i = 0; i < 6; i++) await autonomy.tick();
  const disturbing = acted.filter(i => INTENTS[i].disturb);
  assert.equal(disturbing.length, 0, '闸门关着还是发了：' + disturbing.join(','));
  assert.ok(acted.length > 0, '不打扰的行为也被误伤了');
});

test('自主性：打扰类行为会记进闸门的账', async () => {
  const { autonomy, gate } = autonomyRig();
  await gate.setPolicy({ dnd: { on: false }, minGapMinutes: 0 });
  for (let i = 0; i < 4; i++) await autonomy.tick();
  assert.ok(await gate.todayCount() > 0, '发了却没记账，频率限制就是空的');
});

test('自主性：刚做过的事会降权，不会反复做同一件', async () => {
  const { autonomy, clock, acted, gate } = autonomyRig();
  await gate.setPolicy({ dnd: { on: false }, minGapMinutes: 0, totalPerDay: 99 });
  for (let i = 0; i < 5; i++) { await autonomy.tick(); clock.advance(10 * 60 * 1000); }
  const counts = acted.reduce((m, i) => (m[i] = (m[i] || 0) + 1, m), {});
  assert.ok(Object.keys(counts).length > 1, '五拍全在做同一件事：' + JSON.stringify(counts));
});

test('自主性：可以只看不做（plan）', async () => {
  const { autonomy } = autonomyRig();
  const plan = autonomy.plan(resolveScene({ clock: clockAt('2026-09-23T21:00:00+08:00') }), {});
  assert.equal(plan.length, Object.keys(INTENTS).length);
  assert.ok(plan[0].score >= plan[plan.length - 1].score);
});

test('自主性：最小间隔内不重复跑', async () => {
  const { autonomy } = autonomyRig();
  await autonomy.tick({ minIntervalMs: 60000 });
  const r = await autonomy.tick({ minIntervalMs: 60000 });
  assert.equal(r.acted, false);
  assert.match(r.reason, /太近/);
});

// ------------------------------------------------------------------ 渲染层
test('绘制清单：纯数据，按 z 排好序', () => {
  const clock = clockAt('2026-09-23T23:00:00+08:00');
  const scene = resolveScene({ clock, project: { id: 'p', kind: 'novel', name: 'X' } });
  const list = buildDrawList(scene);
  assert.ok(list.length > 3);
  for (let i = 1; i < list.length; i++) assert.ok(list[i].z >= list[i - 1].z, 'z 没排序');
  assert.ok(list.some(x => x.type === 'background'));
  assert.ok(list.some(x => x.type === 'desk'));
  assert.ok(list.some(x => x.type === 'particles'));
  assert.ok(list.some(x => x.type === 'prop' && x.name === 'manuscript'));
});

test('首页不画人 —— 难看的 2D 小人已经拿掉了', () => {
  const clock = clockAt('2026-09-23T23:00:00+08:00');
  const list = buildDrawList(resolveScene({ clock }));
  assert.equal(list.some(x => x.type === 'avatar'), false, '又把小人画回来了');
});

test('角色状态机还在跑，只是不占像素', () => {
  const clock = clockAt('2026-09-23T23:00:00+08:00');
  const a = createAvatarMachine({ now: () => clock.now() });
  a.send('ai.read');
  assert.equal(a.state, 'reading');
  assert.ok(typeof a.pose().breath === 'number');
});

test('绘制清单：道具坐在桌面上，不悬空', async () => {
  const { DESK_Y } = await import('../src/core/renderer.js');
  const clock = clockAt('2026-09-23T23:00:00+08:00');
  const scene = resolveScene({ clock, project: { id: 'p', kind: 'software', name: '知言' } });
  const list = buildDrawList(scene);
  const props = list.filter(x => x.type === 'prop' && x.name !== 'window_rain');
  assert.ok(props.length > 0);
  for (const p of props) {
    const bottom = p.y + p.h / 2;
    assert.ok(Math.abs(bottom - DESK_Y) < 1e-9, `${p.name} 的底边没贴着桌面（${bottom} vs ${DESK_Y}）`);
  }
});

test('绘制清单：桌上的东西画在桌子之后', () => {
  const clock = clockAt('2026-09-23T23:00:00+08:00');
  const list = buildDrawList(resolveScene({ clock }));
  const desk = list.findIndex(x => x.type === 'desk');
  const firstProp = list.findIndex(x => x.type === 'prop' && x.name !== 'window_rain');
  assert.ok(desk >= 0);
  if (firstProp >= 0) assert.ok(firstProp > desk, '道具画到了桌子下面');
});

test('绘制清单：按画布尺寸缩放', async () => {
  const { DESK_Y } = await import('../src/core/renderer.js');
  const clock = clockAt('2026-09-23T12:00:00+08:00');
  const list = buildDrawList(resolveScene({ clock }), null, { width: 800, height: 600 });
  const desk = list.find(x => x.type === 'desk');
  assert.ok(Math.abs(desk.y - DESK_Y * 600) < 1e-6);
  const mug = list.find(x => x.type === 'prop' && x.name === 'mug');
  if (mug) assert.ok(mug.x > 1 && mug.x < 800, '道具没按画布宽度缩放');
});

test('粒子随场景变：雨天下雨，夜里萤火，久别积灰', () => {
  const clock = clockAt('2026-09-23T23:00:00+08:00');
  assert.equal(particleKind({ weather: 'rain', period: 'night', absence: 'present', light: { level: 0.2 } }), 'rain');
  assert.equal(particleKind({ weather: 'clear', period: 'night', absence: 'present', light: { level: 0.2 } }), 'firefly');
  assert.equal(particleKind({ weather: 'clear', period: 'day', absence: 'long', light: { level: 1 } }), 'dust');
});

test('渲染器注册表：2D 已实现，Live2D / 3D / Unity 是预留且报错清楚', () => {
  const reg = defaultRegistry();
  assert.ok(reg.has('canvas2d'));
  for (const name of Object.keys(RESERVED_RENDERERS)) {
    assert.ok(reg.has(name), name + ' 没预留');
    assert.throws(() => reg.create(name), /架构预留/);
  }
  assert.throws(() => reg.create('不存在的'), /没有注册过/);
});

// ------------------------------------------------------------------ 整体
test('装配：打开 App 得到场景 + 衣着 + 欢迎', async () => {
  const c = createCompanion({
    backend: createMemoryBackend(),
    clock: clockAt('2026-09-23T23:10:00+08:00'),
    rng: () => 0.5,
  });
  const r = await c.enter();
  assert.equal(r.scene.period, 'night');
  assert.equal(c.avatar.state, 'welcome');
  assert.ok(r.outfit.outfit);
  assert.ok(r.greeting.length > 0);
});

test('【关键】组装上下文：人格 + 检索到的记忆 + 此刻，而且守预算', async () => {
  const c = createCompanion({
    backend: createMemoryBackend(),
    clock: clockAt('2026-09-23T21:00:00+08:00'),
    rng: () => 0.5,
  });
  await c.persona.save((await import('../src/core/persona.js')).createPersona({ name: '阿言', personality: '温柔' }));
  await c.memory.add({ type: 'project', content: '在一起改小说《覆水忘川》第九章', importance: 0.9 });
  await c.memory.add({ type: 'semantic', content: '他用 Proton VPN' });
  for (let i = 0; i < 50; i++) await c.memory.add({ type: 'episodic', content: '无关的事 ' + i });

  const ctx = await c.buildContext('小说第九章改得怎么样了', { budgetChars: 400 });
  assert.match(ctx.system, /阿言/);
  assert.match(ctx.system, /第九章/);
  assert.match(ctx.system, /此刻/);
  assert.ok(ctx.usedChars <= 400);
  assert.ok(ctx.memories.length < 52, '把整个记忆库塞进去了');
});

test('装配：用户开口后角色会看过来', async () => {
  const clock = clockAt('2026-09-23T21:00:00+08:00');
  const c = createCompanion({ backend: createMemoryBackend(), clock, rng: () => 0.5 });
  c.avatar.force('reading');
  clock.advance(5000);
  c.userActive();
  assert.equal(c.avatar.state, 'looking_at_user');
});

test('装配：自主循环在勿扰时间里不发打扰类消息', async () => {
  const clock = clockAt('2026-09-24T03:00:00+08:00');
  const c = createCompanion({ backend: createMemoryBackend(), clock, rng: () => 0.5 });
  for (let i = 0; i < 5; i++) { await c.autonomy.tick(); clock.advance(30 * 60 * 1000); }
  assert.equal(await c.gate.todayCount(), 0, '凌晨三点发消息了');
});

test('装配：用户长时间没回来，共同空间留下痕迹', async () => {
  const clock = clockAt('2026-09-23T21:00:00+08:00');
  const c = createCompanion({ backend: createMemoryBackend(), clock, rng: () => 0.5 });
  c.setRuntime({ lastSeenAt: clock.now() - 6 * DAY });
  const s = c.scene();
  assert.equal(s.absence, 'long');
  assert.ok(s.props.includes('diary'));
});
