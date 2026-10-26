const FOUR_HOURS = 4 * 60 * 60 * 1000;

// Only this controller talks to the updater. The renderer receives plain status
// snapshots and can request a check or restart, never supply a feed URL or path.
export function createUpdates({ updater, nativeUpdater, enabled, notify, beforeRestart, now = Date.now, schedule = setInterval, cancel = clearInterval }) {
  let status = { phase: enabled ? 'idle' : 'disabled' };
  let pending, timer, restarting = false, stopped = false, lastCheck = -Infinity;
  const publish = next => {
    if (stopped) return;
    status = next;
    notify({ ...status });
  };
  const failed = error => {
    console.error('App update:', error.message);
    publish({ phase: 'error', version: status.version, message: 'Could not update. Check your connection and try again.' });
  };
  if (enabled) {
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.on('checking-for-update', () => publish({ phase: 'checking' }));
    updater.on('update-available', info => publish({ phase: 'downloading', version: info.version }));
    updater.on('update-not-available', () => publish({ phase: 'current' }));
    updater.on('error', failed);
    // electron-updater's update-downloaded fires before Squirrel verifies and
    // stages the ZIP. Only expose Restart after the native updater is ready.
    nativeUpdater.on('update-downloaded', () => publish({ phase: 'downloaded', version: status.version }));
  }
  const check = () => {
    if (!enabled || stopped || restarting || pending || ['downloading', 'downloaded'].includes(status.phase) || now() - lastCheck < 30_000) return pending ?? Promise.resolve({ ...status });
    lastCheck = now();
    pending = Promise.resolve().then(async () => {
      try {
        const result = await updater.checkForUpdates();
        await result?.downloadPromise;
      } catch (error) { failed(error); }
      finally { pending = undefined; }
      return { ...status };
    });
    return pending;
  };
  return {
    state: () => ({ ...status }),
    check,
    start() {
      if (!enabled || timer || stopped) return;
      void check();
      timer = schedule(() => { void check(); }, FOUR_HOURS);
      timer.unref?.();
    },
    stop() { stopped = true; if (timer) cancel(timer); },
    async restart() {
      if (!enabled || stopped || restarting || status.phase !== 'downloaded') return;
      restarting = true;
      await beforeRestart();
      updater.quitAndInstall();
    },
  };
}
