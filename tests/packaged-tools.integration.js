import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('packaged app loads shared tools from ASAR and creates history using its bundled Git', { timeout: 30000 }, async t => {
  const app = process.env.WETMYTT_PACKAGED_APP || path.resolve(`dist/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/Welcome to My TED Talk.app`);
  const binary = path.join(app, 'Contents/MacOS/Welcome to My TED Talk');
  const resources = path.join(app, 'Contents/Resources');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wetmytt-packaged-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const script = path.join(directory, 'check.cjs');
  await fs.writeFile(script, `
    const { pathToFileURL } = require('node:url');
    (async () => {
      const base = pathToFileURL(process.argv[2] + '/app.asar/').href;
      const { createDeck } = await import(base + 'electron/decks.js');
      const { runTool, toolDefinitions } = await import(base + 'electron/tools.js');
      const root = process.argv[3] + '/deck';
      await createDeck(root);
      console.log(JSON.stringify({ tools: toolDefinitions.map(tool => tool.name), status: await runTool(root, 'git_status', {}), log: await runTool(root, 'git_log', {}) }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `);
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', PATH: '/nonexistent' };
  const { stdout } = await promisify(execFile)(binary, [script, resources, directory], { env, timeout: 25000 });
  const result = JSON.parse(stdout);
  assert.equal(result.status.trim(), '## main');
  assert.match(result.log, /Create presentation/);
  assert.ok(result.tools.includes('search_web') && result.tools.includes('apply_patch'));
  assert.ok(!result.tools.includes('run_command'));
  await fs.access(path.join(resources, 'git-notices.md'));
  assert.match(await fs.readFile(path.join(resources, 'git/COPYING'), 'utf8'), /GNU GENERAL PUBLIC LICENSE/);
  const distribution = JSON.parse(await fs.readFile(path.join(resources, 'git/distribution.json'), 'utf8'));
  assert.ok(distribution.name.includes(process.arch));
});
