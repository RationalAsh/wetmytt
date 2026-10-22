import { spawn } from 'node:child_process';
import electron from 'electron';
const web = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', '3210'], { stdio: 'inherit' });
let desktop;
let stopping = false;
function stop() { if (stopping) return; stopping = true; desktop?.kill(); web.kill(); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
web.on('exit', () => { stop(); process.exitCode = 1; });
for (let attempt = 0; attempt < 120 && !stopping; attempt++) {
  try {
    const response = await fetch('http://127.0.0.1:3210');
    if (response.ok) {
      desktop = spawn(electron, ['.'], { stdio: 'inherit', env: { ...process.env, DECKLET_DEV_URL: 'http://127.0.0.1:3210' } });
      desktop.on('exit', stop);
      break;
    }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 500));
}
if (!desktop) { stop(); throw new Error('Next.js did not start within 60 seconds.'); }
