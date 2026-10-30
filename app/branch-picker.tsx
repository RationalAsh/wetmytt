'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { Deck } from './bridge';

// Microsoft VS Code Codicons, CC BY 4.0; see docs/codicon-notices.md.
function BranchIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M14 5.5C14 4.121 12.879 3 11.5 3C10.121 3 9 4.121 9 5.5C9 6.682 9.826 7.669 10.93 7.928C10.744 8.546 10.177 9 9.5 9H6.5C5.935 9 5.419 9.195 5 9.512V4.949C6.14 4.717 7 3.707 7 2.5C7 1.121 5.879 0 4.5 0C3.121 0 2 1.121 2 2.5C2 3.708 2.86 4.717 4 4.949V11.05C2.86 11.282 2 12.292 2 13.499C2 14.878 3.121 15.999 4.5 15.999C5.879 15.999 7 14.878 7 13.499C7 12.317 6.174 11.33 5.07 11.071C5.256 10.453 5.823 9.999 6.5 9.999H9.5C10.723 9.999 11.74 9.115 11.954 7.953C13.116 7.738 14 6.723 14 5.5ZM3 2.5C3 1.673 3.673 1 4.5 1C5.327 1 6 1.673 6 2.5C6 3.327 5.327 4 4.5 4C3.673 4 3 3.327 3 2.5ZM6 13.5C6 14.327 5.327 15 4.5 15C3.673 15 3 14.327 3 13.5C3 12.673 3.673 12 4.5 12C5.327 12 6 12.673 6 13.5ZM11.5 7C10.673 7 10 6.327 10 5.5C10 4.673 10.673 4 11.5 4C12.327 4 13 4.673 13 5.5C13 6.327 12.327 7 11.5 7Z" /></svg>;
}

export function BranchPicker({ deck, branch, disabled }: { deck: Deck; branch: string; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const id = useId();

  function close() { setOpen(false); trigger.current?.focus(); }
  useEffect(() => {
    if (!open || !deck.root || !window.wetmytt) return;
    let cancelled = false;
    setLoading(true); setError('');
    window.wetmytt.gitBranches(deck.root, deck.generation!).then(names => {
      if (!cancelled) setBranches(names);
    }).catch(err => { if (!cancelled) setError(String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, deck.root, deck.generation, reload]);
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const dismiss = (event: PointerEvent | FocusEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('focusin', dismiss);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('focusin', dismiss); };
  }, [open, creating]);

  async function changeBranch(action: 'switch' | 'create', name: string) {
    if (disabled || pending.current || !deck.root || !window.wetmytt) return;
    pending.current = true; setBusy(true); setError('');
    try {
      await window.wetmytt.gitBranchAction(deck.root, deck.generation!, action, name);
      close();
      requestAnimationFrame(() => trigger.current?.focus());
    } catch (err) { setError(String(err)); }
    finally { pending.current = false; setBusy(false); }
  }

  return <div className="branch-picker" ref={container} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (!open || creating || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const buttons = Array.from(container.current?.querySelectorAll<HTMLButtonElement>('.branch-options button:not(:disabled)') || []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = index < 0 ? (event.key === 'ArrowUp' ? buttons.length - 1 : 0) : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }}>
    <button ref={trigger} className="version-chip" disabled={disabled || busy} aria-label={`Switch branch, current branch: ${branch}`} title={`Switch branch (${branch})`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => {
      setQuery(''); setCreating(false); setOpen(!open);
    }}><BranchIcon /><span className="version-name">{branch}</span></button>
    {open && <div className="branch-popup" id={id} role="dialog" aria-label={creating ? 'Create new branch' : 'Switch branch'} aria-busy={busy}>
      <strong>{creating ? 'Create new branch' : 'Switch branch'}</strong>
      {creating ? <form onSubmit={event => { event.preventDefault(); void changeBranch('create', query.trim()); }}>
        <label htmlFor={`${id}-name`}>Branch name</label>
        <input ref={input} id={`${id}-name`} value={query} maxLength={255} required disabled={busy} placeholder="e.g. improve-opening" onChange={event => setQuery(event.target.value)} />
        <p className="branch-hint">Create from {branch} and switch to it.</p>
        <div className="branch-form-actions"><button type="button" disabled={busy} onClick={() => { setCreating(false); setQuery(''); setError(''); }}>Back</button><button type="submit" disabled={disabled || busy || !query.trim()}>{busy ? 'Creating…' : 'Create branch'}</button></div>
      </form> : <>
        <input ref={input} aria-label="Filter branches" placeholder="Find a branch…" value={query} onChange={event => setQuery(event.target.value)} />
        <div className="branch-options">
          <button disabled={disabled || busy || loading} onClick={() => { setCreating(true); setError(''); }}>+ Create new branch…</button>
          {loading ? <p role="status">Loading branches…</p> : <>
            {branches.filter(name => name.toLowerCase().includes(query.toLowerCase())).map(name => <button key={name} title={name} disabled={disabled || busy} aria-current={name === branch ? 'true' : undefined} onClick={() => { if (name === branch) close(); else void changeBranch('switch', name); }}><span>{name}</span>{name === branch && <span className="branch-current">Current</span>}</button>)}
            {!branches.some(name => name.toLowerCase().includes(query.toLowerCase())) && <p>No matching branches.</p>}
          </>}
        </div>
        {busy && <p role="status">Switching branch…</p>}
      </>}
      {error && <div className="branch-error" role="alert">{error}{!creating && <button disabled={busy || loading} onClick={() => setReload(value => value + 1)}>Refresh branches</button>}</div>}
    </div>}
  </div>;
}
