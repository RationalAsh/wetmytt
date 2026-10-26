import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import { mergeMacUpdates } from '../scripts/merge-mac-updates.js';

test('matrix manifests retain both architecture ZIPs and reject incomplete or corrupt releases', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wetmytt-update-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const arch of ['arm64', 'x64']) {
    const files = [];
    for (const ext of ['zip', 'dmg']) {
      const url = `wetmytt-0.4.0-mac-${arch}.${ext}`, data = Buffer.from(`${arch} ${ext}`);
      await fs.writeFile(path.join(directory, url), data);
      files.push({ url, sha512: createHash('sha512').update(data).digest('base64'), size: data.length });
    }
    await fs.writeFile(path.join(directory, `latest-mac-${arch}.yml`), yaml.dump({ version: '0.4.0', files, path: files[0].url, sha512: files[0].sha512 }));
  }
  const merged = await mergeMacUpdates(directory);
  assert.equal(merged.files.length, 4);
  assert.deepEqual(yaml.load(await fs.readFile(path.join(directory, 'latest-mac.yml'), 'utf8')), merged);
  await fs.writeFile(path.join(directory, 'wetmytt-0.4.0-mac-x64.zip'), 'corrupt');
  await assert.rejects(mergeMacUpdates(directory), /Checksum mismatch/);
  const filename = path.join(directory, 'latest-mac-x64.yml');
  const info = yaml.load(await fs.readFile(filename, 'utf8'));
  info.version = '0.5.0';
  await fs.writeFile(filename, yaml.dump(info));
  await assert.rejects(mergeMacUpdates(directory), /versions do not match/);
  info.files = info.files.filter(file => !file.url.endsWith('.zip'));
  await fs.writeFile(filename, yaml.dump(info));
  await assert.rejects(mergeMacUpdates(directory), /Missing x64 update ZIP/);
});
