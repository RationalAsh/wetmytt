import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createUpdates } from '../electron/updates.js';

function fixture(enabled = true) {
  const updater = new EventEmitter(), nativeUpdater = new EventEmitter();
  let time = 0, checks = 0, restarts = 0, cleaned = false, tick, interval, cancelled;
  updater.checkForUpdates = async () => { checks++; updater.emit('checking-for-update'); updater.emit('update-not-available'); return {}; };
  updater.quitAndInstall = () => { assert.equal(cleaned, true); restarts++; };
  const updates = createUpdates({ updater, nativeUpdater, enabled, notify() {}, now: () => time,
    beforeRestart: async () => { cleaned = true; },
    schedule: (fn, delay) => { tick = fn; interval = delay; return 42; }, cancel: id => { cancelled = id; },
  });
  return { updates, updater, nativeUpdater, advance: () => { time += 4 * 60 * 60 * 1000; }, tick: () => tick(),
    stats: () => ({ checks, restarts, interval, cancelled }) };
}

test('disabled builds never check, schedule, download, or install', async () => {
  const f = fixture(false);
  f.updates.start();
  await f.updates.check(); await f.updates.restart();
  assert.equal(f.updates.state().phase, 'disabled');
  assert.deepEqual(f.stats(), { checks: 0, restarts: 0, interval: undefined, cancelled: undefined });
  assert.equal(f.updater.autoDownload, undefined);
});

test('checks at startup and every four hours, coalesces clicks, throttles retries, and stops on quit', async () => {
  const f = fixture();
  f.updates.start(); f.updates.start();
  await Promise.all([f.updates.check(), f.updates.check()]);
  assert.equal(f.stats().checks, 1);
  assert.equal(f.stats().interval, 4 * 60 * 60 * 1000);
  assert.equal(f.updates.state().phase, 'current');
  await f.updates.check(); assert.equal(f.stats().checks, 1);
  f.advance(); f.tick(); await f.updates.check();
  assert.equal(f.stats().checks, 2);
  f.updates.stop(); f.advance(); f.tick(); await f.updates.check();
  assert.equal(f.stats().checks, 2); assert.equal(f.stats().cancelled, 42);
});

test('background download blocks further checks and waits for native verification before allowing one explicit restart', async () => {
  const f = fixture();
  let finish;
  f.updater.checkForUpdates = async () => {
    f.updater.emit('update-available', { version: '0.4.0' });
    return { downloadPromise: new Promise(resolve => { finish = resolve; }) };
  };
  const pending = f.updates.check();
  await Promise.resolve(); await Promise.resolve();
  f.advance(); assert.equal(f.updates.check(), pending);
  f.updater.emit('update-downloaded', { version: '0.4.0' });
  await f.updates.restart(); assert.equal(f.stats().restarts, 0);
  finish(); await pending;
  assert.equal(f.updates.state().phase, 'downloading');
  f.nativeUpdater.emit('update-downloaded');
  assert.deepEqual(f.updates.state(), { phase: 'downloaded', version: '0.4.0' });
  assert.equal(f.stats().restarts, 0);
  await Promise.all([f.updates.restart(), f.updates.restart()]);
  assert.equal(f.stats().restarts, 1);
  assert.equal(f.updater.autoDownload, true);
  assert.equal(f.updater.autoInstallOnAppQuit, true);
  assert.equal(f.updater.allowDowngrade, false);
  assert.equal(f.updater.allowPrerelease, false);
});

test('offline, failed downloads, and native staging errors allow a later retry without rejecting IPC', async () => {
  const f = fixture();
  f.updater.checkForUpdates = () => { throw new Error('offline'); };
  assert.equal((await f.updates.check()).phase, 'error');
  f.advance();
  f.updater.checkForUpdates = async () => {
    f.updater.emit('update-available', { version: '0.4.0' });
    return { downloadPromise: Promise.reject(new Error('download failed')) };
  };
  assert.equal((await f.updates.check()).phase, 'error');
  assert.equal(f.updates.state().version, '0.4.0');
  f.advance();
  f.updater.checkForUpdates = async () => { f.updater.emit('update-not-available'); return {}; };
  assert.equal((await f.updates.check()).phase, 'current');
  f.updater.emit('error', new Error('native staging failed'));
  assert.equal(f.updates.state().phase, 'error');
  await f.updates.restart(); assert.equal(f.stats().restarts, 0);
});
