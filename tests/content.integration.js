import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runElectronFixture } from './helpers/electron.js';

test('text editing in the actual Electron app', { timeout: 90000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wetmytt-edit-'));
  const fixture = runElectronFixture(t, fileURLToPath(new URL('./fixtures/content-app.js', import.meta.url)), [directory]);
  t.after(async () => {
    await fixture.catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });
  const log = await fixture;
  assert.match(log, /Edit integration passed/);
});
