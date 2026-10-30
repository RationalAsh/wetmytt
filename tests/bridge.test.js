import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

test('preview forwards file drags and drops to its parent and prevents file navigation', async () => {
  const listeners = {}, messages = [];
  const parent = { postMessage: (message, origin) => messages.push({ message, origin }) };
  vm.runInNewContext(await fs.readFile(new URL('../electron/bridge.js', import.meta.url), 'utf8'), {
    parent, window: {}, location: { search: '' }, URLSearchParams,
    document: { querySelectorAll: () => [], body: {}, documentElement: { dataset: {} }, title: 'Deck', createElement: () => ({}), head: { append() {} } },
    MutationObserver: class { observe() {} },
    addEventListener: (name, listener) => { listeners[name] = listener; },
  });
  const origin = 'http://127.0.0.1:3210';
  listeners.message({ source: parent, origin, data: { type: 'wetmytt:navigate', index: 0 } });
  messages.length = 0;
  const file = new File(['image'], 'photo.png');
  for (const type of ['dragenter', 'dragover', 'drop']) {
    let prevented = false;
    const dataTransfer = { types: ['Files'], files: [file] };
    listeners[type]({ dataTransfer, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(dataTransfer.dropEffect, 'copy');
    assert.equal(messages.at(-1).origin, origin);
    assert.equal(messages.at(-1).message.type, type === 'drop' ? 'wetmytt:drop' : 'wetmytt:drag');
  }
  assert.equal(messages.at(-1).message.files[0], file);
  listeners.drop({ dataTransfer: { types: ['text/plain'] }, preventDefault: () => assert.fail('Text drops should be unaffected') });
  assert.equal(messages.length, 3);
});

test('bridge reports stable identities and requires non-nested data-slide-id containers for management', async () => {
  const source = await fs.readFile(new URL('../electron/bridge.js', import.meta.url), 'utf8');
  for (const scenario of [
    { ids: ['a', 'b'], managed: true, stable: true },
    { ids: ['a', 'a'], managed: true, stable: false },
    { ids: ['', ''], managed: false, stable: false },
    { ids: ['a', 'b'], nested: true, managed: false, stable: true },
  ]) {
    const messages = [], listeners = {};
    const slides = scenario.ids.map(id => ({ dataset: { slideId: id }, parentElement: { closest: () => scenario.nested ? {} : null } }));
    const parent = { postMessage: message => messages.push(message) };
    vm.runInNewContext(source, {
      parent, window: {}, location: { search: '?contentRevision=3' }, URLSearchParams,
      document: { querySelectorAll: () => slides, body: {}, documentElement: { dataset: {} }, title: 'Deck', createElement: () => ({}), head: { append() {} } },
      MutationObserver: class { observe() {} },
      addEventListener: (name, listener) => { listeners[name] = listener; },
    });
    listeners.message({ source: parent, origin: 'http://localhost', data: { type: 'wetmytt:navigate', index: 0 } });
    assert.equal(messages.at(-1).managedSlides, scenario.managed);
    assert.deepEqual(Array.from(messages.at(-1).slides), scenario.stable ? scenario.ids.map(id => `id:${id}`) : ['index:3:0', 'index:3:1']);
  }
});
