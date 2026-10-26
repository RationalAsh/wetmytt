import { presentationGuidance } from '../electron/presentation-guidance.js';
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
import { createRecentFolders } from '../electron/recent-folders.js';
import { createDeck } from '../electron/decks.js';

async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wetmytt-mcp-')));
  const root = path.join(directory, 'deck');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'index.html'), '<html><body>Slide</body></html>');
  let deck = { root, generation: 1 };
  const recent = createRecentFolders(path.join(directory, 'recent.json'));
  await recent.add(root);
  const token = await loadMcpToken(directory);
  const openPresentation = async folder => {
    const canonical = await fs.realpath(folder);
    if (!(await fs.stat(path.join(canonical, 'index.html'))).isFile()) throw new Error('Expected index.html file.');
    deck = { root: canonical, generation: deck.generation + 1 };
    service.cancelStaleSessions();
    await recent.add(canonical);
  };
  const service = await startMcpServer({ port: 0, token, getDeck: () => deck, listRecentPresentations: () => recent.list(), openPresentation, createPresentation: async (folder, signal) => {
    signal.throwIfAborted();
    await createDeck(folder);
    signal.throwIfAborted();
    await openPresentation(folder);
  }, screenshotSlide: async (capturedRoot, slide) => {
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

test('MCP creates starter projects at an absolute path and selects only the calling session', async t => {
  const f = await fixture(t);
  f.switchDeck(undefined);
  const client = await f.connect();
  const other = await f.connect();
  const call = (name, args) => client.callTool({ name, arguments: args });
  const folder = path.join(f.directory, 'New presentation');
  const created = await call('create_presentation', { path: folder });
  assert.ok(!created.isError, text(created));
  assert.deepEqual(JSON.parse(text(created)), { root: folder, name: 'New presentation', current: true });
  assert.ok(created.content.some(block => block.text === presentationGuidance));
  for (const file of ['index.html', 'AGENTS.md']) {
    assert.equal(text(await call('read_file', { path: file })), await fs.readFile(new URL(`../templates/starter/${file}`, import.meta.url), 'utf8'));
  }
  assert.ok((await fs.stat(path.join(folder, '.git'))).isDirectory());
  assert.deepEqual(JSON.parse(text(await call('list_recent_presentations'))), [{ root: folder, name: 'New presentation', current: true }, { root: f.root, name: 'deck', current: false }]);
  assert.equal((await other.callTool({ name: 'list_files' })).isError, true);
  await other.callTool({ name: 'get_presentation' });
  assert.ok(!(await other.callTool({ name: 'list_files' })).isError);

  const empty = path.join(f.directory, 'empty');
  const file = path.join(f.directory, 'file');
  await fs.mkdir(empty);
  await fs.writeFile(file, 'Keep this');
  for (const args of [{}, { path: '' }, { path: 'relative' }, { path: 42 }, { path: folder }, { path: empty }, { path: file }, { path: path.join(f.directory, 'missing', 'deck') }]) {
    assert.equal((await call('create_presentation', args)).isError, true);
    assert.equal(JSON.parse(text(await call('get_presentation'))).root, folder);
  }
  assert.deepEqual(await fs.readdir(empty), []);
  assert.equal(await fs.readFile(file, 'utf8'), 'Keep this');
  assert.equal(await fs.readFile(path.join(f.root, 'index.html'), 'utf8'), '<html><body>Slide</body></html>');
  const next = path.join(f.directory, 'Next presentation');
  assert.ok(!(await call('create_presentation', { path: next })).isError);
  assert.equal((await other.callTool({ name: 'list_files' })).isError, true);
  assert.ok(!(await call('write_file', { path: 'notes.txt', content: 'New project' })).isError);
  assert.equal(await fs.readFile(path.join(next, 'notes.txt'), 'utf8'), 'New project');
  await assert.rejects(fs.access(path.join(folder, 'notes.txt')));
});

test('MCP discovers and opens presentations without a deck, selecting only the calling session', async t => {
  const f = await fixture(t);
  const client = await f.connect();
  const other = await f.connect();
  const call = async (name, args) => client.callTool({ name, arguments: args });
  const entries = async () => JSON.parse(text(await call('list_recent_presentations')));
  assert.deepEqual(await entries(), [{ root: f.root, name: 'deck', current: true }]);
  f.switchDeck(undefined);
  assert.deepEqual(await entries(), [{ root: f.root, name: 'deck', current: false }]);
  assert.deepEqual(JSON.parse(text(await call('open_presentation', { path: f.root }))), { root: f.root, name: 'deck', current: true });
  assert.match(text(await call('read_file', { path: 'index.html' })), /Slide/);
  assert.equal((await other.callTool({ name: 'list_files' })).isError, true);

  const next = path.join(f.directory, 'another deck');
  await fs.mkdir(next);
  await fs.writeFile(path.join(next, 'index.html'), 'Next');
  await call('open_presentation', { path: next });
  assert.equal(text(await call('read_file', { path: 'index.html' })), 'Next');
  assert.deepEqual(await entries(), [{ root: next, name: 'another deck', current: true }, { root: f.root, name: 'deck', current: false }]);
  for (const args of [{}, { path: '' }, { path: 'relative' }, { path: 42 }, { path: path.join(f.directory, 'missing') }, { path: f.directory }, { path: path.join(next, 'index.html') }]) {
    assert.equal((await call('open_presentation', args)).isError, true);
    assert.equal(text(await call('read_file', { path: 'index.html' })), 'Next');
  }
  await call('open_presentation', { path: next });
  assert.equal((await entries()).length, 2);
  assert.equal(text(await call('read_file', { path: 'index.html' })), 'Next');
});

test('HTTP MCP exposes the active presentation and scoped file and screenshot tools', async t => {
  const f = await fixture(t);
  const client = await f.connect();
  assert.ok(client.getInstructions().includes(presentationGuidance));
  const selected = await client.callTool({ name: 'get_presentation' });
  assert.ok(selected.content.some(block => block.type === 'text' && block.text === presentationGuidance));
  const opened = await client.callTool({ name: 'open_presentation', arguments: { path: f.root } });
  assert.ok(opened.content.some(block => block.type === 'text' && block.text === presentationGuidance));
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ['get_presentation', 'list_recent_presentations', 'open_presentation', 'create_presentation', 'screenshot_slide', ...toolDefinitions.map(tool => tool.name)].sort());
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

test('get_presentation selects a switched, closed, or reopened deck without reconnecting', async t => {
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
  assert.deepEqual(JSON.parse(text(await old.callTool({ name: 'get_presentation' }))), { root: next, name: 'next', current: true });
  assert.equal(text(await old.callTool({ name: 'read_file', arguments: { path: 'index.html' } })), 'Next');
  assert.ok(!(await old.callTool({ name: 'write_file', arguments: { path: 'notes.txt', content: 'New deck' } })).isError);
  assert.equal(await fs.readFile(path.join(next, 'notes.txt'), 'utf8'), 'New deck');
  await assert.rejects(fs.access(path.join(f.root, 'notes.txt')));
  const fresh = await f.connect();
  assert.equal(text(await fresh.callTool({ name: 'read_file', arguments: { path: 'index.html' } })), 'Next');
  f.switchDeck(undefined);
  assert.equal((await fresh.callTool({ name: 'list_files' })).isError, true);
  assert.deepEqual(JSON.parse(text(await old.callTool({ name: 'get_presentation' }))), { root: null, name: null, current: true });
  assert.match(text(await old.callTool({ name: 'list_files' })), /Open a presentation/);
  const empty = await f.connect();
  assert.match(text(await empty.callTool({ name: 'list_files' })), /Open a presentation/);
  f.switchDeck(f.root);
  assert.equal((await old.callTool({ name: 'write_file', arguments: { path: 'index.html', content: 'WRONG' } })).isError, true);
  assert.match(await fs.readFile(path.join(f.root, 'index.html'), 'utf8'), /Slide/);
  for (const client of [old, empty]) {
    await client.callTool({ name: 'get_presentation' });
    assert.match(text(await client.callTool({ name: 'read_file', arguments: { path: 'index.html' } })), /Slide/);
    assert.ok(!(await client.callTool({ name: 'screenshot_slide', arguments: { slide: 1 } })).isError);
  }
  f.switchDeck(f.root);
  assert.match(text(await old.callTool({ name: 'list_files' })), /Call get_presentation/);
  await old.callTool({ name: 'get_presentation' });
  assert.deepEqual(JSON.parse(text(await old.callTool({ name: 'list_files' }))), ['index.html']);
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
  // Refresh the same session before the old request finishes. Its cancellation
  // must stay attached to the original binding.
  await client.callTool({ name: 'get_presentation' });
  const result = await pending;
  assert.equal(result.isError, true);
  assert.match(text(result), /presentation changed/);
  await assert.rejects(fs.access(path.join(f.root, 'assets/image.png')));
  f.switchDeck(f.root);
  await client.callTool({ name: 'get_presentation' });
  assert.deepEqual(JSON.parse(text(await client.callTool({ name: 'list_files' }))), ['index.html']);
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
