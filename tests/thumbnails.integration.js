import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

test('thumbnail navigation, scrolling, caching, refresh and project lifecycle in Electron', { timeout: 90000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wetmytt-thumbnails-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [fileURLToPath(new URL('./fixtures/thumbnails-app.js', import.meta.url)), directory], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0, log);
  assert.match(log, /Thumbnail integration passed\./, 'fixture must finish all assertions');
  if (process.env.WETMYTT_THUMBNAIL_TRACE) console.log(log);
  assert.doesNotMatch(log, /handler for 'deck:thumbnails':.*AbortError/, 'expected cancellations must not be logged as errors');
});
