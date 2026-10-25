'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

function Dropdown({ label, disabled, children }: { label: string; disabled: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent | FocusEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('focusin', dismiss);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('focusin', dismiss); };
  }, [open]);
  return <div className="dropdown" ref={container} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      if (!open) { setOpen(true); requestAnimationFrame(() => container.current?.querySelector<HTMLButtonElement>('[role="menu"] button:not(:disabled)')?.focus()); return; }
      const buttons = Array.from(container.current?.querySelectorAll<HTMLButtonElement>('[role="menu"] button:not(:disabled)') || []);
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  }}>
    <button ref={trigger} className="menu-trigger" aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}>{label}<span aria-hidden="true">⌄</span></button>
    {open && <div className="dropdown-panel" role="menu" aria-label={label} onClick={event => {
      const button = (event.target as HTMLElement).closest('button');
      if (button && !button.disabled && !button.hasAttribute('data-keep-open')) { setOpen(false); trigger.current?.focus(); }
    }}>{children}</div>}
  </div>;
}

type RecentProps = { folders: string[]; onOpen(folder: string): void; onRemove(folder: string): void; onClear(): void };
export function RecentFolders({ folders, onOpen, onRemove, onClear, menu = false }: RecentProps & { menu?: boolean }) {
  return <div className={menu ? 'recent-menu-list' : 'recent-folders'}>
    {!menu && <div className="recent-heading"><h2>Recent folders</h2>{folders.length > 0 && <button onClick={onClear}>Clear recent folders</button>}</div>}
    {folders.length ? <ul>{folders.map(folder => <li key={folder}>
      <button role={menu ? 'menuitem' : undefined} className="recent-open" title={folder} onClick={() => onOpen(folder)}><strong>{folder.split(/[/\\]/).filter(Boolean).pop() || folder}</strong><span>{folder}</span></button>
      <button role={menu ? 'menuitem' : undefined} className="recent-remove" aria-label={`Remove ${folder} from recents`} title="Remove from recents" onClick={() => onRemove(folder)}>×</button>
    </li>)}</ul> : <p className="recent-empty">Opened presentations will appear here.</p>}
    {menu && folders.length > 0 && <button role="menuitem" onClick={onClear}>Clear recent folders</button>}
  </div>;
}

export function FileMenu({ desktop, hasDeck, folders, onOpen, onRemove, onClear, onNew, onChoose, onAssets, onClose }: RecentProps & { desktop: boolean; hasDeck: boolean; onNew(): void; onChoose(): void; onAssets(): void; onClose(): void }) {
  const [recent, setRecent] = useState(false);
  return <Dropdown label="File" disabled={!desktop}>
    <button role="menuitem" onClick={onNew}>New deck…</button>
    <button role="menuitem" onClick={onChoose}>Open folder…</button>
    <button role="menuitem" data-keep-open aria-expanded={recent} onClick={() => setRecent(!recent)}>Open recent <span aria-hidden="true">{recent ? '⌃' : '⌄'}</span></button>
    {recent && <RecentFolders menu folders={folders} onOpen={onOpen} onRemove={onRemove} onClear={onClear} />}
    <div role="separator" className="menu-separator" />
    <button role="menuitem" disabled={!hasDeck} onClick={onAssets}>Add assets…</button>
    <button role="menuitem" disabled={!hasDeck} onClick={onClose}>Close project</button>
  </Dropdown>;
}

export function ConnectMenu({ desktop, onConnect }: { desktop: boolean; onConnect(agent: 'Codex' | 'Claude'): void }) {
  return <Dropdown label="Connect" disabled={!desktop}>
    <button role="menuitem" onClick={() => onConnect('Codex')}>Connect to Codex</button>
    <button role="menuitem" onClick={() => onConnect('Claude')}>Connect to Claude</button>
  </Dropdown>;
}
