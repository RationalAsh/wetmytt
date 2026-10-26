import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

// Matrix builds each produce latest-mac.yml. Merge their file lists rather
// than letting artifact downloads overwrite one architecture's update feed.
export async function mergeMacUpdates(directory) {
  const manifests = await Promise.all(['arm64', 'x64'].map(async arch => {
    const info = yaml.load(await fs.readFile(path.join(directory, `latest-mac-${arch}.yml`), 'utf8'));
    if (!info?.version || !Array.isArray(info.files) || !info.files.some(file => file.url.endsWith(`-mac-${arch}.zip`))) throw new Error(`Missing ${arch} update ZIP`);
    return info;
  }));
  if (manifests[0].version !== manifests[1].version) throw new Error('Update manifest versions do not match');
  const files = manifests.flatMap(info => info.files);
  if (new Set(files.map(file => file.url)).size !== files.length) throw new Error('Duplicate update assets');
  for (const file of files) {
    if (typeof file.url !== 'string' || path.basename(file.url) !== file.url) throw new Error('Invalid update asset filename');
    const filename = path.join(directory, file.url);
    const hash = createHash('sha512');
    for await (const chunk of createReadStream(filename)) hash.update(chunk);
    if (hash.digest('base64') !== file.sha512) throw new Error(`Checksum mismatch: ${file.url}`);
    if (file.size != null && (await fs.stat(filename)).size !== file.size) throw new Error(`Size mismatch: ${file.url}`);
  }
  const merged = { ...manifests[0], files };
  await fs.writeFile(path.join(directory, 'latest-mac.yml'), yaml.dump(merged));
  return merged;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await mergeMacUpdates(path.resolve(process.argv[2] || 'dist'));
}
