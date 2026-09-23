// 一起看书 + 外部内容源。
//
// 内容从哪来，三条路：
//   1. paste —— 复制一段正文贴进来，AI 陪你读、陪你聊（最常用）
//   2. link  —— 只存链接和备注，点开跳浏览器，不抓正文
//   3. rss   —— 通用 RSS/Atom 源，谁提供 RSS 就能订谁
// 纯前端抓别人家网站会被跨域挡下、也容易被封，所以这里不做抓取。
// 以后要接新的来源，加一个 kind 就行，上层不用动。

import { createStore, uid } from './store.js';

export const SOURCE_KINDS = ['paste', 'link', 'rss', 'file'];

export const SOURCE_NOTE =
  '把正文复制粘贴进来最省事。只想留个记号就用「只存链接」，点开跳浏览器。' +
  '提供 RSS 的站点可以直接订阅。';

// ---------------------------------------------------------------- 分章
/** 把一大段文字切成章节。认得「第 N 章」「Chapter N」，认不出来就按字数切。 */
export function splitChapters(text, { maxChars = 3000 } = {}) {
  const raw = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!raw) return [];
  const re = /^\s*(第[零一二三四五六七八九十百千0-9]+[章节回]|Chapter\s+\d+|CHAPTER\s+\d+)\s*(.*)$/gm;
  const marks = [...raw.matchAll(re)];
  const out = [];
  if (marks.length >= 2) {
    for (let i = 0; i < marks.length; i++) {
      const start = marks[i].index;
      const end = i + 1 < marks.length ? marks[i + 1].index : raw.length;
      const body = raw.slice(start, end).trim();
      out.push({ title: (marks[i][1] + ' ' + (marks[i][2] || '')).trim(), body });
    }
    return out;
  }
  const paras = raw.split(/\n{2,}/);
  let buf = '';
  for (const p of paras) {
    if (buf.length + p.length > maxChars && buf) { out.push({ title: `第 ${out.length + 1} 段`, body: buf.trim() }); buf = ''; }
    buf += p + '\n\n';
  }
  if (buf.trim()) out.push({ title: `第 ${out.length + 1} 段`, body: buf.trim() });
  return out;
}

export function createLibrary(backend, {
  clock = { now: () => Date.now() },
  composer = null,      // 注入模型来写批注；不注入就只记进度
  fetchImpl = null,     // 注入 fetch 来拉 RSS；不注入就跳过
} = {}) {
  const store = createStore(backend, 'library');
  const books = () => store.get('books', []);

  const api = {
    store,
    books,
    SOURCE_NOTE,

    /** 粘贴正文开一本「书」。文章、小说、论文都走这条。 */
    async addFromText({ title, text, author = '', origin = '' }) {
      const chapters = splitChapters(text);
      if (!chapters.length) throw new Error('正文是空的');
      const b = {
        id: uid('b_'), kind: 'paste', title: String(title || '未命名').trim(), author, origin,
        chapters: chapters.map((c, i) => ({ index: i, title: c.title, body: c.body })),
        addedAt: clock.now(),
        progress: { chapter: 0, offset: 0, updatedAt: clock.now() },
        bookmarks: [], notes: [],
      };
      const list = await books();
      list.push(b);
      await store.set('books', list);
      return b;
    },

    /** 只存链接，不抓正文。适合公众号这类抓不动的地方。 */
    async addLink({ title, url, note = '' }) {
      if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('链接得是 http(s) 开头');
      const b = {
        id: uid('b_'), kind: 'link', title: String(title || url).trim(), url, note,
        chapters: [], addedAt: clock.now(),
        progress: { chapter: 0, offset: 0, updatedAt: clock.now() }, bookmarks: [], notes: [],
      };
      const list = await books();
      list.push(b);
      await store.set('books', list);
      return b;
    },

    /** 通用 RSS/Atom。博客、播客、newsletter 大多提供。 */
    async addRss(url) {
      if (!fetchImpl) throw new Error('没有注入 fetch，拉不了 RSS');
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error('RSS 拉取失败：HTTP ' + res.status);
      const xml = await res.text();
      const items = parseRss(xml);
      if (!items.length) throw new Error('这个地址里没解析出文章');
      const b = {
        id: uid('b_'), kind: 'rss', title: items.feedTitle || url, url,
        chapters: items.map((it, i) => ({ index: i, title: it.title, body: it.summary || '', link: it.link })),
        addedAt: clock.now(),
        progress: { chapter: 0, offset: 0, updatedAt: clock.now() }, bookmarks: [], notes: [],
      };
      const list = await books();
      list.push(b);
      await store.set('books', list);
      return b;
    },

    get: async id => (await books()).find(b => b.id === id) || null,

    async remove(id) {
      await store.set('books', (await books()).filter(b => b.id !== id));
    },

    /** 记进度。共同空间首页会用它显示「正在一起读」。 */
    async setProgress(id, { chapter, offset = 0 }) {
      const list = await books();
      const b = list.find(x => x.id === id);
      if (!b) return null;
      b.progress = { chapter, offset, updatedAt: clock.now() };
      await store.set('books', list);
      await store.set('reading', { bookId: id, at: clock.now() });
      return b.progress;
    },

    current: () => store.get('reading', null),

    async bookmark(id, { chapter, offset = 0, text = '' }) {
      const list = await books();
      const b = list.find(x => x.id === id);
      if (!b) return null;
      const bm = { id: uid('bm_'), chapter, offset, text, at: clock.now() };
      b.bookmarks.push(bm);
      await store.set('books', list);
      return bm;
    },

    /**
     * 读完一章，让 AI 写一句批注（一起看书的核心体验）。
     * 没注入 composer 就只留个占位，不假装有内容。
     */
    async annotate(id, chapterIndex, { persona = null } = {}) {
      const list = await books();
      const b = list.find(x => x.id === id);
      if (!b) return null;
      const ch = b.chapters[chapterIndex];
      if (!ch) return null;
      if (!composer) return { pending: true, reason: '没有接模型，暂时写不了批注' };
      const text = await composer({
        kind: 'annotation',
        context: { bookTitle: b.title, chapterTitle: ch.title, body: ch.body.slice(0, 2000), persona },
      });
      if (!text) return null;
      const note = { id: uid('n_'), chapter: chapterIndex, text, at: clock.now() };
      b.notes.push(note);
      await store.set('books', list);
      return note;
    },

    /** 交给 memory 的 project 层：正在一起读什么、读到哪。 */
    async asProjectMemory() {
      const cur = await api.current();
      if (!cur) return null;
      const b = await api.get(cur.bookId);
      if (!b) return null;
      const total = b.chapters.length || 1;
      return {
        type: 'project',
        project_id: b.id,
        importance: 0.7,
        tags: ['读书', b.title],
        content: `我们在一起读《${b.title}》，读到第 ${b.progress.chapter + 1} / ${total} 章。`,
      };
    },
  };

  return api;
}

// ---------------------------------------------------------------- RSS
export function parseRss(xml) {
  const s = String(xml || '');
  const items = [];
  const grab = (block, ...tags) => {
    for (const t of tags) {
      const m = new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i').exec(block);
      if (m) return clean(m[1]);
      const self = new RegExp(`<${t}[^>]*href=["']([^"']+)["'][^>]*/?>`, 'i').exec(block);
      if (self) return self[1];
    }
    return '';
  };
  const blocks = [...s.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)].map(m => m[0]);
  for (const b of blocks) {
    const title = grab(b, 'title');
    if (!title) continue;
    items.push({ title, link: grab(b, 'link'), summary: grab(b, 'description', 'summary', 'content') });
  }
  const ft = /<channel[\s>][\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i.exec(s) || /<feed[\s>][\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i.exec(s);
  items.feedTitle = ft ? clean(ft[1]) : '';
  return items;
}

function clean(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .trim();
}
