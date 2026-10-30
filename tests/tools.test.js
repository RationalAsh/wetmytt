import { presentationGuidance } from '../electron/presentation-guidance.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveGitBinary } from 'dugite';
import { runTool, toolDefinitions } from '../electron/tools.js';
import { createDeck } from '../electron/decks.js';
import { chat } from '../electron/agent.js';
import { currentBranch } from '../electron/git.js';

async function fixture(t, create = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wetmytt-tools-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'deck');
  if (create) await createDeck(root); else await fs.mkdir(root);
  return { root, directory, tool: (name, args = {}, signal) => runTool(root, name, args, signal) };
}
const rawGit = (root, args) => promisify(execFile)(resolveGitBinary(), args, { cwd: root });

test('chat permits 300 turns by default and preserves edits at a configured limit', async t => {
  const { root } = await fixture(t);
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ choices: [{ message: calls === 300 ? { content: 'Finished.' } : {
      tool_calls: [{ id: `edit-${calls}`, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'progress.txt', content: String(calls) }) } }],
    } }] });
  };
  const options = { root, settings: { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'test', apiKey: 'test' }, history: [{ role: 'user', content: 'Edit.' }], signal: new AbortController().signal, onActivity() {} };
  assert.equal((await chat(options)).content, 'Finished.');
  assert.equal(calls, 300);
  calls = 0;
  await assert.rejects(chat({ ...options, settings: { ...options.settings, maxTurns: 2 } }), /Reached the 2-turn limit/);
  assert.equal(calls, 2);
  assert.equal(await fs.readFile(path.join(root, 'progress.txt'), 'utf8'), '2');
});

test('version label follows branches, supports unborn and detached HEAD, and tolerates missing Git', async t => {
  const { root, tool } = await fixture(t);
  assert.equal(await currentBranch(root), null);
  await tool('git_init');
  assert.equal(await currentBranch(root), 'main');
  const fresh = await fixture(t, true);
  await fresh.tool('git_branch', { name: 'draft/slides' });
  await fresh.tool('git_switch', { name: 'draft/slides' });
  assert.equal(await currentBranch(fresh.root), 'draft/slides');
  await rawGit(fresh.root, ['checkout', '--detach']);
  assert.equal(await currentBranch(fresh.root), 'Detached HEAD');
});

test('new decks have a clean main branch and initial commit; existing decks require explicit initialization', async t => {
  const fresh = await fixture(t, true);
  assert.equal((await fresh.tool('git_status')).trim(), '## main');
  assert.match(await fresh.tool('git_log'), /Create presentation/);
  const existing = await fixture(t);
  await fs.writeFile(path.join(existing.root, 'slide.txt'), 'original');
  await assert.rejects(existing.tool('git_status'), /git_init/);
  await existing.tool('git_init');
  await fs.mkdir(path.join(existing.root, '.wetmytt'));
  await fs.writeFile(path.join(existing.root, '.wetmytt/chat.json'), 'private');
  assert.ok(!(await existing.tool('git_status')).includes('wetmytt'));
  assert.match(await existing.tool('git_status'), /slide.txt/);
  await assert.rejects(existing.tool('git_log'), /does not have any commits/);
  assert.match(await existing.tool('git_init'), /already initialized/);
});

test('local Git stages, commits, diffs, unstages, restores, and switches branches without a system Git', async t => {
  const { root, tool } = await fixture(t, true);
  await fs.writeFile(path.join(root, 'slide.txt'), 'one\n');
  await tool('git_stage', { paths: ['slide.txt'] });
  assert.match(await tool('git_diff', { staged: true }), /\+one/);
  await tool('git_commit', { message: 'Add a slide' });
  await fs.writeFile(path.join(root, 'slide.txt'), 'two\n');
  assert.match(await tool('git_diff'), /\+two/);
  await tool('git_stage', { paths: ['slide.txt'] });
  await tool('git_unstage', { paths: ['slide.txt'] });
  assert.equal(await tool('git_diff', { staged: true }), '');
  await tool('git_restore', { paths: ['slide.txt'] });
  assert.equal(await fs.readFile(path.join(root, 'slide.txt'), 'utf8'), 'one\n');
  await tool('git_branch', { name: 'revision' });
  await tool('git_switch', { name: 'revision' });
  assert.match(await tool('git_status'), /revision/);
  await assert.rejects(tool('git_switch', { name: '--detach' }));
  await assert.rejects(tool('git_stage', { paths: ['.wetmytt/chat.json'] }));
  await assert.rejects(tool('git_stage', { paths: ['../outside'] }));
  await assert.rejects(tool('git_stage', { paths: ['assets'] }));
  await assert.rejects(tool('run_command', { command: 'echo bad' }), /Unknown tool/);
  await fs.unlink(path.join(root, 'slide.txt'));
  await tool('git_stage', { paths: ['slide.txt'] });
  assert.match(await tool('git_diff', { staged: true }), /deleted file/);
});

test('Git uses configured identity, falls back without changing config, and never executes hooks or filters', async t => {
  const { root, directory, tool } = await fixture(t, true);
  for (const [key, value] of [['user.name', 'Test Person'], ['user.email', 'test@example.com'], ['filter.evil.clean', `touch ${directory}/filter-ran`], ['filter.evil.smudge', `touch ${directory}/smudge-ran`], ['filter.evil.process', `touch ${directory}/process-ran`], ['filter.evil.required', 'true'], ['core.fsmonitor', `touch ${directory}/monitor-ran`]]) await rawGit(root, ['config', key, value]);
  await fs.writeFile(path.join(root, '.gitattributes'), '*.txt filter=evil\n');
  await fs.mkdir(path.join(root, '.git/hooks'), { recursive: true });
  await fs.writeFile(path.join(root, '.git/hooks/pre-commit'), `#!/bin/sh\ntouch '${directory}/hook-ran'\n`, { mode: 0o755 });
  await fs.writeFile(path.join(root, 'slide.txt'), 'safe\n');
  await tool('git_stage', { paths: ['slide.txt'] });
  await tool('git_commit', { message: 'Configured identity' });
  const { stdout } = await rawGit(root, ['log', '-1', '--format=%an <%ae>']);
  assert.equal(stdout.trim(), 'Test Person <test@example.com>');
  await rawGit(root, ['config', 'user.name', '']);
  await rawGit(root, ['config', 'user.email', '']);
  await fs.writeFile(path.join(root, 'slide.txt'), 'next\n');
  await tool('git_stage', { paths: ['slide.txt'] });
  await tool('git_commit', { message: 'Fallback identity' });
  assert.match((await rawGit(root, ['log', '-1', '--format=%an <%ae>'])).stdout, /Welcome to My TED Talk <wetmytt@users.noreply.local>/);
  assert.equal((await rawGit(root, ['config', 'user.name'])).stdout.trim(), '');
  await fs.writeFile(path.join(root, 'slide.txt'), 'discard\n');
  await tool('git_restore', { paths: ['slide.txt'] });
  for (const file of ['hook-ran', 'filter-ran', 'smudge-ran', 'process-ran', 'monitor-ran']) await assert.rejects(fs.access(path.join(directory, file)));
});

test('Git rejects parent repositories, redirected metadata, and external worktrees', async t => {
  const { root, directory, tool } = await fixture(t);
  await rawGit(directory, ['init']);
  await assert.rejects(tool('git_status'), /git_init/);
  await fs.writeFile(path.join(root, '.git'), `gitdir: ${directory}/.git`);
  await assert.rejects(tool('git_status'), /linked worktrees/);
  await fs.unlink(path.join(root, '.git'));
  await fs.symlink(path.join(directory, '.git'), path.join(root, '.git'));
  await assert.rejects(tool('git_init'), /linked worktrees/);
});

test('literal replacements preserve surrounding bytes and replacement metacharacters', async t => {
  const { root, tool } = await fixture(t);
  const target = path.join(root, 'styles.css');
  await fs.writeFile(target, '/* café */\r\n.panel {\r\n  font-size: 0.9cqw;\r\n}\r\n');
  assert.equal(await tool('replace_text', { path: 'styles.css', old_text: '  font-size: 0.9cqw;', new_text: '  font-size: 0.95cqw; /* $& $1 \\ */' }), 'Saved styles.css');
  assert.equal(await fs.readFile(target, 'utf8'), '/* café */\r\n.panel {\r\n  font-size: 0.95cqw; /* $& $1 \\ */\r\n}\r\n');
  await tool('replace_text', { path: 'styles.css', old_text: ' /* $& $1 \\ */', new_text: '' });
  await tool('replace_text', { path: 'styles.css', old_text: '.panel {\r\n', new_text: '.panel {\r\n  color: blue;\r\n' });
  assert.equal(await fs.readFile(target, 'utf8'), '/* café */\r\n.panel {\r\n  color: blue;\r\n  font-size: 0.95cqw;\r\n}\r\n');
});

test('literal replacements reject missing, ambiguous, overlapping, empty, and unchanged matches', async t => {
  const { root, tool } = await fixture(t);
  const source = 'aaa\nrepeat\nrepeat\n  exact\r\n';
  const target = path.join(root, 'notes.txt');
  await fs.writeFile(target, source);
  for (const [old_text, new_text, error] of [
    ['missing', 'new', /not found exactly/],
    ['repeat', 'new', /more than once/],
    ['aa', 'new', /more than once/],
    ['  exact\n', 'new', /not found exactly/],
    ['', 'new', /./],
    ['aaa', 'aaa', /makes no changes/],
  ]) {
    await assert.rejects(tool('replace_text', { path: 'notes.txt', old_text, new_text }), error);
    assert.equal(await fs.readFile(target, 'utf8'), source);
  }
  // Context disambiguates repeated text without replacing every occurrence.
  await tool('replace_text', { path: 'notes.txt', old_text: 'aaa\nrepeat', new_text: 'aaa\nchanged' });
  assert.equal(await fs.readFile(target, 'utf8'), source.replace('aaa\nrepeat', 'aaa\nchanged'));
});

test('literal replacements validate paths, JSON, text limits, and cancellation before writing', async t => {
  const { root, directory, tool } = await fixture(t);
  const args = { path: 'data.json', old_text: 'true', new_text: 'invalid' };
  await fs.writeFile(path.join(root, 'data.json'), '{"ok":true}');
  await assert.rejects(tool('replace_text', args), SyntaxError);
  assert.equal(await fs.readFile(path.join(root, 'data.json'), 'utf8'), '{"ok":true}');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(tool('replace_text', { ...args, new_text: 'false' }, controller.signal));
  assert.equal(await fs.readFile(path.join(root, 'data.json'), 'utf8'), '{"ok":true}');
  await fs.writeFile(path.join(directory, 'outside.txt'), 'true');
  await fs.writeFile(path.join(root, '.hidden'), 'true');
  await fs.symlink('data.json', path.join(root, 'link.json'));
  await fs.symlink(directory, path.join(root, 'escape'));
  for (const name of ['../outside.txt', '.hidden', 'link.json', 'escape/outside.txt', 'missing.txt', '']) {
    await assert.rejects(tool('replace_text', { ...args, path: name, new_text: 'false' }));
  }
  assert.equal(await fs.readFile(path.join(directory, 'outside.txt'), 'utf8'), 'true');
  assert.equal(await fs.readFile(path.join(root, '.hidden'), 'utf8'), 'true');
  await assert.rejects(fs.access(path.join(root, 'missing.txt')));
  await fs.writeFile(path.join(root, 'large.txt'), 'é'.repeat(500_000));
  await assert.rejects(tool('replace_text', { path: 'large.txt', old_text: 'é'.repeat(500_000), new_text: 'é'.repeat(500_001) }), /1 MB/);
  await assert.rejects(tool('replace_text', { path: 'large.txt', old_text: 'é'.repeat(500_001), new_text: '' }), /1 MB/);
  await fs.writeFile(path.join(root, 'large.txt'), 'x' + 'a'.repeat(999_999));
  await assert.rejects(tool('replace_text', { path: 'large.txt', old_text: 'x', new_text: 'xx' }), /1 MB/);
  assert.equal((await fs.stat(path.join(root, 'large.txt'))).size, 1_000_000);
  await fs.appendFile(path.join(root, 'large.txt'), 'a');
  await assert.rejects(tool('replace_text', { path: 'large.txt', old_text: 'x', new_text: 'y' }), /1 MB/);
  await fs.writeFile(path.join(root, 'binary.txt'), 'x\0');
  await assert.rejects(tool('replace_text', { path: 'binary.txt', old_text: 'x', new_text: 'y' }), /null bytes/);
  await assert.rejects(tool('replace_text', { ...args, new_text: '\0' }), /null bytes/);
  assert.equal(await fs.readFile(path.join(root, 'binary.txt'), 'utf8'), 'x\0');
  await tool('replace_text', { ...args, new_text: 'false' });
  assert.equal(await fs.readFile(path.join(root, 'data.json'), 'utf8'), '{"ok":false}');
});

test('patch edits, creates, renames, and deletes without Git; validates all files before writing', async t => {
  const { root, tool } = await fixture(t);
  await fs.writeFile(path.join(root, 'one.txt'), 'before\n');
  await tool('apply_patch', { patch: '--- a/one.txt\n+++ b/renamed.txt\n@@ -1 +1 @@\n-before\n+after\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+new\n' });
  assert.equal(await fs.readFile(path.join(root, 'renamed.txt'), 'utf8'), 'after\n');
  await assert.rejects(fs.access(path.join(root, 'one.txt')));
  await assert.rejects(tool('apply_patch', { patch: '--- a/renamed.txt\n+++ b/renamed.txt\n@@ -1 +1 @@\n-after\n+wrong\n--- a/new.txt\n+++ b/new.txt\n@@ -1 +1 @@\n-stale\n+wrong\n' }), /conflict/);
  assert.equal(await fs.readFile(path.join(root, 'renamed.txt'), 'utf8'), 'after\n');
  await tool('apply_patch', { patch: '--- a/new.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-new\n' });
  await assert.rejects(fs.access(path.join(root, 'new.txt')));
  for (const name of ['../outside', '.env']) await assert.rejects(tool('apply_patch', { patch: `--- /dev/null\n+++ b/${name}\n@@ -0,0 +1 @@\n+bad\n` }));
  await assert.rejects(tool('apply_patch', { patch: '--- /dev/null\n+++ b/invalid.json\n@@ -0,0 +1 @@\n+{broken\n' }));
  await assert.rejects(fs.access(path.join(root, 'invalid.json')));
  await fs.symlink('renamed.txt', path.join(root, 'link.txt'));
  await assert.rejects(tool('apply_patch', { patch: '--- a/link.txt\n+++ b/link.txt\n@@ -1 +1 @@\n-after\n+bad\n' }), /regular files/);
});

test('patch rejects malformed and empty edits without writing any files', async t => {
  const { root, tool } = await fixture(t);
  const source = '<link rel="stylesheet" href="article.css">\n<link rel="stylesheet" href="photo.css">\n';
  await fs.writeFile(path.join(root, 'index.html'), source);
  const headers = '--- a/index.html\n+++ b/index.html\n';
  const edits = ' <link rel="stylesheet" href="article.css">\n+<link rel="stylesheet" href="teaching.css">\n <link rel="stylesheet" href="photo.css">\n';
  const valid = '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+new\n';
  for (const malformed of [
    // The chat first used custom patch markers, then mixed unified file headers
    // with bare @@ and a custom end marker. Neither may report success.
    `*** Begin Patch\n*** Update File: index.html\n@@\n${edits}*** End Patch\n`,
    `${headers}@@\n${edits}*** End Patch\n`,
    `${headers}@@\n${edits}`,
    `${headers}@@ -1 +1 @@\n-${source.split('\n')[0]}\n+changed\n@@\n+silently skipped\n`,
    headers,
    `${headers}@@ -1,2 +1,2 @@\n ${source.split('\n').slice(0, 2).join('\n ')}\n`,
  ]) {
    await assert.rejects(tool('apply_patch', { patch: valid + malformed }), /numbered hunks.*write_file/);
    assert.equal(await fs.readFile(path.join(root, 'index.html'), 'utf8'), source);
    await assert.rejects(fs.access(path.join(root, 'new.txt')));
  }
  await assert.rejects(tool('apply_patch', { patch: `${headers}@@ -1 +1 @@\n-${source.split('\n')[0]}\n+${source.split('\n')[0]}\n` }), /makes no changes/);
  assert.equal(await fs.readFile(path.join(root, 'index.html'), 'utf8'), source);
  await tool('apply_patch', { patch: `${headers}@@ -1,2 +1,3 @@\n${edits}` });
  assert.equal(await fs.readFile(path.join(root, 'index.html'), 'utf8'), source.replace('<link rel="stylesheet" href="photo.css">', '<link rel="stylesheet" href="teaching.css">\n<link rel="stylesheet" href="photo.css">'));
});

test('dedicated tools validate inputs and respect cancellation before mutations', async t => {
  const { root, tool } = await fixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(tool('write_file', { path: 'cancelled.txt', content: 'bad' }, controller.signal));
  await assert.rejects(fs.access(path.join(root, 'cancelled.txt')));
  for (const [name, args] of [['search_web', { query: '' }], ['search_web', { query: 'test', count: 99 }], ['git_stage', { paths: [] }], ['git_commit', { message: '' }], ['write_file', { path: 'x', content: 'a', command: 'bad' }]]) await assert.rejects(tool(name, args));
});

test('built-in chat advertises dedicated tools, executes patches and replacements, and returns their results', async t => {
  const { root } = await fixture(t);
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.ok(body.messages[0].content.includes(presentationGuidance));
    assert.ok(!body.tools.some(tool => tool.function.name === 'run_command'));
    assert.deepEqual(body.tools.map(tool => tool.function.name).sort(), toolDefinitions.map(tool => tool.name).sort());
    if (calls++ === 0) return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'patch1', type: 'function', function: { name: 'apply_patch', arguments: JSON.stringify({ patch: '--- /dev/null\n+++ b/slide.txt\n@@ -0,0 +1 @@\n+edited\n' }) } }] } }] });
    if (calls === 2) {
      assert.equal(body.messages.at(-1).tool_call_id, 'patch1');
      assert.equal(JSON.parse(body.messages.at(-1).content).changed[0].to, 'slide.txt');
      return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'replace1', type: 'function', function: { name: 'replace_text', arguments: JSON.stringify({ path: 'slide.txt', old_text: 'edited', new_text: 'updated' }) } }] } }] });
    }
    assert.equal(body.messages.at(-1).tool_call_id, 'replace1');
    assert.equal(body.messages.at(-1).content, 'Saved slide.txt');
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'Edited.' } }] });
  };
  const result = await chat({ root, settings: { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'test', apiKey: 'test' }, history: [{ role: 'user', content: 'Edit.' }], signal: new AbortController().signal, onActivity() {} });
  assert.equal(result.content, 'Edited.');
  assert.equal(result.usage.outputTokens, 0);
  assert.ok(result.usage.inputTokens > 100);
  assert.equal(await fs.readFile(path.join(root, 'slide.txt'), 'utf8'), 'updated\n');
});

test('chat keeps the latest provider token count and does not send usage back', async t => {
  const { root } = await fixture(t);
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.messages.some(message => Object.hasOwn(message, 'usage')), false);
    if (calls++ === 0) return Response.json({ usage: { prompt_tokens: 15, completion_tokens: 4 }, choices: [{ message: { content: null, tool_calls: [{ id: 'edit', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'note.txt', content: 'ok' }) } }] } }] });
    return Response.json({ usage: { prompt_tokens: 80, completion_tokens: 6 }, choices: [{ message: { content: 'Saved.' } }] });
  };
  const result = await chat({ root, settings: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', apiKey: 'test' }, history: [{ role: 'user', content: 'Edit.' }], signal: new AbortController().signal, onActivity() {} });
  assert.equal(result.content, 'Saved.');
  assert.deepEqual(result.usage, { inputTokens: 80, outputTokens: 6 });
});

test('chat estimates the final context when only an earlier tool call reports usage', async t => {
  const { root } = await fixture(t);
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  let calls = 0;
  globalThis.fetch = async () => {
    if (calls++ === 0) return Response.json({ usage: { prompt_tokens: 15, completion_tokens: 4 }, choices: [{ message: { tool_calls: [{ id: 'edit', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'note.txt', content: 'ok' }) } }] } }] });
    return Response.json({ choices: [{ message: { content: 'Saved.' } }] });
  };
  const result = await chat({ root, settings: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', apiKey: 'test' }, history: [{ role: 'user', content: 'Edit.' }], signal: new AbortController().signal, onActivity() {} });
  assert.equal(calls, 2);
  assert.equal(result.content, 'Saved.');
  assert.ok(result.usage.inputTokens > 100);
  assert.equal(result.usage.outputTokens, 0);
  assert.equal(await fs.readFile(path.join(root, 'note.txt'), 'utf8'), 'ok');
});
