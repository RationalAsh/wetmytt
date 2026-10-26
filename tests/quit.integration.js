import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

for (const mode of ['open', 'closed']) {
  test(`macOS Quit exits the actual app with its window ${mode}`, { skip: process.platform !== 'darwin', timeout: 30000 }, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wetmytt-quit-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [fileURLToPath(new URL('./fixtures/quit-app.js', import.meta.url)), directory, mode], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', chunk => { log += chunk; });
    child.stderr.on('data', chunk => { log += chunk; });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0, log);
    assert.match(log, /Quit completed/);
  });
}
