import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gitInit } from './git.js';

const starter = fileURLToPath(new URL('../templates/starter/', import.meta.url));

export async function createDeck(folder) {
  try {
    await fs.mkdir(folder);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Choose a new folder name to avoid overwriting files.');
    throw error;
  }
  // The root already exists because we reserved it above. Copy its contents
  // individually so errorOnExist still protects each destination entry.
  for (const entry of await fs.readdir(starter)) {
    await fs.cp(path.join(starter, entry), path.join(folder, entry), { recursive: true, force: false, errorOnExist: true });
  }
  await gitInit(folder, undefined, true);
}
