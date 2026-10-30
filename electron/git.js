import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveEmbeddedGitDir, setupEnvironment } from 'dugite';
import { scopedPath, listFiles } from './files.js';

const execute = promisify(execFile);
const nullFile = process.platform === 'win32' ? 'NUL' : '/dev/null';
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const gitDirectory = () => moduleDirectory.includes(`${path.sep}app.asar${path.sep}`)
  ? path.resolve(moduleDirectory, '..', '..', 'git') : resolveEmbeddedGitDir();

async function command(root, args, signal, extra = []) {
  signal?.throwIfAborted();
  // Do not inherit Git's repository, config injection, pager, or executable overrides.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GIT_|LOCAL_GIT_DIRECTORY$)/i.test(key)));
  const { env, gitLocation } = setupEnvironment({ LOCAL_GIT_DIRECTORY: gitDirectory(), GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', GIT_PAGER: 'cat' }, inherited);
  try {
    const { stdout } = await execute(gitLocation, ['--no-pager', '--literal-pathspecs', `--git-dir=${path.join(root, '.git')}`, `--work-tree=${root}`, '-c', `core.hooksPath=${nullFile}`, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'submodule.recurse=false', '-c', 'protocol.allow=never', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', '-c', 'core.attributesFile=' + nullFile, ...extra, ...args], {
      cwd: root, env, signal, timeout: 30000, maxBuffer: 256 * 1024, windowsHide: true,
    });
    return stdout;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error.code === 'ENOENT') throw new Error('Bundled Git is unavailable. Reinstall the app (development: npm rebuild dugite).');
    const failure = new Error(`Git failed: ${(error.stderr || error.message).slice(0, 4000)}`);
    failure.gitExitCode = error.code;
    throw failure;
  }
}

async function repository(root, signal) {
  const base = await fs.realpath(root);
  const metadata = path.join(base, '.git');
  const stat = await fs.lstat(metadata).catch(() => null);
  if (!stat) throw new Error('This presentation has no Git repository. Use git_init first.');
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Git tools require a .git directory inside this presentation; linked worktrees and external repositories are not supported.');
  // Git may otherwise redirect its work tree or object storage outside this deck.
  for (const relative of ['objects', 'refs', 'config', 'HEAD', 'index', 'commondir', 'objects/info/alternates']) {
    const filename = path.join(metadata, relative);
    const entry = await fs.lstat(filename).catch(() => null);
    if (entry?.isSymbolicLink() || (entry && ['commondir', 'objects/info/alternates'].includes(relative))) throw new Error('External Git metadata is not supported.');
  }
  const actual = (await command(base, ['rev-parse', '--show-toplevel'], signal)).trim();
  if (await fs.realpath(actual) !== base) throw new Error('Git repository must belong to this presentation folder.');
  return base;
}

// A repository can configure clean/smudge/process filters. Override all of them
// for operations that might read or write the working tree.
async function noFilters(root, signal) {
  const config = await command(root, ['config', '--null', '--list'], signal);
  const flags = [];
  for (const entry of config.split('\0')) {
    const key = entry.split('\n')[0];
    if (/^filter\..*\.(clean|smudge|process|required)$/i.test(key)) flags.push('-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`);
  }
  return flags;
}

async function paths(root, values) {
  for (const value of values) {
    const target = value === '.gitignore' ? path.join(root, value) : await scopedPath(root, value, true);
    const stat = await fs.lstat(target).catch(() => null);
    if (stat && !stat.isFile()) throw new Error('Use explicit regular file paths, not directories or symlinks.');
  }
  return values;
}

export async function currentBranch(root, signal) {
  try {
    root = await repository(root, signal);
    const branch = (await command(root, ['branch', '--show-current'], signal)).trim();
    return branch || 'Detached HEAD';
  } catch {
    return null;
  }
}

export async function gitHistory(root, { skip = 0, head, limit = 50 } = {}, signal) {
  if (!Number.isSafeInteger(skip) || skip < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50 || (head !== undefined && !/^[a-f0-9]{40,64}$/.test(head))) throw new Error('Invalid history page.');
  root = await repository(root, signal);
  if (!head) head = (await command(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], signal).catch(error => {
    signal?.throwIfAborted();
    if (error.gitExitCode !== 1) throw error;
    return '';
  })).trim();
  if (!head) return { commits: [], head: null, hasMore: false };
  const output = await command(root, ['log', '-z', '--no-show-signature', '--format=%H%x00%h%x00%an%x00%aI%x00%s%x00%b', `--max-count=${limit + 1}`, `--skip=${skip}`, head, '--'], signal);
  const fields = output.split('\0'), commits = [];
  for (let i = 0; i + 5 < fields.length; i += 6) {
    commits.push({ hash: fields[i], shortHash: fields[i + 1], author: fields[i + 2], date: fields[i + 3], subject: fields[i + 4], body: fields[i + 5].trimEnd() });
  }
  return { commits: commits.slice(0, limit), head, hasMore: commits.length > limit };
}

export async function gitSummary(root, signal) {
  try {
    const [branch, changes, history] = await Promise.all([currentBranch(root, signal), gitChanges(root, signal), gitHistory(root, { limit: 1 }, signal)]);
    return { branch, latestCommit: history.commits[0] || null, dirty: changes.length > 0, error: null };
  } catch (error) {
    signal?.throwIfAborted();
    return { branch: null, latestCommit: null, dirty: null, error: error.message.includes('no Git repository') ? 'This project has no Git repository. Initialize Git in Files to start its history.' : error.message };
  }
}

// Porcelain -z preserves spaces, newlines, Unicode, and rename destinations.
export async function gitChanges(root, signal) {
  root = await repository(root, signal);
  const records = (await command(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'], signal, await noFilters(root, signal))).split('\0');
  const changes = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const index = record[0], worktree = record[1], filename = record.slice(3);
    const originalPath = /[RC]/.test(index + worktree) ? records[++i] : undefined;
    const conflict = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(index + worktree);
    changes.push({ path: filename, originalPath, index, worktree, conflict });
  }
  return changes;
}

// Stash saves the index, working files, and new files before restoring HEAD.
// Keep the stash: restoring a save must never throw away the user's only copy.
export async function restoreLastSave(root, signal) {
  root = await repository(root, signal);
  const head = (await gitHistory(root, { limit: 1 }, signal)).head;
  if (!head) throw new Error('There is no saved version yet. Save a version in Files first.');
  const changes = await gitChanges(root, signal);
  if (!changes.length) return { restored: false, backup: null };
  if (changes.some(change => change.conflict)) throw new Error('Resolve the conflicting files before restoring a saved version. Your files have not been changed.');
  const message = 'Backup before restoring last save';
  // Stash internally passes quoted untracked filenames to clean; forcing literal
  // pathspecs there leaves names containing Unicode or newlines behind. This
  // operation accepts no user-supplied pathspecs, so use Git's normal handling.
  await command(root, ['--no-literal-pathspecs', 'stash', 'push', '--include-untracked', '--message', message], signal, [
    ...await noFilters(root, signal),
    '-c', 'user.name=Welcome to My TED Talk', '-c', 'user.email=wetmytt@users.noreply.local',
  ]);
  const backup = (await command(root, ['rev-parse', '--verify', 'refs/stash'], signal)).trim();
  if ((await gitChanges(root, signal)).length) throw new Error(`Some files could not be restored or changed during restore. Your backup is ${backup}. Pause other editors and try again.`);
  return { restored: true, backup };
}

export async function gitFilesAction(root, action, values, message, signal) {
  root = await repository(root, signal);
  if (action === 'commit') {
    if (typeof message !== 'string' || !message.trim() || message.length > 10000) throw new Error('Enter a commit message (up to 10,000 characters).');
    return gitTool(root, 'git_commit', { message: message.trim() }, signal);
  }
  if (!['stage', 'unstage'].includes(action)) throw new Error('Unknown files action.');
  if (!Array.isArray(values) || !values.length || values.length > 1000) throw new Error('Select files to stage or unstage.');
  for (const value of values) {
    if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.split(/[/\\]/).some(part => ['..', '.git', '.wetmytt', 'node_modules'].includes(part))) throw new Error('Use project file paths.');
    let target = path.resolve(root, value);
    if (!target.startsWith(root + path.sep)) throw new Error('Path is outside the project.');
    while (target !== root) {
      const stat = await fs.lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (stat?.isSymbolicLink()) throw new Error('Symlinks cannot be staged from Files.');
      if (target === path.resolve(root, value) && stat && !stat.isFile()) throw new Error('Select files, not directories.');
      target = path.dirname(target);
    }
  }
  // An unborn branch has no HEAD for restore --staged; remove only its index entries.
  const hasHead = await command(root, ['rev-parse', '--verify', 'HEAD'], signal).then(() => true, () => false);
  const args = action === 'stage' ? ['add'] : hasHead ? ['restore', '--staged'] : ['rm', '--cached', '--force'];
  return command(root, [...args, '--', ...values], signal, await noFilters(root, signal));
}

export async function gitInit(root, signal, initialCommit = false) {
  signal?.throwIfAborted();
  const metadata = await fs.lstat(path.join(root, '.git')).catch(() => null);
  if (metadata) { await repository(root, signal); return 'Git is already initialized.'; }
  await command(root, ['init', '--initial-branch=main', '--template='], signal);
  const ignore = path.join(root, '.gitignore');
  const info = await fs.lstat(ignore).catch(() => null);
  if (info?.isSymbolicLink()) throw new Error('.gitignore must not be a symlink.');
  const content = info ? await fs.readFile(ignore, 'utf8') : '';
  await fs.writeFile(ignore, `${content}${content && !content.endsWith('\n') ? '\n' : ''}\n# Local app history and OS files\n.wetmytt/\n.DS_Store\nnode_modules/\n`);
  if (initialCommit) {
    const files = await listFiles(root);
    await command(root, ['add', '--', '.gitignore', ...files], signal, await noFilters(root, signal));
    await gitTool(root, 'git_commit', { message: 'Create presentation' }, signal);
  }
  return initialCommit ? 'Initialized Git on main with an initial commit.' : 'Initialized Git on main. Stage files and commit to begin history.';
}

export async function gitTool(root, name, args, signal) {
  if (name === 'git_init') return gitInit(root, signal);
  root = await repository(root, signal);
  if (name === 'git_status') return command(root, ['status', '--short', '--branch', '--untracked-files=normal', '--ignore-submodules=all'], signal);
  if (name === 'git_diff') return command(root, ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', ...(args.staged ? ['--cached'] : []), '--', ...await paths(root, args.paths || [])], signal);
  if (name === 'git_log') return command(root, ['log', `-${args.count ?? 10}`, '--format=%h %aI %an%n%s', '--no-show-signature'], signal);
  if (name === 'git_stage') return command(root, ['add', '--', ...await paths(root, args.paths)], signal, await noFilters(root, signal));
  if (name === 'git_unstage') return command(root, ['restore', '--staged', '--', ...await paths(root, args.paths)], signal, await noFilters(root, signal));
  if (name === 'git_commit') {
    const config = await command(root, ['config', '--null', '--list'], signal);
    const entries = new Map(config.split('\0').map(entry => { const at = entry.indexOf('\n'); return [entry.slice(0, at), entry.slice(at + 1)]; }));
    const identity = ['-c', `user.name=${entries.get('user.name') || 'Welcome to My TED Talk'}`, '-c', `user.email=${entries.get('user.email') || 'wetmytt@users.noreply.local'}`];
    return command(root, ['commit', '--no-verify', '--no-gpg-sign', '-m', args.message], signal, [...await noFilters(root, signal), ...identity]);
  }
  if (name === 'git_branch') {
    if (!args.name) return command(root, ['branch', '--list'], signal);
    await command(root, ['check-ref-format', '--branch', args.name], signal);
    return command(root, ['branch', '--no-track', args.name], signal);
  }
  if (name === 'git_switch') {
    await command(root, ['check-ref-format', '--branch', args.name], signal);
    return command(root, ['switch', '--no-guess', args.name], signal, await noFilters(root, signal));
  }
  if (name === 'git_restore') return command(root, ['restore', '--worktree', '--', ...await paths(root, args.paths)], signal, await noFilters(root, signal));
  throw new Error(`Unknown Git operation: ${name}`);
}
