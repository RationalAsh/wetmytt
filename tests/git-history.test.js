import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveGitBinary } from 'dugite';
import { gitHistory, gitSummary, gitFilesAction, gitInit } from '../electron/git.js';

const git = async (root, args) => (await promisify(execFile)(resolveGitBinary(), args, { cwd: root })).stdout.trim();
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wetmytt-history-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('Git history handles missing and unborn repositories and reports untracked, staged and clean states', async t => {
  const root = await fixture(t);
  assert.match((await gitSummary(root)).error, /Initialize Git in Files/);
  await gitInit(root);
  await git(root, ['config', 'user.name', 'Timeline Author']);
  await git(root, ['config', 'user.email', 'timeline@example.com']);
  assert.deepEqual(await gitHistory(root), { commits: [], head: null, hasMore: false });
  assert.equal((await gitSummary(root)).latestCommit, null);
  assert.equal((await gitSummary(root)).dirty, true, '.gitignore is untracked');
  await gitFilesAction(root, 'stage', ['.gitignore']);
  assert.equal((await gitSummary(root)).dirty, true, 'index changes are uncommitted');
  const message = 'Opening: 你好 <script>\n\nA body with\nmultiple lines and separators \x1e \x1f.';
  await gitFilesAction(root, 'commit', [], message);
  const history = await gitHistory(root);
  assert.equal(history.commits[0].subject, 'Opening: 你好 <script>');
  assert.equal(history.commits[0].body, 'A body with\nmultiple lines and separators \x1e \x1f.');
  assert.match(history.commits[0].hash, /^[a-f0-9]{40}$/);
  assert.ok(!Number.isNaN(Date.parse(history.commits[0].date)));
  assert.equal(history.commits[0].author, 'Timeline Author');
  assert.equal((await gitSummary(root)).dirty, false);
  await fs.writeFile(path.join(root, 'notes.txt'), 'new');
  assert.equal((await gitSummary(root)).dirty, true);
  await git(root, ['checkout', '--detach']);
  assert.equal((await gitSummary(root)).branch, 'Detached HEAD');
});

test('history pages are pinned to a commit while newer commits arrive', async t => {
  const root = await fixture(t);
  await gitInit(root);
  await git(root, ['config', 'user.name', 'Timeline Author']);
  await git(root, ['config', 'user.email', 'timeline@example.com']);
  await gitFilesAction(root, 'stage', ['.gitignore']);
  await gitFilesAction(root, 'commit', [], 'Commit 0');
  const tree = await git(root, ['rev-parse', 'HEAD^{tree}']);
  let parent = await git(root, ['rev-parse', 'HEAD']);
  for (let i = 1; i <= 51; i++) parent = await git(root, ['commit-tree', tree, '-p', parent, '-m', `Commit ${i}`]);
  await git(root, ['update-ref', 'refs/heads/main', parent]);
  const first = await gitHistory(root);
  assert.equal(first.commits.length, 50);
  assert.equal(first.hasMore, true);
  assert.equal(first.commits[0].subject, 'Commit 51');
  const next = await git(root, ['commit-tree', tree, '-p', parent, '-m', 'New tip']);
  await git(root, ['update-ref', 'refs/heads/main', next]);
  const older = await gitHistory(root, { skip: first.commits.length, head: first.head });
  assert.deepEqual(older.commits.map(c => c.subject), ['Commit 1', 'Commit 0']);
  assert.equal(older.hasMore, false);
  assert.equal(new Set([...first.commits, ...older.commits].map(c => c.hash)).size, 52);
  assert.equal((await gitSummary(root)).latestCommit.subject, 'New tip');
  for (const page of [{ skip: -1 }, { skip: 1.5 }, { head: '--all' }, { limit: 500 }]) await assert.rejects(gitHistory(root, page), /Invalid history page/);
});
