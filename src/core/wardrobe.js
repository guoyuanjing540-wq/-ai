// 换装系统（modular outfit / wardrobe / accessory）。
//
// 第一阶段**只做接口和少量示例资产**，不做商城、不做抽卡、不做付费。
// 支持三种来源：
//   1. 角色自主换装（autonomy 调 autoSelect）
//   2. 用户指定搭配（wear，会上锁，AI 不再自作主张）
//   3. 场景自动换装（睡前换睡衣、下雨加外套）
// Outfit Memory 记住穿过什么、什么时候穿的、用户夸过哪套。

import { createStore, uid } from './store.js';

export const SLOTS = ['hair', 'top', 'bottom', 'shoes', 'accessory', 'outer'];

/** 示例资产：只有寥寥几件，够验证接口就行。真资产以后往这里加。 */
export const SAMPLE_ITEMS = [
  { id: 'hair_down',   slot: 'hair',      name: '披发',     tags: ['casual', 'home'] },
  { id: 'hair_tied',   slot: 'hair',      name: '扎起来',   tags: ['work', 'tidy'] },
  { id: 'top_tee',     slot: 'top',       name: '白T',      tags: ['casual', 'summer'] },
  { id: 'top_knit',    slot: 'top',       name: '米色针织', tags: ['casual', 'autumn', 'warm'] },
  { id: 'top_pajama',  slot: 'top',       name: '睡衣上衣', tags: ['sleep', 'home'] },
  { id: 'bottom_jean', slot: 'bottom',    name: '牛仔裤',   tags: ['casual'] },
  { id: 'bottom_pj',   slot: 'bottom',    name: '睡裤',     tags: ['sleep', 'home'] },
  { id: 'outer_coat',  slot: 'outer',     name: '风衣',     tags: ['rain', 'cold', 'out'] },
  { id: 'shoes_flat',  slot: 'shoes',     name: '平底鞋',   tags: ['casual'] },
  { id: 'acc_glasses', slot: 'accessory', name: '眼镜',     tags: ['read', 'work'] },
  { id: 'acc_none',    slot: 'accessory', name: '不戴',     tags: ['casual', 'sleep'] },
];

export const SAMPLE_OUTFITS = [
  { id: 'o_home',  name: '在家',   items: ['hair_down', 'top_knit', 'bottom_jean', 'acc_none'],   tags: ['home', 'casual'] },
  { id: 'o_sleep', name: '睡前',   items: ['hair_down', 'top_pajama', 'bottom_pj', 'acc_none'],   tags: ['sleep'] },
  { id: 'o_work',  name: '干活',   items: ['hair_tied', 'top_tee', 'bottom_jean', 'acc_glasses'], tags: ['work', 'read'] },
  { id: 'o_rain',  name: '下雨天', items: ['hair_down', 'top_knit', 'bottom_jean', 'outer_coat'], tags: ['rain', 'cold'] },
];

export function createWardrobe(backend, { clock = { now: () => Date.now() } } = {}) {
  const store = createStore(backend, 'wardrobe');

  const items = async () => store.get('items', SAMPLE_ITEMS);
  const outfits = async () => store.get('outfits', SAMPLE_OUTFITS);

  /**
   * 场景 → 该往哪些标签上靠，带权重。
   * 「在家」「随便穿」只是兜底，权重低；
   * 下雨、睡前、干活这些是具体情境，权重高 —— 否则永远是兜底那套赢。
   */
  function tagsForScene(scene) {
    const want = new Map([['home', 0.4], ['casual', 0.3]]);
    if (!scene) return want;
    if (scene.period === 'night' && scene.hour >= 22) {
      want.delete('home'); want.delete('casual');
      want.set('sleep', 2);
    }
    if (scene.weather === 'rain') want.set('rain', 1.5);
    if (scene.aiState === 'working') want.set('work', 1.5);
    if (scene.aiState === 'reading') want.set('read', 1.5);
    return want;
  }

  function scoreOutfit(outfit, want) {
    const set = new Set(outfit.tags || []);
    let s = 0;
    for (const [tag, w] of want) if (set.has(tag)) s += w;
    return s;
  }

  const api = {
    store,
    SLOTS,
    items,
    outfits,

    async addItem(item) {
      const list = await items();
      const it = { id: item.id || uid('it_'), slot: item.slot, name: item.name, tags: item.tags || [] };
      if (!SLOTS.includes(it.slot)) throw new Error('没有这个部位：' + it.slot);
      await store.set('items', [...list.filter(x => x.id !== it.id), it]);
      return it;
    },

    async addOutfit(outfit) {
      const list = await outfits();
      const o = { id: outfit.id || uid('o_'), name: outfit.name, items: outfit.items || [], tags: outfit.tags || [] };
      await store.set('outfits', [...list.filter(x => x.id !== o.id), o]);
      return o;
    },

    current: () => store.get('current', { outfitId: 'o_home', lockedByUser: false, at: 0 }),

    /** 用户指定搭配：穿上并上锁，AI 不再自动换。 */
    async wear(outfitId, { byUser = true, reason = '' } = {}) {
      const all = await outfits();
      const o = all.find(x => x.id === outfitId);
      if (!o) throw new Error('没有这套衣服：' + outfitId);
      const cur = { outfitId: o.id, lockedByUser: byUser, at: clock.now(), reason };
      await store.set('current', cur);
      await api.remember(o.id, { by: byUser ? 'user' : 'ai', reason });
      return cur;
    },

    /** 解锁，把主动权还给 AI。 */
    async unlock() {
      const cur = await api.current();
      await store.set('current', { ...cur, lockedByUser: false });
    },

    /**
     * 角色自主 / 场景自动换装。
     * 用户上锁了就什么都不做 —— 这条优先级最高。
     */
    async autoSelect(scene, { force = false } = {}) {
      const cur = await api.current();
      if (cur.lockedByUser && !force) return { changed: false, reason: '用户指定了搭配，不自动换', current: cur };
      const want = tagsForScene(scene);
      const wantList = [...want.keys()];
      const all = await outfits();
      const mem = await api.memory();
      const ranked = all
        .map(o => ({
          o,
          s: scoreOutfit(o, want)
            + (mem.favorites.includes(o.id) ? 0.5 : 0)          // 用户夸过的加分
            + (cur.outfitId === o.id ? 0.25 : 0),               // 轻微偏向不折腾
        }))
        .sort((a, b) => b.s - a.s);
      const best = ranked[0];
      if (!best || best.s <= 0) return { changed: false, reason: '没有合适的', current: cur };
      if (best.o.id === cur.outfitId) return { changed: false, reason: '已经穿着合适的了', current: cur };
      const next = { outfitId: best.o.id, lockedByUser: false, at: clock.now(), reason: wantList.join('/') };
      await store.set('current', next);
      await api.remember(best.o.id, { by: 'ai', reason: wantList.join('/') });
      return { changed: true, current: next, outfit: best.o, want: wantList };
    },

    // -------------------------------------------------- Outfit Memory
    memory: () => store.get('memory', { history: [], favorites: [], counts: {} }),

    async remember(outfitId, { by = 'ai', reason = '' } = {}) {
      const m = await api.memory();
      m.history.push({ outfitId, by, reason, at: clock.now() });
      if (m.history.length > 200) m.history = m.history.slice(-200);
      m.counts[outfitId] = (m.counts[outfitId] || 0) + 1;
      await store.set('memory', m);
      return m;
    },

    /** 用户夸了某套 → 记成偏好，以后自动选会偏向它。 */
    async favorite(outfitId, on = true) {
      const m = await api.memory();
      const set = new Set(m.favorites);
      on ? set.add(outfitId) : set.delete(outfitId);
      m.favorites = [...set];
      await store.set('memory', m);
      return m.favorites;
    },

    /** 渲染层要的：当前这身的具体单品。 */
    async resolveCurrent() {
      const cur = await api.current();
      const all = await outfits();
      const its = await items();
      const o = all.find(x => x.id === cur.outfitId) || all[0];
      if (!o) return { outfit: null, pieces: [] };
      const pieces = o.items.map(id => its.find(x => x.id === id)).filter(Boolean);
      return { outfit: o, pieces, lockedByUser: cur.lockedByUser };
    },
  };

  return api;
}
