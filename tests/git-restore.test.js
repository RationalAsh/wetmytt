import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveGitBinary } from 'dugite';
import { gitChanges, gitFilesAction, gitInit, restoreLastSave } from '../electron/git.js';

const git = async (root, args) => (await promisify(execFile)(resolveGitBinary(), args, { cwd: root })).stdout.trim();
async function fixture(t, initial = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wetmytt-restore-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'index.html'), 'saved deck');
  await fs.writeFile(path.join(root, 'deleted.txt'), 'keep me');
  await gitInit(root, undefined, initial);
  return root;
}

test('restore preserves staged, unstaged, renamed, deleted, binary and new files in a recoverable backup', async t => {
  const root = await fixture(t);
  const head = await git(root, ['rev-parse', 'HEAD']);
  await fs.writeFile(path.join(root, 'index.html'), 'staged deck');
  await gitFilesAction(root, 'stage', ['index.html']);
  await fs.writeFile(path.join(root, 'index.html'), 'working deck');
  await fs.rename(path.join(root, 'deleted.txt'), path.join(root, 'renamed.txt'));
  await gitFilesAction(root, 'stage', ['deleted.txt', 'renamed.txt']);
  const filename = 'new file\n你好.bin', bytes = Buffer.from([0, 1, 255, 128]);
  await fs.writeFile(path.join(root, filename), bytes);
  await fs.mkdir(path.join(root, '.wetmytt'));
  await fs.writeFile(path.join(root, '.wetmytt', 'chat.json'), 'private history');
  const before = await gitChanges(root);
  const result = await restoreLastSave(root);
  assert.equal(result.restored, true);
  assert.match(result.backup, /^[a-f0-9]{40,64}$/);
  assert.deepEqual(await gitChanges(root), []);
  assert.equal(await git(root, ['rev-parse', 'HEAD']), head);
  assert.equal(await fs.readFile(path.join(root, 'index.html'), 'utf8'), 'saved deck');
  assert.equal(await fs.readFile(path.join(root, 'deleted.txt'), 'utf8'), 'keep me');
  await assert.rejects(fs.stat(path.join(root, filename)), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(root, '.wetmytt', 'chat.json'), 'utf8'), 'private history');
  await git(root, ['stash', 'apply', '--index', result.backup]);
  assert.deepEqual(await gitChanges(root), before);
  assert.equal(await fs.readFile(path.join(root, 'index.html'), 'utf8'), 'working deck');
  assert.equal(await git(root, ['show', ':index.html']), 'staged deck');
  assert.deepEqual(await fs.readFile(path.join(root, filename)), bytes);
});

test('clean restore creates no backup; repeated restores keep each prior backup and work detached', async t => {
  const root = await fixture(t);
  assert.deepEqual(await restoreLastSave(root), { restored: false, backup: null });
  await assert.rejects(git(root, ['rev-parse', '--verify', 'refs/stash']));
  await fs.writeFile(path.join(root, 'index.html'), 'first edits');
  const first = await restoreLastSave(root);
  assert.deepEqual(await restoreLastSave(root), { restored: false, backup: null });
  assert.equal(await git(root, ['rev-parse', 'refs/stash']), first.backup);
  await git(root, ['checkout', '--detach']);
  await fs.writeFile(path.join(root, 'index.html'), 'second edits');
  const second = await restoreLastSave(root);
  assert.notEqual(first.backup, second.backup);
  assert.equal(await git(root, ['show', `${first.backup}:index.html`]), 'first edits');
  assert.equal(await git(root, ['show', `${second.backup}:index.html`]), 'second edits');
});

test('restore and its status checks never execute repository filters or hooks', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, '.gitattributes'), '*.html filter=custom\n');
  await gitFilesAction(root, 'stage', ['.gitattributes']);
  await gitFilesAction(root, 'commit', [], 'Set attributes');
  const marker = path.join(root, 'filter-ran');
  for (const key of ['clean', 'smudge', 'process']) await git(root, ['config', `filter.custom.${key}`, `touch '${marker}'`]);
  await git(root, ['config', 'filter.custom.required', 'true']);
  await fs.mkdir(path.join(root, '.git', 'hooks'), { recursive: true });
  await fs.writeFile(path.join(root, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  await fs.writeFile(path.join(root, 'index.html'), 'edits');
  const result = await restoreLastSave(root);
  assert.equal(result.restored, true);
  assert.equal(await git(root, ['show', `${result.backup}:index.html`]), 'edits');
  assert.equal(await fs.readFile(path.join(root, 'index.html'), 'utf8'), 'saved deck');
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('missing saves, conflicts, cancellation and a locked index fail without discarding work', async t => {
  const root = await fixture(t, false);
  await assert.rejects(restoreLastSave(root), /no saved version/);
  assert.equal(await fs.readFile(path.join(root, 'index.html'), 'utf8'), 'saved deck');
  await gitFilesAction(root, 'stage', ['.gitignore', 'index.html', 'deleted.txt']);
  await gitFilesAction(root, 'commit', [], 'Initial save');
  await fs.writeFile(path.join(root, 'index.html'), 'keep edits');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(restoreLastSave(root, controller.signal));
  await fs.writeFile(path.join(root, '.git', 'index.lock'), '');
  await assert.rejects(restoreLastSave(root));
  await fs.unlink(path.join(root, '.git', 'index.lock'));
  assert.equal(await fs.readFile(path.join(root, 'index.html'), 'utf8'), 'keep edits');
  // Create a real merge conflict using two branches with different deck contents.
  await git(root, ['checkout', '-b', 'other']);
  await gitFilesAction(root, 'stage', ['index.html']);
  await gitFilesAction(root, 'commit', [], 'Other edit');
  await git(root, ['checkout', 'main']);
  await fs.writeFile(path.join(root, 'index.html'), 'main edit');
  await gitFilesAction(root, 'stage', ['index.html']);
  await gitFilesAction(root, 'commit', [], 'Main edit');
  await assert.rejects(git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'merge', 'other']));
  const conflict = await fs.readFile(path.join(root, 'index.html'), 'utf8');
  await assert.rejects(restoreLastSave(root), /conflicting files/);
  assert.equal(await fs.readFile(path.join(root, 'index.html'), 'utf8'), conflict);
});
