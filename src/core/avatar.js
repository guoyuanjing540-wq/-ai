// 角色动画状态机。
//
// 第一阶段不做 3D。这里只负责「现在该是什么状态、该摆什么姿势」，
// 具体怎么画交给 renderer。状态机本身跟画法无关 ——
// 以后换 Live2D 或 3D，只是 renderer 换掉，这个文件不动。
//
// 状态：待机 / 阅读 / 工作 / 看向用户 / 思考 / 欢迎
// 呼吸和眨眼不是状态，是一直在跑的叠加层（任何状态下都有）。

export const AVATAR_STATES = ['idle', 'reading', 'working', 'looking_at_user', 'thinking', 'welcome'];

export const EXPRESSIONS = ['neutral', 'smile', 'soft', 'surprised', 'sleepy', 'concerned'];

/** 每个状态的最短停留时间（毫秒），免得一帧一个样子乱跳。 */
const MIN_DWELL = {
  idle: 800,
  reading: 3000,
  working: 3000,
  looking_at_user: 1200,
  thinking: 900,
  welcome: 2200,
};

/** 事件 → 目标状态。优先级高的能打断低的。 */
const PRIORITY = { welcome: 100, looking_at_user: 80, thinking: 70, working: 40, reading: 40, idle: 10 };

const TRANSITIONS = {
  'user.enter': 'welcome',
  'user.focus': 'looking_at_user',
  'user.typing': 'looking_at_user',
  'ai.thinking': 'thinking',
  'ai.reply.done': 'looking_at_user',
  'ai.read': 'reading',
  'ai.work': 'working',
  'idle': 'idle',
};

export function createAvatarMachine({
  state = 'idle',
  now = () => Date.now(),
  expression = 'neutral',
} = {}) {
  let cur = AVATAR_STATES.includes(state) ? state : 'idle';
  let since = now();
  let expr = expression;
  let exprUntil = 0;
  let queued = null;
  const listeners = new Set();

  function apply(next, at) {
    if (!AVATAR_STATES.includes(next) || next === cur) return false;
    const prev = cur;
    cur = next;
    since = at;
    for (const fn of listeners) fn({ from: prev, to: next, at });
    return true;
  }

  return {
    get state() { return cur; },
    get expression() { return expr; },
    get since() { return since; },

    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    /**
     * 送一个事件进来。
     * 当前状态没待够最短时间、且新状态优先级不更高 → 先排队，等 tick 时再落地。
     */
    send(event, at = now()) {
      const next = TRANSITIONS[event];
      if (!next) return cur;
      const held = at - since;
      const canInterrupt = PRIORITY[next] > PRIORITY[cur] || held >= (MIN_DWELL[cur] || 0);
      if (canInterrupt) { apply(next, at); queued = null; }
      else queued = next;
      return cur;
    },

    /** 强制切换，不看优先级（用户手动指定时用）。 */
    force(next, at = now()) { queued = null; return apply(next, at); },

    /** 每帧或每秒调一次：处理排队的切换，以及 welcome/thinking 这类临时状态的自动回落。 */
    tick(at = now()) {
      const held = at - since;
      if (queued && held >= (MIN_DWELL[cur] || 0)) {
        const n = queued; queued = null; apply(n, at);
        return cur;
      }
      if ((cur === 'welcome' || cur === 'thinking') && held >= (MIN_DWELL[cur] || 0) * 1.5) {
        apply('looking_at_user', at);
      } else if (cur === 'looking_at_user' && held >= 8000) {
        apply('idle', at);
      }
      if (exprUntil && at >= exprUntil) { expr = 'neutral'; exprUntil = 0; }
      return cur;
    },

    /** 临时表情，过一会儿自己回到 neutral。 */
    setExpression(e, { durationMs = 4000, at = now() } = {}) {
      if (!EXPRESSIONS.includes(e)) return expr;
      expr = e;
      exprUntil = durationMs > 0 ? at + durationMs : 0;
      return expr;
    },

    /**
     * 当前这一帧的姿势。渲染层拿它去画。
     * breath: -1..1 的呼吸相位；blink: 0..1 闭眼程度；gaze: 视线偏移。
     */
    pose(at = now()) {
      const t = at / 1000;
      const held = at - since;
      const breath = Math.sin(t * (Math.PI * 2) / 4.2);            // 4.2 秒一次，慢而轻
      const blinkPhase = (t % 4.6) / 4.6;
      const blink = blinkPhase > 0.965 ? Math.sin((blinkPhase - 0.965) / 0.035 * Math.PI) : 0;
      const gaze = {
        idle:            { x: Math.sin(t / 5) * 0.12, y: 0.02 },
        reading:         { x: -0.18, y: 0.22 },
        working:         { x: -0.10, y: 0.18 },
        looking_at_user: { x: 0, y: 0 },
        thinking:        { x: 0.22, y: -0.16 },
        welcome:         { x: 0, y: -0.04 },
      }[cur] || { x: 0, y: 0 };
      const enter = Math.min(1, held / 400);                        // 进入状态的缓动
      return { state: cur, expression: expr, breath, blink, gaze, enter, heldMs: held };
    },

    /** 场景变了 → 角色该干什么。首页的默认行为由这里给。 */
    syncWithScene(scene, at = now()) {
      if (!scene) return cur;
      if (scene.absence !== 'present' && cur !== 'welcome') { this.send('user.enter', at); return cur; }
      if (scene.aiState === 'reading') this.send('ai.read', at);
      else if (scene.aiState === 'working') this.send('ai.work', at);
      else if (scene.aiState === 'thinking') this.send('ai.thinking', at);
      return cur;
    },
  };
}
