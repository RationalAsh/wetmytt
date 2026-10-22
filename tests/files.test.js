import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scopedPath, readFile, writeFile, listFiles } from '../electron/files.js';
import { serveFolder } from '../electron/server.js';
import { chat } from '../electron/agent.js';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'decklet-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'deck');
  await fs.mkdir(root);
  await fs.writeFile(path.join(directory, 'secret.txt'), 'secret');
  await fs.writeFile(path.join(root, 'index.html'), '<html><body><section data-slide>Hello</section></body></html>');
  return { directory, root };
}

test('file tools read and write within the deck, validate JSON, and list assets', async t => {
  const { root } = await fixture(t);
  await writeFile(root, 'assets/content.json', '{"title":"Hello"}');
  assert.equal(await readFile(root, 'assets/content.json'), '{"title":"Hello"}');
  assert.deepEqual((await listFiles(root)).sort(), ['assets/content.json', 'index.html']);
  await assert.rejects(writeFile(root, 'assets/content.json', '{broken'));
  assert.equal(await readFile(root, 'assets/content.json'), '{"title":"Hello"}');
});

test('file tools block traversal, absolute paths, hidden files, and symlink escapes', async t => {
  const { directory, root } = await fixture(t);
  await fs.symlink(directory, path.join(root, 'escape'));
  for (const name of ['../secret.txt', '/etc/passwd', '.env', 'escape/secret.txt']) await assert.rejects(readFile(root, name));
  await assert.rejects(writeFile(root, 'escape/new/nested.txt', 'bad'));
  await assert.rejects(scopedPath(root, '../new', true));
});

test('preview serves local assets, injects navigation, rejects paths and disables caching', async t => {
  const { root } = await fixture(t);
  const server = await serveFolder(root, { deck: true });
  t.after(() => server.close());
  const response = await fetch(`${server.url}index.html`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /decklet:navigate/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.equal((await fetch(`${server.url}%2e%2e%2fsecret.txt`)).status, 404);
  assert.equal((await fetch(`${new URL(server.url).origin}/index.html`)).status, 404);
});

test('chat executes tool calls and sends their results back to the provider', async t => {
  const { root } = await fixture(t);
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (_url, options) => {
    requests++;
    const body = JSON.parse(options.body);
    if (requests === 1) return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'edit1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'deck.json', content: '{"title":"Updated"}' }) } }] } }] });
    assert.equal(body.messages.at(-1).role, 'tool');
    assert.equal(body.messages.at(-1).content, 'Saved deck.json');
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'Updated the title.' } }] });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const result = await chat({ root, settings: { baseUrl: 'https://example.com/v1', model: 'test' }, history: [{ role: 'user', content: 'Update the title.' }], signal: new AbortController().signal, onActivity() {} });
  assert.equal(result, 'Updated the title.');
  assert.equal(await readFile(root, 'deck.json'), '{"title":"Updated"}');
  assert.equal(requests, 2);
});
