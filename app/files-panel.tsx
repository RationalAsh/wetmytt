'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Deck, FileChange, ProjectFiles } from './bridge';

const labels: Record<string, string> = { M: 'Modified', U: 'Untracked', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed' };
function badge(change: FileChange) {
  return change.conflict ? '!' : change.index === '?' ? 'U' : change.worktree.trim() || change.index;
}
function Status({ code }: { code: string }) {
  return <span className="file-status" data-status={code} title={labels[code] || 'Conflict'} aria-label={labels[code] || 'Conflict'}>{code}</span>;
}

export function FilesPanel({ deck, revision, active, disabled }: { deck: Deck; revision: number; active: boolean; disabled: boolean }) {
  const [data, setData] = useState<ProjectFiles | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const mounted = useRef(true), request = useRef(0), operating = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current++; }; }, []);
  const refresh = useCallback(async () => {
    if (!deck.root || !window.wetmytt) return;
    const token = ++request.current;
    setLoading(true);
    try {
      const next = await window.wetmytt.projectFiles(deck.root, deck.generation!);
      if (mounted.current && token === request.current) { setData(next); setError(''); }
    } catch (err) { if (mounted.current && token === request.current) setError(String(err)); }
    finally { if (mounted.current && token === request.current) setLoading(false); }
  }, [deck.root, deck.generation]);
  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = setInterval(() => { if (!operating.current) void refresh(); }, 3000);
    const focus = () => { if (!operating.current) void refresh(); };
    window.addEventListener('focus', focus);
    return () => { clearInterval(timer); window.removeEventListener('focus', focus); };
  }, [active, revision, refresh]);
  async function act(action: 'stage' | 'unstage' | 'commit' | 'init', paths: string[] = []) {
    if (operating.current || disabled || !deck.root || !window.wetmytt) return;
    operating.current = true; setBusy(true); setError(''); setNotice('');
    try {
      await window.wetmytt.gitAction(deck.root, deck.generation!, action, paths, message);
      if (!mounted.current) return;
      if (action === 'commit') { setMessage(''); setNotice('Changes committed.'); }
      await refresh();
    } catch (err) { if (mounted.current) setError(String(err)); }
    finally { operating.current = false; if (mounted.current) setBusy(false); }
  }
  const locked = busy || disabled || loading;
  const changes = data?.changes || [];
  const staged = changes.filter(c => c.index !== ' ' && c.index !== '?' && !c.conflict);
  const unstaged = changes.filter(c => c.worktree !== ' ' || c.conflict);
  const byPath = new Map(changes.map(c => [c.path, c]));
  function pathsFor(list: FileChange[], action: 'stage' | 'unstage') {
    return [...new Set(list.flatMap(c => c.originalPath && (action === 'unstage' || c.worktree === 'R') ? [c.path, c.originalPath] : [c.path]))];
  }
  function group(title: string, list: FileChange[], action: 'stage' | 'unstage') {
    return <section className="files-changes" aria-label={title}>
      <div className="files-section-heading"><strong>{title} <span>{list.length}</span></strong><button disabled={locked || !list.length} onClick={() => void act(action, pathsFor(list, action))}>{action === 'stage' ? 'Stage all' : 'Unstage all'}</button></div>
      {list.map(change => <div className="file-change" key={change.path}>
        <span className="file-change-path" title={change.originalPath ? `${change.originalPath} → ${change.path}` : change.path}>{change.path}</span>
        <Status code={action === 'unstage' ? change.index : badge(change)} />
        <button title={`${action === 'stage' ? 'Stage' : 'Unstage'} ${change.path}`} aria-label={`${action === 'stage' ? 'Stage' : 'Unstage'} ${change.path}`} disabled={locked} onClick={() => void act(action, pathsFor([change], action))}>{action === 'stage' ? '+' : '−'}</button>
      </div>)}
    </section>;
  }
  return <div className="files-panel" id="files-panel" role="tabpanel" aria-labelledby="files-tab" hidden={!active}>
    {!deck.root ? <p className="files-empty">Open a project to browse its files.</p> : <>
      <div className="files-toolbar"><span title={data?.branch || undefined}>{data?.branch || 'Project files'}</span><button aria-label="Refresh files" disabled={busy || loading} onClick={() => void refresh()}>↻ Refresh</button></div>
      <div className="files-scroll">
        {error && <p className="files-error" role="alert">{error}</p>}
        {!data && !error && <p className="files-empty">Loading files…</p>}
        {data?.gitError && <div className="files-empty"><p>{data.gitError}</p>{data.gitError === 'This project has no Git repository.' && <button className="primary" disabled={locked} onClick={() => void act('init')}>Initialize Git</button>}</div>}
        {data && !data.gitError && <>{group('Staged changes', staged, 'unstage')}{group('Changes', unstaged, 'stage')}{!changes.length && <p className="files-empty">Working tree clean.</p>}</>}
        <div className="files-section-heading"><strong>Project tree</strong></div>
        <ul className="project-tree" aria-label="Project files">
          {data?.files.filter(file => !file.path.split('/').slice(0, -1).some((_, index, parts) => collapsed.has(parts.slice(0, index + 1).join('/')))).map(file => {
            const change = byPath.get(file.path);
            const changed = change || (file.directory ? changes.find(c => c.path.startsWith(file.path + '/')) : undefined);
            const name = file.path.split('/').pop();
            return <li key={file.path} style={{ paddingLeft: 12 + (file.path.split('/').length - 1) * 14 }} title={file.path}>
              {file.directory ? <button aria-expanded={!collapsed.has(file.path)} onClick={() => setCollapsed(current => { const next = new Set(current); if (next.has(file.path)) next.delete(file.path); else next.add(file.path); return next; })}><span aria-hidden="true">{collapsed.has(file.path) ? '▸' : '▾'}</span><span className="file-name">{name}</span></button> : <span className="tree-file"><span className="file-glyph" aria-hidden="true">◇</span><span className="file-name">{name}</span></span>}
              {changed && <Status code={badge(changed)} />}
            </li>;
          })}
        </ul>
        {data && !data.files.length && <p className="files-empty">No project files.</p>}
      </div>
      <form className="files-commit" onSubmit={event => { event.preventDefault(); void act('commit'); }}>
        <label htmlFor="commit-message">Commit message</label>
        <textarea id="commit-message" rows={2} placeholder="Describe your changes…" maxLength={10000} value={message} disabled={busy} onChange={event => setMessage(event.target.value)} />
        <button className="primary" type="submit" disabled={locked || !message.trim() || !staged.length || changes.some(c => c.conflict) || !!data?.gitError}>{busy ? 'Working…' : `Commit staged${staged.length ? ` (${staged.length})` : ''}`}</button>
        <span className="files-hint">Only staged changes are included.</span>
        {notice && <span role="status" className="files-hint">{notice}</span>}
      </form>
    </>}
  </div>;
}
