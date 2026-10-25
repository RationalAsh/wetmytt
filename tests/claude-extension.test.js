import { presentationGuidance } from '../electron/presentation-guidance.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { prepareClaudeExtension, connectClaude } from '../electron/claude-extension.js';
import { startMcpServer } from '../electron/mcp.js';
import { toolDefinitions } from '../electron/tools.js';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wetmytt-claude-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, url: 'http://127.0.0.1:43187/mcp', token: 'test-token' };
}

async function packagedClient(t, options) {
  const { filename } = await prepareClaudeExtension(options);
  for (const [name, bytes] of Object.entries(unzipSync(await fs.readFile(filename)))) {
    const target = path.join(options.directory, 'extracted', name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(options.directory, 'extracted/server/bridge.cjs')] });
  const client = new Client({ name: 'claude-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  return client;
}

test('creates a private standalone Claude extension and refreshes its credentials', async t => {
  const options = await fixture(t);
  const { filename } = await prepareClaudeExtension(options);
  await prepareClaudeExtension({ ...options, token: 'updated-token' });
  const files = unzipSync(await fs.readFile(filename));
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  assert.equal(manifest.name, 'wetmytt');
  assert.ok(manifest.long_description.includes(presentationGuidance));
  assert.equal(manifest.server.type, 'node');
  assert.deepEqual(Buffer.from(files[manifest.icon]), await fs.readFile(new URL('../electron/assets/icon.png', import.meta.url)));
  assert.ok(files[manifest.server.entry_point]);
  assert.deepEqual(JSON.parse(strFromU8(files['server/connection.json'])), { url: options.url, token: 'updated-token' });
  assert.ok(!strFromU8(files['manifest.json']).includes('updated-token'));
  if (process.platform !== 'win32') assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
});

test('opens the prepared bundle and reports both shell errors and thrown failures', async t => {
  const options = await fixture(t);
  const success = await connectClaude({ ...options, openPath: async filename => { await fs.access(filename); return ''; } });
  assert.equal(success.opened, true);
  for (const openPath of [async () => 'No handler', async () => { throw new Error('No handler'); }]) {
    const result = await connectClaude({ ...options, openPath });
    assert.equal(result.opened, false);
    assert.match(result.error, /extension is ready/);
    await fs.access(result.filename);
  }
  let opened = false;
  await assert.rejects(connectClaude({ ...options, url: 'https://example.com/mcp', openPath: async () => { opened = true; } }));
  assert.equal(opened, false);
});

test('packaged stdio bridge edits and captures through the authenticated app server', async t => {
  const options = await fixture(t);
  await fs.writeFile(path.join(options.directory, 'index.html'), '<html>Slide</html>');
  let generation = 0, root;
  const service = await startMcpServer({ port: 0, token: options.token, getDeck: () => ({ root, generation }), screenshotSlide: async () => Buffer.from('PNG') });
  t.after(() => service.close());
  const client = await packagedClient(t, { ...options, url: service.url });
  assert.equal((await client.listTools()).tools.length, toolDefinitions.length + 4);
  assert.equal(JSON.parse((await client.callTool({ name: 'get_presentation' })).content[0].text).root, null);
  root = options.directory;
  generation++;
  service.cancelStaleSessions();
  assert.equal(JSON.parse((await client.callTool({ name: 'get_presentation' })).content[0].text).root, root);
  assert.match((await client.callTool({ name: 'read_file', arguments: { path: 'index.html' } })).content[0].text, /Slide/);
  assert.ok(!(await client.callTool({ name: 'write_file', arguments: { path: 'deck.json', content: '{"title":"Claude"}' } })).isError);
  assert.equal(await fs.readFile(path.join(options.directory, 'deck.json'), 'utf8'), '{"title":"Claude"}');
  assert.equal((await client.callTool({ name: 'screenshot_slide', arguments: { slide: 1 } })).content[0].data, Buffer.from('PNG').toString('base64'));
  generation++;
  service.cancelStaleSessions();
  assert.equal((await client.callTool({ name: 'read_file', arguments: { path: 'index.html' } })).isError, true);
  await client.callTool({ name: 'get_presentation' });
  assert.match((await client.callTool({ name: 'read_file', arguments: { path: 'index.html' } })).content[0].text, /Slide/);
});

test('Claude bridge restores expired sessions and app restarts without replaying edits', async t => {
  const options = await fixture(t);
  const original = path.join(options.directory, 'original');
  const next = path.join(options.directory, 'next');
  await fs.mkdir(original);
  await fs.mkdir(next);
  await fs.writeFile(path.join(original, 'index.html'), 'Original');
  await fs.writeFile(path.join(next, 'index.html'), 'Next');
  let root = original;
  const start = port => startMcpServer({ port, token: options.token, getDeck: () => ({ root, generation: 1 }), listRecentPresentations: () => [original, next], openPresentation: async folder => { root = folder; service.cancelStaleSessions(); }, screenshotSlide: async () => Buffer.from('PNG') });
  let service = await start(0);
  t.after(() => service.close());
  const port = Number(new URL(service.url).port);
  const client = await packagedClient(t, { ...options, url: service.url });
  await client.callTool({ name: 'get_presentation' });
  await service.close();
  root = next;
  service = await start(port);
  // This is the first tool in the user's failing screenshot.
  assert.equal(JSON.parse((await client.callTool({ name: 'get_presentation' })).content[0].text).root, next);
  assert.equal((await client.callTool({ name: 'read_file', arguments: { path: 'index.html' } })).content[0].text, 'Next');
  await service.close();
  root = original;
  service = await start(port);
  const edit = { name: 'write_file', arguments: { path: 'index.html', content: 'Unexpected edit' } };
  const rejected = await client.callTool(edit);
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /Call get_presentation/);
  // Discovery must not bypass the requirement to select the new deck.
  assert.ok((await client.listTools()).tools.length);
  const recent = await client.callTool({ name: 'list_recent_presentations' });
  assert.ok(!recent.isError);
  assert.equal(JSON.parse(recent.content[0].text)[0].root, original);
  assert.equal((await client.callTool(edit)).isError, true);
  assert.equal(await fs.readFile(path.join(original, 'index.html'), 'utf8'), 'Original');
  assert.equal(await fs.readFile(path.join(next, 'index.html'), 'utf8'), 'Next');
  await client.callTool({ name: 'get_presentation' });
  assert.ok(!(await client.callTool(edit)).isError);
  assert.equal(await fs.readFile(path.join(original, 'index.html'), 'utf8'), 'Unexpected edit');
  await service.close();
  service = await start(port);
  const opened = await client.callTool({ name: 'open_presentation', arguments: { path: next } });
  assert.ok(!opened.isError);
  assert.equal(JSON.parse(opened.content[0].text).root, next);
  assert.equal((await client.callTool({ name: 'read_file', arguments: { path: 'index.html' } })).content[0].text, 'Next');
});

test('Claude bridge returns readable tool errors when the app is offline or credentials change', async t => {
  const options = await fixture(t);
  const start = (port, token) => startMcpServer({ port, token, getDeck: () => ({ root: options.directory, generation: 1 }), screenshotSlide: async () => Buffer.from('PNG') });
  let service = await start(0, options.token);
  t.after(() => service.close());
  const port = Number(new URL(service.url).port);
  const client = await packagedClient(t, { ...options, url: service.url });
  await service.close();
  const offline = await client.callTool({ name: 'get_presentation' });
  assert.equal(offline.isError, true);
  assert.match(offline.content[0].text, /Keep the app running/);
  service = await start(port, 'rotated-token');
  const denied = await client.callTool({ name: 'get_presentation' });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /HTTP 401/);
  assert.match(denied.content[0].text, /reinstall.*extension/);
});
