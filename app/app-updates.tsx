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
  async function showLog() {
    try { await window.wetmytt?.showUpdateLog(); }
    catch { setError('Could not open the update log. Please try again.'); }
  }
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    if (!status.retryAt && status.phase !== 'downloading') return;
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status.retryAt, status.phase]);
  return { status, error, action, showLog, clock };
}

function downloadMessage(status: UpdateStatus) {
  return `Downloading version ${status.version}…${status.percent === undefined ? '' : ` ${Math.floor(status.percent)}%`}`;
}

function retryMessage(status: UpdateStatus, clock: number) {
  if (!status.retryAt) return '';
  const seconds = Math.max(0, Math.ceil((status.retryAt - clock) / 1000));
  return seconds ? ` Automatic retry ${status.retryAttempt} of 3 in ${seconds}s. You can retry now.` : ' Retrying automatically…';
}

export function UpdateSettingsButton({ disabled, onClick, children }: { disabled: boolean; onClick(): void; children: React.ReactNode }) {
  const { status, clock } = useUpdates();
  const busy = ['downloading', 'staging'].includes(status.phase), ready = status.phase === 'downloaded';
  const elapsed = Math.max(0, Math.floor((clock - (status.startedAt ?? clock)) / 1000));
  const detail = status.phase === 'staging' ? 'Verifying update' : busy ? `${downloadMessage(status)} (${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')} elapsed)` : ready ? 'Update ready to install' : status.phase === 'error' ? 'Update needs attention' : '';
  return <button className="icon-button update-settings-button" title={detail ? `Settings — ${detail}` : 'Settings'} aria-label="Settings" aria-describedby={detail ? 'settings-update-status' : undefined} disabled={disabled} onClick={onClick}>
    {children}
    {(busy || ready || status.phase === 'error') && <span className={`settings-update-badge ${ready ? 'ready' : status.phase === 'error' ? 'failed' : ''}`} aria-hidden="true">
      {busy ? <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="8" cy="8" r="5.5" /><path d="M8 4.5V8l2.5 1.5" /></svg> : ready ? '✓' : '!'}
    </span>}
    {detail && <span id="settings-update-status" className="sr-only">{detail}</span>}
  </button>;
}

export function UpdateBanner() {
  const { status, error, action, clock } = useUpdates();
  if (!['downloading', 'staging', 'downloaded', 'error'].includes(status.phase) || !status.version) return null;
  const ready = status.phase === 'downloaded';
  return <div className="update-banner">
    <div className="update-banner-message" role="status">
      <span className="update-banner-dot" aria-hidden="true" />
      <span><strong>{ready ? 'Update ready' : 'Update available'}</strong>{' '}
        {error || (ready
          ? `Version ${status.version} is ready. Restart to install the update.`
          : status.phase === 'error' ? `${status.message}${retryMessage(status, clock)}` : status.phase === 'staging' ? `Verifying and preparing version ${status.version}…` : downloadMessage(status))}</span>
    </div>
    {!['downloading', 'staging'].includes(status.phase) && <button type="button" className="primary" onClick={() => void action(ready)}>
      {ready ? 'Restart to Update' : 'Retry now'}
    </button>}
  </div>;
}

export function AppUpdates() {
  const { status, error, action, showLog, clock } = useUpdates();
  const messages = {
    disabled: 'Automatic updates are available in the installed macOS app.',
    idle: 'Updates download automatically in the background.',
    checking: 'Checking for updates…',
    current: 'You’re up to date.',
    downloading: downloadMessage(status),
    staging: `Verifying and preparing version ${status.version}…`,
    downloaded: `Version ${status.version} is ready. Restart now or quit normally to install.`,
    error: `${status.message}${retryMessage(status, clock)}`,
  };
  return <div className="settings-info app-updates">
    <strong>App updates</strong>
    <p role="status">{error || messages[status.phase]}</p>
    {status.phase === 'downloading' && status.percent !== undefined && <progress className="update-progress" aria-label="Update download progress" max={100} value={status.percent} />}
    {status.phase === 'error' && <button type="button" onClick={() => void showLog()}>Show update log</button>}
    {status.phase !== 'disabled' && <button type="button" disabled={['checking', 'downloading', 'staging'].includes(status.phase)} onClick={() => void action(status.phase === 'downloaded')}>
      {status.phase === 'downloaded' ? 'Restart to Update' : status.phase === 'error' ? 'Retry now' : 'Check for Updates'}
    </button>}
  </div>;
}
