import path from 'node:path';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';

export async function importAssets(root, sources, signal) {
  if (!Array.isArray(sources) || !sources.length || sources.some(source => typeof source !== 'string' || !path.isAbsolute(source))) {
    throw new Error('Drop files from your computer to add assets.');
  }
  const imported = [], errors = [];
  for (const source of sources) {
    signal?.throwIfAborted();
    try {
      const stat = await fs.stat(source);
      if (!stat.isFile()) throw new Error('Drop files, not folders.');
      if (stat.size > 25_000_000) throw new Error('Asset exceeds 25 MB.');
      const name = path.basename(source);
      const { name: stem, ext } = path.parse(name);
      const assets = await scopedPath(root, 'assets', true);
      await fs.mkdir(assets, { recursive: true });
      for (let suffix = 0; ; suffix++) {
        signal?.throwIfAborted();
        const relative = `assets/${suffix ? `${stem} (${suffix})${ext}` : name}`;
        const target = await scopedPath(root, relative, true);
        try {
          await fs.copyFile(source, target, constants.COPYFILE_EXCL);
          imported.push(relative);
          break;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
      }
    } catch (error) { errors.push(`${path.basename(source)}: ${error.message}`); }
  }
  return { imported, errors };
}

export async function saveAsset(root, name, bytes, signal) {
  if (!name || name.startsWith('.') || /[/\\\x00-\x1f]/.test(name) || path.basename(name) !== name) throw new Error('Use a plain asset filename without directories or hidden prefixes.');
  if (bytes.length > 25_000_000) throw new Error('Asset exceeds 25 MB.');
  const assets = await scopedPath(root, 'assets', true);
  await fs.mkdir(assets, { recursive: true });
  const { name: stem, ext } = path.parse(name);
  for (let suffix = 0; ; suffix++) {
    signal?.throwIfAborted();
    const relative = `assets/${stem}${suffix ? ` (${suffix})` : ''}${ext}`;
    const target = await scopedPath(root, relative, true);
    try {
      await fs.writeFile(target, bytes, { flag: 'wx' });
      return { path: relative, bytes: bytes.length };
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}

export async function scopedPath(root, relative, writing = false) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new Error('Use a relative deck path.');
  const base = await fs.realpath(root);
  const target = path.resolve(base, relative);
  const inside = value => value === base || value.startsWith(base + path.sep);
  if (!inside(target) || relative.split(/[\\/]/).some(part => part.startsWith('.'))) throw new Error('Path is outside the deck or hidden.');
  // Resolve every existing ancestor, including symlinks, before permitting writes.
  let ancestor = target;
  while (true) {
    try {
      const real = await fs.realpath(ancestor);
      if (!inside(real)) throw new Error('Symlinks cannot escape the deck.');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT' || !writing) throw error;
      ancestor = path.dirname(ancestor);
    }
  }
  return target;
}

export async function listFiles(root, sub = '') {
  const entries = await fs.readdir(sub ? await scopedPath(root, sub) : root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
    const name = path.posix.join(sub, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, name));
    else files.push(name);
    if (files.length > 1000) throw new Error('Deck has too many files (limit 1000).');
  }
  return files;
}

export async function readFile(root, relative) {
  const target = await scopedPath(root, relative);
  if ((await fs.stat(target)).size > 1_000_000) throw new Error('Text file exceeds 1 MB.');
  return fs.readFile(target, 'utf8');
}

export async function writeFile(root, relative, content, beforeWrite = () => {}) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > 1_000_000) throw new Error('Text file exceeds 1 MB.');
  if (relative.endsWith('.json')) JSON.parse(content);
  const target = await scopedPath(root, relative, true);
  await fs.mkdir(path.dirname(target), { recursive: true });
  beforeWrite();
  await fs.writeFile(target, content, 'utf8');
  return `Saved ${relative}`;
}

export async function replaceText(root, relative, oldText, newText, signal) {
  if (!oldText) throw new Error('old_text must be non-empty. Include enough surrounding text to match exactly once.');
  if (oldText === newText) throw new Error('Replacement makes no changes. Provide different new_text.');
  if (Buffer.byteLength(oldText) > 1_000_000 || Buffer.byteLength(newText) > 1_000_000) throw new Error('Replacement text exceeds 1 MB.');
  const target = await scopedPath(root, relative);
  if (!(await fs.lstat(target)).isFile()) throw new Error('Replacement targets must be regular files, not symlinks.');
  const source = await readFile(root, relative);
  if (source.includes('\0') || newText.includes('\0')) throw new Error('Only text without null bytes is supported.');
  const start = source.indexOf(oldText);
  if (start === -1) throw new Error('old_text was not found exactly. Read the file again and preserve whitespace and line endings.');
  // Count overlapping occurrences too: "aa" is ambiguous within "aaa".
  if (source.indexOf(oldText, start + 1) !== -1) throw new Error('old_text matches more than once. Include more surrounding text to make the match unique.');
  // Slicing keeps replacement text literal, including $&, $1, and backslashes.
  const content = source.slice(0, start) + newText + source.slice(start + oldText.length);
  if (await fs.readFile(target, 'utf8') !== source) throw new Error('File changed while preparing the replacement. Read it and retry.');
  return writeFile(root, relative, content, () => signal?.throwIfAborted());
}
