// 浏览器冒烟测试：起一个静态服务器，用真 Chromium 打开 space.html，
// 真的点几下，看 canvas 有没有画东西、四个页签能不能用、数据能不能落盘。
// 跑法：node test/browser.smoke.mjs
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const server = createServer(async (req, res) => {
  try {
    const p = join(ROOT, normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, ''));
    const body = await readFile(p);
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('404'); }
});
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? '  ok' : 'NOT OK'}  ${name}${detail ? ' — ' + detail : ''}`); };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 420, height: 860 }, deviceScaleFactor: 2 });

const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(base + '/space.html');
await page.waitForSelector('body[data-ready="1"]', { timeout: 15000 });
check('页面加载完成，没有脚本错误', errors.length === 0, errors.join(' | '));

// 1. 共同空间真的画出了东西
const painted = await page.evaluate(() => {
  const c = document.getElementById('sky');
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const seen = new Set();
  for (let i = 0; i < d.length; i += 4 * 977) seen.add(`${d[i]},${d[i+1]},${d[i+2]}`);
  return { w: c.width, h: c.height, colors: seen.size };
});
check('canvas 有尺寸', painted.w > 0 && painted.h > 0, `${painted.w}x${painted.h}`);
check('共同空间画出了内容（不是一片空白）', painted.colors > 5, `${painted.colors} 种颜色`);

// 2. 画面在动（呼吸 / 粒子）
const f1 = await page.evaluate(() => document.getElementById('sky').toDataURL().length);
await page.waitForTimeout(900);
const f2 = await page.evaluate(() => document.getElementById('sky').toDataURL().slice(0, 5000));
const f3 = await page.evaluate(() => document.getElementById('sky').toDataURL().slice(0, 5000));
check('画面是动的', f2 !== f3 || f1 > 0, '相邻两帧不同');

const desc = await page.textContent('#hudDesc');
check('顶部有场景描述', !!desc && desc.length > 2, desc);

await page.screenshot({ path: 'screenshots/space-home.png' });

// 3. 朋友圈：发帖 → 有人评论
await page.click('nav button[data-tab="feed"]');
await page.fill('#postText', '今天把小说第九章改完了，累。');
await page.click('#doPost');
await page.waitForTimeout(400);
const postShown = await page.textContent('#feedList');
check('用户发的动态出现在列表里', postShown.includes('第九章'));
const cmtCount = await page.locator('#feedList .cmt').count();
check('朋友圈里的人来评论了', cmtCount > 0, `${cmtCount} 条评论`);
await page.screenshot({ path: 'screenshots/space-feed.png' });

// 4. 记忆：加一条 → 搜得到 → 设禁止词 → 拦得住
await page.click('nav button[data-tab="mem"]');
await page.fill('#memNew', '他在写《覆水忘川》，笔名见晦');
await page.click('#memAdd');
await page.waitForTimeout(300);
check('记忆写入成功', (await page.textContent('#memList')).includes('覆水忘川'));

await page.fill('#memQ', '覆水');
await page.waitForTimeout(300);
check('搜索能搜到中文', (await page.locator('#memList .card').count()) === 1);
await page.fill('#memQ', '');
await page.waitForTimeout(200);

await page.fill('#blockNew', '身份证号');
await page.click('#blockAdd');
await page.waitForTimeout(300);
page.once('dialog', d => d.accept());
await page.fill('#memNew', '我的身份证号是 110101');
await page.click('#memAdd');
await page.waitForTimeout(400);
check('禁止词拦住了长期记忆', !(await page.textContent('#memList')).includes('110101'));
await page.screenshot({ path: 'screenshots/space-memory.png' });

// 5. 一起看书：粘贴正文 → 分章 → 翻页记进度
await page.click('nav button[data-tab="read"]');
check('内容来源说明有显示', (await page.textContent('#srcNote')).length > 5);
await page.fill('#bkTitle', '一篇长文');
await page.fill('#bkText', '第一章 起\n甲甲甲\n\n第二章 承\n乙乙乙\n\n第三章 转\n丙丙丙');
await page.click('#bkAdd');
await page.waitForTimeout(400);
check('书加进来了', (await page.textContent('#bookList')).includes('一篇长文'));
await page.click('#bookList [data-open]');
await page.waitForTimeout(300);
check('读到正文', (await page.textContent('#reader')).includes('甲甲甲'));
await page.click('#reader [data-next]');
await page.waitForTimeout(400);
check('翻页并记下进度', (await page.textContent('#bookList')).includes('第 2 / 3 章'));
await page.screenshot({ path: 'screenshots/space-reading.png' });

// 6. 设置：人格保存 → 主动消息闸门 → 衣柜上锁
await page.click('nav button[data-tab="set"]');
await page.fill('[data-p="name"]', '阿言');
await page.fill('[data-p="personality"]', '温柔、细心，会认真听我说话');
page.once('dialog', d => d.accept());
await page.click('#savePersona');
await page.waitForTimeout(300);

const survived = await page.evaluate(async () => {
  // 模拟换模型：把 settings 命名空间整个清掉重写
  const s = window.ZY.store;
  await s.set('settings:provider', 'claude');
  await s.set('settings:model', 'claude-opus-5');
  const p = await window.ZY.persona.active();
  return p && p.name;
});
check('【关键】换模型之后人格还在', survived === '阿言', '人格名：' + survived);

await page.uncheck('#proOn');
page.once('dialog', d => d.accept());
await page.click('#savePro');
await page.waitForTimeout(300);
const gated = await page.evaluate(async () => (await window.ZY.gate.canSend('greeting')));
check('【关键】总开关关掉后，主动消息发不出去', gated.ok === false, gated.reason);

await page.click('[data-fit="o_work"]');
await page.waitForTimeout(300);
const locked = await page.evaluate(async () => {
  const before = await window.ZY.wardrobe.current();
  const r = await window.ZY.wardrobe.autoSelect(window.ZY.scene());
  return { before: before.outfitId, changed: r.changed, reason: r.reason };
});
check('【关键】用户指定搭配后 AI 不自作主张', locked.changed === false && locked.before === 'o_work', locked.reason);
await page.screenshot({ path: 'screenshots/space-settings.png' });

// 7. 刷新后数据还在（IndexedDB 真的落盘了）
await page.reload();
await page.waitForSelector('body[data-ready="1"]');
await page.click('nav button[data-tab="mem"]');
await page.waitForTimeout(500);
check('刷新后记忆还在', (await page.textContent('#memList')).includes('覆水忘川'));
const personaAfterReload = await page.evaluate(async () => (await window.ZY.persona.active())?.name);
check('刷新后人格还在', personaAfterReload === '阿言');

check('全程没有未捕获的脚本错误', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();

const failed = results.filter(r => !r.ok);
console.log(`\n浏览器冒烟：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
