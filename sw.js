// 每次更新文件后把版本号 +1，手机上才会拿到新版本
const CACHE = 'zhiyan-v8';
const SHELL = ['./', './index.html', './manifest.webmanifest', './vendor/marked.min.js', './vendor/purify.min.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put('./index.html', copy));
      return res;
    }).catch(() => caches.match('./index.html')));
    return;
  }

  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  })));
});

// ---- TA 主动发来的消息 ----
// Worker 只发一个空推送，这里再去 Worker 取消息内容
function kv(key) {
  return new Promise((res, rej) => {
    const r = indexedDB.open('zhiyan', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('secrets'); };
    r.onerror = () => rej(r.error);
    r.onsuccess = () => {
      const q = r.result.transaction('kv').objectStore('kv').get(key);
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    };
  });
}

self.addEventListener('push', e => {
  e.waitUntil((async () => {
    let title = '知言', body = 'TA 给你发了消息', remind = false;
    try {
      const s = await kv('settings');
      if (s?.persona?.name) title = s.persona.name;
      let item = null;
      try { item = e.data?.json(); } catch {}
      if (!item?.text) {
        const cfg = await kv('pushcfg');
        if (cfg?.url) {
          const r = await fetch(cfg.url + '/inbox', { headers: { 'x-zy-pass': cfg.pass } });
          const j = await r.json();
          item = j.items?.[j.items.length - 1];
        }
      }
      if (item?.text) { body = item.text; remind = item.kind === 'remind'; }
    } catch {}
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    wins.forEach(c => c.postMessage('inbox'));
    await self.registration.showNotification(remind ? `${title} · 提醒` : title, {
      body, tag: 'zhiyan', renotify: true,
      icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { url: './' },
    });
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of wins) if ('focus' in c) { c.postMessage('inbox'); return c.focus(); }
    return self.clients.openWindow(e.notification.data?.url || './');
  })());
});
