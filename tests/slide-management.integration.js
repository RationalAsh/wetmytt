import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

test('slide management in the actual Electron app', { timeout: 90000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wetmytt-manage-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [fileURLToPath(new URL('./fixtures/slide-management-app.js', import.meta.url)), directory], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; if (process.env.WETMYTT_MANAGE_TRACE) process.stdout.write(chunk); });
  child.stderr.on('data', chunk => { log += chunk; if (process.env.WETMYTT_MANAGE_TRACE) process.stderr.write(chunk); });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0, log);
  assert.match(log, /Slide management integration passed/);
});
