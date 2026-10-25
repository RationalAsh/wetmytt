import { presentationGuidance } from '../electron/presentation-guidance.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareCodexPlugin, connectCodex } from '../electron/codex-plugin.js';

async function fixture(t) {
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'wetmytt-plugin-'));
  t.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));
  return { homeDirectory, url: 'http://127.0.0.1:43187/mcp', token: 'local-test-token' };
}
const readJSON = async filename => JSON.parse(await fs.readFile(filename, 'utf8'));

test('prepares a private local plugin with the app endpoint and an encoded Codex link', async t => {
  const options = await fixture(t);
  const result = await prepareCodexPlugin(options);
  const marketplace = await readJSON(result.marketplacePath);
  const entry = marketplace.plugins[0];
  // The personal marketplace's relative source resolves from the home directory.
  assert.equal(path.resolve(options.homeDirectory, entry.source.path), result.pluginDirectory);
  assert.equal(entry.policy.installation, 'AVAILABLE');
  const manifest = await readJSON(path.join(result.pluginDirectory, '.codex-plugin/plugin.json'));
  assert.equal(manifest.name, 'wetmytt');
  assert.ok(manifest.interface.longDescription.includes(presentationGuidance));
  assert.equal(manifest.requires_local_executor, true);
  const mcp = await readJSON(path.join(result.pluginDirectory, manifest.mcpServers));
  assert.equal(mcp.mcpServers.wetmytt.url, options.url);
  assert.deepEqual(mcp.mcpServers.wetmytt.http_headers, { Authorization: `Bearer ${options.token}` });
  const link = new URL(result.link);
  assert.equal(link.protocol, 'codex:');
  assert.equal(link.hostname, 'plugins');
  assert.equal(link.pathname, '/wetmytt');
  assert.equal(link.searchParams.get('marketplacePath'), result.marketplacePath);
  assert.ok(!(await fs.readFile(result.marketplacePath, 'utf8')).includes(options.token));
  assert.ok(!(await fs.readFile(path.join(result.pluginDirectory, '.codex-plugin/plugin.json'), 'utf8')).includes(options.token));
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(result.pluginDirectory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(result.pluginDirectory, '.mcp.json'))).mode & 0o777, 0o600);
  }
});

test('preserves existing marketplace plugins and metadata, and refreshes without duplicates', async t => {
  const options = await fixture(t);
  const marketplaceDirectory = path.join(options.homeDirectory, '.agents/plugins');
  await fs.mkdir(marketplaceDirectory, { recursive: true });
  const other = { name: 'other', source: './plugins/other', policy: { installation: 'AVAILABLE' }, extra: true };
  const marketplace = { name: 'personal-existing', interface: { displayName: 'Mine' }, plugins: [other], custom: { preserve: true } };
  const marketplacePath = path.join(marketplaceDirectory, 'marketplace.json');
  await fs.writeFile(marketplacePath, JSON.stringify(marketplace));
  const result = await prepareCodexPlugin(options);
  await prepareCodexPlugin({ ...options, token: 'updated-token' });
  const updated = await readJSON(marketplacePath);
  assert.equal(updated.name, marketplace.name);
  assert.deepEqual(updated.interface, marketplace.interface);
  assert.deepEqual(updated.custom, marketplace.custom);
  assert.deepEqual(updated.plugins[0], other);
  assert.equal(updated.plugins.filter(plugin => plugin.name === 'wetmytt').length, 1);
  assert.equal((await readJSON(path.join(result.pluginDirectory, '.mcp.json'))).mcpServers.wetmytt.http_headers.Authorization, 'Bearer updated-token');
});

test('does not overwrite malformed marketplaces, conflicting entries, or unrelated plugin folders', async t => {
  const options = await fixture(t);
  const directory = path.join(options.homeDirectory, '.agents/plugins');
  await fs.mkdir(directory, { recursive: true });
  const marketplacePath = path.join(directory, 'marketplace.json');
  for (const value of ['{broken', '{"name":"mine","plugins":{}}', '{"name":"mine","plugins":[{"name":"wetmytt","source":"./some-other-plugin"}]}']) {
    await fs.writeFile(marketplacePath, value);
    await assert.rejects(prepareCodexPlugin(options));
    assert.equal(await fs.readFile(marketplacePath, 'utf8'), value);
  }
  const valid = '{"name":"mine","plugins":[]}';
  await fs.writeFile(marketplacePath, valid);
  await fs.mkdir(path.join(directory, 'wetmytt'));
  await fs.writeFile(path.join(directory, 'wetmytt', 'keep.txt'), 'Keep me');
  await assert.rejects(prepareCodexPlugin(options), /other files/);
  assert.equal(await fs.readFile(path.join(directory, 'wetmytt', 'keep.txt'), 'utf8'), 'Keep me');
  assert.equal(await fs.readFile(marketplacePath, 'utf8'), valid);
});

test('opens Codex only after preparation and allows retry if opening fails', async t => {
  const options = await fixture(t);
  const failed = await connectCodex({ ...options, openExternal: async link => {
    assert.ok(await fs.stat(new URL(link).searchParams.get('marketplacePath')));
    throw new Error('No handler');
  } });
  assert.equal(failed.opened, false);
  assert.match(failed.error, /plugin is ready/);
  let opened;
  const success = await connectCodex({ ...options, openExternal: async link => { opened = link; } });
  assert.deepEqual(success, { opened: true });
  assert.ok(opened.startsWith('codex://plugins/wetmytt?'));
});

test('rejects a busy marketplace and never opens Codex if preparation fails', async t => {
  const options = await fixture(t);
  const directory = path.join(options.homeDirectory, '.agents/plugins');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'marketplace.json.lock'), '');
  let opened = false;
  await assert.rejects(connectCodex({ ...options, openExternal: async () => { opened = true; } }), /being updated/);
  assert.equal(opened, false);
  assert.ok(await fs.stat(path.join(directory, 'marketplace.json.lock')));
});
