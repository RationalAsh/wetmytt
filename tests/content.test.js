import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { textFields, replaceText } from '../shared/content.js';
import { readContent, saveContent } from '../electron/content.js';

test('text fields preserve nested keys, arrays, empty strings, and escaped JSON pointers', () => {
  const value = { slides: [{ title: 'Hello', bullets: ['First', ''] }], 'a/b~c': { 'prompt.key': 'Value' }, count: 3 };
  assert.deepEqual(textFields(value), [
    { path: '/slides/0/title', value: 'Hello' }, { path: '/slides/0/bullets/0', value: 'First' },
    { path: '/slides/0/bullets/1', value: '' }, { path: '/a~1b~0c/prompt.key', value: 'Value' },
  ]);
  replaceText(value, '/a~1b~0c/prompt.key', 'New\ntext');
  assert.equal(value['a/b~c']['prompt.key'], 'New\ntext');
  for (const pointer of ['/count', '/missing', '/slides/7/title', '/__proto__/polluted']) {
    assert.throws(() => replaceText(value, pointer, 'bad'));
  }
});

test('saving edits only the selected string and rejects stale or invalid edits', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wetmytt-content-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'deck.json');
  const original = JSON.stringify({ slides: [{ title: 'Same', body: 'Same' }], size: 16 });
  await fs.writeFile(file, original);
  const source = await readContent(root);
  const saved = await saveContent(root, source, '/slides/0/title', 'Edited "title"\nwith a newline');
  assert.deepEqual(JSON.parse(saved), { slides: [{ title: 'Edited "title"\nwith a newline', body: 'Same' }], size: 16 });
  await assert.rejects(saveContent(root, source, '/slides/0/body', 'Stale'), /changed on disk/);
  await assert.rejects(saveContent(root, saved, '/size', 'invalid'), /existing text field/);
  assert.equal(await readContent(root), saved);
});
