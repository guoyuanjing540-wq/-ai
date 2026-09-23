// 记忆系统。
//
// 分五层：
//   working      当前会话上下文（短期，滚动丢弃，不进长期库）
//   episodic     发生过的重要事件（"今天一起改了小说第九章"）
//   semantic     长期稳定的事实和偏好
//   relationship 双方的共同经历、称呼、重要节点
//   project      正在共同进行的项目（小说 / 软件 / 学习计划）
//
// 核心原则：**不要每次把全部记忆塞进 Prompt。**
// retrieve() 按当前聊的内容做检索，只把相关的、在预算内的几条注进上下文。

import { createStore, uid } from './store.js';

export const MEMORY_TYPES = ['working', 'episodic', 'semantic', 'relationship', 'project'];

/** 长期库不收 working —— 它天生是临时的。 */
export const LONG_TERM_TYPES = ['episodic', 'semantic', 'relationship', 'project'];

const TYPE_WEIGHT = {
  working: 1.0,
  relationship: 0.85,
  project: 0.8,
  semantic: 0.7,
  episodic: 0.6,
};

const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- 分词
// 中文没有空格，所以：英文/数字按词切，中文切成单字 + 双字。
// 双字（"小说"、"第九章"里的"九章"）比单字更能说明问题，打分时权重更高。
export function tokenize(s) {
  const text = String(s ?? '').toLowerCase();
  const toks = [];
  for (const m of text.matchAll(/[a-z0-9_]+/g)) toks.push(m[0]);
  const cjk = text.replace(/[^一-鿿]+/g, ' ');
  for (const seg of cjk.split(/\s+/)) {
    if (!seg) continue;
    for (let i = 0; i < seg.length; i++) {
      toks.push(seg[i]);
      if (i + 1 < seg.length) toks.push(seg.slice(i, i + 2));
    }
  }
  return toks;
}

const weightOf = t => (t.length >= 2 ? 2 : 0.5);

/** 两段文字的相关度，0–1。 */
export function similarity(query, text) {
  const q = tokenize(query), d = new Set(tokenize(text));
  if (!q.length) return 0;
  let hit = 0, total = 0;
  const seen = new Set();
  for (const t of q) {
    if (seen.has(t)) continue;
    seen.add(t);
    const w = weightOf(t);
    total += w;
    if (d.has(t)) hit += w;
  }
  return total ? hit / total : 0;
}

// ---------------------------------------------------------------- 记录
export function createMemory(partial = {}) {
  const now = partial.created_at || Date.now();
  const type = MEMORY_TYPES.includes(partial.type) ? partial.type : 'episodic';
  return {
    id: partial.id || uid('m_'),
    content: String(partial.content ?? '').trim(),
    type,
    importance: clamp01(partial.importance ?? 0.5),
    created_at: now,
    updated_at: partial.updated_at || now,
    last_accessed: partial.last_accessed || 0,
    source: partial.source || 'chat',      // chat / user / ai / import / system
    tags: Array.isArray(partial.tags) ? [...new Set(partial.tags.map(String))] : [],
    locked: !!partial.locked,              // 锁定：永不自动淘汰，检索时置顶
    project_id: partial.project_id || null,
  };
}

const clamp01 = v => Math.min(1, Math.max(0, Number(v) || 0));
const norm = s => String(s ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

// ---------------------------------------------------------------- 仓库
export function createMemoryStore(backend, {
  clock = { now: () => Date.now() },
  capacity = 500,          // 长期库封顶，超了淘汰最不重要的（锁定的不动）
  workingCapacity = 40,    // 当前会话最多留几条
} = {}) {
  const store = createStore(backend, 'memory');

  const readAll = () => store.get('items', []);
  const writeAll = items => store.set('items', items);
  const readBlocklist = () => store.get('blocklist', []);

  async function evict(items) {
    const long = items.filter(m => m.type !== 'working');
    const work = items.filter(m => m.type === 'working');
    // working：只留最近 N 条
    const keptWork = work.slice(-workingCapacity);
    if (long.length <= capacity) return [...long, ...keptWork];
    const pinned = long.filter(m => m.locked);
    const rest = long.filter(m => !m.locked)
      .sort((a, b) => (b.importance - a.importance) || (b.updated_at - a.updated_at));
    return [...pinned, ...rest.slice(0, Math.max(0, capacity - pinned.length)), ...keptWork];
  }

  const api = {
    store,

    async all() { return readAll(); },

    /** 某条内容是否被用户禁止进入长期记忆。 */
    async isBlocked(content) {
      const list = await readBlocklist();
      const n = norm(content);
      if (!n) return false;
      return list.some(b => n.includes(norm(b)));
    },

    /**
     * 写入一条记忆。
     * - 被 blocklist 命中的长期记忆直接拒绝（working 不受限，它本来就不落长期库）
     * - 忽略标点和大小写去重，同一件事不会记两遍
     */
    async add(partial) {
      const m = createMemory(partial);
      if (!m.content) return { ok: false, reason: 'empty' };
      if (m.type !== 'working' && await api.isBlocked(m.content)) {
        return { ok: false, reason: 'blocked' };
      }
      const items = await readAll();
      const n = norm(m.content);
      const dup = items.find(x => x.type === m.type && norm(x.content) === n);
      if (dup) {
        dup.updated_at = clock.now();
        dup.importance = Math.max(dup.importance, m.importance);
        dup.tags = [...new Set([...dup.tags, ...m.tags])];
        await writeAll(await evict(items));
        return { ok: true, memory: dup, deduped: true };
      }
      m.created_at = m.created_at || clock.now();
      m.updated_at = clock.now();
      items.push(m);
      await writeAll(await evict(items));
      return { ok: true, memory: m };
    },

    async get(id) { return (await readAll()).find(m => m.id === id) || null; },

    async update(id, patch) {
      const items = await readAll();
      const m = items.find(x => x.id === id);
      if (!m) return null;
      for (const k of ['content', 'type', 'source', 'project_id']) if (patch[k] != null) m[k] = patch[k];
      if (patch.importance != null) m.importance = clamp01(patch.importance);
      if (patch.tags) m.tags = [...new Set(patch.tags.map(String))];
      if (patch.locked != null) m.locked = !!patch.locked;
      m.updated_at = clock.now();
      await writeAll(items);
      return m;
    },

    async remove(id) {
      const items = await readAll();
      const next = items.filter(m => m.id !== id);
      await writeAll(next);
      return next.length !== items.length;
    },

    lock: id => api.update(id, { locked: true }),
    unlock: id => api.update(id, { locked: false }),

    /** 禁止某条信息进入长期记忆，并清掉已经记下的。 */
    async block(text) {
      const list = await readBlocklist();
      const t = String(text || '').trim();
      if (!t) return list;
      if (!list.includes(t)) list.push(t);
      await store.set('blocklist', list);
      const items = await readAll();
      const n = norm(t);
      await writeAll(items.filter(m => m.type === 'working' || !norm(m.content).includes(n)));
      return list;
    },
    async unblock(text) {
      const list = (await readBlocklist()).filter(x => x !== text);
      await store.set('blocklist', list);
      return list;
    },
    blocklist: () => readBlocklist(),

    /** Memory Manager 用：按关键词 / 类型 / 标签筛。 */
    async search(query = '', { type, tag, limit = 50 } = {}) {
      let items = await readAll();
      if (type) items = items.filter(m => m.type === type);
      if (tag) items = items.filter(m => m.tags.includes(tag));
      if (query) {
        items = items
          .map(m => ({ m, s: similarity(query, m.content + ' ' + m.tags.join(' ')) }))
          .filter(x => x.s > 0)
          .sort((a, b) => b.s - a.s)
          .map(x => x.m);
      } else {
        items = [...items].sort((a, b) => b.updated_at - a.updated_at);
      }
      return items.slice(0, limit);
    },

    /**
     * 检索注入 —— 这是整个记忆系统的关键。
     * 输入当前聊天内容，输出「该带进上下文的那几条」，带字数预算。
     *
     * 排序分 = 相关度 0.55 + 重要度 0.2 + 新近度 0.15 + 类型权重 0.1
     * working 永远带上（它就是当前上下文）；locked 置顶。
     */
    async retrieve(query, { limit = 8, budgetChars = 1200, types = null, projectId = null } = {}) {
      const now = clock.now();
      let items = await readAll();
      if (types) items = items.filter(m => types.includes(m.type));
      if (projectId) items = items.filter(m => m.type !== 'project' || m.project_id === projectId);

      const working = items.filter(m => m.type === 'working').slice(-6);
      const pool = items.filter(m => m.type !== 'working');

      const scored = pool.map(m => {
        const rel = similarity(query, m.content + ' ' + m.tags.join(' '));
        const ageDays = (now - m.updated_at) / DAY;
        const recency = Math.exp(-ageDays / 30);
        const score = 0.55 * rel + 0.2 * m.importance + 0.15 * recency + 0.1 * (TYPE_WEIGHT[m.type] || 0.5);
        return { m, rel, score };
      });

      const pinned = scored.filter(x => x.m.locked).sort((a, b) => b.score - a.score);
      const rest = scored.filter(x => !x.m.locked && x.rel > 0).sort((a, b) => b.score - a.score);

      const picked = [];
      let used = 0;
      for (const x of [...pinned, ...rest]) {
        if (picked.length >= limit) break;
        const cost = x.m.content.length + 4;
        if (used + cost > budgetChars) continue;   // 放不下就跳过，不是直接停
        picked.push(x.m);
        used += cost;
      }

      // 标记访问时间，用于以后的"常用记忆"判断
      if (picked.length) {
        const all = await readAll();
        for (const p of picked) {
          const m = all.find(x => x.id === p.id);
          if (m) m.last_accessed = now;
        }
        await writeAll(all);
      }

      return { items: picked, working, usedChars: used, budgetChars };
    },

    /** 把检索结果拼成注进 Prompt 的那段文字。 */
    format({ items = [], working = [] } = {}) {
      const label = { episodic: '发生过的事', semantic: '长期事实', relationship: '我们之间', project: '正在做的项目' };
      const out = [];
      const byType = {};
      for (const m of items) (byType[m.type] ||= []).push(m);
      for (const t of LONG_TERM_TYPES) {
        if (!byType[t]?.length) continue;
        out.push(`【${label[t]}】`);
        for (const m of byType[t]) out.push('- ' + m.content);
      }
      if (working.length) {
        out.push('【刚才聊到】');
        for (const m of working) out.push('- ' + m.content);
      }
      return out.join('\n');
    },

    async stats() {
      const items = await readAll();
      const by = Object.fromEntries(MEMORY_TYPES.map(t => [t, 0]));
      for (const m of items) by[m.type] = (by[m.type] || 0) + 1;
      return { total: items.length, byType: by, locked: items.filter(m => m.locked).length };
    },

    async clearWorking() {
      const items = await readAll();
      await writeAll(items.filter(m => m.type !== 'working'));
    },

    async export() { return { version: 1, items: await readAll(), blocklist: await readBlocklist() }; },
    async import(data, { replace = false } = {}) {
      if (!data || !Array.isArray(data.items)) throw new Error('导入的数据里没有 items');
      const base = replace ? [] : await readAll();
      const merged = [...base];
      for (const raw of data.items) {
        const m = createMemory(raw);
        if (!merged.some(x => x.id === m.id)) merged.push(m);
      }
      await writeAll(await evict(merged));
      if (Array.isArray(data.blocklist)) await store.set('blocklist', data.blocklist);
      return merged.length;
    },
  };

  return api;
}
