import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createUpdates } from '../electron/updates.js';

function fixture(enabled = true) {
  const updater = new EventEmitter(), nativeUpdater = new EventEmitter();
  let time = 0, checks = 0, restarts = 0, cleaned = false, tick, interval, cancelled;
  const retries = new Map(), logs = [];
  let nextTimer = 0;
  updater.checkForUpdates = async () => { checks++; updater.emit('checking-for-update'); updater.emit('update-not-available'); return {}; };
  updater.quitAndInstall = () => { assert.equal(cleaned, true); restarts++; };
  const updates = createUpdates({ updater, nativeUpdater, enabled, notify() {}, now: () => time,
    beforeRestart: async () => { cleaned = true; },
    logger: { info() {}, error: (...args) => logs.push(args) },
    delay: (fn, ms) => { const id = ++nextTimer; retries.set(id, { fn, ms }); return id; }, cancelDelay: id => retries.delete(id),
    schedule: (fn, delay) => { tick = fn; interval = delay; return 42; }, cancel: id => { cancelled = id; },
  });
  return { updates, updater, nativeUpdater, retries, logs, runRetry: async () => {
    const [id, retry] = retries.entries().next().value; retries.delete(id); time += retry.ms; retry.fn();
    // Drain the check/download promise chain without triggering a manual check.
    for (let i = 0; i < 12; i++) await Promise.resolve();
  }, advance: () => { time += 4 * 60 * 60 * 1000; }, tick: () => tick(),
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
  assert.equal(f.updates.state().phase, 'staging');
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


test('manual retry immediately starts a new check and cancels the scheduled retry', async () => {
  const f = fixture();
  let checks = 0;
  f.updater.checkForUpdates = async () => { checks++; throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }); };
  await f.updates.check();
  assert.equal(f.updates.state().retryAt, 15_000);
  assert.equal(f.retries.size, 1);
  f.updater.checkForUpdates = async () => { checks++; f.updater.emit('update-not-available'); return {}; };
  await f.updates.check();
  assert.equal(checks, 2);
  assert.equal(f.retries.size, 0);
  assert.equal(f.updates.state().phase, 'current');
});

test('temporary failures retry at bounded intervals and duplicate error delivery counts once', async () => {
  const f = fixture();
  let checks = 0;
  f.updater.checkForUpdates = async () => {
    checks++;
    f.updater.emit('checking-for-update');
    f.updater.emit('update-available', { version: '0.4.1' });
    const error = Object.assign(new Error('network connection lost'), { code: 'ECONNRESET' });
    f.updater.emit('error', error);
    return { downloadPromise: Promise.reject(error) };
  };
  await f.updates.check();
  for (const ms of [15_000, 60_000, 180_000]) {
    assert.equal([...f.retries.values()][0].ms, ms);
    await f.runRetry();
  }
  assert.equal(checks, 4);
  assert.equal(f.logs.length, 4);
  assert.equal(f.retries.size, 0);
  assert.equal(f.updates.state().retryAt, undefined);
  assert.equal(f.updates.state().step, 'downloading');
  assert.match(f.updates.state().message, /download the update/);
});

test('disk, permission, verification and staging failures have useful messages without automatic retries', async () => {
  for (const [code, message] of [['ENOSPC', /disk space/], ['EACCES', /permission/], ['ERR_CHECKSUM_MISMATCH', /verified/]]) {
    const f = fixture();
    f.updater.checkForUpdates = async () => { throw Object.assign(new Error(code), { code }); };
    await f.updates.check();
    assert.match(f.updates.state().message, message);
    assert.equal(f.retries.size, 0);
    assert.equal(f.updates.state().step, 'checking');
  }
  const f = fixture();
  f.updater.emit('update-available', { version: '0.4.1' });
  f.updater.emit('download-progress', { percent: 45.8 });
  assert.equal(f.updates.state().percent, 45.8);
  f.updater.emit('update-downloaded');
  f.updater.emit('error', new Error('Squirrel staging failed'));
  assert.equal(f.updates.state().step, 'staging');
  assert.match(f.updates.state().message, /verify or prepare/);
  assert.equal(f.retries.size, 0);
});

test('stopping cancels recovery and success resets the retry budget', async () => {
  const f = fixture();
  f.updater.checkForUpdates = async () => { throw new Error('offline'); };
  await f.updates.check();
  f.updater.emit('update-not-available');
  assert.equal(f.retries.size, 0);
  f.advance();
  await f.updates.check();
  assert.equal(f.updates.state().retryAttempt, 1);
  f.updates.stop();
  assert.equal(f.retries.size, 0);
});


test('manual retries during failure cleanup coalesce and start only after the old operation settles', async () => {
  const f = fixture();
  let finish, checks = 0;
  const error = new Error('connection lost');
  f.updater.checkForUpdates = async () => {
    checks++;
    if (checks > 1) { f.updater.emit('update-not-available'); return {}; }
    f.updater.emit('error', error);
    return { downloadPromise: new Promise((_, reject) => { finish = () => reject(error); }) };
  };
  const first = f.updates.check();
  await Promise.resolve(); await Promise.resolve();
  const retry = f.updates.check();
  assert.equal(f.updates.check(), retry);
  assert.equal(checks, 1);
  assert.equal(f.retries.size, 0);
  finish();
  await first;
  await retry;
  assert.equal(checks, 2);
  assert.equal(f.updates.state().phase, 'current');
});

test('automatic retry waits for failure cleanup and a stopped controller cannot retry afterwards', async () => {
  const f = fixture();
  let finish, checks = 0;
  const error = new Error('connection lost');
  f.updater.checkForUpdates = async () => {
    checks++;
    f.updater.emit('error', error);
    return { downloadPromise: new Promise((_, reject) => { finish = () => reject(error); }) };
  };
  const first = f.updates.check();
  await Promise.resolve(); await Promise.resolve();
  await f.runRetry();
  assert.equal(checks, 1);
  f.updates.stop();
  finish();
  await first;
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(checks, 1);
});
