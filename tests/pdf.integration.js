import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runElectronFixture } from './helpers/electron.js';

test('PDF export in the actual Electron app', { timeout: 180000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wetmytt-pdf-'));
  const output = process.env.WETMYTT_PDF_TEST_OUTPUT || path.join(directory, 'output');
  const fixture = runElectronFixture(t, fileURLToPath(new URL('./fixtures/pdf-app.js', import.meta.url)), [directory, output], { timeout: 150000 });
  t.after(async () => {
    await fixture.catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });
  const log = await fixture;
  assert.match(log, /PDF integration passed/);
});
