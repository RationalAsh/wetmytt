import fs from 'node:fs/promises';
import path from 'node:path';
import { currentBranch, gitChanges } from './git.js';

export async function readProjectFiles(root, signal) {
  const files = [];
  async function walk(directory, prefix = '') {
    signal?.throwIfAborted();
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (['.git', '.wetmytt', 'node_modules', '.DS_Store'].includes(entry.name) || entry.isSymbolicLink()) continue;
      const relative = prefix + entry.name;
      if (files.length >= 5000) throw new Error('Project tree exceeds 5,000 entries.');
      files.push({ path: relative, directory: entry.isDirectory() });
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative + '/');
    }
  }
  await walk(root);
  const metadata = await fs.lstat(path.join(root, '.git')).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (!metadata) return { files, changes: [], branch: null, gitError: 'This project has no Git repository.' };
  try {
    const changes = await gitChanges(root, signal);
    return { files, changes, branch: await currentBranch(root, signal), gitError: null };
  } catch (error) {
    return { files, changes: [], branch: null, gitError: error.message };
  }
}
