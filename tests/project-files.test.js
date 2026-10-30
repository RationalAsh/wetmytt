import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveGitBinary } from 'dugite';
import { gitChanges, gitFilesAction, gitInit } from '../electron/git.js';
import { readProjectFiles } from '../electron/project-files.js';

const git = (root, args) => promisify(execFile)(resolveGitBinary(), args, { cwd: root });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wetmytt-files-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('project tree includes hidden project files and empty folders, excludes app internals and symlinks', async t => {
  const root = await fixture(t);
  for (const dir of ['empty', 'assets', '.github', '.wetmytt', 'node_modules']) await fs.mkdir(path.join(root, dir));
  for (const file of ['index.html', 'assets/image.svg', '.github/config.yml', '.wetmytt/chat.json', 'node_modules/large.js']) await fs.writeFile(path.join(root, file), 'test');
  await fs.symlink(os.tmpdir(), path.join(root, 'external'));
  const data = await readProjectFiles(root);
  assert.deepEqual(data.files.map(f => f.path).sort(), ['.github', '.github/config.yml', 'assets', 'assets/image.svg', 'empty', 'index.html']);
  assert.match(data.gitError, /no Git repository/);
  await gitInit(root);
  assert.equal((await readProjectFiles(root)).gitError, null);
});

test('files Git operations handle first commit, partial staging, deletion, rename and unusual filenames', async t => {
  const root = await fixture(t);
  await gitInit(root);
  const unusual = 'slides/你好 space\nline.txt';
  await fs.mkdir(path.join(root, 'slides'));
  await fs.writeFile(path.join(root, unusual), 'first');
  await fs.writeFile(path.join(root, '.hidden'), 'hidden');
  let changes = await gitChanges(root);
  assert.ok(changes.some(c => c.path === unusual && c.index === '?'));
  await gitFilesAction(root, 'stage', [unusual, '.hidden']);
  await gitFilesAction(root, 'unstage', [unusual]);
  assert.ok((await gitChanges(root)).some(c => c.path === unusual && c.index === '?'));
  await gitFilesAction(root, 'stage', [unusual, '.gitignore']);
  await gitFilesAction(root, 'commit', [], 'Initial files');
  assert.equal((await gitChanges(root)).length, 0);
  await fs.writeFile(path.join(root, unusual), 'second');
  await gitFilesAction(root, 'stage', [unusual]);
  await fs.writeFile(path.join(root, unusual), 'third');
  changes = await gitChanges(root);
  assert.equal(changes[0].index + changes[0].worktree, 'MM');
  await gitFilesAction(root, 'commit', [], 'Only staged version');
  assert.equal((await git(root, ['show', `HEAD:${unusual}`])).stdout, 'second');
  assert.equal(await fs.readFile(path.join(root, unusual), 'utf8'), 'third');
  await gitFilesAction(root, 'stage', [unusual]);
  await gitFilesAction(root, 'unstage', [unusual]);
  assert.equal((await gitChanges(root))[0].index, ' ');
  await fs.unlink(path.join(root, '.hidden'));
  await gitFilesAction(root, 'stage', ['.hidden']);
  await gitFilesAction(root, 'commit', [], 'Remove hidden file');
  await git(root, ['mv', '--', unusual, 'renamed.txt']);
  changes = await gitChanges(root);
  assert.ok(changes.some(c => c.path === 'renamed.txt' && c.originalPath === unusual && c.index === 'R'));
  await gitFilesAction(root, 'unstage', ['renamed.txt', unusual]);
  assert.ok((await gitChanges(root)).some(c => c.path === unusual && c.worktree === 'D'));
});

test('files Git actions reject traversal, internal metadata, symlinks and invalid requests', async t => {
  const root = await fixture(t);
  await gitInit(root);
  await fs.writeFile(path.join(root, 'file.txt'), 'safe');
  await fs.symlink(path.join(root, 'file.txt'), path.join(root, 'link'));
  for (const file of ['../outside', '.git/config', '.wetmytt/chats/a', 'node_modules/a', 'link', '/tmp/outside']) {
    await assert.rejects(gitFilesAction(root, 'stage', [file]));
  }
  await assert.rejects(gitFilesAction(root, 'stage', []));
  await assert.rejects(gitFilesAction(root, 'delete', ['file.txt']));
  await assert.rejects(gitFilesAction(root, 'commit', [], '   '));
  assert.equal((await git(root, ['diff', '--cached', '--name-only'])).stdout, '');
});

test('files status identifies unresolved conflicts and clears them after staging a resolution', async t => {
  const root = await fixture(t);
  await gitInit(root);
  await git(root, ['config', 'user.name', 'Test']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await fs.writeFile(path.join(root, 'slide.txt'), 'base\n');
  await gitFilesAction(root, 'stage', ['slide.txt', '.gitignore']);
  await gitFilesAction(root, 'commit', [], 'Base');
  await git(root, ['checkout', '-b', 'other']);
  await fs.writeFile(path.join(root, 'slide.txt'), 'other\n');
  await gitFilesAction(root, 'stage', ['slide.txt']);
  await gitFilesAction(root, 'commit', [], 'Other');
  await git(root, ['checkout', 'main']);
  await fs.writeFile(path.join(root, 'slide.txt'), 'main\n');
  await gitFilesAction(root, 'stage', ['slide.txt']);
  await gitFilesAction(root, 'commit', [], 'Main');
  await assert.rejects(git(root, ['merge', 'other']));
  assert.equal((await gitChanges(root))[0].conflict, true);
  await fs.writeFile(path.join(root, 'slide.txt'), 'resolved\n');
  await gitFilesAction(root, 'stage', ['slide.txt']);
  assert.equal((await gitChanges(root))[0].conflict, false);
});
