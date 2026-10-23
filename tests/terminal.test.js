import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { runCommand } from '../electron/terminal.js';
import { chat } from '../electron/agent.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wetmytt-terminal-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

const posix = { skip: process.platform === 'win32' };
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const node = code => `${quote(process.execPath)} -e ${quote(code)}`;

test('terminal executes shell syntax in the deck and reports stdout, stderr, and failures', posix, async t => {
  const root = await fixture(t);
  const result = await runCommand(root, { command: 'printf hello | tr a-z A-Z > result.txt; cat result.txt; printf problem >&2; exit 7' });
  assert.equal(await fs.readFile(path.join(root, 'result.txt'), 'utf8'), 'HELLO');
  assert.equal(result.stdout, 'HELLO');
  assert.equal(result.stderr, 'problem');
  assert.equal(result.exit_code, 7);
  assert.equal(result.timed_out, false);
  assert.equal(result.cancelled, false);
});

test('terminal bounds large output while preserving UTF-8', posix, async t => {
  const root = await fixture(t);
  const result = await runCommand(root, { command: node("process.stdout.write('🌟'.repeat(50000))") });
  assert.equal(result.exit_code, 0);
  assert.equal(result.truncated, true);
  assert.equal(Buffer.byteLength(result.stdout), 65536);
  assert.ok(!result.stdout.includes('\uFFFD'));
});

test('terminal can use curl to query a search API', posix, async t => {
  const root = await fixture(t);
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/search?q=slide+research');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ results: [{ title: 'Source', url: 'https://example.com/source' }] }));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const result = await runCommand(root, { command: `curl -sS --fail --max-time 5 --get --data-urlencode 'q=slide research' http://127.0.0.1:${server.address().port}/search` });
  assert.equal(result.exit_code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).results[0].url, 'https://example.com/source');
});

test('terminal times out and stops child processes', posix, async t => {
  const root = await fixture(t);
  const command = `${node("setTimeout(() => require('fs').writeFileSync('leaked.txt', 'bad'), 800)")} & wait`;
  const result = await runCommand(root, { command, timeout_ms: 150 });
  assert.equal(result.timed_out, true);
  assert.equal(result.signal, 'SIGKILL');
  await new Promise(resolve => setTimeout(resolve, 900));
  await assert.rejects(fs.stat(path.join(root, 'leaked.txt')), { code: 'ENOENT' });
});

test('terminal cancellation returns partial output and kills the running command', posix, async t => {
  const root = await fixture(t);
  const controller = new AbortController();
  await fs.writeFile(path.join(root, 'ready'), '');
  const pending = runCommand(root, { command: node("console.log('started'); require('fs').unlinkSync('ready'); setInterval(() => {}, 1000)") }, controller.signal);
  // Wait for the command to start before testing interruption.
  for (let i = 0; i < 100; i++) {
    if (!(await fs.stat(path.join(root, 'ready')).catch(() => null))) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  controller.abort();
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(result.stdout, 'started\n');
  assert.equal(result.signal, 'SIGKILL');
  await assert.rejects(runCommand(root, { command: 'touch should-not-exist' }, controller.signal), { name: 'AbortError' });
  await assert.rejects(fs.stat(path.join(root, 'should-not-exist')), { code: 'ENOENT' });
});

test('terminal rejects invalid inputs and reports a missing working directory', async t => {
  const root = await fixture(t);
  for (const args of [{ command: '' }, { command: 123 }, { command: 'a\0b' }, { command: 'echo hi', timeout_ms: 0 }, { command: 'echo hi', timeout_ms: 180001 }]) {
    await assert.rejects(runCommand(root, args));
  }
  await assert.rejects(runCommand(path.join(root, 'missing'), { command: 'echo hi' }), /Could not run command/);
});

test('OpenRouter chat advertises terminal tools and sends command results back to the model', posix, async t => {
  const root = await fixture(t);
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  const activity = [];
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(options.body);
    assert.ok(body.tools.some(tool => tool.function.name === 'run_command'));
    if (calls++ === 0) {
      assert.match(body.messages[0].content, /curl/);
      return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'cmd-1', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'printf edited > slide.txt; cat slide.txt' }) } }] } }] });
    }
    const result = body.messages.at(-1);
    assert.equal(result.role, 'tool');
    assert.equal(result.tool_call_id, 'cmd-1');
    assert.equal(JSON.parse(result.content).stdout, 'edited');
    assert.equal(JSON.parse(result.content).exit_code, 0);
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'Edited the slide.' } }] });
  };
  const result = await chat({ root, settings: { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'test-model', apiKey: 'test-key' }, history: [{ role: 'user', content: 'Edit the slide.' }], signal: new AbortController().signal, onActivity: text => activity.push(text) });
  assert.equal(result, 'Edited the slide.');
  assert.equal(calls, 2);
  assert.equal(await fs.readFile(path.join(root, 'slide.txt'), 'utf8'), 'edited');
  assert.match(activity[0], /run command · printf/);
});
