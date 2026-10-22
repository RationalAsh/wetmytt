import path from 'node:path';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';

export async function importAssets(root, sources) {
  if (!Array.isArray(sources) || !sources.length || sources.some(source => typeof source !== 'string' || !path.isAbsolute(source))) {
    throw new Error('Drop files from your computer to add assets.');
  }
  const imported = [], errors = [];
  for (const source of sources) {
    try {
      if (!(await fs.stat(source)).isFile()) throw new Error('Drop files, not folders.');
      const name = path.basename(source);
      const { name: stem, ext } = path.parse(name);
      const assets = await scopedPath(root, 'assets', true);
      await fs.mkdir(assets, { recursive: true });
      for (let suffix = 0; ; suffix++) {
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

export async function writeFile(root, relative, content) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > 1_000_000) throw new Error('Text file exceeds 1 MB.');
  if (relative.endsWith('.json')) JSON.parse(content);
  const target = await scopedPath(root, relative, true);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
  return `Saved ${relative}`;
}
