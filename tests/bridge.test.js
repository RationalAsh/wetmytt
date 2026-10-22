import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

test('preview forwards file drags and drops to its parent and prevents file navigation', async () => {
  const listeners = {}, messages = [];
  const parent = { postMessage: (message, origin) => messages.push({ message, origin }) };
  vm.runInNewContext(await fs.readFile(new URL('../electron/bridge.js', import.meta.url), 'utf8'), {
    parent,
    document: { querySelectorAll: () => [], body: {}, title: 'Deck' },
    MutationObserver: class { observe() {} },
    addEventListener: (name, listener) => { listeners[name] = listener; },
  });
  const origin = 'http://127.0.0.1:3210';
  listeners.message({ source: parent, origin, data: { type: 'decklet:navigate', index: 0 } });
  messages.length = 0;
  const file = new File(['image'], 'photo.png');
  for (const type of ['dragenter', 'dragover', 'drop']) {
    let prevented = false;
    const dataTransfer = { types: ['Files'], files: [file] };
    listeners[type]({ dataTransfer, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(dataTransfer.dropEffect, 'copy');
    assert.equal(messages.at(-1).origin, origin);
    assert.equal(messages.at(-1).message.type, type === 'drop' ? 'decklet:drop' : 'decklet:drag');
  }
  assert.equal(messages.at(-1).message.files[0], file);
  listeners.drop({ dataTransfer: { types: ['text/plain'] }, preventDefault: () => assert.fail('Text drops should be unaffected') });
  assert.equal(messages.length, 3);
});
