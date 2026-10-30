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
    else if (relative === 'deck.json') {
      const actual = JSON.parse(await fs.readFile(destination, 'utf8'));
      const template = JSON.parse(await fs.readFile(path.join(starter, relative), 'utf8'));
      assert.equal(new Set(actual.slides.map(slide => slide.id)).size, actual.slides.length);
      actual.slides.forEach((slide, index) => {
        assert.match(slide.id, /^[0-9a-f-]{36}$/);
        assert.notEqual(slide.id, template.slides[index].id);
        template.slides[index].id = slide.id;
      });
      assert.deepEqual(actual, template);
    } else assert.deepEqual(await fs.readFile(destination), await fs.readFile(path.join(starter, relative)));
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
