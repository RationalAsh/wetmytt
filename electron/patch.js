import fs from 'node:fs/promises';
import path from 'node:path';
import { applyPatch, parsePatch } from 'diff';
import { scopedPath, readFile } from './files.js';

// Unified diffs work in folders without Git, including additions and renames.
export async function patchFiles(root, patch, signal) {
  if (Buffer.byteLength(patch) > 1_000_000) throw new Error('Patch exceeds 1 MB.');
  const formatError = 'Use a unified diff with --- and +++ file headers and numbered hunks such as @@ -1,2 +1,3 @@. Bare @@ and *** Begin Patch / *** Update File markers are not supported. Read the file and retry, or use write_file with its complete content.';
  // The diff parser skips unrecognized lines, including bare @@ markers. Reject
  // these before parsing so even a partly valid patch cannot lose edits silently.
  for (const line of patch.split(/\r?\n/)) {
    if ((line.startsWith('@@') && !/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(?: .*)?$/.test(line)) || line.startsWith('*** ')) throw new Error(formatError);
  }
  const changes = parsePatch(patch);
  if (!changes.length || changes.length > 100) throw new Error('Provide a unified diff with file headers (maximum 100 files).');
  if (changes.some(change => !change.hunks.length || !change.hunks.some(hunk => hunk.lines.some(line => line.startsWith('+') || line.startsWith('-'))))) throw new Error(formatError);
  const plans = [], touched = new Set();
  for (const change of changes) {
    signal?.throwIfAborted();
    if (change.isBinary || change.isCopy || change.newMode === '120000' || change.newMode === '160000') throw new Error('Only regular UTF-8 text patches are supported.');
    const filename = (value, prefix) => value === '/dev/null' ? null : value?.startsWith(prefix) ? value.slice(2) : value;
    const oldName = filename(change.oldFileName, 'a/');
    const newName = filename(change.newFileName, 'b/');
    if ((!oldName && !newName) || change.oldFileName === undefined || change.newFileName === undefined) throw new Error('Each patch needs --- and +++ file headers.');
    const oldPath = oldName ? await scopedPath(root, oldName, true) : null;
    const newPath = newName ? await scopedPath(root, newName, true) : null;
    for (const target of new Set([oldPath, newPath].filter(Boolean))) {
      if (touched.has(target)) throw new Error('Patch touches the same file more than once. Combine its changes into one diff.');
      touched.add(target);
      const stat = await fs.lstat(target).catch(() => null);
      if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('Patch targets must be regular files.');
    }
    const source = oldName ? await readFile(root, oldName) : '';
    if (source.includes('\0')) throw new Error('Cannot patch binary files.');
    if (newPath && newPath !== oldPath && await fs.lstat(newPath).catch(() => null)) throw new Error(`Destination already exists: ${newName}`);
    const content = applyPatch(source, change, { fuzzFactor: 0 });
    if (content === false) throw new Error(`Patch conflict in ${oldName || newName}. Read the file again before retrying.`);
    if (newPath === oldPath && content === source) throw new Error(`Patch makes no changes to ${oldName}. Read the file and provide a patch that changes its content.`);
    if (!newName && content !== '') throw new Error('A deletion patch must remove the entire file.');
    if (Buffer.byteLength(content) > 1_000_000 || content.includes('\0')) throw new Error('Patched text exceeds 1 MB or contains null bytes.');
    if (newName?.endsWith('.json')) JSON.parse(content);
    plans.push({ oldPath, newPath, source, content, oldName, newName });
  }
  // Validate every file before making any change. Check originals again so an
  // external editor's update during validation becomes a conflict.
  for (const plan of plans) {
    if (plan.oldPath && await fs.readFile(plan.oldPath, 'utf8') !== plan.source) throw new Error('Files changed while preparing the patch. Read them and retry.');
  }
  signal?.throwIfAborted();
  for (const plan of plans) {
    if (plan.newPath) {
      await scopedPath(root, plan.newName, true);
      await fs.mkdir(path.dirname(plan.newPath), { recursive: true });
      await fs.writeFile(plan.newPath, plan.content, { flag: plan.newPath === plan.oldPath ? 'w' : 'wx' });
    }
    if (plan.oldPath && plan.oldPath !== plan.newPath) await fs.unlink(plan.oldPath);
  }
  return { changed: plans.map(({ oldName, newName }) => ({ from: oldName, to: newName })) };
}
