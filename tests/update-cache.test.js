import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DownloadedUpdateHelper } from 'electron-updater/out/DownloadedUpdateHelper.js';
import { GenericDifferentialDownloader } from 'electron-updater/out/differentialDownloader/GenericDifferentialDownloader.js';
import { cleanInstalledUpdateCache } from '../electron/update-cache.js';

async function fixture(t, version = '0.3.2', arch = 'arm64') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wetmytt-update-cache-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const pending = path.join(directory, 'pending');
  await fs.mkdir(pending);
  const fileName = `wetmytt-${version}-mac-${arch}.zip`;
  const data = Buffer.from(`verified ZIP for ${version}`);
  const sha512 = createHash('sha512').update(data).digest('base64');
  const archive = path.join(pending, fileName);
  const metadata = path.join(pending, 'update-info.json');
  await fs.writeFile(archive, data);
  await fs.writeFile(metadata, JSON.stringify({ fileName, sha512, isAdminRightsRequired: false }));
  await fs.writeFile(path.join(directory, 'update.zip'), data);
  await fs.writeFile(path.join(directory, 'current.blockmap'), 'differential base blockmap');
  await fs.writeFile(path.join(pending, 'current.blockmap'), 'pending blockmap');
  return { directory, pending, archive, metadata, fileName, data, sha512 };
}

for (const arch of ['arm64', 'x64']) {
  test(`after installation, removes only the ${arch} pending copy and keeps the differential base`, async t => {
    const f = await fixture(t, '0.3.2', arch);
    const unknown = path.join(f.pending, 'temp-other-update.zip');
    await fs.writeFile(unknown, 'leave unknown files alone');
    await cleanInstalledUpdateCache(f.directory, '0.3.2');
    assert.deepEqual(await fs.readdir(f.pending), ['temp-other-update.zip']);
    assert.deepEqual(await fs.readFile(path.join(f.directory, 'update.zip')), f.data);
    assert.equal(await fs.readFile(path.join(f.directory, 'current.blockmap'), 'utf8'), 'differential base blockmap');
    // Cleanup is safe to repeat, including after an interrupted cleanup.
    await cleanInstalledUpdateCache(f.directory, '0.3.2');
  });
}

test('preserves an upcoming update and the real updater can reuse its verified ZIP offline', async t => {
  const f = await fixture(t, '0.3.3');
  await cleanInstalledUpdateCache(f.directory, '0.3.2');
  assert.deepEqual(await fs.readFile(f.archive), f.data);
  assert.ok(await fs.stat(f.metadata));
  assert.ok(await fs.stat(path.join(f.pending, 'current.blockmap')));
  // Exercise electron-updater's actual cache validator, not a mock of it.
  const helper = new DownloadedUpdateHelper(f.directory);
  const info = { url: f.fileName, sha512: f.sha512, size: f.data.length };
  assert.equal(await helper.validateDownloadedPath(f.archive, { version: '0.3.3' }, { info }, { info() {}, warn() {} }), f.archive);
  // Only a subsequent launch of the installed version may reclaim that copy.
  await cleanInstalledUpdateCache(f.directory, '0.3.3');
  await assert.rejects(fs.stat(f.archive), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'update.zip')), f.data);
});

test('the real differential downloader can reconstruct and checksum data from the retained base', async t => {
  const f = await fixture(t);
  const blocks = [f.data.subarray(0, 8), f.data.subarray(8)];
  const blockmap = parts => ({ version: '2', files: [{ name: 'file', offset: 0,
    checksums: parts.map(block => createHash('sha256').update(block).digest('base64')),
    sizes: parts.map(block => block.length),
  }] });
  const oldMap = blockmap(blocks);
  await fs.writeFile(path.join(f.directory, 'current.blockmap'), JSON.stringify(oldMap));
  await cleanInstalledUpdateCache(f.directory, '0.3.2');
  const reordered = [...blocks].reverse();
  const expected = Buffer.concat(reordered);
  const destination = path.join(f.directory, 'next-update.zip');
  const downloader = new GenericDifferentialDownloader({ size: expected.length,
    sha512: createHash('sha512').update(expected).digest('base64'),
  }, { createRequest() { throw new Error('Cached blocks must not require a network request.'); } }, {
    oldFile: path.join(f.directory, 'update.zip'), newFile: destination,
    newUrl: new URL('https://example.com/next-update.zip'), isUseMultipleRangeRequest: false,
    logger: { info() {}, warn() {}, error() {} },
  });
  await downloader.download(JSON.parse(await fs.readFile(path.join(f.directory, 'current.blockmap'), 'utf8')), blockmap(reordered));
  assert.deepEqual(await fs.readFile(destination), expected);
});

test('skips unknown versions and unsafe or malformed metadata without deleting files', async t => {
  const f = await fixture(t);
  for (const version of ['0.3.1', '0.3.3', '0.3.2-beta.1', '../0.3.2']) {
    await cleanInstalledUpdateCache(f.directory, version);
    assert.deepEqual(await fs.readFile(f.archive), f.data);
  }
  for (const metadata of ['{broken', 'null', JSON.stringify({ fileName: '../update.zip' }), JSON.stringify({ fileName: 'unknown.zip' })]) {
    await fs.writeFile(f.metadata, metadata);
    await cleanInstalledUpdateCache(f.directory, '0.3.2');
    assert.deepEqual(await fs.readFile(f.archive), f.data);
    assert.equal(await fs.readFile(f.metadata, 'utf8'), metadata);
  }
});

test('skips symlinks for the cache, pending directory, metadata, and archive', async t => {
  for (const location of ['cache', 'pending', 'metadata', 'archive']) {
    const f = await fixture(t);
    const target = location === 'cache' ? f.directory : location === 'pending' ? f.pending : f[location];
    const moved = `${target}-real`;
    await fs.rename(target, moved);
    t.after(() => fs.rm(moved, { recursive: true, force: true }));
    await fs.symlink(moved, target);
    await cleanInstalledUpdateCache(f.directory, '0.3.2');
    assert.equal((await fs.lstat(target)).isSymbolicLink(), true);
    const archive = location === 'archive' ? moved : location === 'pending' ? path.join(moved, f.fileName) : f.archive;
    assert.deepEqual(await fs.readFile(archive), f.data);
  }
});

test('handles absent caches and interrupted cleanup; filesystem failures can be caught by startup', async t => {
  const f = await fixture(t);
  await cleanInstalledUpdateCache(path.join(f.directory, 'missing'), '0.3.2');
  await fs.unlink(f.archive);
  await cleanInstalledUpdateCache(f.directory, '0.3.2');
  assert.deepEqual(await fs.readdir(f.pending), []);
  // Unexpected I/O failures propagate to the startup warning handler.
  await assert.rejects(cleanInstalledUpdateCache(`${f.directory}\0`, '0.3.2'), { code: 'ERR_INVALID_ARG_VALUE' });
});
