import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBackend } from '../src/core/store.js';
import { createMemoryStore, tokenize, similarity, MEMORY_TYPES } from '../src/core/memory.js';
import { createFixedClock, DAY } from '../src/core/clock.js';

const mk = (opts = {}) => {
  const clock = createFixedClock('2026-09-23T21:00:00+08:00');
  return { clock, mem: createMemoryStore(createMemoryBackend(), { clock, ...opts }) };
};

test('中文分词切出单字和双字', () => {
  const t = tokenize('小说第九章');
  assert.ok(t.includes('小'));
  assert.ok(t.includes('小说'));
  assert.ok(t.includes('九章'));
});

test('相关度：相关的高，不相关的为 0', () => {
  const a = similarity('小说第九章改得怎么样', '今天一起改了小说第九章');
  const b = similarity('小说第九章改得怎么样', '他喜欢喝美式咖啡');
  assert.ok(a > 0.3, '相关的应该高，实际 ' + a);
  assert.equal(b, 0);
  assert.ok(a > b);
});

test('五种记忆类型都能存', async () => {
  const { mem } = mk();
  for (const t of MEMORY_TYPES) {
    const r = await mem.add({ type: t, content: '类型测试-' + t });
    assert.ok(r.ok, t + ' 存不进去');
    assert.equal(r.memory.type, t);
  }
  const s = await mem.stats();
  assert.equal(s.total, MEMORY_TYPES.length);
});

test('记录带齐 9 个字段', async () => {
  const { mem } = mk();
  const { memory: m } = await mem.add({ content: '测试', type: 'semantic', source: 'user', tags: ['a'] });
  for (const f of ['id', 'content', 'type', 'importance', 'created_at', 'updated_at', 'last_accessed', 'source', 'tags']) {
    assert.ok(f in m, '缺字段 ' + f);
  }
});

test('忽略标点大小写去重', async () => {
  const { mem } = mk();
  await mem.add({ content: '他喜欢喝美式咖啡。', type: 'semantic' });
  const r = await mem.add({ content: '他喜欢喝美式咖啡', type: 'semantic' });
  assert.equal(r.deduped, true);
  assert.equal((await mem.all()).length, 1);
});

test('【关键】检索只带相关的几条，不是全部', async () => {
  const { mem } = mk();
  for (let i = 0; i < 40; i++) {
    await mem.add({ type: 'episodic', content: `无关的事情第 ${i} 条，跟做饭钓鱼有关` });
  }
  await mem.add({ type: 'project', content: '我们在一起改小说《覆水忘川》第九章', importance: 0.8 });

  const got = await mem.retrieve('小说第九章改到哪了');
  assert.ok(got.items.length > 0);
  assert.ok(got.items.length < 40, '把全部记忆都塞进来了');
  assert.ok(got.items.some(m => m.content.includes('第九章')), '最该带的那条没带上');
});

test('【关键】检索受字数预算约束', async () => {
  const { mem } = mk();
  for (let i = 0; i < 30; i++) {
    await mem.add({ type: 'semantic', content: '小说相关的长记忆'.repeat(10) + i });
  }
  const got = await mem.retrieve('小说', { budgetChars: 300, limit: 50 });
  assert.ok(got.usedChars <= 300, `超预算了：${got.usedChars}`);
  assert.ok(got.items.length < 30);
});

test('锁定的记忆会置顶，即使跟当前话题无关', async () => {
  const { mem } = mk();
  const { memory: locked } = await mem.add({ type: 'semantic', content: '他对花生过敏' });
  await mem.lock(locked.id);
  for (let i = 0; i < 10; i++) await mem.add({ type: 'episodic', content: '今天聊了小说 ' + i });

  const got = await mem.retrieve('小说写得怎么样');
  assert.equal(got.items[0].id, locked.id, '锁定的没有置顶');
});

test('禁止进入长期记忆：拦新的，也清旧的', async () => {
  const { mem } = mk();
  await mem.add({ type: 'semantic', content: '我的身份证号是 1234' });
  await mem.block('身份证号');
  assert.equal((await mem.all()).filter(m => m.content.includes('身份证')).length, 0, '旧的没清掉');

  const r = await mem.add({ type: 'semantic', content: '再说一次身份证号 5678' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'blocked');
});

test('working 记忆不受 blocklist 限制，也不进长期库', async () => {
  const { mem } = mk();
  await mem.block('身份证号');
  const r = await mem.add({ type: 'working', content: '刚说到身份证号' });
  assert.equal(r.ok, true, 'working 被误拦了');
});

test('working 记忆有上限，会滚动丢弃', async () => {
  const { mem } = mk({ workingCapacity: 5 });
  for (let i = 0; i < 20; i++) await mem.add({ type: 'working', content: '第 ' + i + ' 句' });
  const w = (await mem.all()).filter(m => m.type === 'working');
  assert.equal(w.length, 5);
  assert.ok(w[w.length - 1].content.includes('19'), '丢的是新的而不是旧的');
});

test('长期库超容量时淘汰最不重要的，锁定的不动', async () => {
  const { mem } = mk({ capacity: 10 });
  const { memory: keep } = await mem.add({ type: 'semantic', content: '必须留下的事', importance: 0.01 });
  await mem.lock(keep.id);
  for (let i = 0; i < 30; i++) await mem.add({ type: 'episodic', content: '普通事件 ' + i, importance: 0.5 });
  const all = await mem.all();
  assert.ok(all.length <= 10);
  assert.ok(all.some(m => m.id === keep.id), '锁定的被淘汰了');
});

test('新近度参与打分：同样相关时新的排前面', async () => {
  const clock = createFixedClock('2026-09-23T21:00:00+08:00');
  const mem = createMemoryStore(createMemoryBackend(), { clock });
  await mem.add({ type: 'episodic', content: '一起改了小说第九章' });
  const items = await mem.all();
  items[0].updated_at = clock.now() - 120 * DAY;
  await mem.store.set('items', items);

  await mem.add({ type: 'episodic', content: '一起改了小说第十章' });
  const got = await mem.retrieve('小说 改 章');
  assert.equal(got.items[0].content.includes('第十章'), true, '旧的排到了前面');
});

test('检索会更新 last_accessed', async () => {
  const { mem, clock } = mk();
  const { memory: m } = await mem.add({ type: 'semantic', content: '他用 Proton VPN' });
  assert.equal(m.last_accessed, 0);
  await mem.retrieve('Proton');
  assert.equal((await mem.get(m.id)).last_accessed, clock.now());
});

test('Memory Manager：查 / 改 / 删 / 按类型筛', async () => {
  const { mem } = mk();
  const { memory: m } = await mem.add({ type: 'semantic', content: '他住北京', tags: ['地点'] });
  assert.equal((await mem.search('北京')).length, 1);
  assert.equal((await mem.search('', { type: 'semantic' })).length, 1);
  assert.equal((await mem.search('', { tag: '地点' })).length, 1);
  await mem.update(m.id, { content: '他住上海', importance: 0.9 });
  assert.equal((await mem.get(m.id)).content, '他住上海');
  assert.equal((await mem.get(m.id)).importance, 0.9);
  assert.equal(await mem.remove(m.id), true);
  assert.equal(await mem.get(m.id), null);
});

test('format 把检索结果拼成人能读的提示词', async () => {
  const { mem } = mk();
  await mem.add({ type: 'project', content: '在一起改小说第九章', importance: 0.9 });
  await mem.add({ type: 'working', content: '刚才说到结尾没收住' });
  const got = await mem.retrieve('小说第九章');
  const s = mem.format(got);
  assert.match(s, /正在做的项目/);
  assert.match(s, /第九章/);
});

test('导入导出不丢数据', async () => {
  const { mem } = mk();
  await mem.add({ type: 'semantic', content: 'A' });
  await mem.add({ type: 'episodic', content: 'B' });
  await mem.block('C');
  const dump = await mem.export();

  const clock = createFixedClock('2026-09-23T21:00:00+08:00');
  const m2 = createMemoryStore(createMemoryBackend(), { clock });
  await m2.import(dump);
  assert.equal((await m2.all()).length, 2);
  assert.deepEqual(await m2.blocklist(), ['C']);
});
