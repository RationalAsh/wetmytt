import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseSearch, searchWeb, fetchURL, publicURL, requestBytes } from '../electron/web.js';
import { runTool } from '../electron/tools.js';

const html = `<html><body><div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fsource">A &amp; B</a><div class="result__snippet">A <b>useful</b> source.</div></div><div class="result"><a class="result__a" href="https://example.org/other">Other</a><div class="result__snippet">More.</div></div></body></html>`;
test('DuckDuckGo parser extracts decoded links, titles, snippets, limits, and empty results', () => {
  assert.deepEqual(parseSearch(html, 1), [{ title: 'A & B', url: 'https://example.com/source', snippet: 'A useful source.' }]);
  assert.equal(parseSearch(html).length, 2);
  assert.deepEqual(parseSearch('<div class="no-results">No results found</div>'), []);
  assert.throws(() => parseSearch('<form id="challenge-form">CAPTCHA</form>'), /blocked/);
  assert.throws(() => parseSearch('<html>unrecognized</html>'), /unrecognized/);
});

test('search makes bounded requests, encodes queries, caches results, and honors cancellation', async () => {
  let calls = 0;
  const request = async (url, options) => {
    calls++;
    assert.equal(new URL(url).searchParams.get('q'), 'slides & research');
    assert.equal(new URL(url).hostname, 'html.duckduckgo.com');
    assert.ok(options.signal);
    return { bytes: Buffer.from(html) };
  };
  const controller = new AbortController();
  assert.equal((await searchWeb({ query: 'slides & research' }, controller.signal, request)).results.length, 2);
  await searchWeb({ query: 'slides & research' }, controller.signal, request);
  assert.equal(calls, 1);
  controller.abort();
  await assert.rejects(searchWeb({ query: 'slides & research' }, controller.signal, request));
});

test('page retrieval strips scripts and navigation, preserves readable text, and rejects binaries', async () => {
  const request = async () => ({ bytes: Buffer.from('<title>Research</title><nav>Menu</nav><main><h1>Heading</h1><p>Useful &amp; readable.</p><script>bad()</script></main>'), url: 'https://example.com/final', contentType: 'text/html' });
  const result = await fetchURL({ url: 'https://example.com' }, undefined, request);
  assert.equal(result.title, 'Research');
  assert.equal(result.url, 'https://example.com/final');
  assert.match(result.text, /Heading\nUseful & readable/);
  assert.ok(!result.text.includes('bad()') && !result.text.includes('Menu'));
  const long = await fetchURL({ url: 'https://example.com' }, undefined, async () => ({ bytes: Buffer.from('x'.repeat(50000)), contentType: 'text/plain', url: 'https://example.com' }));
  assert.equal(long.text.length, 40000); assert.equal(long.truncated, true);
  await assert.rejects(fetchURL({ url: 'https://example.com' }, undefined, async () => ({ bytes: Buffer.from('PNG'), contentType: 'image/png' })), /download_asset/);
});

test('public web tools reject credentials, unsupported protocols, and private addresses', async () => {
  for (const url of ['file:///etc/passwd', 'https://user:pass@example.com', 'http://127.0.0.1', 'http://10.1.2.3', 'http://169.254.169.254', 'http://192.168.1.1', 'http://172.16.1.2', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://[fe80::1]']) await assert.rejects(publicURL(url));
  assert.equal((await publicURL('https://93.184.216.34')).hostname, '93.184.216.34');
});

test('requests reject private redirects, HTTP failures, large responses, and redirect loops', async t => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = async () => new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } });
  await assert.rejects(requestBytes('https://93.184.216.34'), /private network/);
  globalThis.fetch = async () => new Response('blocked', { status: 429 });
  await assert.rejects(requestBytes('https://93.184.216.34'), /429/);
  globalThis.fetch = async () => new Response('too large');
  await assert.rejects(requestBytes('https://93.184.216.34', { limit: 2 }), /exceeds/);
  globalThis.fetch = async () => new Response(null, { status: 302, headers: { Location: '/loop' } });
  await assert.rejects(requestBytes('https://93.184.216.34'), /Too many redirects/);
});

test('asset downloads preserve binary bytes, avoid collisions, reject unsafe names and symlink escapes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wetmytt-download-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  const bytes = Buffer.from([0x89, 0x50, 0, 0xff]);
  globalThis.fetch = async () => new Response(bytes, { headers: { 'Content-Type': 'image/png' } });
  const args = { url: 'https://93.184.216.34/image.png', filename: 'image.png' };
  assert.equal(JSON.parse(await runTool(root, 'download_asset', args)).path, 'assets/image.png');
  assert.equal(JSON.parse(await runTool(root, 'download_asset', args)).path, 'assets/image (1).png');
  assert.deepEqual(await fs.readFile(path.join(root, 'assets/image.png')), bytes);
  for (const filename of ['../outside.png', '.env', 'dir/file', 'bad\\file']) await assert.rejects(runTool(root, 'download_asset', { ...args, filename }));
  await fs.rename(path.join(root, 'assets'), path.join(root, 'original-assets'));
  await fs.symlink(os.tmpdir(), path.join(root, 'assets'));
  await assert.rejects(runTool(root, 'download_asset', args), /Symlinks cannot escape/);
});
