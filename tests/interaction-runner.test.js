import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTestProcess } from './helpers/electron.js';

test('fixture runner waits for output and reports a successful exit', async () => {
  const log = await runTestProcess(process.execPath, ['-e', 'console.log("fixture complete")']);
  assert.match(log, /fixture complete/);
});

test('fixture runner includes stdout and stderr when a fixture fails', async () => {
  await assert.rejects(runTestProcess(process.execPath, ['-e', 'console.log("last step"); console.error("failure details"); process.exitCode = 7;']), error => {
    assert.match(error.message, /exit 7/);
    assert.match(error.message, /last step/);
    assert.match(error.message, /failure details/);
    return true;
  });
});

test('fixture runner kills a stalled fixture and preserves its diagnostics', { timeout: 5000 }, async () => {
  await assert.rejects(runTestProcess(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); console.error("stalled step"); setInterval(() => {}, 1000);'], { timeout: 500 }), error => {
    assert.match(error.message, /SIGKILL/);
    assert.match(error.message, /timeout 500ms/);
    assert.match(error.message, /stalled step/);
    return true;
  });
});

test('fixture runner stops the child when its test is aborted', async () => {
  const controller = new AbortController();
  const result = runTestProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { signal: controller.signal });
  controller.abort();
  await assert.rejects(result, /aborted/i);
});
