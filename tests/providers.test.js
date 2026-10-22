import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings, inferProvider, providers } from '../shared/ai.js';
import { requestMessage } from '../electron/providers.js';
import { toolDefinitions } from '../electron/agent.js';

const connection = (provider = 'openai') => ({ provider, baseUrl: providers[provider].baseUrl, model: 'test-model', apiKey: 'secret' });
const messages = [{ role: 'system', content: 'Edit the deck.' }, { role: 'user', content: 'List files.' }];
const signal = () => new AbortController().signal;
const mocked = new WeakSet();
function mockFetch(t, callback) {
  if (!mocked.has(t)) {
    mocked.add(t);
    const previous = globalThis.fetch;
    t.after(() => { globalThis.fetch = previous; });
  }
  globalThis.fetch = callback;
}

test('settings require supported providers, models, secure base URLs, and cloud keys', () => {
  for (const patch of [
    { provider: 'unknown' }, { model: ' ' }, { baseUrl: 'broken' },
    { baseUrl: 'http://example.com/v1' }, { baseUrl: 'https://user:secret@example.com/v1' },
    { baseUrl: 'https://example.com/v1?key=secret' }, { baseUrl: 'https://example.com/v1#hash' },
    { baseUrl: 'https://example.com/v1/messages' }, { baseUrl: 'https://example.com/v1/chat/completions/' },
    { apiKey: '' }, { apiKey: 'bad\nkey' },
  ]) assert.throws(() => normalizeSettings({ ...connection(), ...patch }));
  assert.equal(normalizeSettings({ ...connection('ollama'), apiKey: '' }).apiKey, '');
  assert.throws(() => normalizeSettings({ ...connection('ollama'), baseUrl: 'https://remote.example/v1', apiKey: '' }));
  assert.equal(normalizeSettings({ ...connection(), baseUrl: 'https://api.openai.com/v1/', model: ' test ' }).model, 'test');
});

test('keys are retained only for the same provider and normalized endpoint', () => {
  const previous = connection();
  assert.equal(normalizeSettings({ ...previous, apiKey: undefined, baseUrl: `${previous.baseUrl}/` }, previous).apiKey, 'secret');
  for (const patch of [{ provider: 'claude' }, { baseUrl: 'https://proxy.example/v1' }]) {
    assert.throws(() => normalizeSettings({ ...previous, ...patch, apiKey: undefined }, previous), /API key/);
  }
  assert.equal(normalizeSettings({ ...connection('ollama'), apiKey: undefined }, previous).apiKey, '');
  assert.equal(inferProvider('https://openrouter.ai/api/v1'), 'openrouter');
  assert.equal(inferProvider('https://api.anthropic.com/v1'), 'claude');
  assert.equal(inferProvider('http://127.0.0.1:11434/v1'), 'ollama');
});

test('OpenAI, OpenRouter, and Ollama use Chat Completions with tools', async t => {
  for (const provider of ['openai', 'openrouter', 'ollama']) {
    mockFetch(t, async (url, options) => {
      assert.equal(url, `${providers[provider].baseUrl}/chat/completions`);
      assert.equal(options.headers.Authorization, 'Bearer secret');
      assert.equal(options.redirect, 'error');
      const body = JSON.parse(options.body);
      assert.equal(body.tools[0].function.name, 'list_files');
      assert.equal(body.provider?.require_parameters, provider === 'openrouter' ? true : undefined);
      return Response.json({ choices: [{ message: { content: 'Hello.' } }] });
    });
    assert.equal((await requestMessage(connection(provider), messages, toolDefinitions, signal())).content, 'Hello.');
  }
});

test('Claude translates system prompts, tool definitions, tool calls and results', async t => {
  let calls = 0;
  mockFetch(t, async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(options.headers['x-api-key'], 'secret');
    assert.equal(options.headers['anthropic-version'], '2023-06-01');
    assert.equal(options.headers.Authorization, undefined);
    const body = JSON.parse(options.body);
    assert.equal(body.system, 'Edit the deck.');
    assert.equal(body.max_tokens, 8192);
    assert.equal(body.tools[0].input_schema.type, 'object');
    if (calls === 1) return Response.json({ content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'call1', name: 'list_files', input: {} }], stop_reason: 'tool_use' });
    assert.deepEqual(body.messages.at(-2), { role: 'assistant', content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'call1', name: 'list_files', input: {} }] });
    assert.deepEqual(body.messages.at(-1), { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call1', content: '["index.html"]' }] });
    return Response.json({ content: [{ type: 'text', text: 'Found index.html.' }], stop_reason: 'end_turn' });
  });
  const first = await requestMessage(connection('claude'), messages, toolDefinitions, signal());
  const result = await requestMessage(connection('claude'), [...messages, first, { role: 'tool', tool_call_id: 'call1', content: '["index.html"]' }], toolDefinitions, signal());
  assert.equal(result.content, 'Found index.html.');
});

test('provider errors and invalid responses produce actionable errors', async t => {
  for (const [response, expected] of [
    [new Response('', { status: 401 }), /API key/],
    [new Response('', { status: 429 }), /quota/],
    [new Response('html'), /invalid JSON/],
    [Response.json(null), /unsupported response/],
    [Response.json({ error: { message: 'private provider details' } }), /could not complete/],
    [Response.json({ choices: [] }), /unsupported/],
    [Response.json({ choices: [{ message: { content: null } }] }), /empty response/],
    [Response.json({ choices: [{ message: { tool_calls: [{}] } }] }), /malformed tool calls/],
    [Response.json({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }), /output limit/],
  ]) {
    mockFetch(t, async () => response);
    await assert.rejects(requestMessage(connection(), messages, toolDefinitions, signal()), expected);
  }
  mockFetch(t, async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(requestMessage(connection('ollama'), messages, toolDefinitions, signal()), /Ollama is running/);
  const controller = new AbortController();
  controller.abort(new DOMException('Timed out', 'TimeoutError'));
  await assert.rejects(requestMessage(connection(), messages, toolDefinitions, controller.signal), /timed out/);
});
