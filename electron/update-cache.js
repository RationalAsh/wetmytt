import fs from 'node:fs/promises';
import path from 'node:path';

const stat = filename => fs.lstat(filename).catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});

// Run once at packaged macOS startup, before any update checks/downloads.
// electron-updater 6 keeps a ZIP in pending/ for Squirrel and a separate
// update.zip (+ current.blockmap) at the cache root for differential downloads.
// Only a launch of the matching version proves the pending ZIP is obsolete.
export async function cleanInstalledUpdateCache(cacheDirectory, installedVersion) {
  if (!/^\d+\.\d+\.\d+$/.test(installedVersion)) return;
  if (!(await stat(cacheDirectory))?.isDirectory()) return;
  const pending = path.join(cacheDirectory, 'pending');
  if (!(await stat(pending))?.isDirectory()) return;
  const metadataPath = path.join(pending, 'update-info.json');
  if (!(await stat(metadataPath))?.isFile()) return;
  let metadata;
  try { metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')); }
  catch (error) { if (error instanceof SyntaxError || error.code === 'ENOENT') return; throw error; }
  if (!['arm64', 'x64'].some(arch => metadata?.fileName === `wetmytt-${installedVersion}-mac-${arch}.zip`)) return;
  const archive = path.join(pending, metadata.fileName);
  const archiveStat = await stat(archive);
  if (archiveStat && !archiveStat.isFile()) return;
  // Never recursively clear pending/: unknown files may belong to a different
  // updater version. Leave the root ZIP/blockmap and Squirrel's cache alone.
  if (archiveStat) await fs.unlink(archive);
  const blockmap = path.join(pending, 'current.blockmap');
  if ((await stat(blockmap))?.isFile()) await fs.unlink(blockmap);
  await fs.unlink(metadataPath);
}
