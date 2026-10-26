'use client';

import { useEffect, useState } from 'react';
import type { UpdateStatus } from './bridge';

function useUpdates() {
  const [status, setStatus] = useState<UpdateStatus>({ phase: 'disabled' });
  const [error, setError] = useState('');
  useEffect(() => {
    const api = window.wetmytt;
    if (!api) return;
    let received = false, active = true;
    const off = api.on('updates:changed', (next: UpdateStatus) => { received = true; setStatus(next); setError(''); });
    void api.updateState().then(next => { if (active && !received) setStatus(next); }).catch(() => {});
    return () => { active = false; off(); };
  }, []);
  async function action(restart = false) {
    setError('');
    try {
      if (restart) await window.wetmytt?.restartToUpdate();
      else await window.wetmytt?.checkForUpdates();
    } catch { setError('Could not update. Please try again.'); }
  }
  return { status, error, action };
}

export function UpdateBadge() {
  const { status, error, action } = useUpdates();
  if (!['downloading', 'downloaded', 'error'].includes(status.phase) || !status.version) return null;
  return <span className="update-badge" aria-live="polite">
    {status.phase === 'downloaded'
      ? <button title={`Version ${status.version} is ready. You can also quit normally to install.`} onClick={() => void action(true)}>Restart to Update</button>
      : status.phase === 'error'
        ? <button title={status.message} onClick={() => void action()}>Update available · Retry</button>
        : <span title={`Downloading version ${status.version}`}>Update available · Downloading…</span>}
    {error && <span role="status">{error}</span>}
  </span>;
}

export function AppUpdates() {
  const { status, error, action } = useUpdates();
  const messages = {
    disabled: 'Automatic updates are available in the installed macOS app.',
    idle: 'Updates download automatically in the background.',
    checking: 'Checking for updates…',
    current: 'You’re up to date.',
    downloading: `Downloading version ${status.version}…`,
    downloaded: `Version ${status.version} is ready. Restart now or quit normally to install.`,
    error: status.message,
  };
  return <div className="settings-info app-updates">
    <strong>App updates</strong>
    <p role="status">{error || messages[status.phase]}</p>
    {status.phase !== 'disabled' && <button type="button" disabled={['checking', 'downloading'].includes(status.phase)} onClick={() => void action(status.phase === 'downloaded')}>
      {status.phase === 'downloaded' ? 'Restart to Update' : 'Check for Updates'}
    </button>}
  </div>;
}
