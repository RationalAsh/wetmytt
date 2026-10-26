import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { conversationTokens } from '../shared/ai.js';
import { listChats, loadChat, runConversation } from '../electron/chats.js';
import { chat } from '../electron/agent.js';

const settings = { provider: 'openai', model: 'test-model', baseUrl: 'https://api.openai.com/v1', apiKey: 'secret-key' };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wetmytt-chats-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const request = (root, extra = {}) => ({ root, text: 'Help with the opening', settings, signal: new AbortController().signal, onActivity() {}, chat: async () => 'Try a question.', ...extra });

test('saves and reloads chats, retains per-request models, and starts with fresh context', async t => {
  const root = await fixture(t);
  assert.deepEqual(await listChats(root), []);
  const first = (await runConversation(request(root, { chat: async () => {
    const saved = await listChats(root);
    assert.equal(saved.length, 1);
    const log = await loadChat(root, saved[0].id);
    assert.equal(log.requests[0].status, 'running');
    assert.equal(log.messages[0].content, 'Help with the opening');
    return 'Try a question.';
  } }))).conversation;
  const next = (await runConversation(request(root, { id: first.id, text: 'Make it shorter', settings: { ...settings, provider: 'ollama', model: 'another-model' }, chat: async ({ history }) => {
    assert.deepEqual(history, [{ role: 'user', content: 'Help with the opening' }, { role: 'assistant', content: 'Try a question.' }, { role: 'user', content: 'Make it shorter' }]);
    return 'Why?';
  } }))).conversation;
  assert.equal(next.id, first.id);
  assert.equal(next.requests[0].model, 'test-model');
  assert.equal(next.requests[1].model, 'another-model');
  assert.equal(next.requests[1].status, 'completed');
  assert.deepEqual(await loadChat(root, first.id), next);
  const fresh = (await runConversation(request(root, { chat: async ({ history }) => { assert.equal(history.length, 1); return 'Fresh.'; } }))).conversation;
  assert.notEqual(fresh.id, first.id);
  assert.equal((await listChats(root)).length, 2);
  const raw = await fs.readFile(path.join(root, '.wetmytt', 'chats', `${first.id}.json`), 'utf8');
  assert.ok(!raw.includes('secret-key'));
  assert.ok(!raw.includes('apiKey'));
  assert.equal((await fs.stat(path.join(root, '.wetmytt', 'chats', `${first.id}.json`))).mode & 0o777, 0o600);
  assert.deepEqual(await listChats(await fixture(t)), []);
});

test('stores provider token usage and keeps the previous count when a later reply fails', async t => {
  const root = await fixture(t);
  const saved = (await runConversation(request(root, { chat: async () => ({ content: 'Done.', usage: { inputTokens: 120.2, outputTokens: 30 } }) }))).conversation;
  assert.deepEqual(saved.requests[0].usage, { inputTokens: 120, outputTokens: 30 });
  const again = (await runConversation(request(root, { id: saved.id, text: 'Next', chat: async () => { throw new Error('nope'); } }))).conversation;
  assert.equal(again.requests[1].usage, undefined);
  assert.equal(conversationTokens(again.requests), 150);
  assert.equal(conversationTokens(await loadChat(root, saved.id).then(chat => chat.requests)), 150);
});

test('preserves prompts and request status after provider failures and cancellation', async t => {
  const root = await fixture(t);
  const failed = await runConversation(request(root, { chat: async () => { throw new Error('provider unavailable'); } }));
  assert.equal(failed.error, 'provider unavailable');
  const saved = await loadChat(root, failed.conversation.id);
  assert.equal(saved.requests[0].status, 'failed');
  assert.equal(saved.messages.length, 1);
  const controller = new AbortController();
  const stopped = await runConversation(request(root, { signal: controller.signal, chat: async () => { controller.abort(); throw controller.signal.reason; } }));
  assert.equal(stopped.error, 'Generation stopped.');
  assert.equal((await loadChat(root, stopped.conversation.id)).requests[0].status, 'cancelled');
});

test('rejects invalid IDs and symlinked storage, and skips damaged logs', async t => {
  const root = await fixture(t);
  await assert.rejects(loadChat(root, '../settings'), /Invalid conversation ID/);
  const saved = (await runConversation(request(root))).conversation;
  await fs.writeFile(path.join(root, '.wetmytt', 'chats', '11111111-1111-1111-1111-111111111111.json'), '{');
  assert.equal((await listChats(root)).length, 1);
  await assert.rejects(loadChat(root, '11111111-1111-1111-1111-111111111111'), SyntaxError);
  const other = await fixture(t);
  await fs.symlink(path.join(root, '.wetmytt'), path.join(other, '.wetmytt'));
  await assert.rejects(runConversation(request(other)), /inside the project/);
  assert.equal((await loadChat(root, saved.id)).messages.length, 2);
});

test('persists live tool details, errors and commentary without replaying activity into model history', async t => {
  const root = await fixture(t);
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  let calls = 0;
  globalThis.fetch = async () => Response.json({ choices: [{ message: calls++ === 0 ? {
    content: 'I will inspect the deck.', tool_calls: [
      { id: 'read', function: { name: 'read_file', arguments: JSON.stringify({ path: 'index.html' }) } },
      { id: 'bad', function: { name: 'read_file', arguments: '{bad json' } },
    ],
  } : { content: 'Inspection complete.' } }] });
  await fs.writeFile(path.join(root, 'index.html'), 'x'.repeat(30000));
  const snapshots = [];
  const result = await runConversation(request(root, { chat, onConversation: conversation => snapshots.push(structuredClone(conversation)) }));
  assert.equal(result.error, undefined);
  const saved = await loadChat(root, result.conversation.id);
  assert.deepEqual(saved, result.conversation);
  assert.equal(saved.messages.length, 3);
  const activity = saved.messages[1];
  assert.equal(activity.activity, true);
  assert.equal(activity.content, 'I will inspect the deck.');
  assert.deepEqual(activity.tools.map(tool => tool.status), ['completed', 'failed']);
  assert.match(activity.tools[0].result, /Display truncated/);
  assert.match(activity.tools[1].result, /^Error:/);
  assert.ok(snapshots.some(snapshot => snapshot.messages[1]?.tools[0].status === 'running'));
  assert.equal(snapshots.at(-1).requests[0].status, 'completed');
  await runConversation(request(root, { id: saved.id, text: 'Continue', chat: async ({ history }) => {
    assert.deepEqual(history.map(message => message.content), ['Help with the opening', 'Inspection complete.', 'Continue']);
    return 'Continued.';
  } }));
});

test('keeps tool results after Stop and closes pending calls after cancellation or failure', async t => {
  const root = await fixture(t);
  for (const cancelled of [true, false]) {
    const controller = new AbortController();
    const result = await runConversation(request(root, { signal: controller.signal, chat: async ({ onEvent }) => {
      await onEvent({ type: 'assistant', content: '', tools: [
        { id: 'done', name: 'write_file', argsText: '{}', status: 'pending' },
        { id: 'waiting', name: 'read_file', argsText: '{}', status: 'pending' },
      ] });
      await onEvent({ type: 'tool', id: 'done', status: 'completed', result: 'Saved.' });
      await onEvent({ type: 'tool', id: 'waiting', status: 'running' });
      if (cancelled) controller.abort();
      throw new Error('Request interrupted');
    } }));
    const saved = await loadChat(root, result.conversation.id);
    assert.equal(saved.requests[0].status, cancelled ? 'cancelled' : 'failed');
    assert.equal(saved.messages[1].tools[0].result, 'Saved.');
    assert.equal(saved.messages[1].tools[1].status, cancelled ? 'cancelled' : 'failed');
  }
});
