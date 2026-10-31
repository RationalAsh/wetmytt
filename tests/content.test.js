import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { textFields, replaceText, replaceValue } from '../shared/content.js';
import { humanize, singular, stringKind, expandHex, findSlides, slideTitle, imagePaths, pointerChild } from '../shared/content-form.js';
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
  await assert.rejects(saveContent(root, saved, '/size', 'invalid'), /existing field/);
  assert.equal(await readContent(root), saved);
});

test('replaceValue keeps each value kind and supports string lists', () => {
  const value = { slides: [{ title: 'Hi', bullets: ['a'], wide: true, id: 'x' }], size: 16, wetmytt: { slideManagement: 1 } };
  replaceValue(value, '/slides/0/bullets', ['b', 'a', '']);
  replaceValue(value, '/slides/0/wide', false);
  replaceValue(value, '/size', 18);
  assert.deepEqual(value.slides[0], { title: 'Hi', bullets: ['b', 'a', ''], wide: false, id: 'x' });
  assert.equal(value.size, 18);
  for (const [pointer, next] of [['/size', '18'], ['/size', Infinity], ['/slides/0/title', ['x']], ['/slides/0/bullets', [1]], ['/slides/0/wide', 'no'], ['/slides/0/id', 'y'], ['/wetmytt/slideManagement', 2], ['/missing', 'x']]) {
    assert.throws(() => replaceValue(value, pointer, next), undefined, `${pointer} ${String(next)}`);
  }
});

test('form helpers label keys and pick widgets from the data', () => {
  assert.equal(humanize('bullets'), 'Bullet points');
  assert.equal(humanize('heroImage'), 'Hero image');
  assert.equal(humanize('speaker_notes'), 'Speaker notes');
  assert.equal(singular('Bullet points'), 'bullet point');
  assert.deepEqual(stringKind('image', 'assets/orbit.svg'), { kind: 'image' });
  assert.deepEqual(stringKind('hero', 'assets/a.PNG'), { kind: 'image' });
  assert.deepEqual(stringKind('accent', '#abc'), { kind: 'color' });
  assert.deepEqual(stringKind('layout', 'split', ['cover', 'split', 'closing']), { kind: 'choice', options: ['cover', 'split', 'closing'] });
  assert.equal(stringKind('layout', 'only', ['only']).kind, 'short');
  assert.equal(stringKind('title', 'a\nb').kind, 'long');
  assert.equal(stringKind('body', 'x'.repeat(61)).kind, 'long');
  assert.equal(expandHex('#abc'), '#aabbcc');
  const doc = { title: 'T', slides: [{ title: 'One', image: 'assets/a.svg' }, { eyebrow: 'Only' }] };
  assert.equal(findSlides(doc).key, 'slides');
  assert.equal(findSlides({ title: 'x' }), null);
  assert.equal(slideTitle(doc.slides[0]), 'One');
  assert.equal(slideTitle(doc.slides[1]), 'Only');
  assert.deepEqual(imagePaths(doc), ['assets/a.svg']);
  assert.equal(pointerChild('/a', 'b/c~'), '/a/b~1c~0');
});
