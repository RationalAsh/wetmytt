import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chat } from '../electron/agent.js';
import { runConversation, loadChat } from '../electron/chats.js';
import { providers } from '../shared/ai.js';

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const screenshot = (slide = 1) => call(`shot-${slide}`, 'screenshot_slide', { slide });
const reply = (provider, content, calls = []) => Response.json(provider === 'claude'
  ? { content: [...(content ? [{ type: 'text', text: content }] : []), ...calls.map(item => ({ type: 'tool_use', id: item.id, name: item.function.name, input: JSON.parse(item.function.arguments) }))] }
  : { choices: [{ message: { content, tool_calls: calls } }] });

async function fixture(t, provider = 'openai') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wetmytt-visual-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, settings: { provider, baseUrl: providers[provider].baseUrl, apiKey: 'test', model: 'test' }, history: [{ role: 'user', content: 'Inspect and fix slide 1.' }], signal: new AbortController().signal };
}

for (const provider of ['openai', 'openrouter', 'gemini', 'ollama', 'claude']) {
  test(`${provider}: images follow all tool results, corrections are reinspected, and logs contain no image data`, async t => {
    const options = await fixture(t, provider);
    await fs.writeFile(path.join(options.root, 'slide.txt'), 'clipped');
    let requests = 0, captures = 0;
    const previous = globalThis.fetch;
    t.after(() => { globalThis.fetch = previous; });
    globalThis.fetch = async (_url, request) => {
      const body = JSON.parse(request.body);
      const tools = body.tools.map(tool => tool.function?.name || tool.name);
      assert.ok(tools.includes('screenshot_slide'));
      requests++;
      if (requests === 1) return reply(provider, null, [screenshot(), call('read', 'read_file', { path: 'slide.txt' })]);
      if (requests === 3) return reply(provider, null, [screenshot()]);
      const imageMessage = body.messages.at(-1);
      assert.equal(imageMessage.role, 'user');
      if (provider === 'claude') {
        const image = imageMessage.content[1];
        assert.deepEqual(image, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(requests === 2 ? 'clipped' : 'fixed').toString('base64') } });
        assert.equal(body.messages.at(-2).content[0].type, 'tool_result');
      } else {
        assert.equal(body.messages.at(-2).role, 'tool');
        assert.equal(imageMessage.content[1].image_url.url, `data:image/png;base64,${Buffer.from(requests === 2 ? 'clipped' : 'fixed').toString('base64')}`);
      }
      if (requests === 2) return reply(provider, 'The text is clipped; correcting it.', [call('fix', 'write_file', { path: 'slide.txt', content: 'fixed' })]);
      assert.equal(JSON.stringify(body).includes(Buffer.from('clipped').toString('base64')), false);
      return reply(provider, 'Corrected and inspected slide 1.');
    };
    const result = await runConversation({ ...options, text: 'Inspect and fix slide 1.', chat: args => chat({ ...args, screenshotSlide: async (root, slide, { signal }) => {
      assert.equal(root, options.root);
      assert.equal(slide, 1);
      assert.equal(signal, options.signal);
      captures++;
      return Buffer.from(await fs.readFile(path.join(root, 'slide.txt'), 'utf8'));
    } }) });
    assert.equal(captures, 2);
    assert.equal(requests, 4);
    const saved = await loadChat(options.root, result.conversation.id);
    assert.equal(saved.messages.at(-1).content, 'Corrected and inspected slide 1.');
    assert.equal(JSON.stringify(saved).includes('base64'), false);
    assert.equal(saved.requests.at(-1).status, 'completed');
  });
}

test('image rejection retries text only once, preserves edits, and always discloses the limitation', async t => {
  const options = await fixture(t);
  let requests = 0, captures = 0;
  const events = [];
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = async (_url, request) => {
    const body = JSON.parse(request.body);
    requests++;
    if (requests === 1) return reply('openai', null, [call('edit', 'write_file', { path: 'slide.txt', content: 'saved' }), screenshot()]);
    if (requests === 2) {
      assert.ok(JSON.stringify(body).includes('data:image/png'));
      return new Response('model does not support images', { status: 400 });
    }
    assert.equal(JSON.stringify(body).includes('data:image/png'), false);
    assert.equal(body.tools.some(tool => tool.function.name === 'screenshot_slide'), false);
    assert.ok(body.messages.some(message => message.tool_call_id === 'edit'));
    return reply('openai', 'Edits saved.');
  };
  const result = await chat({ ...options, onEvent: event => events.push(event), screenshotSlide: async () => { captures++; return Buffer.from('PNG'); } });
  assert.match(result.content, /Edits saved\.[\s\S]*Visual inspection unavailable[\s\S]*model with image support/);
  assert.equal(captures, 1);
  assert.equal(requests, 3);
  assert.equal(events.filter(event => event.id === 'edit' && event.status === 'completed').length, 1);
  assert.equal(await fs.readFile(path.join(options.root, 'slide.txt'), 'utf8'), 'saved');
});

test('bad slide input and rendering failures return failed tool activity without images', async t => {
  const options = await fixture(t);
  let requests = 0, captures = 0;
  const events = [];
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = async (_url, request) => {
    const body = JSON.parse(request.body);
    if (++requests === 1) return reply('openai', null, [screenshot(0), screenshot(1.5), call('extra', 'screenshot_slide', { slide: 1, path: '/elsewhere' }), screenshot(99)]);
    assert.equal(body.messages.at(-1).role, 'tool');
    assert.match(body.messages.at(-1).content, /Slide 99 does not exist/);
    assert.equal(JSON.stringify(body).includes('data:image/png'), false);
    return reply('openai', 'Could not inspect the slides.');
  };
  await chat({ ...options, onEvent: event => events.push(event), screenshotSlide: async () => { captures++; throw new Error('Slide 99 does not exist.'); } });
  assert.equal(captures, 1);
  assert.equal(events.filter(event => event.status === 'failed').length, 4);
});

for (const [provider, status] of [['claude', 400], ['openrouter', 404], ['ollama', 422], ['gemini', 415], ['openai', 413]]) {
  test(`${provider}: image rejection (${status}) removes images and continues with text`, async t => {
    const options = await fixture(t, provider);
    let requests = 0;
    const previous = globalThis.fetch;
    t.after(() => { globalThis.fetch = previous; });
    globalThis.fetch = async (_url, request) => {
      const body = JSON.parse(request.body);
      requests++;
      if (requests === 1) return reply(provider, null, [screenshot()]);
      if (requests === 2) return new Response('', { status });
      assert.equal(body.messages.some(message => Array.isArray(message.content) && message.content.some(part => ['image', 'image_url'].includes(part.type))), false);
      assert.equal(body.tools.some(tool => (tool.function?.name || tool.name) === 'screenshot_slide'), false);
      return reply(provider, 'Text editing is available.');
    };
    const result = await chat({ ...options, screenshotSlide: async () => Buffer.from('PNG') });
    assert.equal(requests, 3);
    assert.match(result.content, /Visual inspection unavailable/);
  });
}

test('authentication errors after screenshots remain actionable and are not retried as image rejection', async t => {
  const options = await fixture(t);
  let requests = 0;
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = async () => ++requests === 1 ? reply('openai', null, [screenshot()]) : new Response('', { status: 401 });
  await assert.rejects(chat({ ...options, screenshotSlide: async () => Buffer.from('PNG') }), /API key/);
  assert.equal(requests, 2);
});

test('Stop during screenshot capture cancels activity and sends no further model request', async t => {
  const options = await fixture(t);
  const controller = new AbortController();
  let requests = 0;
  const events = [];
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = async () => { requests++; return reply('openai', null, [screenshot()]); };
  await assert.rejects(chat({ ...options, signal: controller.signal, onEvent: event => events.push(event), screenshotSlide: async (_root, _slide, { signal }) => {
    controller.abort();
    signal.throwIfAborted();
  } }));
  assert.equal(requests, 1);
  assert.equal(events.at(-1).status, 'cancelled');
});
