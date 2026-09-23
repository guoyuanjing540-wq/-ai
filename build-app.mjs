// 把网页版需要的文件拷进 www/，给 Capacitor 打包用。
// 不拷 sw.js（原生壳里资源本来就是本地的，Service Worker 只会添乱）、
// 不拷 worker.js（那是跑在 Cloudflare 上的）、不拷 screenshots/。
import { cp, rm, mkdir } from 'node:fs/promises';

const FILES = ['index.html', 'space.html', 'src', 'manifest.webmanifest', 'icons', 'vendor'];

await rm('www', { recursive: true, force: true });
await mkdir('www');
for (const f of FILES) await cp(f, `www/${f}`, { recursive: true });
console.log('www/ 已生成：' + FILES.join('、'));
