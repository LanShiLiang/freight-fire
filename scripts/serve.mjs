import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { root } from './catalog.mjs';

const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.wasm': 'application/wasm'
};

export function resolveRequest(base, rawUrl) {
  let pathname;
  try { pathname = decodeURIComponent(rawUrl.split('?')[0]); } catch { return null; }
  if (!pathname.startsWith('/') || /[\\\0]/.test(pathname)) return null;
  const segments = pathname.split('/');
  if (segments.some((segment) => segment === '..' || segment.startsWith('.'))) return null;
  if (!['', 'index.html', 'src', 'games', 'games.json'].includes(segments[1])) return null;
  const filename = path.resolve(base, `.${pathname.endsWith('/') ? `${pathname}index.html` : pathname}`);
  const relative = path.relative(base, filename);
  return relative.startsWith('..') || path.isAbsolute(relative) ? null : filename;
}

export function makeServer(base) {
  return createServer(async (request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return;
    }
    const filename = resolveRequest(base, request.url || '/');
    if (!filename) { response.writeHead(404); response.end('Not found'); return; }
    try {
      if (!(await stat(filename)).isFile()) throw new Error('Not a file');
      const data = await readFile(filename);
      response.writeHead(200, {
        'Content-Type': types[path.extname(filename).toLowerCase()] || 'application/octet-stream',
        'Content-Length': data.length,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      });
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('文件不存在');
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const base = args.includes('--preview') ? path.join(root, 'dist') : root;
  const portIndex = args.indexOf('--port');
  const port = Number(portIndex >= 0 ? args[portIndex + 1] : process.env.PORT || 5173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须在 1–65535 之间');
  if (!(await stat(path.join(base, 'index.html')).catch(() => null))?.isFile()) {
    throw new Error('未找到首页。预览前请先运行 npm run build。');
  }
  const server = makeServer(base);
  server.on('error', (error) => { console.error(`启动失败：${error.message}。可用 --port 5174 指定其他端口。`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Freight Fire · ${args.includes('--preview') ? '构建预览' : '开发'}\nhttp://127.0.0.1:${port}\n修改文件后刷新浏览器。按 Ctrl+C 结束。`);
  });
}
