// 知言 · Cloudflare Worker
// 一个文件两个用处：
//   1. 转发接口：某家供应商在网页里"连不上"时，把设置里的接口地址填成 https://你的worker地址/deepseek（或 /openai、/glm、/claude）
//   2. TA 主动找你：定时生成消息、推送通知、到点提醒日程
// 第 2 个功能需要：KV 绑定（变量名 ZY）、密钥 PASS、Cron 触发器 */10 * * * *。步骤见使用说明。

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

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const [, name, ...rest] = url.pathname.split('/');

    if (UPSTREAM[name]) {
      if (request.method !== 'POST') return new Response('Not found', { status: 404, headers: CORS });
      const headers = new Headers();
      for (const h of PASS_HEADERS) { const v = request.headers.get(h); if (v) headers.set(h, v); }
      const upstream = await fetch(`${UPSTREAM[name]}/${rest.join('/')}`, { method: 'POST', headers, body: request.body });
      const out = new Headers(CORS);
      const ct = upstream.headers.get('content-type'); if (ct) out.set('content-type', ct);
      return new Response(upstream.body, { status: upstream.status, headers: out });
    }

    if (!name) return new Response('知言 Worker 在运行', { headers: { ...CORS, 'content-type': 'text/plain; charset=utf-8' } });
    if (!env.ZY) return json({ error: 'Worker 还没绑定 KV（变量名要叫 ZY）' }, 500);
    if (!env.PASS) return json({ error: 'Worker 还没设置密码（密钥名要叫 PASS）' }, 500);
    if (request.headers.get('x-zy-pass') !== env.PASS) return json({ error: 'Worker 密码不对' }, 401);

    if (name === 'vapid') return json({ key: (await vapidKeys(env)).pub });

    if (name === 'sync' && request.method === 'POST') {
      const body = await request.json();
      const st = await load(env);
      const { sub, ...rest } = body;
      Object.assign(st, rest);
      if (sub?.endpoint) st.subs = [...(st.subs || []).filter(s => s.endpoint !== sub.endpoint), sub].slice(-5);
      await save(env, st);
      return json({ ok: true, devices: (st.subs || []).length });
    }

    if (name === 'inbox') return json({ items: (await load(env)).inbox || [] });

    if (name === 'ack' && request.method === 'POST') {
      const { ids = [] } = await request.json();
      const st = await load(env);
      st.inbox = (st.inbox || []).filter(i => !ids.includes(i.id));
      await save(env, st);
      return json({ ok: true });
    }

    if (name === 'test' && request.method === 'POST') {
      const st = await load(env);
      if (!st.ai?.key) return json({ error: '还没同步到 API Key，先在知言里点"开启通知"' }, 400);
      try {
        const r = await deliver(env, st, 'miss');
        await save(env, st);
        return json(r);
      } catch (e) {
        return json({ error: '生成消息失败：' + e.message }, 502);
      }
    }

    return json({ error: 'Not found' }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env));
  },
};

// ---------- 存储 ----------
async function load(env) { return (await env.ZY.get('state', 'json')) || {}; }
async function save(env, st) { await env.ZY.put('state', JSON.stringify(st)); }

// ---------- 时间（按手机时区） ----------
const pad = n => String(n).padStart(2, '0');
function localNow(st) {
  const d = new Date(Date.now() + (st.tz ?? 480) * 6e4);
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

// ---------- 定时任务（每 10 分钟） ----------
async function tick(env) {
  const st = await load(env);
  if (!st.ai?.key) return;
  const L = localNow(st);
  const before = JSON.stringify(st);

  if (st.plan?.date !== L.date) {
    st.plan = { date: L.date, slots: makeSlots(Math.max(0, Math.min(6, +st.perDay || 0)), toMin(st.from || '09:00'), toMin(st.to || '22:30')), done: [] };
    st.reminded = (st.reminded || []).filter(k => k.startsWith(L.date));
  }

  // 日程提醒：有时间的提前 30 分钟，全天的早上 9 点
  if (st.remind !== false) {
    for (const e of st.events || []) {
      if (e.on !== L.date) continue;
      const key = `${e.on}|${e.time}|${e.title}`;
      if ((st.reminded || []).includes(key)) continue;
      const at = e.time ? toMin(e.time) - 30 : 9 * 60;
      const until = e.time ? toMin(e.time) : 23 * 60;
      if (L.min < at || L.min > until) continue;
      st.reminded = [...(st.reminded || []), key];
      await deliver(env, st, 'remind', e).catch(() => {});
    }
  }

  // 随机主动找你：刚聊过（40 分钟内）就跳过这一次，错过超过 1 小时的也不补
  const p = st.plan;
  for (let i = 0; i < p.slots.length; i++) {
    if (p.done.includes(i) || L.min < p.slots[i]) continue;
    p.done.push(i);
    if (Date.now() - (st.lastActive || 0) < 40 * 6e4) continue;
    if (L.min - p.slots[i] > 60) continue;
    await deliver(env, st, 'miss').catch(() => {});
    break;
  }

  if (JSON.stringify(st) !== before) await save(env, st);
}

// ---------- 生成消息并推送 ----------
async function deliver(env, st, kind, ev) {
  const L = localNow(st);
  const nick = st.nick || '你';
  let text;
  try {
    text = await generate(st, L, kind === 'remind'
      ? `提醒${nick}：${ev.time ? `今天 ${ev.time}` : '今天'}要「${ev.title}」。用你的语气自然地提醒一句，别超过 50 个字。只输出消息本身。`
      : `现在是 ${L.hm}，${nick}不在线。你想主动给对方发一条消息：可以是突然想到对方、分享你此刻的小事或心情、关心对方在做什么（吃饭没、累不累、睡了没，看时间来），或者接着之前聊的话题。像真人发微信，一两句，别超过 60 个字。不要问"在吗"，不要抱怨对方不理你。只输出消息本身。`);
  } catch (e) {
    if (kind !== 'remind') throw e;
    text = `${ev.time ? ev.time + ' ' : '今天'}要${ev.title}，别忘啦～`;
  }
  const item = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text, kind, at: Date.now() };
  st.inbox = [...(st.inbox || []), item].slice(-20);
  const results = await pushAll(env, st);
  const pushed = results.some(r => r >= 200 && r < 300);
  return { text, pushed, note: st.subs?.length ? (pushed ? '' : `推送失败（${results.join(', ')}）`) : '还没开启通知' };
}

async function generate(st, L, instruction) {
  const { provider, model, key } = st.ai;
  const nick = st.nick || '你';
  const history = (st.recent || []).map(m => `${m.r === 'u' ? nick : '你'}：${m.t}`).join('\n');
  const system = [st.persona || '', `现在是 ${L.date} ${L.hm}。`, history ? `你们最近的聊天：\n${history}` : '', instruction].filter(Boolean).join('\n\n');
  const user = '（直接写出你要发的这条消息）';
  let text = '';
  if (provider === 'claude') {
    const r = await fetch(UPSTREAM.claude + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 1024, system, messages: [{ role: 'user', content: user }] }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || String(r.status));
    text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  } else {
    const r = await fetch(UPSTREAM[provider] + '/chat/completions', {
      method: 'POST',
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
  const enc = o => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ typ: 'JWT', alg: 'ES256' }) + '.' + enc({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:zhiyan@example.com' });
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned)));
  return `vapid t=${unsigned}.${b64u(sig)}, k=${v.pub}`;
}

async function pushAll(env, st) {
  const results = [];
  const keep = [];
  for (const sub of st.subs || []) {
    let status = 0;
    try {
      const r = await fetch(sub.endpoint, { method: 'POST', headers: { Authorization: await vapidAuth(env, sub.endpoint), TTL: '86400', Urgency: 'high' } });
      status = r.status;
    } catch { status = -1; }
    results.push(status);
    if (status !== 404 && status !== 410) keep.push(sub);
  }
  st.subs = keep;
  return results;
}
