import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeck } from '../electron/decks.js';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wetmytt-create-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'New presentation');
}

test('creates a new presentation with all starter files', async t => {
  const folder = await fixture(t);
  await createDeck(folder);
  const starter = fileURLToPath(new URL('../templates/starter/', import.meta.url));
  const entries = await fs.readdir(starter, { recursive: true, withFileTypes: true });
  assert.ok(entries.some(entry => entry.name === 'index.html'));
  for (const entry of entries) {
    const relative = path.relative(starter, path.join(entry.parentPath, entry.name));
    const destination = path.join(folder, relative);
    if (entry.isDirectory()) assert.ok((await fs.stat(destination)).isDirectory());
    else assert.deepEqual(await fs.readFile(destination), await fs.readFile(path.join(starter, relative)));
  }
});

test('rejects existing destinations without modifying them', async t => {
  const folder = await fixture(t);
  await fs.mkdir(folder);
  await assert.rejects(createDeck(folder), /Choose a new folder name/);
  assert.deepEqual(await fs.readdir(folder), []);
  await fs.writeFile(path.join(folder, 'index.html'), 'Existing presentation');
  await assert.rejects(createDeck(folder), /Choose a new folder name/);
  assert.equal(await fs.readFile(path.join(folder, 'index.html'), 'utf8'), 'Existing presentation');
  assert.deepEqual(await fs.readdir(folder), ['index.html']);
});
