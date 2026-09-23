// Companion Autonomy System —— 让角色有一点自主性，而不是只会被动回话。
//
// 每隔一段时间 tick() 一次：
//   1. 看当前场景（时间、天气、用户在不在、在做什么项目）
//   2. 列出所有「TA 现在可能想做的事」，各自打分
//   3. 挑分最高的那个
//   4. **凡是会打扰到用户的，一律先过 proactive 闸门**；不打扰的（换衣服、看书、
//      写日记）不用过闸，因为它们只改变共同空间，不会震你手机。
//
// rng 可注入 → 行为可复现、可测试。

import { HOUR } from './clock.js';

/** 会不会打扰用户。false 的只改变共同空间。 */
export const INTENTS = {
  idle:          { disturb: false, category: null },
  change_outfit: { disturb: false, category: null },
  read:          { disturb: false, category: null },
  work:          { disturb: false, category: null },
  write_diary:   { disturb: false, category: null },
  post_moment:   { disturb: true,  category: 'moment' },
  greet:         { disturb: true,  category: 'greeting' },
  check_in:      { disturb: true,  category: 'checkin' },
  share_thought: { disturb: true,  category: 'share' },
};

export function createAutonomy({
  clock,
  gate,             // createProactiveGate(...)
  scene: sceneFn,   // () => scene
  rng = Math.random,
  handlers = {},    // { [intent]: async (ctx) => any }
} = {}) {
  let lastAt = 0;
  const lastByIntent = {};

  function score(intent, scene, ctx) {
    const hour = scene.hour;
    const sinceLast = (clock.now() - (lastByIntent[intent] || 0)) / HOUR;
    let s = 0;
    switch (intent) {
      case 'greet':
        // 用户离开过一阵子回来 → 想打招呼
        s = scene.absence === 'present' ? 0 : (scene.absence === 'short' ? 0.4 : 0.85);
        break;
      case 'check_in':
        s = scene.absence === 'medium' || scene.absence === 'long' ? 0.6 : 0.15;
        if (hour >= 22 || hour < 7) s *= 0.4;
        break;
      case 'share_thought':
        s = 0.3 + (scene.mood - 0.5) * 0.4;
        break;
      case 'post_moment':
        s = 0.35;
        if (hour >= 9 && hour < 22) s += 0.15;
        break;
      case 'read':
        s = (hour >= 20 && hour < 24) || scene.weather === 'rain' ? 0.6 : 0.3;
        break;
      case 'work':
        s = scene.project ? 0.55 : 0.1;
        if (hour < 8 || hour >= 23) s *= 0.3;
        break;
      case 'write_diary':
        s = hour >= 21 ? 0.5 : 0.05;
        break;
      case 'change_outfit':
        s = ctx.outfitStale ? 0.45 : 0.08;
        break;
      case 'idle':
        s = 0.25;
        break;
    }
    // 刚做过的事降权，避免反复做同一件
    if (sinceLast < 2) s *= 0.25;
    else if (sinceLast < 6) s *= 0.7;
    return Math.max(0, s + (rng() - 0.5) * 0.12);   // 一点点抖动，别太机械
  }

  const api = {
    /** 只算不做 —— 方便在设置页里预览「TA 现在想干嘛」。 */
    plan(scene, ctx = {}) {
      return Object.keys(INTENTS)
        .map(i => ({ intent: i, score: score(i, scene, ctx) }))
        .sort((a, b) => b.score - a.score);
    },

    /**
     * 跑一拍。
     * @returns {intent, acted, reason, result}
     */
    async tick(ctx = {}) {
      const now = clock.now();
      if (ctx.minIntervalMs && now - lastAt < ctx.minIntervalMs) {
        return { intent: null, acted: false, reason: '离上一拍太近' };
      }
      lastAt = now;

      const scene = typeof sceneFn === 'function' ? sceneFn() : sceneFn;
      if (!scene) return { intent: null, acted: false, reason: '没有场景' };

      const ranked = api.plan(scene, ctx);
      for (const { intent } of ranked) {
        const meta = INTENTS[intent];
        const handler = handlers[intent];
        if (!handler) continue;

        if (meta.disturb) {
          const g = await gate.canSend(meta.category, { lastUserActiveAt: ctx.lastUserActiveAt });
          if (!g.ok) continue;                       // 闸门拦下就换下一个想法，不硬发
          const result = await handler({ scene, ctx, intent });
          if (result === false || result == null) continue;
          await gate.record(meta.category);
          lastByIntent[intent] = now;
          return { intent, acted: true, reason: '', result, scene };
        }

        const result = await handler({ scene, ctx, intent });
        if (result === false || result == null) continue;
        lastByIntent[intent] = now;
        return { intent, acted: true, reason: '', result, scene };
      }
      return { intent: null, acted: false, reason: '这一拍没有想做的事（或都被闸门拦了）', scene };
    },

    /** 调试用：看看每个意图上次是什么时候做的。 */
    history: () => ({ ...lastByIntent }),
    reset() { lastAt = 0; for (const k of Object.keys(lastByIntent)) delete lastByIntent[k]; },
  };

  return api;
}
