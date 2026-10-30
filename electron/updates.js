const FOUR_HOURS = 4 * 60 * 60 * 1000;
const RETRY_DELAYS = [15_000, 60_000, 180_000];

function describeFailure(error, step) {
  const detail = `${error.code || ''} ${error.statusCode || ''} ${error.message || error}`;
  const action = { checking: 'check for updates', downloading: 'download the update', staging: 'verify or prepare the update' }[step];
  if (/ENOSPC|disk.*full|no space/i.test(detail)) return { message: `Could not ${action}. Free up disk space and try again.`, retryable: false };
  if (/EACCES|EPERM|permission|read.only/i.test(detail)) return { message: `Could not ${action}. Check that the app is in Applications and that you have permission to update it.`, retryable: false };
  if (/checksum|signature|signed|verification/i.test(detail)) return { message: `Could not ${action}. The update could not be verified. Try again or download the latest installer.`, retryable: false };
  const retryable = /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ERR_NETWORK|ERR_INTERNET|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ERR_TIMED_OUT|offline|network|connection|aborted|timed?\s*out|\b(?:408|429|5\d\d)\b/i.test(detail);
  return { message: `Could not ${action}. ${retryable ? 'Check your connection and try again.' : 'Try again. If this continues, share the update log.'}`, retryable };
}

// Only this controller talks to the updater; the renderer gets plain snapshots.
export function createUpdates({ updater, nativeUpdater, enabled, notify, beforeRestart, logger = console,
  now = Date.now, schedule = setInterval, cancel = clearInterval, delay = setTimeout, cancelDelay = clearTimeout }) {
  let status = { phase: enabled ? 'idle' : 'disabled' };
  let pending, queuedRetry, timer, retryTimer, retryCount = 0, restarting = false, stopped = false, lastCheck = -Infinity;
  let step = 'checking', lastError;
  const publish = next => {
    if (stopped) return;
    if (next.phase !== status.phase) logger.info(`Update state: ${next.phase} target=${next.version || 'unknown'}`);
    status = next;
    notify({ ...status });
  };
  const clearRetry = () => { if (retryTimer !== undefined) cancelDelay(retryTimer); retryTimer = undefined; };
  const recovered = () => { clearRetry(); retryCount = 0; lastError = undefined; };
  const failed = error => {
    if (stopped || error === lastError) return;
    lastError = error;
    logger.error(`Update failed: step=${step} target=${status.version || 'unknown'} attempt=${retryCount + 1}`, error);
    clearRetry();
    const failure = describeFailure(error, step);
    const retryIn = failure.retryable ? RETRY_DELAYS[retryCount] : undefined;
    if (retryIn !== undefined) {
      retryCount++;
      retryTimer = delay(async () => {
        // Keep this timer's identity while waiting so a manual retry or stop
        // can invalidate it without starting another operation.
        const scheduled = retryTimer;
        if (pending) await pending;
        if (stopped || retryTimer !== scheduled) return;
        retryTimer = undefined;
        void check(false);
      }, retryIn);
      retryTimer.unref?.();
    }
    publish({ phase: 'error', step, version: status.version, message: failure.message,
      ...(retryIn !== undefined ? { retryAt: now() + retryIn, retryAttempt: retryCount } : {}) });
  };
  if (enabled) {
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.on('checking-for-update', () => { step = 'checking'; publish({ phase: 'checking', version: status.version }); });
    updater.on('update-available', info => {
      step = 'downloading';
      publish({ phase: 'downloading', version: info.version, startedAt: now() });
    });
    updater.on('download-progress', info => {
      if (status.phase !== 'downloading') return;
      publish({ ...status, percent: Math.max(0, Math.min(100, Number(info.percent) || 0)) });
    });
    updater.on('update-downloaded', () => {
      step = 'staging';
      publish({ phase: 'staging', version: status.version });
    });
    updater.on('update-not-available', () => { recovered(); publish({ phase: 'current' }); });
    updater.on('error', failed);
    // Wait for Squirrel to verify and stage the ZIP before offering Restart.
    nativeUpdater.on('update-downloaded', () => { recovered(); publish({ phase: 'downloaded', version: status.version }); });
  }
  const check = (manual = true) => {
    if (!enabled || stopped || restarting) return Promise.resolve({ ...status });
    if (pending) {
      if (!manual || status.phase !== 'error') return pending;
      // An error event can arrive before the failed operation finishes cleanup.
      // Queue one manual retry instead of silently consuming the click.
      clearRetry();
      queuedRetry ??= pending.then(() => { queuedRetry = undefined; return check(true); });
      return queuedRetry;
    }
    if (['downloading', 'staging', 'downloaded'].includes(status.phase)) return Promise.resolve({ ...status });
    if (manual) { clearRetry(); retryCount = 0; }
    // A visible retry is always actionable; ordinary repeated checks are coalesced.
    if (status.phase !== 'error' && now() - lastCheck < 30_000) return Promise.resolve({ ...status });
    lastCheck = now();
    lastError = undefined;
    step = 'checking';
    logger.info(`Update check: manual=${manual} attempt=${retryCount + 1}`);
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
    check: () => check(true),
    start() {
      if (!enabled || timer || stopped) return;
      void check(false);
      timer = schedule(() => { if (retryTimer === undefined) { retryCount = 0; void check(false); } }, FOUR_HOURS);
      timer.unref?.();
    },
    stop() { stopped = true; clearRetry(); if (timer) cancel(timer); },
    async restart() {
      if (!enabled || stopped || restarting || status.phase !== 'downloaded') return;
      restarting = true;
      await beforeRestart();
      updater.quitAndInstall();
    },
  };
}
