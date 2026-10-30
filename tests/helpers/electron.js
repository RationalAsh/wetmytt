import { spawn } from 'node:child_process';
import electron from 'electron';

// Wait for close so the fixture and its output streams are finished before the
// test removes its profile. A graceful quit can itself hang during app cleanup.
export function runTestProcess(command, args, { env = process.env, timeout = 60000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, timeout, signal, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '', failure;
    child.stdout.on('data', chunk => { log += chunk; });
    child.stderr.on('data', chunk => { log += chunk; });
    child.on('error', error => { failure = error; });
    child.once('close', (code, exitSignal) => {
      if (failure || code !== 0) {
        reject(new Error(`Fixture ${args[0]} failed (${failure?.message || exitSignal || `exit ${code}`}; timeout ${timeout}ms).\n${log}`, { cause: failure }));
      } else resolve(log);
    });
  });
}

export function runElectronFixture(t, fixture, args, options = {}) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.WETMYTT_DEV_URL;
  return runTestProcess(electron, [fixture, ...args], { ...options, env, signal: t.signal });
}
