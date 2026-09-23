// 渲染层抽象。
//
// 第一阶段只做 2D：动态背景 + 轻量粒子 + 简单动画状态机。
// 但架构把口子留好了 —— Live2D / 3D / Unity / Godot 以后注册进来就行，
// 上层（scene.js、avatar.js）一行都不用改。
//
// 画之前先由 buildDrawList() 算出一份纯数据的绘制清单，
// 真正的 canvas 操作只在 createCanvas2DRenderer 里。
// 好处：绘制逻辑能在 Node 里直接测，不需要浏览器。

// ---------------------------------------------------------------- 注册表
export function createRendererRegistry() {
  const factories = new Map();
  return {
    register(name, factory) { factories.set(name, factory); return this; },
    has: name => factories.has(name),
    list: () => [...factories.keys()],
    create(name, opts) {
      const f = factories.get(name);
      if (!f) throw new Error(`没有注册过渲染器：${name}（已注册：${[...factories.keys()].join('、') || '无'}）`);
      return f(opts);
    },
  };
}

/** 预留但还没实现的渲染器：调用时给一句人话，而不是 undefined。 */
function reserved(name, note) {
  return () => { throw new Error(`${name} 渲染器是架构预留，第一阶段没有实现。${note}`); };
}

export const RESERVED_RENDERERS = {
  live2d: reserved('Live2D', '接进来需要 Cubism SDK 和 .model3.json 资产。'),
  three: reserved('3D（three.js）', '接进来需要模型文件和骨骼动画映射。'),
  unity: reserved('Unity / Godot', '要以 WebGL 导出后嵌一层消息桥。'),
};

// ---------------------------------------------------------------- 绘制清单
/** 桌面前沿的高度。角色站在桌子后面，道具摆在桌面上，都以这条线为准。 */
export const DESK_Y = 0.78;

/**
 * 道具布局。y 不写死 —— 只给 x / 宽 / 高，
 * 由 buildDrawList 把它们「放在桌面上」（底边贴着 DESK_Y），
 * 这样换屏幕比例也不会出现东西浮在半空。
 */
const PROP_LAYOUT = {
  laptop:       { x: 0.30, w: 0.19, h: 0.030, z: 9,  onDesk: true },
  terminal:     { x: 0.30, w: 0.17, h: 0.105, z: 8,  onDesk: true },  // 竖起来的屏
  manuscript:   { x: 0.29, w: 0.20, h: 0.018, z: 9,  onDesk: true },
  books:        { x: 0.74, w: 0.13, h: 0.075, z: 9,  onDesk: true },
  open_book:    { x: 0.50, w: 0.17, h: 0.022, z: 10, onDesk: true },
  notebook:     { x: 0.30, w: 0.16, h: 0.020, z: 9,  onDesk: true },
  pen:          { x: 0.45, w: 0.07, h: 0.007, z: 11, onDesk: true },
  mug:          { x: 0.63, w: 0.045, h: 0.042, z: 10, onDesk: true },
  lamp:         { x: 0.87, w: 0.11, h: 0.150, z: 8,  onDesk: true },
  sticky_note:  { x: 0.17, w: 0.075, h: 0.060, z: 11, onDesk: true },
  diary:        { x: 0.11, w: 0.12, h: 0.018, z: 9,  onDesk: true },
  dust:         { x: 0.50, w: 0.92, h: 0.010, z: 12, onDesk: true },
  window_rain:  { x: 0.79, y: 0.33, w: 0.34, h: 0.50, z: -4 },
};

/**
 * 把场景 + 姿势算成绘制清单（纯函数，可测）。
 * 坐标全是 0–1 的相对值，渲染时再乘画布尺寸 —— 换分辨率不用改。
 *
 * z 的分层很重要：角色(6) 在桌子(7) 后面，桌子挡住角色下半身，
 * 道具(8+) 再摆到桌面上。这样才像一个房间，而不是几个方块浮在那儿。
 */
export function buildDrawList(scene, pose, { width = 1, height = 1 } = {}) {
  const list = [];
  const p = scene.palette;

  list.push({ type: 'background', gradient: [p.bg, p.far], z: -10 });
  list.push({ type: 'room', near: p.near, far: p.far, light: scene.light.level, warmth: scene.light.warmth, z: -5 });

  if (scene.period === 'night' || scene.weather === 'rain') {
    list.push({ type: 'glow', color: p.glow, x: 0.87, y: DESK_Y - 0.15, radius: 0.30, alpha: 0.55 * (1 - scene.light.level), z: 7.5 });
  }

  // 角色：呼吸只影响纵向缩放，幅度很小，看着才自然
  const breathScale = 1 + pose.breath * 0.012;
  list.push({
    type: 'avatar',
    state: pose.state,
    expression: pose.expression,
    x: 0.5, y: 0.52, scale: breathScale, z: 6,
    deskY: DESK_Y,
    blink: pose.blink,
    gaze: pose.gaze,
    alpha: 0.35 + 0.65 * pose.enter,
  });

  list.push({ type: 'desk', color: p.near, y: DESK_Y, z: 7 });

  for (const name of scene.props) {
    const l = PROP_LAYOUT[name];
    if (!l) continue;
    const note = scene.leftovers.find(x => x.kind === name && x.text);
    const y = l.onDesk ? DESK_Y - l.h / 2 : l.y;
    list.push({ type: 'prop', name, ...l, y, text: note?.text || null });
  }

  list.push({ type: 'particles', kind: particleKind(scene), count: particleCount(scene), z: 20 });

  return list.sort((a, b) => (a.z ?? 0) - (b.z ?? 0)).map(item => scaleItem(item, width, height));
}

function scaleItem(item, w, h) {
  if (w === 1 && h === 1) return item;
  const out = { ...item };
  if (out.x != null) out.x *= w;
  if (out.y != null) out.y *= h;
  if (out.w != null) out.w *= w;
  if (out.h != null) out.h *= h;
  if (out.deskY != null) out.deskY *= h;
  if (out.radius != null) out.radius *= Math.min(w, h);
  return out;
}

export function particleKind(scene) {
  if (scene.weather === 'rain') return 'rain';
  if (scene.period === 'night') return 'firefly';
  if (scene.absence === 'long') return 'dust';
  return 'motes';
}

export function particleCount(scene) {
  const base = { rain: 90, firefly: 14, dust: 26, motes: 18 }[particleKind(scene)];
  return Math.round(base * (scene.light.level > 0.8 ? 0.7 : 1));
}

// ---------------------------------------------------------------- 2D 实现
export function createCanvas2DRenderer({ canvas, dpr = (globalThis.devicePixelRatio || 1) } = {}) {
  if (!canvas) throw new Error('createCanvas2DRenderer 需要一个 canvas');
  const ctx = canvas.getContext('2d');
  let particles = [];
  let lastKind = null;

  function resize() {
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
  }

  function seedParticles(kind, count, w, h) {
    particles = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      v: 0.2 + Math.random() * 0.8,
      r: kind === 'rain' ? 1 : 0.6 + Math.random() * 1.6,
      a: 0.2 + Math.random() * 0.5,
    }));
    lastKind = kind;
  }

  function drawParticles(kind, count, w, h, t) {
    if (kind !== lastKind || particles.length !== count) seedParticles(kind, count, w, h);
    ctx.save();
    for (const p of particles) {
      if (kind === 'rain') {
        p.y += p.v * 14; p.x += p.v * 2;
        if (p.y > h) { p.y = -10; p.x = Math.random() * w; }
        ctx.strokeStyle = `rgba(200,215,230,${p.a * 0.5})`;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - 2, p.y - 12); ctx.stroke();
      } else {
        p.y -= p.v * 0.25;
        p.x += Math.sin((t / 1600) + p.y / 90) * 0.3;
        if (p.y < -8) { p.y = h + 8; p.x = Math.random() * w; }
        const glow = kind === 'firefly' ? `rgba(240,201,135,${p.a * (0.5 + 0.5 * Math.sin(t / 700 + p.x))})`
          : `rgba(255,255,255,${p.a * 0.35})`;
        ctx.fillStyle = glow;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawAvatar(it, w, h) {
    const unit = Math.min(w, h) * 0.19;
    const deskY = it.deskY ?? h * 0.78;
    ctx.save();
    ctx.globalAlpha = it.alpha;
    ctx.translate(it.x, it.y);
    ctx.scale(1, it.scale);

    // 身体：肩膀往下基本竖直，不做成一个大帐篷。
    // 一直画到桌面以下，由桌子挡住下半身，人才像站在桌后。
    const bodyBottom = (deskY - it.y) / it.scale + unit * 0.9;
    ctx.fillStyle = 'rgba(64,72,88,0.95)';
    ctx.beginPath();
    ctx.moveTo(-unit * 0.60, bodyBottom);
    ctx.lineTo(-unit * 0.56, unit * 0.34);
    ctx.quadraticCurveTo(-unit * 0.50, unit * 0.02, -unit * 0.24, -unit * 0.04);
    ctx.lineTo(unit * 0.24, -unit * 0.04);
    ctx.quadraticCurveTo(unit * 0.50, unit * 0.02, unit * 0.56, unit * 0.34);
    ctx.lineTo(unit * 0.60, bodyBottom);
    ctx.closePath(); ctx.fill();
    // 领口，让肩线不至于太平
    ctx.fillStyle = 'rgba(82,92,110,0.95)';
    ctx.beginPath();
    ctx.moveTo(-unit * 0.17, -unit * 0.04);
    ctx.quadraticCurveTo(0, unit * 0.16, unit * 0.17, -unit * 0.04);
    ctx.closePath(); ctx.fill();

    // 脖子
    ctx.fillStyle = 'rgba(226,209,196,0.97)';
    ctx.fillRect(-unit * 0.11, -unit * 0.22, unit * 0.22, unit * 0.3);

    const hx = it.gaze.x * unit * 0.22, hy = -unit * 0.62 + it.gaze.y * unit * 0.16;

    // 头发（后层）
    ctx.fillStyle = 'rgba(48,42,44,0.95)';
    ctx.beginPath(); ctx.ellipse(hx, hy + unit * 0.06, unit * 0.58, unit * 0.62, 0, 0, Math.PI * 2); ctx.fill();

    // 脸
    ctx.fillStyle = 'rgba(243,229,217,0.98)';
    ctx.beginPath(); ctx.ellipse(hx, hy, unit * 0.48, unit * 0.52, 0, 0, Math.PI * 2); ctx.fill();

    // 刘海
    ctx.fillStyle = 'rgba(48,42,44,0.95)';
    ctx.beginPath();
    ctx.ellipse(hx, hy - unit * 0.26, unit * 0.50, unit * 0.30, 0, Math.PI, 0);
    ctx.fill();

    // 眼睛（blink 压扁）
    const eyeY = hy + unit * 0.04;
    const eyeDX = unit * 0.19;
    const open = Math.max(0.06, 1 - it.blink);
    ctx.fillStyle = 'rgba(38,36,42,0.92)';
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(hx + s * eyeDX + it.gaze.x * unit * 0.12, eyeY, unit * 0.058, unit * 0.082 * open, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // 腮红，暖一点
    ctx.fillStyle = 'rgba(214,138,138,0.16)';
    for (const s of [-1, 1]) {
      ctx.beginPath(); ctx.ellipse(hx + s * unit * 0.30, eyeY + unit * 0.13, unit * 0.10, unit * 0.055, 0, 0, Math.PI * 2); ctx.fill();
    }

    // 嘴：按表情换弧度
    const mouth = { smile: 0.13, soft: 0.07, neutral: 0.0, concerned: -0.08, surprised: 0.0, sleepy: -0.03 }[it.expression] ?? 0;
    ctx.strokeStyle = 'rgba(120,72,70,0.8)';
    ctx.lineWidth = Math.max(1, unit * 0.035);
    ctx.lineCap = 'round';
    ctx.beginPath();
    const my = hy + unit * 0.26;
    ctx.moveTo(hx - unit * 0.10, my);
    ctx.quadraticCurveTo(hx, my + mouth * unit, hx + unit * 0.10, my);
    ctx.stroke();
    if (it.expression === 'surprised') {
      ctx.beginPath(); ctx.ellipse(hx, my, unit * 0.06, unit * 0.07, 0, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }

  function drawDesk(it, w, h) {
    const y = it.y;
    const g = ctx.createLinearGradient(0, y, 0, h);
    g.addColorStop(0, shadeHex(it.color, 18));
    g.addColorStop(1, shadeHex(it.color, -14));
    ctx.fillStyle = g;
    ctx.fillRect(0, y, w, h - y);
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(0, y, w, Math.max(1, h * 0.003));   // 桌沿高光
  }

  const PROP_COLOR = {
    laptop: '#4e5866', terminal: '#1d222a', manuscript: '#efe6d6', books: '#8a6a58',
    open_book: '#f2ece0', notebook: '#d8cfc0', pen: '#3a3f47', mug: '#c98d6b',
    lamp: '#e6dccb', sticky_note: '#f3e08a', diary: '#9a7b6a',
  };

  function drawProp(it, w, h) {
    const u = Math.min(w, h);
    ctx.save();

    if (it.name === 'dust') {
      ctx.fillStyle = 'rgba(190,190,190,0.14)';
      ctx.fillRect(it.x - it.w / 2, it.y - it.h / 2, it.w, it.h);
      ctx.restore(); return;
    }

    if (it.name === 'window_rain') {
      ctx.strokeStyle = 'rgba(170,195,220,0.22)';
      ctx.lineWidth = Math.max(1, u * 0.002);
      const x0 = it.x - it.w / 2, y0 = it.y - it.h / 2;
      for (let i = 0; i < 26; i++) {
        const sx = x0 + ((i * 97) % 1000) / 1000 * it.w;
        const sy = y0 + ((i * 211) % 1000) / 1000 * it.h;
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx - u * 0.006, sy + u * 0.03); ctx.stroke();
      }
      ctx.restore(); return;
    }

    if (it.name === 'lamp') {
      const bx = it.x, by = it.y + it.h / 2;
      ctx.strokeStyle = 'rgba(90,96,108,0.9)';
      ctx.lineWidth = Math.max(1.5, u * 0.006);
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx, by - it.h * 0.62); ctx.stroke();
      ctx.fillStyle = 'rgba(90,96,108,0.9)';
      ctx.beginPath(); ctx.ellipse(bx, by, it.w * 0.30, it.h * 0.045, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = PROP_COLOR.lamp;                 // 灯罩
      ctx.beginPath();
      ctx.moveTo(bx - it.w * 0.46, by - it.h * 0.62);
      ctx.lineTo(bx + it.w * 0.46, by - it.h * 0.62);
      ctx.lineTo(bx + it.w * 0.30, by - it.h * 1.00);
      ctx.lineTo(bx - it.w * 0.30, by - it.h * 1.00);
      ctx.closePath(); ctx.fill();
      ctx.restore(); return;
    }

    if (it.name === 'terminal') {                       // 竖起来的屏幕 + 亮着的内容
      const x0 = it.x - it.w / 2, y0 = it.y - it.h / 2;
      ctx.fillStyle = PROP_COLOR.terminal;
      ctx.beginPath(); ctx.roundRect(x0, y0, it.w, it.h, u * 0.006); ctx.fill();
      ctx.fillStyle = 'rgba(126,200,160,0.55)';
      for (let i = 0; i < 5; i++) {
        ctx.fillRect(x0 + it.w * 0.10, y0 + it.h * (0.15 + i * 0.15), it.w * (0.25 + (i % 3) * 0.2), Math.max(1, it.h * 0.045));
      }
      ctx.restore(); return;
    }

    if (it.name === 'mug') {
      ctx.fillStyle = PROP_COLOR.mug;
      ctx.beginPath(); ctx.roundRect(it.x - it.w / 2, it.y - it.h / 2, it.w, it.h, it.w * 0.2); ctx.fill();
      ctx.strokeStyle = PROP_COLOR.mug; ctx.lineWidth = Math.max(1.5, u * 0.005);
      ctx.beginPath(); ctx.arc(it.x + it.w * 0.62, it.y, it.w * 0.32, -1.2, 1.2); ctx.stroke();
      ctx.restore(); return;
    }

    if (it.name === 'books') {                          // 一摞书，不是一个方块
      const n = 3, hh = it.h / n;
      for (let i = 0; i < n; i++) {
        ctx.fillStyle = ['#8a6a58', '#6f7f85', '#a08468'][i];
        const ww = it.w * (1 - i * 0.12);
        ctx.beginPath();
        ctx.roundRect(it.x - ww / 2, it.y + it.h / 2 - hh * (i + 1), ww, hh * 0.86, u * 0.004);
        ctx.fill();
      }
      ctx.restore(); return;
    }

    ctx.fillStyle = PROP_COLOR[it.name] || '#888';
    ctx.beginPath();
    ctx.roundRect(it.x - it.w / 2, it.y - it.h / 2, it.w, it.h, Math.min(it.w, it.h) * 0.16);
    ctx.fill();

    if (it.name === 'sticky_note' && it.text) {
      ctx.fillStyle = 'rgba(70,58,32,0.9)';
      const fs = Math.max(8, Math.round(u * 0.016));
      ctx.font = `${fs}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const line = it.text.slice(0, 6);
      ctx.fillText(line, it.x, it.y);
    }
    ctx.restore();
  }

  function shadeHex(hex, amt) {
    const n = parseInt(String(hex).slice(1), 16);
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => Math.min(255, Math.max(0, v + amt)));
    return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
  }

  return {
    name: 'canvas2d',
    resize,
    /** 画一帧。draws 来自 buildDrawList()，已经按画布尺寸缩放过。 */
    render(draws, t = Date.now()) {
      const w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      for (const it of draws) {
        switch (it.type) {
          case 'background': {
            const g = ctx.createLinearGradient(0, 0, 0, h);
            g.addColorStop(0, it.gradient[0]); g.addColorStop(1, it.gradient[1]);
            ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
            break;
          }
          case 'room': {
            // 窗：外面的天 + 窗框 + 十字窗棂 + 窗台
            const wx = w * 0.62, wy = h * 0.08, ww = w * 0.34, wh = h * 0.50;
            const sky = ctx.createLinearGradient(0, wy, 0, wy + wh);
            sky.addColorStop(0, it.far);
            sky.addColorStop(1, shadeRGB(it.far, 14));
            ctx.fillStyle = sky; ctx.fillRect(wx, wy, ww, wh);
            ctx.strokeStyle = shadeRGB(it.near, 22);
            ctx.lineWidth = Math.max(2, w * 0.008);
            ctx.strokeRect(wx, wy, ww, wh);
            ctx.lineWidth = Math.max(1, w * 0.004);
            ctx.beginPath();
            ctx.moveTo(wx + ww / 2, wy); ctx.lineTo(wx + ww / 2, wy + wh);
            ctx.moveTo(wx, wy + wh * 0.5); ctx.lineTo(wx + ww, wy + wh * 0.5);
            ctx.stroke();
            ctx.fillStyle = shadeRGB(it.near, 10);
            ctx.fillRect(wx - w * 0.01, wy + wh, ww + w * 0.02, h * 0.012);
            break;
          }
          case 'desk': drawDesk(it, w, h); break;
          case 'glow': {
            const g = ctx.createRadialGradient(it.x, it.y, 0, it.x, it.y, it.radius);
            g.addColorStop(0, it.color); g.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.globalAlpha = it.alpha; ctx.fillStyle = g;
            ctx.fillRect(it.x - it.radius, it.y - it.radius, it.radius * 2, it.radius * 2);
            ctx.globalAlpha = 1;
            break;
          }
          case 'prop': drawProp(it, w, h); break;
          case 'avatar': drawAvatar(it, w, h); break;
          case 'particles': drawParticles(it.kind, it.count, w, h, t); break;
        }
      }
    },
    destroy() { particles = []; },
  };

  function shadeRGB(hex, amt) { return shadeHex(hex, amt); }
}

export function defaultRegistry() {
  const r = createRendererRegistry();
  r.register('canvas2d', createCanvas2DRenderer);
  for (const [k, v] of Object.entries(RESERVED_RENDERERS)) r.register(k, v);
  return r;
}
