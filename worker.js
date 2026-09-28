// 知言 · Cloudflare Worker
// 一个文件两个用处：
//   1. 转发接口：某家供应商在网页里"连不上"时，把设置里的接口地址填成 https://你的worker地址/deepseek（或 /openai、/glm、/claude）
//      设了 PASS 以后转发也要密码（App 自动带上，前提是「TA 主动找你」里填了同一个 Worker 的地址和密码）
//   2. TA 主动找你：定时生成消息、推送通知、到点提醒日程
// 第 2 个功能需要：KV 绑定（变量名 ZY）、密钥 PASS、Cron 触发器 */10 * * * *。步骤见使用说明。
// 可选：
//   - USERS：几个人共用一个 Worker 时用，格式 名字:密码,名字:密码 。每个密码一份独立的数据，互相看不到。
//   - SEAL：单独的加密密钥（随便一长串字符）。不设就用 PASS 派生。改了它或 PASS，Worker 上存的 Key 会解不开，
//     手机下次同步时会自动重新上传，不用管。
//
// 存储结构（KV，每个用户一组键，<user> 是 default 或 USERS 里的名字）：
//   u:<user>:cfg        手机同步来的：人设、日程、最近聊天、时间段……（只由 /sync 写）
//   u:<user>:cred       加密后的模型 Key + 过期时间（只由 /sync、/revoke 写）
//   u:<user>:run        定时任务自己的状态：今天的计划、发过几条、提醒过哪些（只由 Cron 写）
//   u:<user>:inbox      TA 发出的消息（只由 Cron 和 /test 写）
//   u:<user>:dev:<id>   每台设备：推送订阅、最后活跃时间、确认过哪些消息（只由这台设备写）
// 谁写哪个键分得很开，是为了避免 KV "后写覆盖先写" 把别的数据冲掉。
// 老版本的单键 state 第一次访问时会自动拆到 default 用户下，然后删掉 state（里面有明文 Key）。

const UPSTREAM = {
  deepseek: 'https://api.deepseek.com',
  openai: 'https://api.openai.com/v1',
  glm: 'https://open.bigmodel.cn/api/paas/v4',
  claude: 'https://api.anthropic.com',
};
const PASS_HEADERS = ['content-type', 'authorization', 'x-api-key', 'anthropic-version', 'anthropic-beta'];
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization, x-api-key, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access, x-zy-pass',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...CORS, 'content-type': 'application/json; charset=utf-8' } });

const VERSION = 2;
const DAY = 864e5, HOUR = 36e5, MIN = 6e4;
const KEY_TTL = 7 * DAY;        // 这么久没打开过 App，Worker 上的 Key 自动删掉；打开 App 同步一次就续上
const INBOX_KEEP = 3 * DAY, INBOX_MAX = 30;
const MAX_DEVICES = 8;
// 手机能同步上来的字段。白名单以外的一律不收，免得请求体改到 Worker 自己的状态
const CFG_FIELDS = ['persona', 'nick', 'name', 'events', 'perDay', 'remind', 'from', 'to', 'tz', 'recent', 'recentAt', 'mems'];

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const [, name, ...rest] = url.pathname.split('/');

    if (UPSTREAM[name]) {
      if (request.method !== 'POST') return new Response('Not found', { status: 404, headers: CORS });
      // 设了密码，转发就只给自己的 App 用：App 会带上 x-zy-pass，别人知道地址也蹭不了。没设密码的老 Worker 照旧放行
      if ((env.PASS || env.USERS) && !auth(request.headers.get('x-zy-pass') || '', env)) return json({ error: { message: 'Worker 密码不对：去知言设置里「TA 主动找你」填好 Worker 地址和密码' } }, 401);
      const headers = new Headers();
      for (const h of PASS_HEADERS) { const v = request.headers.get(h); if (v) headers.set(h, v); }
      const upstream = await fetch(`${UPSTREAM[name]}/${rest.join('/')}`, { method: 'POST', headers, body: request.body });
      const out = new Headers(CORS);
      const ct = upstream.headers.get('content-type'); if (ct) out.set('content-type', ct);
      return new Response(upstream.body, { status: upstream.status, headers: out });
    }

    if (!name) return new Response('知言 Worker 在运行', { headers: { ...CORS, 'content-type': 'text/plain; charset=utf-8' } });
    if (!env.ZY) return json({ error: 'Worker 还没绑定 KV（变量名要叫 ZY）' }, 500);
    if (!env.PASS && !env.USERS) return json({ error: 'Worker 还没设置密码（密钥名要叫 PASS）' }, 500);
    const user = auth(request.headers.get('x-zy-pass') || '', env);
    if (!user) return json({ error: 'Worker 密码不对' }, 401);
    await migrate(env);

    // 设备号放在查询参数里而不是请求头：老版本 Worker 的跨域设置不认新请求头，放参数里新 App 配老 Worker 也不会连不上。
    // 老版本 App 不带设备号，都算作 legacy 这一台
    const d = url.searchParams.get('d') || '';
    const devId = /^[\w-]{8,64}$/.test(d) ? d : 'legacy';
    const K = keys(user);

    if (name === 'vapid') return json({ key: (await vapidKeys(env)).pub });

    if (name === 'sync' && request.method === 'POST') {
      const body = await readJSON(request);
      if (!body) return json({ error: '同步的内容格式不对' }, 400);
      const cfg = await env.ZY.get(K.cfg, 'json') || {};
      for (const f of CFG_FIELDS) if (f in body) cfg[f] = body[f];
      await env.ZY.put(K.cfg, JSON.stringify(cfg));

      const dev = await env.ZY.get(K.dev(devId), 'json') || { since: Date.now(), acked: [], subs: [] };
      dev.seen = Date.now();
      if (+body.lastActive) dev.lastActive = Math.min(Date.now(), Math.max(dev.lastActive || 0, +body.lastActive));
      const sub = body.sub;
      if (sub?.endpoint && /^https:\/\//.test(sub.endpoint)) {
        dev.subs = [...(dev.subs || []).filter(s => s.endpoint !== sub.endpoint), { endpoint: sub.endpoint }].slice(-3);
        await dropEndpointElsewhere(env, user, devId, sub.endpoint);
      }
      await env.ZY.put(K.dev(devId), JSON.stringify(dev));

      // Key：带了就加密存下；没带就只续期。手机发来的指纹和存的对不上，就让手机重新上传
      let cred = await loadCred(env, user);
      if (body.ai?.key && UPSTREAM[body.ai.provider]) {
        cred = { provider: body.ai.provider, model: String(body.ai.model || '').slice(0, 100), fp: String(body.ai.fp || '').slice(0, 64), box: await seal(env, user, String(body.ai.key)) };
      }
      if (cred) { cred.exp = Date.now() + KEY_TTL; await env.ZY.put(K.cred, JSON.stringify(cred)); }
      const needKey = !cred || (!!body.fp && body.fp !== cred.fp);
      const devices = (await listDevices(env, user)).filter(x => x.subs?.length).length;
      return json({ ok: true, v: VERSION, devices, needKey, keyExp: cred?.exp || 0 });
    }

    if (name === 'inbox') {
      const dev = await env.ZY.get(K.dev(devId), 'json') || { since: 0, acked: [] };
      const inbox = await env.ZY.get(K.inbox, 'json') || [];
      return json({ items: inbox.filter(i => i.at >= (dev.since || 0) - 10 * MIN && !(dev.acked || []).includes(i.id)) });
    }

    // 只记在这台设备自己名下，别的设备照样能取到这条
    if (name === 'ack' && request.method === 'POST') {
      const ids = (await readJSON(request))?.ids;
      const inbox = await env.ZY.get(K.inbox, 'json') || [];
      const live = new Set(inbox.map(i => i.id));
      const dev = await env.ZY.get(K.dev(devId), 'json') || { since: Date.now(), acked: [], subs: [] };
      dev.acked = [...new Set([...(dev.acked || []), ...(Array.isArray(ids) ? ids : []).filter(x => typeof x === 'string')])].filter(x => live.has(x));
      await env.ZY.put(K.dev(devId), JSON.stringify(dev));
      return json({ ok: true });
    }

    // 从 Worker 上删掉 Key。之后主动消息停发，日程提醒改用固定句子照常发
    if (name === 'revoke' && request.method === 'POST') {
      await env.ZY.delete(K.cred);
      return json({ ok: true });
    }

    if (name === 'test' && request.method === 'POST') {
      const cred = await loadCred(env, user);
      if (!cred) return json({ error: '还没同步到 API Key，先在知言里点"开启通知"' }, 400);
      const cfg = await env.ZY.get(K.cfg, 'json') || {};
      const run = await env.ZY.get(K.run, 'json') || {};
      try {
        return json(await deliver(env, user, { cfg, run, cred, test: true }, 'miss'));
      } catch (e) {
        return json({ error: '生成消息失败：' + e.message }, 502);
      }
    }

    return json({ error: 'Not found' }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await migrate(env);
      // 一个用户出错不影响其他人
      await Promise.allSettled(userList(env).map(u => tick(env, u).catch(e => console.log('tick', u, e.message))));
    })());
  },
};

// ---------- 用户与存储 ----------
function parseUsers(env) {
  return String(env.USERS || '').split(/[,\n，]/).map(s => s.trim()).filter(Boolean).map(s => {
    const i = s.indexOf(':');
    return i > 0 ? [s.slice(0, i).trim(), s.slice(i + 1).trim()] : ['', ''];
  }).filter(([n, p]) => /^[\w一-鿿-]{1,32}$/.test(n) && n !== 'default' && p);
}
function userList(env) { return [...(env.PASS ? ['default'] : []), ...parseUsers(env).map(([n]) => n)]; }
// 恒定时间比较，不让人靠响应快慢一位一位猜密码
function same(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}
function auth(pass, env) {
  if (!pass) return null;
  let who = null;
  if (env.PASS && same(pass, env.PASS)) who = 'default';
  for (const [n, p] of parseUsers(env)) if (same(pass, p)) who ||= n;
  return who;
}
const keys = u => ({ cfg: `u:${u}:cfg`, cred: `u:${u}:cred`, run: `u:${u}:run`, inbox: `u:${u}:inbox`, dev: id => `u:${u}:dev:${id}` });
async function readJSON(request) {
  const text = await request.text();
  if (text.length > 256 * 1024) return null;
  try { const j = JSON.parse(text); return j && typeof j === 'object' ? j : null; } catch { return null; }
}
async function listDevices(env, user) {
  const prefix = keys(user).dev('');
  const { keys: ks } = await env.ZY.list({ prefix });
  const out = [];
  for (const k of ks) { const d = await env.ZY.get(k.name, 'json'); if (d) out.push({ ...d, id: k.name.slice(prefix.length) }); }
  // 设备太多就删掉最久没出现的
  if (out.length > MAX_DEVICES) {
    out.sort((a, b) => (b.seen || 0) - (a.seen || 0));
    for (const d of out.splice(MAX_DEVICES)) await env.ZY.delete(prefix + d.id);
  }
  return out;
}
// 同一个推送地址只挂在一台设备名下（比如老版本迁移来的 legacy 和升级后的新设备号其实是同一部手机），免得一条消息推两遍
async function dropEndpointElsewhere(env, user, devId, endpoint) {
  for (const d of await listDevices(env, user)) {
    if (d.id === devId || !d.subs?.some(s => s.endpoint === endpoint)) continue;
    const { id, ...rec } = d;
    rec.subs = rec.subs.filter(s => s.endpoint !== endpoint);
    await env.ZY.put(keys(user).dev(id), JSON.stringify(rec));
  }
}

// 老版本只有一个 state 键：拆到 default 用户下，Key 加密后再存，最后删掉 state
let migrated = false;
async function migrate(env) {
  if (migrated) return;
  const old = env.PASS ? await env.ZY.get('state', 'json') : null;
  if (old) {
    const K = keys('default');
    if (!(await env.ZY.get(K.cfg))) {
      const cfg = {};
      for (const f of CFG_FIELDS) if (f in old) cfg[f] = old[f];
      await env.ZY.put(K.cfg, JSON.stringify(cfg));
      await env.ZY.put(K.run, JSON.stringify({ plan: old.plan, reminded: old.reminded || [] }));
      await env.ZY.put(K.inbox, JSON.stringify(old.inbox || []));
      await env.ZY.put(K.dev('legacy'), JSON.stringify({ since: 0, acked: [], subs: (old.subs || []).map(s => ({ endpoint: s.endpoint })), lastActive: old.lastActive || 0, seen: Date.now() }));
      if (old.ai?.key && UPSTREAM[old.ai.provider]) {
        await env.ZY.put(K.cred, JSON.stringify({ provider: old.ai.provider, model: old.ai.model || '', fp: '', box: await seal(env, 'default', old.ai.key), exp: Date.now() + KEY_TTL }));
      }
    }
    await env.ZY.delete('state');
  }
  migrated = true;
}

// ---------- Key 加密 ----------
// AES-GCM，密钥由 Worker 的机密（SEAL 或 PASS）按用户派生，KV 里只有密文。
// 光拿到 KV 的内容（比如在 Cloudflare 后台点开看）解不出 Key；用户名作附加数据，密文挪到别人名下也解不开。
const enc = s => new TextEncoder().encode(s);
const toB64 = u8 => btoa(String.fromCharCode(...u8));
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function sealKey(env, user) {
  const base = await crypto.subtle.importKey('raw', enc(env.SEAL || env.PASS || env.USERS || ''), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc('zhiyan-seal-v1'), info: enc(user) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function seal(env, user, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc(user) }, await sealKey(env, user), enc(text));
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}
async function unseal(env, user, box) {
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv), additionalData: enc(user) }, await sealKey(env, user), fromB64(box.ct));
    return new TextDecoder().decode(pt);
  } catch { return ''; }
}
// 过期了就当没有，顺手删掉
async function loadCred(env, user) {
  const K = keys(user);
  const c = await env.ZY.get(K.cred, 'json');
  if (!c) return null;
  if (!c.box || (c.exp || 0) < Date.now()) { await env.ZY.delete(K.cred); return null; }
  return c;
}
// 解密只在真要调模型的这一刻做，明文不落 KV
async function credKey(env, user, cred) {
  const key = cred && await unseal(env, user, cred.box);
  return key ? { provider: cred.provider, model: cred.model, key } : null;
}

// ---------- 时间（按手机时区） ----------
const pad = n => String(n).padStart(2, '0');
function localNow(cfg, offsetDays = 0) {
  const d = new Date(Date.now() + (cfg.tz ?? 480) * MIN + offsetDays * DAY);
  return { date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, min: d.getUTCHours() * 60 + d.getUTCMinutes(), hm: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` };
}
const toMin = s => { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };

// 每天在时间段里随机挑几个时刻，分段挑，避免挤在一起
function makeSlots(n, from, to) {
  if (to <= from) to = from + 60;
  const seg = (to - from) / n, out = [];
  for (let i = 0; i < n; i++) out.push(Math.round(from + seg * i + Math.random() * seg));
  return out;
}

// ---------- 定时任务（每 10 分钟，每个用户各跑一遍） ----------
// 两条主动消息之间至少隔多久：按"时间段长度 ÷ 每天几次"的一半算，夹在 40 分钟到 3 小时之间。
// 一天 2 次大约隔 3 小时，一天 12 次（09:00–22:30）大约隔 40 分钟
const minGap = (from, to, perDay) => Math.max(40 * MIN, Math.min(3 * HOUR, ((to - from) / Math.max(1, perDay)) * MIN / 2));
const QUIET_AFTER_CHAT = 90 * MIN; // 刚聊完这么久之内不打扰
const SLOT_GRACE = 60;             // 预定时刻过了这么多分钟还没发出去，这一次就算了

async function tick(env, user) {
  const K = keys(user);
  const cfg = await env.ZY.get(K.cfg, 'json');
  if (!cfg) return;
  const run = await env.ZY.get(K.run, 'json') || {};
  const before = JSON.stringify(run);
  const L = localNow(cfg);
  const cred = await loadCred(env, user);
  const from = toMin(cfg.from || '09:00'), to = toMin(cfg.to || '22:30');
  const perDay = Math.max(0, Math.min(12, +cfg.perDay || 0));

  if (run.plan?.date !== L.date) {
    run.plan = { date: L.date, slots: makeSlots(perDay, from, to), done: [] };
    run.sent = 0;
    run.reminded = (run.reminded || []).filter(k => k.startsWith(L.date));
  }
  const ctx = { cfg, run, cred };

  // 日程提醒：有时间的提前 30 分钟，全天的早上 9 点。Worker 上没有 Key 也照发，用固定句子
  if (cfg.remind !== false) {
    for (const e of cfg.events || []) {
      if (e.on !== L.date) continue;
      const key = `${e.on}|${e.time}|${e.title}`;
      if ((run.reminded || []).includes(key)) continue;
      const at = e.time ? toMin(e.time) - 30 : 9 * 60;
      const until = e.time ? toMin(e.time) : 23 * 60;
      if (L.min < at || L.min > until) continue;
      run.reminded = [...(run.reminded || []), key];
      await deliver(env, user, ctx, 'remind', e).catch(() => {});
    }
  }

  // 随机主动找你
  const p = run.plan;
  const due = p.slots.findIndex((s, i) => !p.done.includes(i) && L.min >= s);
  if (due >= 0) {
    const devices = await listDevices(env, user);
    const lastActive = Math.max(0, ...devices.map(x => x.lastActive || 0));
    const inbox = await env.ZY.get(K.inbox, 'json') || [];
    // 还没有任何一台设备看过的主动消息攒多了，就别再叠：一天几次以内按 1 条算，次数多的放宽到每 3 次允许 1 条没看
    const unseen = inbox.filter(i => i.kind === 'miss' && Date.now() - i.at < 12 * HOUR && !devices.some(x => x.acked?.includes(i.id))).length;
    const unread = unseen >= Math.max(1, Math.floor(perDay / 3));
    const skip = !cred || L.min - p.slots[due] > SLOT_GRACE || (run.sent || 0) >= perDay || L.min < from || L.min > to || unread;
    // 刚聊完 / 离上一条太近：先不作废，下一轮再看，过了宽限时间自然作废
    const wait = Date.now() - lastActive < QUIET_AFTER_CHAT || Date.now() - (run.lastMiss || 0) < minGap(from, to, perDay);
    if (skip) p.done.push(due);
    else if (!wait) {
      p.done.push(due);
      await deliver(env, user, ctx, 'miss').catch(e => console.log('miss', user, e.message));
    }
  }

  // 收件箱只留最近 3 天、最多 30 条
  const inbox = await env.ZY.get(K.inbox, 'json');
  if (inbox) {
    const kept = inbox.filter(i => Date.now() - i.at < INBOX_KEEP).slice(-INBOX_MAX);
    if (kept.length !== inbox.length) await env.ZY.put(K.inbox, JSON.stringify(kept));
  }
  if (JSON.stringify(run) !== before) await env.ZY.put(K.run, JSON.stringify(run));
}

// ---------- 主动消息的由头 ----------
// 带压力、让人内疚的说法：生成出来就重写一次，还是这样就不发
const PRESSURE = /在吗|在不在|怎么不理|不理我|为什么不回|怎么不回|不回我|理理我|人呢|去哪[了儿]|忘了我|不要我了|是不是生气|等你好久|一直在等你/;
// 从未来两天的日程、最近聊天、最近记忆里挑一个由头；都没有就聊日常
function pickTopic(cfg, run, L) {
  const nick = cfg.nick || '你';
  const out = [];
  const d1 = localNow(cfg, 1).date, d2 = localNow(cfg, 2).date;
  const soon = (cfg.events || []).filter(e => e.on > L.date && e.on <= d2);
  if (soon.length) {
    const e = soon[0];
    out.push({ kind: 'event', w: 3, say: `${nick}${e.on === d1 ? '明天' : '后天'}${e.time ? ' ' + e.time : ''}有「${e.title}」。可以顺口关心一下，别像闹钟一样提醒。` });
  }
  const lastU = [...(cfg.recent || [])].reverse().find(m => m.r === 'u');
  if (lastU && Date.now() - (cfg.recentAt || 0) < 2 * DAY) {
    out.push({ kind: 'chat', w: 2, say: `接着你们最近聊的话题说一句后续（${nick}最后说的是：「${String(lastU.t).slice(0, 60)}」）。` });
  }
  const mems = (cfg.mems || []).filter(Boolean);
  if (mems.length) {
    const m = mems[Math.floor(Math.random() * Math.min(5, mems.length))];
    out.push({ kind: 'mem', w: 1, say: `你记得：「${String(m).slice(0, 80)}」。由这件事自然地想到${nick}，说一句。` });
  }
  out.push({ kind: 'daily', w: 1, say: `分享你此刻的小事或心情，或者看时间关心一下${nick}（吃饭没、累不累、早点休息）。` });
  // 和上一次同一类的，权重减半，免得连着两次都在说同一件事
  const pool = out.map(t => ({ ...t, w: t.kind === run.lastTopic && out.length > 1 ? t.w / 2 : t.w }));
  let r = Math.random() * pool.reduce((a, t) => a + t.w, 0);
  return pool.find(t => (r -= t.w) < 0) || pool[pool.length - 1];
}

// ---------- 生成消息并推送 ----------
async function deliver(env, user, ctx, kind, ev) {
  const { cfg, run } = ctx;
  const K = keys(user);
  const L = localNow(cfg);
  const nick = cfg.nick || '你';
  const ai = await credKey(env, user, ctx.cred);
  let text = '', topic = null;
  if (kind === 'remind') {
    try {
      if (!ai) throw new Error('no key');
      text = await generate(cfg, ai, L, `提醒${nick}：${ev.time ? `今天 ${ev.time}` : '今天'}要「${ev.title}」。用你的语气自然地提醒一句，别超过 50 个字。只输出消息本身。`);
      if (PRESSURE.test(text)) throw new Error('pressure');
    } catch {
      text = `${ev.time ? ev.time + ' ' : '今天'}要${ev.title}，别忘啦～`;
    }
  } else {
    if (!ai) throw new Error('Worker 上没有可用的 Key');
    topic = pickTopic(cfg, run, L);
    const said = (run.lastTexts || []).slice(-4);
    const ask = strict => `现在是 ${L.hm}，${nick}不在线。你想主动给对方发一条消息。这次的由头：${topic.say}
像真人发微信，一两句，别超过 60 个字。${said.length ? `你最近主动发过：${said.map(s => `「${s}」`).join('')}，别重复这些意思。` : ''}
不要问"在吗"，不要抱怨对方不理你、不回消息，不要让对方有负担或内疚。${strict ? '上一版语气有压力，这次要轻松、不求回应。' : ''}只输出消息本身。`;
    text = await generate(cfg, ai, L, ask(false));
    if (PRESSURE.test(text)) text = await generate(cfg, ai, L, ask(true));
    if (PRESSURE.test(text)) throw new Error('生成的话带压力，这次不发');
  }

  const item = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text, kind, at: Date.now() };
  // 写之前重新读一次，尽量不覆盖同一时间写进去的消息
  const inbox = await env.ZY.get(K.inbox, 'json') || [];
  await env.ZY.put(K.inbox, JSON.stringify([...inbox, item].slice(-INBOX_MAX)));
  // 设置里点"让 TA 现在发一条"是测试，不占每天的次数（run 由 tick 最后统一保存）
  if (kind === 'miss' && !ctx.test) {
    run.sent = (run.sent || 0) + 1;
    run.lastMiss = Date.now();
    run.lastTopic = topic?.kind;
    run.lastTexts = [...(run.lastTexts || []), text.slice(0, 60)].slice(-6);
  }
  const results = await pushAll(env, user);
  const pushed = results.some(r => r >= 200 && r < 300);
  return { text, pushed, note: results.length ? (pushed ? '' : `推送失败（${results.join(', ')}）`) : '还没开启通知' };
}

async function generate(cfg, ai, L, instruction) {
  const { provider, model, key } = ai;
  const nick = cfg.nick || '你';
  const history = (cfg.recent || []).map(m => `${m.r === 'u' ? nick : '你'}：${m.t}`).join('\n');
  const system = [cfg.persona || '', `现在是 ${L.date} ${L.hm}。`, history ? `你们最近的聊天：\n${history}` : '', instruction].filter(Boolean).join('\n\n');
  const user = '（直接写出你要发的这条消息）';
  const signal = AbortSignal.timeout(30000);
  let text = '';
  if (provider === 'claude') {
    const r = await fetch(UPSTREAM.claude + '/v1/messages', {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 1024, system, messages: [{ role: 'user', content: user }] }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || String(r.status));
    text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  } else {
    const r = await fetch(UPSTREAM[provider] + '/chat/completions', {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || String(r.status));
    text = j.choices?.[0]?.message?.content || '';
  }
  text = text.replace(/\[\[[^\]]*\]\]/g, '').replace(/^["“「]+|["”」]+$/g, '').trim().slice(0, 300);
  if (!text) throw new Error('模型没有回话');
  return text;
}

// ---------- Web Push（VAPID，空推送，手机收到后自己来取消息） ----------
const b64u = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function vapidKeys(env) {
  let v = await env.ZY.get('vapid', 'json');
  if (!v) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    v = { jwk: await crypto.subtle.exportKey('jwk', kp.privateKey), pub: b64u(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))) };
    await env.ZY.put('vapid', JSON.stringify(v));
  }
  return v;
}

async function vapidAuth(env, endpoint) {
  const v = await vapidKeys(env);
  const key = await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const e = o => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = e({ typ: 'JWT', alg: 'ES256' }) + '.' + e({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:zhiyan@example.com' });
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned)));
  return `vapid t=${unsigned}.${b64u(sig)}, k=${v.pub}`;
}

// 推给这个用户的每一台设备；失效的订阅（404/410）从那台设备名下删掉
async function pushAll(env, user) {
  const results = [];
  const sent = new Set();
  for (const d of await listDevices(env, user)) {
    const keep = [];
    for (const sub of d.subs || []) {
      keep.push(sub);
      if (sent.has(sub.endpoint)) continue;
      sent.add(sub.endpoint);
      let status = 0;
      try {
        const r = await fetch(sub.endpoint, { method: 'POST', headers: { Authorization: await vapidAuth(env, sub.endpoint), TTL: '86400', Urgency: 'high' } });
        status = r.status;
      } catch { status = -1; }
      results.push(status);
      if (status === 404 || status === 410) keep.pop();
    }
    if (keep.length !== (d.subs || []).length) {
      const { id, ...rec } = d;
      await env.ZY.put(keys(user).dev(id), JSON.stringify({ ...rec, subs: keep }));
    }
  }
  return results;
}
