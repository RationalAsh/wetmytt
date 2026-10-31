import { readFile, writeFile } from './files.js';
import { replaceValue } from '../shared/content.js';

export async function readContent(root) {
  const source = await readFile(root, 'deck.json');
  JSON.parse(source);
  return source;
}

const writes = new Map();
export function withContentWrite(root, action) {
  const next = (writes.get(root) || Promise.resolve()).then(action);
  const settled = next.catch(() => {});
  writes.set(root, settled);
  void settled.then(() => { if (writes.get(root) === settled) writes.delete(root); });
  return next;
}

export function saveContent(root, source, pointer, edit, guard = () => {}) {
  return withContentWrite(root, async () => {
    guard();
    if (typeof source !== 'string' || await readContent(root) !== source) {
      throw new Error('deck.json changed on disk. Reload the fields before saving your edit.');
    }
    const value = replaceValue(JSON.parse(source), pointer, edit);
    const next = JSON.stringify(value, null, 2) + '\n';
    guard();
    await writeFile(root, 'deck.json', next, guard);
    return next;
  });
}
