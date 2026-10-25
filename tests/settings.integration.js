import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

test('settings save without an AI connection and persist across app restarts', { timeout: 90000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wetmytt-settings-ui-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.WETMYTT_DEV_URL;
  for (const phase of ['save', 'reload', 'connected']) {
    const child = spawn(electron, [fileURLToPath(new URL('./fixtures/settings-app.js', import.meta.url)), directory, phase], { env, timeout: 25000, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', chunk => { log += chunk; process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { log += chunk; });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0, log);
  }
});
