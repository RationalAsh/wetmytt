import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { slideManagement, readSlideManagement, mutateSlide } from '../electron/slide-management.js';
import { readContent, saveContent } from '../electron/content.js';
import { textFields, replaceText } from '../shared/content.js';

const deck = () => ({ wetmytt: { slideManagement: 1, note: 'internal' }, title: 'Talk', custom: { preserve: true }, slides: [{ id: 'a', title: 'A', image: 'assets/a.png', nested: { bullets: ['One'] } }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }] });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wetmytt-slides-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'deck.json'), JSON.stringify(deck()));
  const act = async (type, id) => {
    const source = await readContent(root);
    return mutateSlide(root, source, slideManagement(source).ids.map(id => `id:${id}`), { type, id });
  };
  return { root, act };
}

test('requires opt-in, slide objects, and unique nonempty IDs', async t => {
  for (const value of [{}, null, { slides: [] }, { ...deck(), slides: [] }, { ...deck(), slides: ['a'] }, { ...deck(), slides: [{ id: '' }] }, { ...deck(), slides: [{ id: 'a' }, { id: 'a' }] }]) {
    assert.equal(slideManagement(JSON.stringify(value)).supported, false);
  }
  const { root } = await fixture(t);
  await fs.writeFile(path.join(root, 'deck.json'), 'broken');
  assert.equal((await readSlideManagement(root)).supported, false);
});

test('duplicates complete slide JSON with fresh identity and shared assets', async t => {
  const { root, act } = await fixture(t);
  const result = await act('duplicate', 'a');
  const value = JSON.parse(result.source);
  assert.match(result.duplicateId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(result.ids, ['a', result.duplicateId, 'b', 'c']);
  assert.deepEqual(value.slides[1], { ...deck().slides[0], id: result.duplicateId });
  assert.deepEqual(value.custom, deck().custom);
  assert.equal(await readContent(root), result.source);
});

test('moves preserve IDs and boundaries, deletion preserves one slide', async t => {
  const { root, act } = await fixture(t);
  assert.deepEqual((await act('moveEarlier', 'b')).ids, ['b', 'a', 'c']);
  assert.deepEqual((await act('moveLater', 'b')).ids, ['a', 'b', 'c']);
  const source = await readContent(root);
  await assert.rejects(act('moveEarlier', 'a'), /cannot move/);
  await assert.rejects(act('moveLater', 'c'), /cannot move/);
  await assert.rejects(act('delete', 'missing'), /no longer exists/);
  await assert.rejects(act('surprise', 'a'), /Unknown/);
  assert.equal(await readContent(root), source);
  await act('delete', 'b'); await act('delete', 'a');
  await assert.rejects(act('delete', 'c'), /at least one/);
});

test('rejects stale snapshots, mismatched rendered identities and failed revision guards without writes', async t => {
  const { root } = await fixture(t);
  const source = await readContent(root);
  await assert.rejects(mutateSlide(root, source, ['id:b', 'id:a', 'id:c'], { type: 'delete', id: 'a' }), /do not match/);
  await assert.rejects(mutateSlide(root, source, ['id:a', 'id:b', 'id:c'], { type: 'delete', id: 'a' }, () => { throw new Error('revision changed'); }), /revision changed/);
  assert.equal(await readContent(root), source);
  await saveContent(root, source, '/slides/0/title', 'New');
  await assert.rejects(mutateSlide(root, source, ['id:a', 'id:b', 'id:c'], { type: 'delete', id: 'a' }), /changed on disk/);
});

test('serializes text and structural writes, rejecting the losing stale save', async t => {
  const { root } = await fixture(t);
  const source = await readContent(root);
  const results = await Promise.allSettled([
    mutateSlide(root, source, ['id:a', 'id:b', 'id:c'], { type: 'moveLater', id: 'a' }),
    saveContent(root, source, '/slides/0/title', 'Wrong slide'),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.deepEqual(JSON.parse(await readContent(root)).slides.map(slide => slide.title), ['B', 'A', 'C']);
});

test('reserved metadata is hidden and protected only for opted-in decks', () => {
  const value = deck();
  assert.ok(!textFields(value).some(field => field.path.includes('/id') || field.path.startsWith('/wetmytt/')));
  assert.throws(() => replaceText(value, '/slides/0/id', 'changed'), /cannot be edited/);
  assert.throws(() => replaceText(value, '/wetmytt/note', 'changed'), /cannot be edited/);
  delete value.wetmytt;
  assert.ok(textFields(value).some(field => field.path === '/slides/0/id'));
  replaceText(value, '/slides/0/id', 'legacy');
});

test('queued structural writes recheck state after a text save and recover after rejection', async t => {
  const { root, act } = await fixture(t);
  const source = await readContent(root);
  const results = await Promise.allSettled([
    saveContent(root, source, '/slides/0/title', 'Saved first'),
    mutateSlide(root, source, ['id:a', 'id:b', 'id:c'], { type: 'delete', id: 'a' }),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(JSON.parse(await readContent(root)).slides[0].title, 'Saved first');
  assert.equal((await act('duplicate', 'a')).ids.length, 4);
});

test('rechecks generation and revision before writing after asynchronous reads', async t => {
  const { root } = await fixture(t);
  const source = await readContent(root);
  for (const failAt of [2, 3, 4]) {
    let checks = 0;
    await assert.rejects(mutateSlide(root, source, ['id:a', 'id:b', 'id:c'], { type: 'duplicate', id: 'a' }, () => {
      if (++checks === failAt) throw new Error('project changed');
    }), /project changed/);
    assert.equal(await readContent(root), source);
  }
});
