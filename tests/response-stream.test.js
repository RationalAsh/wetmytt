import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestMessage } from '../electron/providers.js';
import { chat } from '../electron/agent.js';

const settings = { provider: 'openai', model: 'test', apiKey: 'secret', baseUrl: 'https://example.test/v1' };
const messages = [{ role: 'system', content: 'Help.' }, { role: 'user', content: 'Edit.' }];
const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
function stream(events, options = {}) {
  const wire = events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\r\n\r\n`).join('');
  const bytes = new TextEncoder().encode(wire);
  return new Response(new ReadableStream({
    start(controller) {
      // Exercise arbitrary transport boundaries, including UTF-8 and CRLF.
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      if (!options.hold) controller.close();
    },
    cancel: options.cancel,
  }), { headers: { 'content-type': 'text/event-stream' } });
}
function mock(t, handler) { t.mock.method(globalThis, 'fetch', handler); }

test('streams text before completion, assembles fragmented tools, and preserves token usage', async t => {
  const previews = [];
  mock(t, async (_url, options) => {
    assert.equal(JSON.parse(options.body).stream, true);
    return stream([
      chunk({ content: 'Let’s inspect 🌟' }),
      chunk({ tool_calls: [{ index: 0, id: 'read', function: { name: 'read_', arguments: '{"pa' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { name: 'file', arguments: 'th":"index.html"}' } }] }, 'tool_calls'),
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } }, '[DONE]',
    ]);
  });
  const result = await requestMessage(settings, messages, [], new AbortController().signal, text => previews.push(text));
  assert.equal(previews[0], 'Let’s inspect 🌟');
  assert.equal(result.content, previews.at(-1));
  assert.deepEqual(result.tool_calls, [{ id: 'read', type: 'function', function: { name: 'read_file', arguments: '{"path":"index.html"}' } }]);
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 20 });
});

test('accepts JSON from compatible servers that ignore streaming', async t => {
  mock(t, async () => Response.json({ choices: [{ message: { content: 'Done.' } }] }));
  assert.equal((await requestMessage(settings, messages, [], new AbortController().signal, () => {})).content, 'Done.');
});

test('rejects truncated streams, provider errors and output limits without executing tools or retrying', async t => {
  for (const ending of [[], [chunk({}, 'tool_calls')], [{ error: { message: 'private' } }], [chunk({}, 'length')], ['[DONE]']]) {
    let requests = 0, toolEvents = 0;
    mock(t, async () => { requests++; return stream([
      chunk({ tool_calls: [{ index: 0, id: 'write', function: { name: 'write_file', arguments: '{"path":"note.txt","content":"unsafe"}' } }] }), ...ending,
    ]); });
    await assert.rejects(chat({ root: '/unused', settings: { ...settings, provider: 'openrouter' }, history: messages.slice(1), signal: new AbortController().signal, onText() {}, onEvent() { toolEvents++; } }), /interrupted|failed|output limit/);
    assert.equal(toolEvents, 0);
    assert.equal(requests, 1);
  }
});

test('Stop cancels a held response body and never returns a partial answer', async t => {
  const controller = new AbortController();
  let cancelled = false, requests = 0;
  mock(t, async () => { requests++; return stream([chunk({ content: 'Partial answer' })], { hold: true, cancel() { cancelled = true; } }); });
  await assert.rejects(requestMessage(settings, messages, [], controller.signal, () => controller.abort()), /stopped/);
  assert.equal(cancelled, true);
  assert.equal(requests, 1);
});

test('model phases reset after tool activity before the next response', async t => {
  let calls = 0;
  const activities = [];
  mock(t, async () => Response.json({ choices: [{ message: calls++ === 0
    ? { tool_calls: [{ id: 'list', function: { name: 'list_files', arguments: '{}' } }] }
    : { content: 'Done.' } }] }));
  // Invalid project still produces a tool result and a subsequent model call.
  await chat({ root: '/missing-project', settings, history: messages.slice(1), signal: new AbortController().signal, onActivity: value => activities.push(value) });
  assert.equal(activities[0], 'Waiting for model response…');
  assert.match(activities[1], /list files/);
  assert.equal(activities[2], 'Waiting for model response…');
});


test('Claude and Gemini keep their complete response formats when progress is enabled', async t => {
  for (const provider of ['claude', 'gemini']) {
    mock(t, async (_url, options) => {
      assert.equal(JSON.parse(options.body).stream, undefined);
      return Response.json(provider === 'claude'
        ? { content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn' }
        : { choices: [{ message: { content: 'Done.' } }] });
    });
    assert.equal((await requestMessage({ ...settings, provider }, messages, [], new AbortController().signal, () => {})).content, 'Done.');
  }
});
