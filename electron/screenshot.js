import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const execute = promisify(execFile);

export async function screenshotSlide(root, slide) {
  if (!Number.isSafeInteger(slide) || slide < 1) throw new Error('Slide must be a positive integer, starting at 1.');
  await fs.access(path.join(root, 'index.html'));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wetmytt-screenshot-'));
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      await execute(electron, [fileURLToPath(new URL('./screenshot-worker.js', import.meta.url)), path.resolve(root), String(slide), directory], {
        env, timeout: 25000, killSignal: 'SIGKILL', maxBuffer: 1_000_000,
      });
    } catch (error) {
      const message = await fs.readFile(path.join(directory, 'error.txt'), 'utf8').catch(() => null);
      throw new Error(message || (error.killed ? 'Slide screenshot timed out after 25 seconds.' : `Could not render slide screenshot: ${error.message}`));
    }
    return await fs.readFile(path.join(directory, 'slide.png'));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
