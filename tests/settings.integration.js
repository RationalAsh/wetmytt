import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runElectronFixture } from './helpers/electron.js';

test('settings save without an AI connection and persist across app restarts', { timeout: 90000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wetmytt-settings-ui-'));
  let fixture;
  t.after(async () => {
    await fixture?.catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });
  for (const phase of ['save', 'reload', 'connected']) {
    fixture = runElectronFixture(t, fileURLToPath(new URL('./fixtures/settings-app.js', import.meta.url)), [directory, phase], { timeout: 25000 });
    const log = await fixture;
    assert.match(log, new RegExp(`Settings ${phase} checks passed`));
  }
});
