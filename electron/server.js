import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { scopedPath } from './files.js';

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.woff2': 'font/woff2', '.mp4': 'video/mp4' };
export async function serveFolder(root, { deck = false } = {}) {
  const token = randomBytes(18).toString('hex');
  const prefix = deck ? `/${token}/` : '/';
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (!pathname.startsWith(prefix)) { res.writeHead(404).end(); return; }
      const relative = decodeURIComponent(pathname.slice(prefix.length)) || 'index.html';
      const target = await scopedPath(root, relative);
      let body = await fs.readFile(target);
      if (deck && path.extname(target) === '.html') {
        const bridge = await fs.readFile(new URL('./bridge.js', import.meta.url), 'utf8');
        body = Buffer.from(body.toString().replace(/<\/body>/i, `<script>${bridge}</script></body>`));
      }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', `${mime[path.extname(target)] || 'application/octet-stream'}${/\.(html|js|css|json)$/.test(target) ? '; charset=utf-8' : ''}`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (deck) res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'");
      else res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src http://127.0.0.1:*; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'");
      res.writeHead(200).end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(404).end('File unavailable'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}${prefix}`, close: () => new Promise(resolve => server.close(resolve)) };
}
