import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveGitBinary } from 'dugite';
import { currentBranch, gitBranches, gitBranchAction, gitChanges, gitFilesAction, gitInit } from '../electron/git.js';

const git = async (root, args) => (await promisify(execFile)(resolveGitBinary(), args, { cwd: root })).stdout.trim();
async function fixture(t, initial = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wetmytt-branches-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'index.html'), 'original');
  await gitInit(root, undefined, initial);
  return root;
}

test('list local branches, create and switch atomically, and return from detached HEAD', async t => {
  const root = await fixture(t);
  assert.deepEqual(await gitBranches(root), ['main']);
  await gitBranchAction(root, 'create', 'slides/你好');
  assert.equal(await currentBranch(root), 'slides/你好');
  await fs.writeFile(path.join(root, 'index.html'), 'branch slides');
  await gitFilesAction(root, 'stage', ['index.html']);
  await gitFilesAction(root, 'commit', [], 'Change branch slides');
  await gitBranchAction(root, 'switch', 'main');
  assert.equal(await fs.readFile(path.join(root, 'index.html'), 'utf8'), 'original');
  assert.deepEqual(await gitBranches(root), ['main', 'slides/你好']);
  await git(root, ['checkout', '--detach']);
  assert.equal(await currentBranch(root), 'Detached HEAD');
  await gitBranchAction(root, 'switch', 'slides/你好');
  assert.equal(await fs.readFile(path.join(root, 'index.html'), 'utf8'), 'branch slides');
});

test('preserve staged and untracked edits and refuse switches that would overwrite them', async t => {
  const root = await fixture(t);
  await gitBranchAction(root, 'create', 'other');
  await fs.writeFile(path.join(root, 'index.html'), 'other slides');
  await gitFilesAction(root, 'stage', ['index.html']);
  await gitFilesAction(root, 'commit', [], 'Other slides');
  await gitBranchAction(root, 'switch', 'main');
  await fs.writeFile(path.join(root, 'index.html'), 'unsaved slides');
  await gitFilesAction(root, 'stage', ['index.html']);
  await fs.writeFile(path.join(root, 'draft.txt'), 'keep draft');
  const changes = await gitChanges(root);
  await assert.rejects(gitBranchAction(root, 'switch', 'other'), /overwritten/);
  assert.equal(await currentBranch(root), 'main');
  assert.deepEqual(await gitChanges(root), changes);
  assert.equal(await fs.readFile(path.join(root, 'index.html'), 'utf8'), 'unsaved slides');
  await gitBranchAction(root, 'create', 'draft');
  assert.deepEqual(await gitChanges(root), changes);
  assert.equal(await fs.readFile(path.join(root, 'draft.txt'), 'utf8'), 'keep draft');
});

test('reject invalid, duplicate and missing names without moving HEAD, and support unborn branches', async t => {
  const root = await fixture(t);
  const head = await git(root, ['rev-parse', 'HEAD']);
  for (const name of ['', '--force', '@{-1}', 'bad name', 'a..b', 'x\ny', null, 'x'.repeat(256)]) {
    await assert.rejects(gitBranchAction(root, 'create', name));
  }
  await assert.rejects(gitBranchAction(root, 'delete', 'main'), /Unknown branch action/);
  await assert.rejects(gitBranchAction(root, 'create', 'main'), /already exists/);
  await assert.rejects(gitBranchAction(root, 'switch', 'missing'));
  assert.equal(await currentBranch(root), 'main');
  assert.equal(await git(root, ['rev-parse', 'HEAD']), head);
  const unborn = await fixture(t, false);
  assert.deepEqual(await gitBranches(unborn), ['main']);
  await gitBranchAction(unborn, 'create', 'first-draft');
  assert.equal(await currentBranch(unborn), 'first-draft');
  assert.deepEqual(await gitBranches(unborn), ['first-draft']);
  assert.equal(await fs.readFile(path.join(unborn, 'index.html'), 'utf8'), 'original');
});

test('switches suppress repository hooks and filters, respect locks and cancellation', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, '.gitattributes'), '*.html filter=custom\n');
  await gitFilesAction(root, 'stage', ['.gitattributes']);
  await gitFilesAction(root, 'commit', [], 'Attributes');
  await gitBranchAction(root, 'create', 'other');
  await fs.writeFile(path.join(root, 'index.html'), 'other slides');
  await gitFilesAction(root, 'stage', ['index.html']);
  await gitFilesAction(root, 'commit', [], 'Other slides');
  const marker = path.join(root, 'executed');
  for (const key of ['clean', 'smudge', 'process']) await git(root, ['config', `filter.custom.${key}`, `touch '${marker}'`]);
  await git(root, ['config', 'filter.custom.required', 'true']);
  await fs.mkdir(path.join(root, '.git', 'hooks'), { recursive: true });
  await fs.writeFile(path.join(root, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  await gitBranchAction(root, 'switch', 'main');
  assert.equal(await fs.readFile(path.join(root, 'index.html'), 'utf8'), 'original');
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  await fs.writeFile(path.join(root, '.git', 'index.lock'), '');
  await assert.rejects(gitBranchAction(root, 'switch', 'other'));
  await fs.unlink(path.join(root, '.git', 'index.lock'));
  assert.equal(await currentBranch(root), 'main');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(gitBranchAction(root, 'create', 'cancelled', controller.signal));
  assert.ok(!(await gitBranches(root)).includes('cancelled'));
});
