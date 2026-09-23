// PersonaProfile —— AI 人格单独存储。
//
// 最要紧的一条：人格不能因为更换模型而消失。
// 所以人格存在自己的命名空间（persona:*）里，跟 provider / model / apiKey
// 这些设置**没有任何共享的存储键**。换模型只改 settings，人格原封不动。
// personaToPrompt() 负责把人格翻译成任何模型都吃得下的纯文本，
// 各家模型的差异留在调用层，不渗进人格数据。

import { createStore, uid } from './store.js';

export const PERSONA_FIELDS = [
  'name',                // 称呼
  'relationship_style',  // 关系定位：恋人 / 朋友 / 搭档 / 长辈……
  'speaking_style',      // 说话方式
  'personality',         // 性格
  'preferences',         // 喜好
  'boundaries',          // 边界：不聊什么、不做什么
  'interaction_rules',   // 互动规则：主动程度、称呼习惯、回复长度
  'custom_prompt',       // 用户自己写的补充提示词，优先级最高
];

export function createPersona(partial = {}) {
  const now = Date.now();
  const p = {
    id: partial.id || uid('p_'),
    name: '阿言',
    relationship_style: '恋人',
    speaking_style: '口语、简短，不说教，偶尔用语气词',
    personality: '温柔、细心，有一点小幽默，会认真听你说话',
    preferences: '',
    boundaries: '不追问不想说的事；不替你做决定',
    interaction_rules: '你忙的时候少打扰；重要的事会主动提',
    custom_prompt: '',
    avatar: '',
    created_at: now,
    updated_at: now,
  };
  for (const k of PERSONA_FIELDS) if (partial[k] != null) p[k] = String(partial[k]);
  if (partial.avatar != null) p.avatar = String(partial.avatar);
  if (partial.created_at) p.created_at = partial.created_at;
  return p;
}

export function validatePersona(p) {
  const errors = [];
  if (!p || typeof p !== 'object') return { ok: false, errors: ['人格不是一个对象'] };
  if (!p.id) errors.push('缺少 id');
  if (!String(p.name || '').trim()) errors.push('名字不能为空');
  for (const k of PERSONA_FIELDS) {
    if (p[k] != null && typeof p[k] !== 'string') errors.push(`${k} 必须是文本`);
  }
  if (String(p.custom_prompt || '').length > 4000) errors.push('custom_prompt 太长（超过 4000 字）');
  return { ok: errors.length === 0, errors };
}

const LABELS = {
  name: '你的名字',
  relationship_style: '你和用户的关系',
  speaking_style: '说话方式',
  personality: '性格',
  preferences: '喜好',
  boundaries: '边界',
  interaction_rules: '互动规则',
};

/** 把人格翻成纯文本提示词。跟具体模型无关，谁都能吃。 */
export function personaToPrompt(p, { userName = '' } = {}) {
  const lines = ['你不是一个助手，你是一个有连续性的同伴。'];
  for (const k of PERSONA_FIELDS) {
    if (k === 'custom_prompt') continue;
    const v = String(p?.[k] || '').trim();
    if (v) lines.push(`${LABELS[k]}：${v}`);
  }
  if (userName) lines.push(`用户的称呼：${userName}`);
  const custom = String(p?.custom_prompt || '').trim();
  if (custom) lines.push('', '用户的额外要求（优先级最高）：', custom);
  return lines.join('\n');
}

/**
 * 人格仓库。跟模型设置完全隔离：
 * 这里只读写 persona:* 前缀，从不读 settings。
 */
export function createPersonaStore(backend) {
  const store = createStore(backend, 'persona');

  const listIds = () => store.get('index', []);

  return {
    store,
    async list() {
      const ids = await listIds();
      const out = [];
      for (const id of ids) {
        const p = await store.get(`item:${id}`);
        if (p) out.push(p);
      }
      return out;
    },
    async save(persona) {
      const v = validatePersona(persona);
      if (!v.ok) throw new Error('人格不合法：' + v.errors.join('；'));
      const p = { ...persona, updated_at: Date.now() };
      await store.set(`item:${p.id}`, p);
      const ids = await listIds();
      if (!ids.includes(p.id)) await store.set('index', [...ids, p.id]);
      if (!(await store.get('active'))) await store.set('active', p.id);
      return p;
    },
    get: id => store.get(`item:${id}`),
    async remove(id) {
      await store.del(`item:${id}`);
      const ids = (await listIds()).filter(x => x !== id);
      await store.set('index', ids);
      if ((await store.get('active')) === id) await store.set('active', ids[0] || null);
    },
    async activate(id) {
      if (!(await store.get(`item:${id}`))) throw new Error('没有这个人格：' + id);
      await store.set('active', id);
    },
    async active() {
      const id = await store.get('active');
      const p = id ? await store.get(`item:${id}`) : null;
      return p || null;
    },
    /** 导出/导入：换手机、换账号时人格能跟着走。 */
    async export() {
      return { version: 1, active: await store.get('active'), personas: await this.list() };
    },
    async import(data, { replace = false } = {}) {
      if (!data || !Array.isArray(data.personas)) throw new Error('导入的数据里没有 personas');
      if (replace) for (const id of await listIds()) await store.del(`item:${id}`);
      if (replace) await store.set('index', []);
      for (const p of data.personas) await this.save(createPersona(p));
      if (data.active) { try { await this.activate(data.active); } catch { /* 忽略：指向的人格不在导入包里 */ } }
      return this.list();
    },
  };
}
