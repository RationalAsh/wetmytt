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

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wetmytt-claude-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, url: 'http://127.0.0.1:43187/mcp', token: 'test-token' };
}

test('creates a private standalone Claude extension and refreshes its credentials', async t => {
  const options = await fixture(t);
  const { filename } = await prepareClaudeExtension(options);
  await prepareClaudeExtension({ ...options, token: 'updated-token' });
  const files = unzipSync(await fs.readFile(filename));
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  assert.equal(manifest.name, 'wetmytt');
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
  let generation = 1;
  const service = await startMcpServer({ port: 0, token: options.token, getDeck: () => ({ root: options.directory, generation }), screenshotSlide: async () => Buffer.from('PNG') });
  t.after(() => service.close());
  const { filename } = await prepareClaudeExtension({ ...options, url: service.url });
  for (const [name, bytes] of Object.entries(unzipSync(await fs.readFile(filename)))) {
    const target = path.join(options.directory, 'extracted', name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(options.directory, 'extracted/server/bridge.cjs')] });
  const client = new Client({ name: 'claude-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 5);
  assert.match((await client.callTool({ name: 'read_file', arguments: { path: 'index.html' } })).content[0].text, /Slide/);
  assert.ok(!(await client.callTool({ name: 'write_file', arguments: { path: 'deck.json', content: '{"title":"Claude"}' } })).isError);
  assert.equal(await fs.readFile(path.join(options.directory, 'deck.json'), 'utf8'), '{"title":"Claude"}');
  assert.equal((await client.callTool({ name: 'screenshot_slide', arguments: { slide: 1 } })).content[0].data, Buffer.from('PNG').toString('base64'));
  generation++;
  assert.equal((await client.callTool({ name: 'read_file', arguments: { path: 'index.html' } })).isError, true);
});
