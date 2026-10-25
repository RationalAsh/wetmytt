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
    throw new Error(`Git failed: ${(error.stderr || error.message).slice(0, 4000)}`);
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
