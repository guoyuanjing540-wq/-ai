// 主动消息的闸门。
//
// 规格里点名要的四样，缺一不可：
//   总开关 / 勿扰时间 / 频率限制 / 分类开关
// 所有主动行为（推送、私聊、发动态、提醒）都必须先过 canSend()，
// 没有任何一条路径可以绕过去 —— 这是「避免疯狂推送」唯一能落地的做法。

import { createStore } from './store.js';
import { inWindow, MINUTE, HOUR } from './clock.js';

export const CATEGORIES = {
  greeting: { label: '打招呼', defaultOn: true, perDay: 2 },
  checkin:  { label: '关心你', defaultOn: true, perDay: 2 },
  share:    { label: 'TA 想说的事', defaultOn: true, perDay: 3 },
  remind:   { label: '日程提醒', defaultOn: true, perDay: 8 },
  moment:   { label: '发动态', defaultOn: true, perDay: 3 },
  comment:  { label: '评论你的动态', defaultOn: true, perDay: 6 },
  dm:       { label: '朋友圈里的人私聊你', defaultOn: false, perDay: 2 },
};

export function defaultPolicy() {
  return {
    enabled: true,
    dnd: { on: true, from: '23:00', to: '08:00' },   // 勿扰，支持跨零点
    totalPerDay: 8,
    minGapMinutes: 45,
    quietAfterUserSilentHours: 0,                    // >0 时，用户多久不理就自动收声
    categories: Object.fromEntries(
      Object.entries(CATEGORIES).map(([k, v]) => [k, { on: v.defaultOn, perDay: v.perDay }])
    ),
  };
}

export function createProactiveGate(backend, { clock } = {}) {
  const store = createStore(backend, 'proactive');
  const now = () => (clock ? clock.now() : Date.now());
  const today = () => (clock ? clock.ymd() : new Date().toISOString().slice(0, 10));

  const getPolicy = async () => {
    const saved = await store.get('policy');
    const d = defaultPolicy();
    if (!saved) return d;
    return {
      ...d, ...saved,
      dnd: { ...d.dnd, ...(saved.dnd || {}) },
      categories: { ...d.categories, ...(saved.categories || {}) },
    };
  };

  const getLog = () => store.get('log', []);   // [{kind, at, ymd}]

  const api = {
    store,
    policy: getPolicy,
    async setPolicy(patch) {
      const p = { ...(await getPolicy()), ...patch };
      if (patch.dnd) p.dnd = { ...(await getPolicy()).dnd, ...patch.dnd };
      if (patch.categories) p.categories = { ...(await getPolicy()).categories, ...patch.categories };
      await store.set('policy', p);
      return p;
    },
    async setCategory(kind, patch) {
      const p = await getPolicy();
      p.categories[kind] = { ...(p.categories[kind] || { on: true, perDay: 3 }), ...patch };
      await store.set('policy', p);
      return p;
    },

    /**
     * 能不能发？返回 {ok, reason}。reason 是给设置页显示的人话。
     * @param kind CATEGORIES 里的分类
     * @param ctx  { lastUserActiveAt } 用户最后一次说话的时间
     */
    async canSend(kind, ctx = {}) {
      const p = await getPolicy();
      const t = now();

      if (!p.enabled) return { ok: false, reason: '主动消息总开关关着' };
      const cat = p.categories[kind];
      if (!cat) return { ok: false, reason: `没有这个分类：${kind}` };
      if (!cat.on) return { ok: false, reason: `「${CATEGORIES[kind]?.label || kind}」这一类关着` };

      if (p.dnd?.on) {
        const d = new Date(t);
        const minutes = d.getHours() * 60 + d.getMinutes();
        if (inWindow(minutes, p.dnd.from, p.dnd.to)) {
          return { ok: false, reason: `勿扰时间（${p.dnd.from}–${p.dnd.to}）` };
        }
      }

      if (p.quietAfterUserSilentHours > 0 && ctx.lastUserActiveAt) {
        const silent = (t - ctx.lastUserActiveAt) / HOUR;
        if (silent > p.quietAfterUserSilentHours) {
          return { ok: false, reason: `你已经 ${Math.floor(silent)} 小时没说话，TA 先不打扰了` };
        }
      }

      const log = await getLog();
      const ymd = today();
      const todayLog = log.filter(x => x.ymd === ymd);
      if (todayLog.length >= p.totalPerDay) return { ok: false, reason: `今天主动消息已经到上限（${p.totalPerDay} 条）` };
      const kindCount = todayLog.filter(x => x.kind === kind).length;
      if (kindCount >= cat.perDay) return { ok: false, reason: `「${CATEGORIES[kind]?.label || kind}」今天已经 ${kindCount} 条` };

      const last = log.length ? log[log.length - 1].at : 0;
      const gap = (t - last) / MINUTE;
      if (last && gap < p.minGapMinutes) {
        return { ok: false, reason: `离上一条才 ${Math.floor(gap)} 分钟，最少要隔 ${p.minGapMinutes} 分钟` };
      }

      return { ok: true, reason: '' };
    },

    /** 真的发出去之后记一笔。只有记了账，频率限制才算数。 */
    async record(kind) {
      const log = await getLog();
      log.push({ kind, at: now(), ymd: today() });
      const cutoff = now() - 7 * 24 * HOUR;
      await store.set('log', log.filter(x => x.at >= cutoff));
      return log.length;
    },

    /** 包一层：过闸 + 执行 + 记账，一步到位，不给绕过的机会。 */
    async attempt(kind, fn, ctx = {}) {
      const gate = await api.canSend(kind, ctx);
      if (!gate.ok) return { sent: false, ...gate };
      const result = await fn();
      if (result === false) return { sent: false, reason: '这次没内容可发' };
      await api.record(kind);
      return { sent: true, reason: '', result };
    },

    async todayCount() {
      const ymd = today();
      return (await getLog()).filter(x => x.ymd === ymd).length;
    },
    async reset() { await store.set('log', []); },
  };

  return api;
}
