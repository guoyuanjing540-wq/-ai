// 把所有子系统装配成一个东西。
// UI 只跟这一层打交道，不用知道底下有几个模块。

import { createClock } from './clock.js';
import { createMemoryBackend, createIdbBackend } from './store.js';
import { createPersonaStore, personaToPrompt, createPersona } from './persona.js';
import { createMemoryStore } from './memory.js';
import { resolveScene } from './scene.js';
import { createAvatarMachine } from './avatar.js';
import { createProactiveGate } from './proactive.js';
import { createWardrobe } from './wardrobe.js';
import { createFeed } from './residents.js';
import { createLibrary } from './reading.js';
import { createAutonomy } from './autonomy.js';

export function createCompanion({
  backend = null,
  clock = createClock(),
  composer = undefined,
  fetchImpl = null,
  rng = Math.random,
} = {}) {
  const store = backend || (typeof indexedDB !== 'undefined' ? createIdbBackend() : createMemoryBackend());

  const persona = createPersonaStore(store);
  const memory = createMemoryStore(store, { clock });
  const gate = createProactiveGate(store, { clock });
  const wardrobe = createWardrobe(store, { clock });
  const feed = createFeed(store, { clock, composer, rng });
  const library = createLibrary(store, { clock, composer, fetchImpl });
  const avatar = createAvatarMachine({ now: () => clock.now() });

  // 运行时状态（不落盘的那部分）
  let runtime = { aiState: 'idle', mood: 0.6, lastUserActiveAt: clock.now(), lastSeenAt: clock.now(), project: null };

  const sceneOf = () => resolveScene({
    clock,
    aiState: runtime.aiState,
    user: { lastSeenAt: runtime.lastSeenAt, activity: runtime.project?.kind || null },
    project: runtime.project,
    mood: runtime.mood,
  });

  const autonomy = createAutonomy({
    clock, gate, rng,
    scene: sceneOf,
    handlers: {
      change_outfit: async ({ scene }) => {
        const r = await wardrobe.autoSelect(scene);
        return r.changed ? r : null;
      },
      read: async () => { runtime.aiState = 'reading'; avatar.send('ai.read'); return { aiState: 'reading' }; },
      work: async ({ scene }) => {
        if (!scene.project) return null;
        runtime.aiState = 'working'; avatar.send('ai.work');
        return { aiState: 'working', project: scene.project.name };
      },
      write_diary: async ({ scene }) => {
        const r = await memory.add({
          type: 'episodic', importance: 0.4, source: 'ai', tags: ['日记'],
          content: `${new Date(scene.at).toLocaleDateString('zh-CN')}：${scene.describe()}`,
        });
        return r.ok ? r.memory : null;
      },
      post_moment: async () => {
        const made = await feed.residentsPost({ max: 1 });
        return made.length ? made[0] : null;
      },
      greet: async ({ scene }) => ({ kind: 'greet', text: `你回来了。${scene.describe()}` }),
      check_in: async () => ({ kind: 'check_in', text: '今天还好吗？' }),
      share_thought: async () => ({ kind: 'share', text: '刚才想到一件事，想跟你说。' }),
      idle: async () => { runtime.aiState = 'idle'; return { aiState: 'idle' }; },
    },
  });

  return {
    clock, store, persona, memory, gate, wardrobe, feed, library, avatar, autonomy,

    get runtime() { return { ...runtime }; },
    setRuntime(patch) { runtime = { ...runtime, ...patch }; return { ...runtime }; },

    scene: sceneOf,

    /** 用户开口了：刷新活跃时间，角色看过来。 */
    userActive(at = clock.now()) {
      runtime.lastUserActiveAt = at;
      runtime.lastSeenAt = at;
      avatar.send('user.focus', at);
    },

    /** 打开 App：算出场景 → 角色做欢迎动作 → 场景自动换装。 */
    async enter() {
      const scene = sceneOf();
      avatar.send('user.enter');
      await wardrobe.autoSelect(scene);
      const r = { scene, outfit: await wardrobe.resolveCurrent(), greeting: scene.describe() };
      runtime.lastSeenAt = clock.now();
      return r;
    },

    /**
     * 组装一次对话要用的系统提示词：人格 + 检索到的记忆 + 当前场景。
     * 注意 memory.retrieve 有字数预算，不会把全部记忆塞进去。
     */
    async buildContext(userText, { budgetChars = 1200, limit = 8 } = {}) {
      const p = (await persona.active()) || createPersona();
      const got = await memory.retrieve(userText, { budgetChars, limit });
      const scene = sceneOf();
      const parts = [personaToPrompt(p)];
      const mem = memory.format(got);
      if (mem) parts.push('', '【你记得的事】', mem);
      parts.push('', '【此刻】', scene.describe());
      return {
        system: parts.join('\n'),
        persona: p,
        memories: got.items,
        usedChars: got.usedChars,
        budgetChars: got.budgetChars,
        scene,
      };
    },
  };
}

export { personaToPrompt, createPersona, resolveScene };
