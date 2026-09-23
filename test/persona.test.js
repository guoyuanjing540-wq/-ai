import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBackend, createStore } from '../src/core/store.js';
import { createPersonaStore, createPersona, personaToPrompt, validatePersona, PERSONA_FIELDS } from '../src/core/persona.js';

test('人格有全部 8 个字段', () => {
  const p = createPersona();
  for (const f of PERSONA_FIELDS) assert.ok(f in p, `缺字段 ${f}`);
});

test('名字为空的人格不合法', () => {
  assert.equal(validatePersona(createPersona({ name: '  ' })).ok, false);
  assert.equal(validatePersona(createPersona({ name: '阿言' })).ok, true);
});

test('personaToPrompt 输出纯文本，跟模型无关', () => {
  const p = createPersona({ name: '阿言', personality: '温柔', custom_prompt: '别叫我宝贝' });
  const s = personaToPrompt(p, { userName: '老顾' });
  assert.match(s, /阿言/);
  assert.match(s, /温柔/);
  assert.match(s, /别叫我宝贝/);
  assert.match(s, /老顾/);
  assert.equal(typeof s, 'string');
});

test('custom_prompt 排在最后，优先级最高', () => {
  const s = personaToPrompt(createPersona({ custom_prompt: 'XYZ' }));
  assert.ok(s.indexOf('XYZ') > s.indexOf('性格'));
});

test('【关键】换模型之后人格还在', async () => {
  const backend = createMemoryBackend();
  const ps = createPersonaStore(backend);
  const settings = createStore(backend, 'settings');

  await settings.set('provider', 'deepseek');
  await settings.set('model', 'deepseek-chat');
  const p = await ps.save(createPersona({ name: '阿言', personality: '温柔、细心' }));
  await ps.activate(p.id);

  // 模拟用户换模型：把整个 settings 命名空间清掉重写
  for (const k of await settings.keys()) await settings.del(k);
  await settings.set('provider', 'claude');
  await settings.set('model', 'claude-opus-5');

  const after = await ps.active();
  assert.equal(after.id, p.id);
  assert.equal(after.name, '阿言');
  assert.equal(after.personality, '温柔、细心');
  assert.equal(await settings.get('provider'), 'claude');
});

test('人格存储和设置没有共享的键', async () => {
  const backend = createMemoryBackend();
  const ps = createPersonaStore(backend);
  await ps.save(createPersona({ name: 'A' }));
  const keys = await backend.keys();
  assert.ok(keys.every(k => k.startsWith('persona:')), '人格写到了别的命名空间：' + keys.join(','));
});

test('多人格切换 + 导入导出', async () => {
  const backend = createMemoryBackend();
  const ps = createPersonaStore(backend);
  const a = await ps.save(createPersona({ name: '阿言' }));
  const b = await ps.save(createPersona({ name: '小野' }));
  assert.equal((await ps.active()).id, a.id, '第一个保存的自动激活');
  await ps.activate(b.id);
  assert.equal((await ps.active()).name, '小野');

  const dump = await ps.export();
  assert.equal(dump.personas.length, 2);

  const backend2 = createMemoryBackend();
  const ps2 = createPersonaStore(backend2);
  await ps2.import(dump);
  assert.equal((await ps2.list()).length, 2);
  assert.equal((await ps2.active()).name, '小野');
});

test('删除人格后 active 会落到还在的那个', async () => {
  const backend = createMemoryBackend();
  const ps = createPersonaStore(backend);
  const a = await ps.save(createPersona({ name: 'A' }));
  const b = await ps.save(createPersona({ name: 'B' }));
  await ps.activate(a.id);
  await ps.remove(a.id);
  assert.equal((await ps.active()).id, b.id);
});
