import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const OUTPUT_LIMIT = 64 * 1024;

// Commands intentionally have the current user's permissions, not the file tools' scope.
export async function runCommand(root, { command, timeout_ms = 60000 }, signal) {
  if (typeof command !== 'string' || !command.trim() || command.includes('\0')) throw new Error('Provide a nonempty shell command without null bytes.');
  if (!Number.isInteger(timeout_ms) || timeout_ms < 1 || timeout_ms > 180000) throw new Error('timeout_ms must be an integer between 1 and 180000.');
  signal?.throwIfAborted();

  return new Promise((resolve, reject) => {
    const windows = process.platform === 'win32';
    const shell = windows ? process.env.ComSpec || 'cmd.exe' : process.env.SHELL || '/bin/sh';
    const child = spawn(shell, windows ? ['/d', '/s', '/c', command] : ['-c', command], {
      cwd: root, detached: !windows, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let bytes = 0, truncated = false, timedOut = false, cancelled = false;
    const output = { stdout: '', stderr: '' };
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
      const kept = chunk.subarray(0, Math.max(0, OUTPUT_LIMIT - bytes));
      bytes += kept.length;
      output[stream] += decoders[stream].write(kept);
      if (kept.length < chunk.length) truncated = true;
    });
    const killTree = () => {
      if (!child.pid) return;
      if (windows) {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill('SIGKILL'));
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
      }
    };
    const abort = () => { cancelled = true; killTree(); };
    const timer = setTimeout(() => { timedOut = true; killTree(); }, timeout_ms);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    signal?.addEventListener('abort', abort, { once: true });
    // Account for cancellation between the initial check and listener registration.
    if (signal?.aborted) abort();
    child.once('error', error => { cleanup(); reject(new Error(`Could not run command: ${error.message}`)); });
    // Do not leave background jobs running after a command finishes.
    if (!windows) child.once('exit', killTree);
    child.once('close', (exitCode, exitSignal) => {
      cleanup();
      for (const stream of ['stdout', 'stderr']) output[stream] += decoders[stream].end();
      resolve({ ...output, exit_code: exitCode, signal: exitSignal, timed_out: timedOut, cancelled, truncated });
    });
  });
}
