'use client';

import { useEffect, useRef, useState } from 'react';
import { textFields } from '../shared/content';
import type { Deck } from './bridge';

export type TextField = { path: string; value: string };
export type TextSelection = { path: string | null; text?: string; token: number };

function fieldLabel(path: string) {
  return path ? path.slice(1).split('/').map(key => key.replace(/~1/g, '/').replace(/~0/g, '~')).join(' › ') : 'Text';
}

export function ContentEditor({ deck, revision, active, selection, onFields, onSelect }: {
  deck: Deck; revision: number; active: boolean; selection: TextSelection | null;
  onFields: (fields: TextField[]) => void; onSelect: (path: string) => void;
}) {
  const [source, setSource] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const dirty = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const panel = useRef<HTMLDivElement>(null);
  const fields: TextField[] = source === null ? [] : textFields(JSON.parse(source));

  useEffect(() => {
    if (!deck.root || !window.wetmytt) { onFields([]); return; }
    if (dirty.current) { setLoading(false); setStatus('The folder changed. Unsaved edits are kept; reload if deck.json changed.'); return; }
    let canceled = false;
    setLoading(true);
    window.wetmytt.readContent(deck.root, deck.generation!).then(next => {
      if (canceled) return;
      setSource(next); setError(''); onFields(textFields(JSON.parse(next)));
    }).catch(err => {
      if (!canceled) { setError(`Cannot edit deck.json: ${String(err)}`); setSource(null); onFields([]); }
    }).finally(() => { if (!canceled) setLoading(false); });
    return () => { canceled = true; };
  }, [deck.root, deck.generation, revision, reload, onFields]);

  useEffect(() => {
    if (!active || selection?.path == null || loading) return;
    const input = Array.from(panel.current?.querySelectorAll('textarea') || []).find(item => item.dataset.path === selection.path);
    input?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    input?.focus({ preventScroll: true });
  }, [active, selection, loading]);

  async function save(path: string) {
    if (!deck.root || !window.wetmytt || source === null || saving) return;
    setSaving(true); setError(''); setStatus('');
    try {
      const next = await window.wetmytt.saveContent(deck.root, deck.generation!, source, path, drafts[path]);
      if (!mounted.current) return;
      const remaining = { ...drafts }; delete remaining[path];
      dirty.current = Object.keys(remaining).length > 0;
      setDrafts(remaining); setSource(next); onFields(textFields(JSON.parse(next)));
      setStatus('Saved to deck.json. The preview updates automatically.');
    } catch (err) { if (mounted.current) setError(String(err)); }
    finally { if (mounted.current) setSaving(false); }
  }

  return <div className="content-editor" ref={panel} hidden={!active} role="tabpanel" id="edit-panel" aria-labelledby="edit-tab">
    <div className="edit-intro"><strong>Edit slide text</strong><p>Click text on a slide to jump to its JSON key. Edit the value below, then save to update the slide.</p></div>
    {!deck.root ? <p className="edit-empty">Open a deck to edit its text.</p> : <>
      <div className="edit-file"><code>deck.json</code><button disabled={saving || loading} onClick={() => { dirty.current = false; setDrafts({}); setStatus(''); setReload(value => value + 1); }}>{dirty.current ? 'Discard edits & reload' : 'Reload fields'}</button></div>
      {loading && <p role="status">Loading text fields…</p>}
      {error && <p className="settings-error" role="alert">{error}</p>}
      {status && <p className="edit-status" role="status">{status}</p>}
      {selection?.path === null && selection.text && <p className="edit-status">This text has no unique match in deck.json. Choose its field below, or add a data-json-path to the slide element.</p>}
      {!loading && source !== null && !fields.length && <p className="edit-empty">No text values found in deck.json.</p>}
      {fields.map(field => {
        const changed = Object.hasOwn(drafts, field.path);
        return <div className={`edit-field${selection?.path === field.path ? ' active' : ''}`} key={field.path}>
          <label><span title={field.path}>{fieldLabel(field.path)}</span><textarea data-path={field.path} value={changed ? drafts[field.path] : field.value} disabled={saving || loading} rows={Math.min(8, Math.max(2, (changed ? drafts[field.path] : field.value).split('\n').length + 1))} onFocus={() => onSelect(field.path)} onChange={event => {
            const next = { ...drafts };
            if (event.target.value === field.value) delete next[field.path]; else next[field.path] = event.target.value;
            dirty.current = Object.keys(next).length > 0; setDrafts(next); setStatus('');
          }} /></label>
          {changed && <div className="edit-field-actions"><span>Unsaved changes</span><button className="primary" disabled={saving} onClick={() => void save(field.path)}>{saving ? 'Saving…' : 'Save text'}</button></div>}
        </div>;
      })}
    </>}
  </div>;
}
