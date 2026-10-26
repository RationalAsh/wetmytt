import test from 'node:test';
import assert from 'node:assert/strict';
import { createAISettings } from '../electron/ai-settings.js';

const saved = { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1', maxTurns: 72, encryptedKey: Buffer.from('encrypted').toString('base64') };
function fixture() {
  const calls = { available: 0, decrypt: 0, encrypt: 0 }, writes = [];
  const safeStorage = {
    async isAsyncEncryptionAvailable() { calls.available++; return true; },
    async decryptStringAsync(cipher) { calls.decrypt++; assert.equal(cipher.toString(), 'encrypted'); return { result: 'test-api-key' }; },
    async encryptStringAsync(key) { calls.encrypt++; assert.equal(key, 'replacement'); return Buffer.from('replacement-cipher'); },
  };
  const store = createAISettings({ safeStorage, write: async value => { writes.push(value); } });
  store.load(saved);
  return { store, calls, writes, safeStorage };
}

test('loading metadata, context, preferences, and model changes preserve the locked key without Keychain access', async () => {
  const { store, calls, writes } = fixture();
  assert.equal(store.state().hasKey, true);
  assert.equal(store.context().apiKey, '');
  assert.equal(Object.hasOwn(store.state(), 'apiKey'), false);
  await store.savePreferences({ maxTurns: 90 });
  await store.saveConnection({ provider: saved.provider, baseUrl: saved.baseUrl, model: 'gpt-4.1-mini' });
  assert.deepEqual(calls, { available: 0, decrypt: 0, encrypt: 0 });
  assert.equal(writes.length, 2);
  for (const value of writes) {
    assert.equal(value.encryptedKey, saved.encryptedKey);
    assert.equal(Object.hasOwn(value, 'apiKey'), false);
  }
  assert.equal(store.state().maxTurns, 90);
});

test('first chat unlocks once, concurrent requests share access, and later requests use memory', async () => {
  const { store, calls, writes } = fixture();
  const connections = await Promise.all([store.connection(), store.connection()]);
  assert.equal(connections[0].apiKey, 'test-api-key');
  assert.equal(connections[1].apiKey, 'test-api-key');
  await store.connection();
  await store.savePreferences({ maxTurns: 80 });
  await store.saveConnection({ ...saved, model: 'gpt-4.1-mini' });
  assert.deepEqual(calls, { available: 1, decrypt: 1, encrypt: 0 });
  for (const value of writes) assert.equal(value.encryptedKey, saved.encryptedKey);
});

test('denied or unavailable Keychain access retains credentials and permits retry', async () => {
  const { store, safeStorage } = fixture();
  const decrypt = safeStorage.decryptStringAsync;
  safeStorage.decryptStringAsync = () => { throw new Error('denied'); };
  await assert.rejects(store.connection(), /Could not unlock/);
  assert.equal(store.state().hasKey, true);
  safeStorage.isAsyncEncryptionAvailable = () => { throw new Error('unavailable'); };
  await assert.rejects(store.connection(), /Could not unlock/);
  safeStorage.isAsyncEncryptionAvailable = async () => true;
  safeStorage.decryptStringAsync = decrypt;
  assert.equal((await store.connection()).apiKey, 'test-api-key');
});

test('replacing or removing a key never decrypts the old key and a changed endpoint cannot inherit it', async () => {
  const { store, calls, writes } = fixture();
  await assert.rejects(store.saveConnection({ ...saved, baseUrl: 'https://example.com/v1' }), /Enter an API key/);
  assert.equal(writes.length, 0);
  await store.saveConnection({ ...saved, apiKey: 'replacement' });
  assert.deepEqual(calls, { available: 1, decrypt: 0, encrypt: 1 });
  assert.equal(writes.at(-1).encryptedKey, Buffer.from('replacement-cipher').toString('base64'));
  await store.saveConnection({ ...saved, apiKey: '' });
  assert.equal(writes.at(-1).encryptedKey, null);
  assert.equal(store.state().hasKey, false);
  assert.equal(calls.decrypt, 0);
});

test('an outstanding unlock cannot restore a key removed while the prompt was open', async () => {
  const { store, safeStorage } = fixture();
  let finish;
  safeStorage.decryptStringAsync = () => new Promise(resolve => { finish = resolve; });
  const pending = store.connection();
  await new Promise(resolve => setImmediate(resolve));
  await store.saveConnection({ ...saved, apiKey: '' });
  finish({ result: 'old-key' });
  await assert.rejects(pending, /settings changed/);
  assert.equal(store.state().hasKey, false);
  assert.equal(store.context().apiKey, '');
});
