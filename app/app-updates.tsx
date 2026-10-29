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

export function UpdateBanner() {
  const { status, error, action } = useUpdates();
  if (!['downloading', 'downloaded', 'error'].includes(status.phase) || !status.version) return null;
  const ready = status.phase === 'downloaded';
  return <div className="update-banner">
    <div className="update-banner-message" role="status">
      <span className="update-banner-dot" aria-hidden="true" />
      <span><strong>{ready ? 'Update ready' : 'Update available'}</strong>{' '}
        {error || (ready
          ? `Version ${status.version} is ready. Restart to install the update.`
          : status.phase === 'error' ? status.message : `Downloading version ${status.version}…`)}</span>
    </div>
    {status.phase !== 'downloading' && <button type="button" className="primary" onClick={() => void action(ready)}>
      {ready ? 'Restart to Update' : 'Retry download'}
    </button>}
  </div>;
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
