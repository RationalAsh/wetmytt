import fs from 'node:fs/promises';
import path from 'node:path';

export function createRecentFolders(filename) {
  let entries = [], queue = Promise.resolve();
  const serialize = operation => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const save = async next => {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
    await fs.rename(temporary, filename);
    entries = next;
    return [...entries];
  };
  return {
    load: () => serialize(async () => {
      try {
        const saved = JSON.parse(await fs.readFile(filename, 'utf8'));
        entries = Array.isArray(saved) ? [...new Set(saved.filter(value => typeof value === 'string' && path.isAbsolute(value)).map(value => path.normalize(value)))].slice(0, 10) : [];
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        entries = [];
      }
      return [...entries];
    }),
    list: () => [...entries],
    add: folder => serialize(async () => {
      const canonical = await fs.realpath(folder);
      return save([canonical, ...entries.filter(entry => entry !== canonical)].slice(0, 10));
    }),
    remove: folder => serialize(() => save(entries.filter(entry => entry !== folder))),
    clear: () => serialize(() => save([])),
  };
}
