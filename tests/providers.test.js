import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationTokens, knownContextWindow, normalizeMaxTurns, normalizeSettings, inferProvider, providers } from '../shared/ai.js';
import { contextLimit, requestMessage } from '../electron/providers.js';
import { toolDefinitions } from '../electron/agent.js';

const connection = (provider = 'openai') => ({ provider, baseUrl: providers[provider].baseUrl, model: 'test-model', apiKey: 'secret' });
const messages = [{ role: 'system', content: 'Edit the deck.' }, { role: 'user', content: 'List files.' }];
const signal = () => new AbortController().signal;
const mocked = new WeakSet();
test('turn limits default to 300, survive connection changes, and reject invalid values', () => {
  assert.equal(normalizeSettings(connection()).maxTurns, 300);
  assert.equal(normalizeSettings(connection('claude'), { ...connection(), maxTurns: 72 }).maxTurns, 72);
  assert.equal(normalizeSettings({ ...connection(), maxTurns: 1 }).maxTurns, 1);
  assert.equal(normalizeMaxTurns(1024), 1024);
  for (const maxTurns of [0, -1, 1025, 1.5, '300', null, NaN, Infinity]) {
    assert.throws(() => normalizeMaxTurns(maxTurns), /whole number of turns/);
  }
});
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
  assert.equal(inferProvider('https://generativelanguage.googleapis.com/v1beta/openai'), 'gemini');
  assert.equal(inferProvider('http://127.0.0.1:11434/v1'), 'ollama');
});

test('OpenAI, OpenRouter, Gemini, and Ollama use Chat Completions with tools', async t => {
  for (const provider of ['openai', 'openrouter', 'gemini', 'ollama']) {
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

test('Gemini tool calls retain thought signatures for the next model turn', async t => {
  const call = { id: 'gemini-call', type: 'function', function: { name: 'list_files', arguments: '{}' }, extra_content: { google: { thought_signature: 'opaque-signature' } } };
  let calls = 0;
  mockFetch(t, async (url, options) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer secret');
    const body = JSON.parse(options.body);
    if (++calls === 1) return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [call] } }] });
    assert.deepEqual(body.messages.at(-2).tool_calls, [call]);
    assert.deepEqual(body.messages.at(-1), { role: 'tool', tool_call_id: call.id, content: '["index.html"]' });
    return Response.json({ choices: [{ message: { content: 'Found index.html.' } }] });
  });
  const { usage, ...first } = await requestMessage(connection('gemini'), messages, toolDefinitions, signal());
  const result = await requestMessage(connection('gemini'), [...messages, first, { role: 'tool', tool_call_id: call.id, content: '["index.html"]' }], toolDefinitions, signal());
  assert.equal(result.content, 'Found index.html.');
});

test('Gemini requires its own key when switching providers', () => {
  assert.throws(() => normalizeSettings({ ...connection('gemini'), apiKey: '' }), /API key for Gemini/);
  assert.throws(() => normalizeSettings({ ...connection('gemini'), apiKey: undefined }, connection()), /API key for Gemini/);
  assert.equal(normalizeSettings(connection('gemini')).provider, 'gemini');
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

test('OpenRouter retries incomplete responses and temporary gateway failures once', async t => {
  for (const failure of [
    () => new Response('{"choices":['),
    () => new Response(''),
    () => new Response('Bad gateway', { status: 502 }),
    () => ({ ok: true, text: async () => { throw new TypeError('terminated'); } }),
  ]) {
    let calls = 0;
    mockFetch(t, async () => ++calls === 1 ? failure() : Response.json({ choices: [{ message: { content: 'Recovered.' } }] }));
    assert.equal((await requestMessage(connection('openrouter'), messages, toolDefinitions, signal())).content, 'Recovered.');
    assert.equal(calls, 2);
  }
  let calls = 0;
  mockFetch(t, async () => { calls++; return new Response('{'); });
  await assert.rejects(requestMessage(connection('openrouter'), messages, toolDefinitions, signal()), /OpenRouter returned invalid JSON.*incomplete/);
  assert.equal(calls, 2);
});

test('timeouts and cancellation during response download are not reported as invalid JSON or retried', async t => {
  for (const [reason, expected] of [
    [new DOMException('Timed out', 'TimeoutError'), /timed out/],
    [new DOMException('Stopped', 'AbortError'), /request stopped/],
  ]) {
    const controller = new AbortController();
    let calls = 0;
    mockFetch(t, async () => {
      calls++;
      return { ok: true, text: async () => { controller.abort(reason); throw reason; } };
    });
    await assert.rejects(requestMessage(connection('openrouter'), messages, toolDefinitions, controller.signal), expected);
    assert.equal(calls, 1);
  }
});

test('each model call gets a fresh timeout and authentication errors are not retried', async t => {
  const deadlines = [];
  t.mock.method(AbortSignal, 'timeout', ms => {
    assert.equal(ms, 180000);
    const controller = new AbortController();
    deadlines.push(controller);
    return controller.signal;
  });
  const session = signal();
  mockFetch(t, async () => Response.json({ choices: [{ message: { content: 'Done.' } }] }));
  await requestMessage(connection('openrouter'), messages, toolDefinitions, session);
  deadlines[0].abort(new DOMException('Timed out', 'TimeoutError'));
  await requestMessage(connection('openrouter'), messages, toolDefinitions, session);
  assert.equal(deadlines.length, 2);
  let calls = 0;
  mockFetch(t, async () => { calls++; return new Response('', { status: 401 }); });
  await assert.rejects(requestMessage(connection('openrouter'), messages, toolDefinitions, session), /API key/);
  assert.equal(calls, 1);
});

test('partial provider failures cannot be returned as successful edits', async t => {
  mockFetch(t, async () => Response.json({ choices: [{ finish_reason: 'error', error: { code: 502 }, message: { content: 'Partial reply', tool_calls: [{ id: 'partial', function: { name: 'write_file', arguments: '{' } }] } }] }));
  await assert.rejects(requestMessage(connection('openrouter'), messages, toolDefinitions, signal()), /failed while generating/);
});

test('token usage is normalized for Claude, OpenAI, OpenRouter, Gemini, and Ollama', async t => {
  mockFetch(t, async () => Response.json({ usage: { input_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 10, output_tokens: 7 }, content: [{ type: 'text', text: 'Ok.' }], stop_reason: 'end_turn' }));
  assert.deepEqual((await requestMessage(connection('claude'), messages, toolDefinitions, signal())).usage, { inputTokens: 150, outputTokens: 7 });
  for (const provider of ['openai', 'openrouter', 'gemini', 'ollama']) {
    mockFetch(t, async () => Response.json({ usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } }, choices: [{ message: { content: 'Ok.' } }] }));
    assert.deepEqual((await requestMessage(connection(provider), messages, toolDefinitions, signal())).usage, { inputTokens: 12, outputTokens: 3 });
  }
  mockFetch(t, async () => Response.json({ usage: { total_tokens: 9 }, choices: [{ message: { content: 'Ok.' } }] }));
  assert.deepEqual((await requestMessage(connection(), messages, toolDefinitions, signal())).usage, { inputTokens: 9, outputTokens: 0 });
  mockFetch(t, async () => Response.json({ choices: [{ message: { content: 'Ok.' } }] }));
  assert.equal((await requestMessage(connection(), messages, toolDefinitions, signal())).usage, null);
  assert.equal(conversationTokens([{ usage: { inputTokens: 5, outputTokens: 1 } }, { usage: { inputTokens: -1, outputTokens: 1 } }]), 6);
  assert.equal(conversationTokens([{ usage: { inputTokens: 5, outputTokens: 1 } }, { status: 'failed' }]), 6);
});

test('known context windows cover provider model families', () => {
  assert.equal(knownContextWindow('openai', 'gpt-4.1-mini'), 1_047_576);
  assert.equal(knownContextWindow('openai', 'gpt-5-mini-2025-08-07'), 400_000);
  assert.equal(knownContextWindow('openai', 'gpt-4o-2024-08-06'), 128_000);
  assert.equal(knownContextWindow('openai', 'gpt-4-0613'), 8_192);
  assert.equal(knownContextWindow('openai', 'o1-mini'), 128_000);
  assert.equal(knownContextWindow('openai', 'o3'), 200_000);
  assert.equal(knownContextWindow('openai', 'mystery-model'), null);
  assert.equal(knownContextWindow('claude', 'claude-opus-4-6'), 1_000_000);
  assert.equal(knownContextWindow('claude', 'claude-sonnet-4-5-20250929'), 200_000);
  assert.equal(knownContextWindow('claude', 'claude-opus-4-20250514'), 200_000);
  assert.equal(knownContextWindow('claude', 'claude-3-5-sonnet-20241022'), 200_000);
  assert.equal(knownContextWindow('openrouter', 'openai/gpt-4o'), 128_000);
  assert.equal(knownContextWindow('openrouter', 'anthropic/claude-opus-4-6'), 1_000_000);
  assert.equal(knownContextWindow('ollama', 'llama3.2'), null);
});

test('context limits come from each provider and fall back when lookup fails', async t => {
  let calls = 0;
  mockFetch(t, async () => { calls++; return Response.json({}); });
  assert.equal(await contextLimit({ ...connection(), model: 'gpt-4o' }), 128_000);
  assert.equal(await contextLimit({ ...connection(), model: 'local-custom' }), null);
  assert.equal(calls, 0);

  const claude = { ...connection('claude'), baseUrl: 'https://claude.example/v1', model: 'custom-model' };
  mockFetch(t, async (url, options) => {
    assert.equal(url, 'https://claude.example/v1/models/custom-model');
    assert.equal(options.headers['x-api-key'], 'secret');
    assert.equal(options.headers['anthropic-version'], '2023-06-01');
    return Response.json({ max_input_tokens: 1_000_000 });
  });
  assert.equal(await contextLimit(claude), 1_000_000);

  mockFetch(t, async () => { throw new TypeError('offline'); });
  assert.equal(await contextLimit({ ...connection('claude'), baseUrl: 'https://claude-fallback.example/v1', model: 'claude-opus-4-6' }), 1_000_000);
  assert.equal(await contextLimit({ ...connection('claude'), baseUrl: 'https://claude-old.example/v1', model: 'claude-sonnet-4-5' }), 200_000);

  const router = { ...connection('openrouter'), baseUrl: 'https://router.example/v1', model: 'custom/model' };
  let routerCalls = 0;
  mockFetch(t, async (url, options) => {
    routerCalls++;
    assert.equal(url, 'https://router.example/v1/models');
    assert.equal(options.headers.Authorization, 'Bearer secret');
    return Response.json({ data: [{ id: 'custom/model', context_length: 32_768 }, { id: 'other', top_provider: { context_length: 4096 } }] });
  });
  assert.equal(await contextLimit(router), 32_768);
  assert.equal(await contextLimit(router), 32_768);
  assert.equal(await contextLimit({ ...router, model: 'other' }), 4096);
  assert.equal(routerCalls, 1);
  mockFetch(t, async () => new Response('', { status: 404 }));
  assert.equal(await contextLimit({ ...connection('openrouter'), baseUrl: 'https://router-fallback.example/v1', model: 'openai/gpt-4o' }), 128_000);

  const ollama = { ...connection('ollama'), baseUrl: 'http://127.0.0.1:44111/v1', model: 'gemma4' };
  const urls = [];
  mockFetch(t, async url => {
    urls.push(String(url));
    if (String(url).endsWith('/api/ps')) return Response.json({ models: [{ name: 'gemma4:latest', context_length: 32_768 }] });
    return Response.json({ parameters: 'num_ctx 2048', model_info: { 'gemma4.context_length': 131_072 } });
  });
  assert.equal(await contextLimit(ollama), 32_768);
  assert.deepEqual(urls, ['http://127.0.0.1:44111/api/ps']);

  const configured = { ...ollama, baseUrl: 'http://127.0.0.1:44112/v1' };
  mockFetch(t, async url => String(url).endsWith('/api/ps')
    ? Response.json({ models: [] })
    : Response.json({ parameters: 'temperature 0.7\nnum_ctx 8192\n', model_info: { 'gemma4.context_length': 131_072 } }));
  assert.equal(await contextLimit(configured), 8192);
  mockFetch(t, async url => String(url).endsWith('/api/ps')
    ? Response.json({ models: [] })
    : Response.json({ parameters: 'temperature 0.7', model_info: { 'gemma4.context_length': 131_072, 'gemma4.audio.block_count': 12 } }));
  assert.equal(await contextLimit({ ...configured, baseUrl: 'http://127.0.0.1:44113/v1' }), 131_072);
  mockFetch(t, async () => { throw new TypeError('offline'); });
  assert.equal(await contextLimit({ ...ollama, baseUrl: 'http://127.0.0.1:44114/v1' }), null);
});
