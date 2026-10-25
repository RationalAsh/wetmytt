import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRecentFolders } from '../electron/recent-folders.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wetmytt-recent-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'settings', 'recent-folders.json');
  const folders = await Promise.all(Array.from({ length: 12 }, async (_, index) => {
    const folder = path.join(root, `deck-${index}`);
    await fs.mkdir(folder);
    return fs.realpath(folder);
  }));
  return { filename, folders, store: createRecentFolders(filename) };
}

test('recent folders persist newest first, deduplicate real paths, and keep only ten entries', async t => {
  const { filename, folders, store } = await fixture(t);
  assert.deepEqual(await store.load(), []);
  await Promise.all(folders.map(folder => store.add(folder)));
  assert.deepEqual(store.list(), folders.slice(2).reverse());
  const alias = path.join(path.dirname(folders[0]), 'alias');
  await fs.symlink(folders[5], alias);
  await store.add(alias);
  const expected = [folders[5], ...folders.slice(2).reverse().filter(folder => folder !== folders[5])];
  assert.deepEqual(store.list(), expected);
  const restored = createRecentFolders(filename);
  assert.deepEqual(await restored.load(), expected);
  await restored.remove(folders[5]);
  assert.deepEqual(restored.list(), expected.slice(1));
  await restored.clear();
  assert.deepEqual(await createRecentFolders(filename).load(), []);
  assert.equal(await fs.stat(folders[5]).then(stat => stat.isDirectory()), true);
});

test('recent folders tolerate damaged storage, validate saved paths, and retain missing entries until removed', async t => {
  const { filename, folders, store } = await fixture(t);
  await fs.mkdir(path.dirname(filename));
  await fs.writeFile(filename, '{broken');
  assert.deepEqual(await store.load(), []);
  await fs.writeFile(filename, JSON.stringify([null, 12, 'relative', folders[0], folders[0], folders[1]]));
  assert.deepEqual(await store.load(), folders.slice(0, 2));
  await fs.rmdir(folders[0]);
  await assert.rejects(store.add(folders[0]), { code: 'ENOENT' });
  assert.deepEqual(store.list(), folders.slice(0, 2));
  await store.add(folders[2]);
  assert.deepEqual(store.list(), [folders[2], folders[0], folders[1]]);
});
