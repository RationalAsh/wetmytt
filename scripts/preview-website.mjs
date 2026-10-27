import fs from 'node:fs/promises';
import http from 'node:http';
import { parseArgs } from 'node:util';
import { loadRelease, renderWebsite } from './build-website.mjs';

const root = new URL('../', import.meta.url);
const files = new Map([
  ['/website/', ['website/index.html', 'text/html; charset=utf-8']],
  ['/website/styles.css', ['website/styles.css', 'text/css; charset=utf-8']],
  ['/website/assets/folder-structure.svg', ['website/assets/folder-structure.svg', 'image/svg+xml']],
  ['/website/assets/icon.svg', ['electron/assets/icon.svg', 'image/svg+xml']],
  ['/website/assets/workspace.jpg', ['docs/screenshots/workspace.jpg', 'image/jpeg']],
]);

async function main() {
  const { values } = parseArgs({ options: {
    port: { type: 'string', default: '4173' },
    'release-json': { type: 'string' },
  } });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be an integer from 1 to 65535');

  console.log('Loading release downloads for the preview…');
  const release = await loadRelease(values['release-json']);
  // Validate release metadata before starting the server.
  renderWebsite('', release);

  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const pathname = request.url?.split('?')[0];
    if (['/', '/website', '/website/index.html'].includes(pathname)) {
      response.writeHead(302, { Location: '/website/' }).end();
      return;
    }
    const file = files.get(pathname);
    if (!file) {
      response.writeHead(404).end();
      return;
    }
    try {
      const [source, type] = file;
      let content = await fs.readFile(new URL(source, root));
      if (type.startsWith('text/html')) content = Buffer.from(renderWebsite(content.toString('utf8'), release));
      response.writeHead(200, { 'Content-Type': type, 'Content-Length': content.length });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      console.error(`Could not serve ${pathname}: ${error.message}`);
      response.writeHead(500).end('Could not render the website. Check the terminal for details.');
    }
  });
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE'
      ? `Port ${port} is already in use. Try npm run preview:website -- --port ${port + 1}.`
      : error.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Website preview: http://127.0.0.1:${port}/website/`);
    console.log('Edit website/index.html or website/styles.css, then refresh your browser. Stop with Ctrl+C.');
  });
}

main().catch(error => {
  console.error(`Website preview failed: ${error.message}`);
  process.exitCode = 1;
});
