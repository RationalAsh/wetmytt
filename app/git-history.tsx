'use client';

import { useEffect, useRef, useState } from 'react';
import type { Deck, GitHistory, GitSummary } from './bridge';

export function useGitSummary(deck: Deck) {
  const key = `${deck.root}:${deck.generation}`;
  const [value, setValue] = useState<{ key: string; summary: GitSummary } | null>(null);
  useEffect(() => {
    if (!deck.root || !window.wetmytt) return;
    const api = window.wetmytt;
    let cancelled = false, pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const summary = await api.gitSummary(deck.root!, deck.generation!);
        if (!cancelled) setValue({ key, summary });
      } catch (error) {
        if (!cancelled) setValue({ key, summary: { branch: null, latestCommit: null, dirty: null, error: String(error) } });
      } finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    const focus = () => void refresh();
    const unsubscribe = api.on('deck:changed', (next: Deck) => { if (next.root === deck.root && next.generation === deck.generation) void refresh(); });
    window.addEventListener('focus', focus);
    return () => { cancelled = true; clearInterval(timer); unsubscribe(); window.removeEventListener('focus', focus); };
  }, [deck.root, deck.generation, key]);
  return value?.key === key ? value.summary : null;
}

function RestoreLastSave({ deck, summary, disabled }: { deck: Deck; summary: GitSummary; disabled: boolean }) {
  const [restoring, setRestoring] = useState(false);
  const [result, setResult] = useState<{ message: string; detail?: string; error?: boolean } | null>(null);
  const pending = useRef(false);
  const reason = !summary.latestCommit ? 'There is no saved version yet.' : disabled ? 'Wait for the current operation to finish.' : !summary.dirty ? 'Your presentation already matches the last save.' : '';
  async function restore() {
    if (pending.current || reason || !deck.root || !window.wetmytt) return;
    pending.current = true; setRestoring(true); setResult(null);
    try {
      const result = await window.wetmytt.restoreLastSave(deck.root, deck.generation!);
      setResult(result.restored ? { message: 'Last save restored. Your changes are backed up.', detail: `To recover this backup: git stash apply --index ${result.backup}` } : { message: 'Already at the last save.' });
    } catch (error) { setResult({ message: String(error), error: true }); }
    finally { pending.current = false; setRestoring(false); }
  }
  return <>
    <span className="restore-control" tabIndex={reason || restoring ? 0 : -1} aria-describedby="restore-detail">
      <button className="restore-save" disabled={restoring || !!reason} aria-busy={restoring} aria-describedby="restore-detail" onClick={() => void restore()}>{restoring ? 'Restoring…' : 'Restore last save'}</button>
      <span className="version-tooltip" id="restore-detail" role="tooltip">{reason && <>{reason}<br /></>}Returns to the latest saved version, keeping a backup of changed and new files. Ignored files stay in place.<br /><code>git stash push --include-untracked --message "Backup before restoring last save"</code></span>
    </span>
    {result && <span className="restore-result" role={result.error ? 'alert' : 'status'} tabIndex={result.detail ? 0 : undefined} aria-describedby={result.detail ? 'restore-backup' : undefined}>{result.message}{result.detail && <span className="version-tooltip restore-backup" id="restore-backup" role="tooltip">{result.detail}</span>}</span>}
  </>;
}

export function GitStatus({ deck, summary, disabled }: { deck: Deck; summary: GitSummary | null; disabled: boolean }) {
  if (!summary?.branch) return null;
  return <>
    <span className="version-chip" tabIndex={0} aria-describedby="version-detail"><span className="version-label">Branch:</span><span className="version-name">{summary.branch}</span><span className="version-tooltip" role="tooltip" id="version-detail">{summary.branch === 'Detached HEAD' ? 'You are viewing a commit without an active branch (detached HEAD).' : <>The current branch is <strong>{summary.branch}</strong>.</>}</span></span>
    <RestoreLastSave key={`${deck.root}:${deck.generation}`} deck={deck} summary={summary} disabled={disabled} />
    <span className="last-commit" title={summary.latestCommit ? `${summary.latestCommit.shortHash} · ${summary.latestCommit.subject}` : undefined}>{summary.latestCommit?.subject || 'No commits yet'}</span>
    <span className="git-working-status" data-dirty={summary.dirty} role="status">{summary.dirty ? 'Uncommitted changes' : 'No uncommitted changes'}</span>
  </>;
}

export function HistoryPanel({ deck, summary, active }: { deck: Deck; summary: GitSummary | null; active: boolean }) {
  const [history, setHistory] = useState<GitHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const request = useRef(0);
  const latestHash = summary?.latestCommit?.hash;
  const gitError = summary?.error;
  const ready = Boolean(summary);
  // Refresh when HEAD changes; dirty-state polls should preserve older pages.
  useEffect(() => {
    const token = ++request.current;
    if (!active || !deck.root || !ready || gitError) return;
    let cancelled = false;
    setLoading(true); setError(''); setHistory(null);
    window.wetmytt?.gitHistory(deck.root, deck.generation!).then(next => {
      if (!cancelled && token === request.current) setHistory(next);
    }).catch(err => { if (!cancelled && token === request.current) setError(String(err)); })
      .finally(() => { if (!cancelled && token === request.current) setLoading(false); });
    return () => { cancelled = true; request.current++; };
  }, [active, deck.root, deck.generation, latestHash, gitError, ready, refresh]);
  async function loadMore() {
    if (!deck.root || !history?.head || loading || !window.wetmytt) return;
    const token = ++request.current;
    setLoading(true); setError('');
    try {
      const next = await window.wetmytt.gitHistory(deck.root, deck.generation!, { skip: history.commits.length, head: history.head });
      if (token === request.current) setHistory({ ...next, commits: [...history.commits, ...next.commits] });
    } catch (err) { if (token === request.current) setError(String(err)); }
    finally { if (token === request.current) setLoading(false); }
  }
  return <div id="history-panel" className="history-panel" role="tabpanel" aria-labelledby="history-tab" hidden={!active}>
    {!deck.root ? <p className="files-empty">Open a project to browse its history.</p> : <>
      <div className="files-toolbar"><span>{summary?.branch || 'Git history'}</span><button disabled={loading || !summary || !!gitError} onClick={() => setRefresh(value => value + 1)} aria-label="Refresh history">↻ Refresh</button></div>
      <div className="history-scroll">
        {(error || gitError) && <p className="files-error" role="alert">{error || gitError}</p>}
        {!summary || (loading && !history) ? <p className="files-empty">Loading history…</p> : history && !history.commits.length && <p className="files-empty">No commits yet. Stage and commit changes in Files to start your timeline.</p>}
        <ol className="commit-timeline" aria-label="Commit history">
          {history?.commits.map((commit, index) => <li key={commit.hash}>
            <div className="commit-heading"><code title={commit.hash}>{commit.shortHash}</code>{index === 0 && <span className="commit-latest">Latest</span>}</div>
            <h3>{commit.subject}</h3>
            <p className="commit-meta">{commit.author}<br /><time dateTime={commit.date}>{new Date(commit.date).toLocaleString()}</time></p>
            {commit.body && <details><summary>Details</summary><p className="commit-body">{commit.body}</p></details>}
          </li>)}
        </ol>
        {history?.hasMore && <button className="history-more" disabled={loading} onClick={() => void loadMore()}>{loading ? 'Loading…' : 'Load older commits'}</button>}
      </div>
    </>}
  </div>;
}
