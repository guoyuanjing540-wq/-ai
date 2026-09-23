// 存储适配层。
// 内核不直接碰 IndexedDB，只认 {get,set,del,keys} 这四个方法，
// 这样同一份代码在浏览器里存 IndexedDB，在 Node 测试里存内存对象。

export function createMemoryBackend(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    async get(k) { return map.has(k) ? structuredClone(map.get(k)) : undefined; },
    async set(k, v) { map.set(k, structuredClone(v)); },
    async del(k) { map.delete(k); },
    async keys() { return [...map.keys()]; },
    _dump: () => Object.fromEntries(map),
  };
}

/** 浏览器用：沿用现有的 zhiyan 库，新开一个 core 存储区，不动老数据。 */
export function createIdbBackend(dbName = 'zhiyan-core', storeName = 'core') {
  let p;
  const open = () => p ||= new Promise((res, rej) => {
    const r = indexedDB.open(dbName, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(storeName)) r.result.createObjectStore(storeName); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(storeName, mode);
      const req = fn(t.objectStore(storeName));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  };
  return {
    get: k => run('readonly', s => s.get(k)),
    set: (k, v) => run('readwrite', s => s.put(v, k)),
    del: k => run('readwrite', s => s.delete(k)),
    keys: () => run('readonly', s => s.getAllKeys()),
  };
}

/**
 * 带命名空间的小仓库。每个子系统拿自己的前缀，互不踩踏。
 * 人格、记忆、衣柜各存各的 —— 换模型只动 settings，碰不到它们。
 */
export function createStore(backend, ns = '') {
  const key = k => (ns ? `${ns}:${k}` : k);
  return {
    ns,
    backend,
    get: async (k, fallback) => {
      const v = await backend.get(key(k));
      return v === undefined ? fallback : v;
    },
    set: (k, v) => backend.set(key(k), v),
    del: k => backend.del(key(k)),
    async keys() {
      const all = await backend.keys();
      const p = ns ? `${ns}:` : '';
      return all.filter(k => typeof k === 'string' && k.startsWith(p)).map(k => k.slice(p.length));
    },
    child: sub => createStore(backend, ns ? `${ns}:${sub}` : sub),
  };
}

export const uid = (prefix = '') =>
  prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
