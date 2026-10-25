import http from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpServer, loadMcpToken } from '../electron/mcp.js';
import { toolDefinitions } from '../electron/tools.js';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wetmytt-mcp-'));
  const root = path.join(directory, 'deck');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'index.html'), '<html><body>Slide</body></html>');
  let deck = { root, generation: 1 };
  const token = await loadMcpToken(directory);
  const service = await startMcpServer({ port: 0, token, getDeck: () => deck, screenshotSlide: async (capturedRoot, slide) => {
    assert.equal(capturedRoot, root);
    if (slide > 2) throw new Error('Slide does not exist.');
    return Buffer.from('PNG');
  } });
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map(({ client, transport }) => transport.terminateSession().catch(() => {}).finally(() => client.close())));
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, root, token, service, switchDeck(next) { deck = { root: next, generation: deck.generation + 1 }; service.cancelStaleSessions(); }, async connect() {
    const client = new Client({ name: 'test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(service.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    clients.push({ client, transport });
    await client.connect(transport);
    return client;
  } };
}

const text = result => result.content[0].text;

test('HTTP MCP exposes the active presentation and scoped file and screenshot tools', async t => {
  const f = await fixture(t);
  const client = await f.connect();
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ['get_presentation', 'screenshot_slide', ...toolDefinitions.map(tool => tool.name)].sort());
  assert.deepEqual(JSON.parse(text(await client.callTool({ name: 'get_presentation' }))), { root: f.root, name: 'deck', current: true });
  assert.deepEqual(JSON.parse(text(await client.callTool({ name: 'list_files' }))), ['index.html']);
  assert.match(text(await client.callTool({ name: 'read_file', arguments: { path: 'index.html' } })), /Slide/);
  const saved = await client.callTool({ name: 'write_file', arguments: { path: 'deck.json', content: '{"title":"Updated"}' } });
  assert.ok(!saved.isError);
  assert.equal(await fs.readFile(path.join(f.root, 'deck.json'), 'utf8'), '{"title":"Updated"}');
  const escape = await client.callTool({ name: 'write_file', arguments: { path: '../outside.txt', content: 'no' } });
  assert.equal(escape.isError, true);
  const screenshot = await client.callTool({ name: 'screenshot_slide', arguments: { slide: 2 } });
  assert.equal(screenshot.content[0].type, 'image');
  assert.equal(Buffer.from(screenshot.content[0].data, 'base64').toString(), 'PNG');
  assert.equal((await client.callTool({ name: 'screenshot_slide', arguments: { slide: 3 } })).isError, true);
  assert.equal((await client.callTool({ name: 'screenshot_slide', arguments: { slide: 0 } })).isError, true);
});

test('sessions fail after switching, closing, or reopening a deck; new sessions bind explicitly', async t => {
  const f = await fixture(t);
  const old = await f.connect();
  const next = path.join(f.directory, 'next');
  await fs.mkdir(next);
  await fs.writeFile(path.join(next, 'index.html'), 'Next');
  f.switchDeck(next);
  for (const [name, args] of [['list_files', {}], ['read_file', { path: 'index.html' }], ['write_file', { path: 'index.html', content: 'WRONG' }], ['screenshot_slide', { slide: 1 }]]) {
    const result = await old.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
    assert.match(text(result), /presentation changed/);
  }
  assert.equal(await fs.readFile(path.join(next, 'index.html'), 'utf8'), 'Next');
  assert.equal(JSON.parse(text(await old.callTool({ name: 'get_presentation' }))).current, false);
  const fresh = await f.connect();
  assert.equal(text(await fresh.callTool({ name: 'read_file', arguments: { path: 'index.html' } })), 'Next');
  f.switchDeck(undefined);
  assert.equal((await fresh.callTool({ name: 'list_files' })).isError, true);
  const empty = await f.connect();
  assert.match(text(await empty.callTool({ name: 'list_files' })), /Open a presentation/);
  f.switchDeck(f.root);
  assert.equal((await old.callTool({ name: 'write_file', arguments: { path: 'index.html', content: 'WRONG' } })).isError, true);
  assert.match(await fs.readFile(path.join(f.root, 'index.html'), 'utf8'), /Slide/);
});

test('HTTP MCP rejects invalid credentials, origins, hosts, routes and sessions', async t => {
  const f = await fixture(t);
  const headers = { Authorization: `Bearer ${f.token}` };
  assert.equal((await fetch(f.service.url)).status, 401);
  assert.equal((await fetch(f.service.url, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(f.service.url, { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    const req = http.get(f.service.url, { headers: { ...headers, Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await fetch(f.service.url, { headers: { ...headers, 'Mcp-Session-Id': 'unknown' } })).status, 404);
  assert.equal((await fetch(f.service.url, { method: 'PUT', headers })).status, 405);
  assert.equal((await fetch(f.service.url + '/other', { headers })).status, 404);
  assert.equal((await fetch(f.service.url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{broken' })).status, 400);
  const client = await f.connect();
  assert.ok((await client.listTools()).tools.length);
});

test('MCP runs patch, asset, and local Git tools through the shared registry', async t => {
  const f = await fixture(t);
  const client = await f.connect();
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, text(result));
    return text(result);
  };
  await call('apply_patch', { patch: '--- /dev/null\n+++ b/notes.txt\n@@ -0,0 +1 @@\n+Research notes\n' });
  await call('git_init');
  await call('git_stage', { paths: ['notes.txt', '.gitignore'] });
  await call('git_commit', { message: 'Save notes' });
  assert.match(await call('git_log'), /Save notes/);
  const source = path.join(f.directory, 'photo.png');
  await fs.writeFile(source, Buffer.from([0, 255, 42]));
  assert.deepEqual(JSON.parse(await call('import_assets', { sources: [source] })).imported, ['assets/photo.png']);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'assets/photo.png')), Buffer.from([0, 255, 42]));
  assert.equal((await client.callTool({ name: 'run_command', arguments: { command: 'echo no' } })).isError, true);
});

test('switching projects aborts an in-flight MCP download before it can write an asset', async t => {
  const f = await fixture(t);
  const client = await f.connect();
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  globalThis.fetch = (url, options) => {
    if (new URL(url).hostname !== '93.184.216.34') return previous(url, options);
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      started();
    });
  };
  const pending = client.callTool({ name: 'download_asset', arguments: { url: 'https://93.184.216.34/image.png', filename: 'image.png' } });
  await ready;
  f.switchDeck(undefined);
  const result = await pending;
  assert.equal(result.isError, true);
  assert.match(text(result), /presentation changed/);
  await assert.rejects(fs.access(path.join(f.root, 'assets/image.png')));
});

test('installation credentials persist and a closed MCP server releases its port', async t => {
  const f = await fixture(t);
  assert.equal(await loadMcpToken(f.directory), f.token);
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(f.directory, 'mcp-token'))).mode & 0o777, 0o600);
  await f.service.close();
  const restarted = await startMcpServer({ port: Number(new URL(f.service.url).port), token: f.token, getDeck: () => ({ generation: 0 }), screenshotSlide: async () => Buffer.alloc(0) });
  assert.equal(restarted.url, f.service.url);
  await restarted.close();
});
