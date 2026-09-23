// 人机朋友圈。
//
// 圈子里住着几个 AI，有男有女，各有各的性格和作息。
// 他们会：自己发动态 / 评论你发的动态 / 主动私聊你。
// 你也可以发动态，他们会来评论。
//
// 生成文字这件事交给外面注入的 composer(prompt, ctx) —— App 里接真模型，
// 测试里接模板函数。所以这套逻辑离线也能跑、也能测。

import { createStore, uid } from './store.js';
import { HOUR } from './clock.js';

export const GENDERS = ['female', 'male', 'neutral'];

/** 预置住户。用户可以改、可以删、可以自己加。 */
export const DEFAULT_RESIDENTS = [
  {
    id: 'r_lin', name: '林野', gender: 'male', relation: '朋友',
    personality: '话少，爱骑车和拍照，偶尔冒一句冷幽默',
    interests: ['摄影', '骑行', '独立音乐'],
    activeHours: [7, 23], postChance: 0.35, commentChance: 0.5, dmChance: 0.08,
  },
  {
    id: 'r_su', name: '苏昭', gender: 'female', relation: '同事',
    personality: '热络、爱操心，什么都想搭一句嘴',
    interests: ['做饭', '追剧', '咖啡'],
    activeHours: [9, 24], postChance: 0.45, commentChance: 0.8, dmChance: 0.15,
  },
  {
    id: 'r_qi', name: '祁乐', gender: 'neutral', relation: '网友',
    personality: '半夜出没，聊技术和书，说话直',
    interests: ['写代码', '科幻小说', '熬夜'],
    activeHours: [20, 3], postChance: 0.4, commentChance: 0.45, dmChance: 0.1,
  },
];

const inActive = (hour, [from, to]) => (from <= to ? hour >= from && hour < to : hour >= from || hour < to);

/** 默认 composer：不接模型时用模板，保证离线/测试也有东西可看。 */
export function templateComposer({ kind, resident, context }) {
  const pick = (arr, seed) => arr[Math.abs(seed) % arr.length];
  const seed = (resident.id + kind + (context.postId || '') + (context.bucket || '')).split('')
    .reduce((a, c) => a + c.charCodeAt(0), 0);
  if (kind === 'post') {
    const topic = pick(resident.interests, seed);
    return pick([
      `今天又去${topic}了，挺好的。`,
      `关于${topic}，我最近想通一件事。`,
      `${topic}。就这样。`,
    ], seed >> 3);
  }
  if (kind === 'comment') {
    return pick(['这个好。', '我也是这么想的。', '哈哈哈，理解。', '下次带我一个。'], seed);
  }
  if (kind === 'dm') {
    return pick([`在忙吗？`, `看到你发的了，还好吧？`, `随便问一句，最近怎么样。`], seed);
  }
  return '';
}

export function createFeed(backend, {
  clock = { now: () => Date.now(), hour: () => new Date().getHours(), ymd: () => '' },
  composer = templateComposer,
  rng = Math.random,
} = {}) {
  const store = createStore(backend, 'feed');

  const residents = () => store.get('residents', DEFAULT_RESIDENTS);
  const posts = () => store.get('posts', []);       // 时间倒序保存为正序，渲染时再倒
  const dms = () => store.get('dms', []);

  const api = {
    store,
    residents,
    posts,
    dms,

    async setResidents(list) { await store.set('residents', list); return list; },
    async addResident(r) {
      const list = await residents();
      const res = {
        id: r.id || uid('r_'), name: r.name, gender: GENDERS.includes(r.gender) ? r.gender : 'neutral',
        relation: r.relation || '朋友', personality: r.personality || '', interests: r.interests || [],
        activeHours: r.activeHours || [9, 23],
        postChance: r.postChance ?? 0.35, commentChance: r.commentChance ?? 0.5, dmChance: r.dmChance ?? 0.1,
      };
      await store.set('residents', [...list.filter(x => x.id !== res.id), res]);
      return res;
    },
    async removeResident(id) {
      await store.set('residents', (await residents()).filter(x => x.id !== id));
    },

    /** 用户自己发一条动态（可带图）。 */
    async post({ text, images = [], authorId = 'me' }) {
      const list = await posts();
      const p = {
        id: uid('post_'), authorId, text: String(text || '').trim(),
        images: images.slice(0, 9), at: clock.now(), comments: [], likes: [],
      };
      if (!p.text && !p.images.length) throw new Error('动态不能是空的');
      list.push(p);
      await store.set('posts', list.slice(-300));
      return p;
    },

    async comment(postId, { authorId, text }) {
      const list = await posts();
      const p = list.find(x => x.id === postId);
      if (!p) return null;
      const c = { id: uid('c_'), authorId, text, at: clock.now() };
      p.comments.push(c);
      await store.set('posts', list);
      return c;
    },

    async like(postId, authorId = 'me') {
      const list = await posts();
      const p = list.find(x => x.id === postId);
      if (!p) return null;
      const i = p.likes.indexOf(authorId);
      i >= 0 ? p.likes.splice(i, 1) : p.likes.push(authorId);
      await store.set('posts', list);
      return p.likes;
    },

    /**
     * 住户来评论用户最近发的动态。
     * 一个人对同一条只评一次；只在自己的活跃时间里出现。
     *
     * atLeastOne：用户刚发了东西却一个人都没掷中，看着就像坏了。
     * 所以只要还有人醒着，就让最爱说话的那个必定回一句 —— 这是产品决定，不是掷骰子。
     */
    async reactToUserPosts({ withinHours = 24, max = 3, atLeastOne = true } = {}) {
      const list = await posts();
      const rs = await residents();
      const hour = clock.hour();
      const now = clock.now();
      const fresh = list.filter(p => p.authorId === 'me' && now - p.at <= withinHours * HOUR);
      const made = [];

      const say = async (p, r) => {
        const text = await composer({ kind: 'comment', resident: r, context: { postId: p.id, post: p } });
        if (!text) return false;
        p.comments.push({ id: uid('c_'), authorId: r.id, text, at: now });
        made.push({ postId: p.id, residentId: r.id, text });
        return true;
      };

      for (const p of fresh) {
        for (const r of rs) {
          if (made.length >= max) break;
          if (!inActive(hour, r.activeHours)) continue;
          if (p.comments.some(c => c.authorId === r.id)) continue;
          if (rng() > r.commentChance) continue;
          await say(p, r);
        }
      }

      if (atLeastOne && !made.length) {
        // 挑一条还没人理的最新动态，让最爱说话的醒着的人回一句
        const lonely = [...fresh].reverse().find(p => !p.comments.length);
        if (lonely) {
          const awake = rs.filter(r => inActive(hour, r.activeHours))
            .sort((a, b) => b.commentChance - a.commentChance);
          if (awake.length) await say(lonely, awake[0]);
        }
      }

      if (made.length) await store.set('posts', list);
      return made;
    },

    /** 住户自己发动态。bucket 用来保证同一个时间段不会重复刷屏。 */
    async residentsPost({ max = 2, bucket = null } = {}) {
      const rs = await residents();
      const list = await posts();
      const hour = clock.hour();
      const now = clock.now();
      const b = bucket || `${clock.ymd()}#${Math.floor(hour / 4)}`;
      const seen = new Set(list.filter(p => p.bucket).map(p => `${p.authorId}@${p.bucket}`));
      const made = [];
      for (const r of rs) {
        if (made.length >= max) break;
        if (!inActive(hour, r.activeHours)) continue;
        if (seen.has(`${r.id}@${b}`)) continue;
        if (rng() > r.postChance) continue;
        const text = await composer({ kind: 'post', resident: r, context: { bucket: b } });
        if (!text) continue;
        const p = { id: uid('post_'), authorId: r.id, text, images: [], at: now, comments: [], likes: [], bucket: b };
        list.push(p);
        made.push(p);
      }
      if (made.length) await store.set('posts', list.slice(-300));
      return made;
    },

    /**
     * 住户主动私聊。
     * 这条走 proactive 闸门 —— 默认是关的，用户自己开。
     */
    async maybeDM({ max = 1 } = {}) {
      const rs = await residents();
      const hour = clock.hour();
      const out = [];
      const box = await dms();
      for (const r of rs) {
        if (out.length >= max) break;
        if (!inActive(hour, r.activeHours)) continue;
        if (rng() > r.dmChance) continue;
        const text = await composer({ kind: 'dm', resident: r, context: {} });
        if (!text) continue;
        const m = { id: uid('dm_'), residentId: r.id, text, at: clock.now(), read: false };
        box.push(m);
        out.push(m);
      }
      if (out.length) await store.set('dms', box.slice(-200));
      return out;
    },

    async markDMRead(id) {
      const box = await dms();
      const m = box.find(x => x.id === id);
      if (m) { m.read = true; await store.set('dms', box); }
      return m;
    },

    async unreadDMs() { return (await dms()).filter(m => !m.read); },

    /** 渲染用：最新在前，附带作者信息。 */
    async timeline({ limit = 50 } = {}) {
      const list = await posts();
      const rs = await residents();
      const who = id => (id === 'me' ? { id: 'me', name: '我', gender: 'neutral' } : rs.find(r => r.id === id) || { id, name: id });
      return [...list].sort((a, b) => b.at - a.at).slice(0, limit)
        .map(p => ({
          ...p,
          author: who(p.authorId),
          comments: p.comments.map(c => ({ ...c, author: who(c.authorId) })),
        }));
    },
  };

  return api;
}
