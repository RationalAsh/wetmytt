import { readFile, writeFile } from './files.js';
import { replaceText } from '../shared/content.js';

export async function readContent(root) {
  const source = await readFile(root, 'deck.json');
  JSON.parse(source);
  return source;
}

export async function saveContent(root, source, pointer, text) {
  if (typeof source !== 'string' || await readContent(root) !== source) {
    throw new Error('deck.json changed on disk. Reload the fields before saving your edit.');
  }
  const value = replaceText(JSON.parse(source), pointer, text);
  const next = JSON.stringify(value, null, 2) + '\n';
  await writeFile(root, 'deck.json', next);
  return next;
}
