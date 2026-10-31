'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { textFields } from '../shared/content';
import { editable, expandHex, findSlides, humanize, imagePaths, peerValues, pointerChild, singular, slideTitle, stringKind } from '../shared/content-form';
import type { Deck } from './bridge';

export type TextField = { path: string; value: string };
export type TextSelection = { path: string | null; text?: string; token: number };
type Value = string | number | boolean | string[];
type Entries = Record<string, unknown>;

const AUTOSAVE_DELAY = 600;
const isObject = (value: unknown): value is Entries => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function ContentEditor({ deck, revision, active, selection, slide, onFields, onSelect, onBlockedChange, onSourceChange, disabled = false }: {
  deck: Deck; revision: number; active: boolean; selection: TextSelection | null; slide: number;
  onFields: (fields: TextField[]) => void; onSelect: (path: string) => void; onBlockedChange: (blocked: boolean) => void; onSourceChange: (source: string | null) => void; disabled?: boolean;
}) {
  const [source, setSource] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Value>>({});
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [eager, setEager] = useState(false);
  const [reload, setReload] = useState(0);
  const dirty = useRef(false);
  const loaded = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const panel = useRef<HTMLDivElement>(null);
  const doc = useMemo(() => source === null ? null : JSON.parse(source) as unknown, [source]);
  const pending = Object.keys(drafts).length > 0;
  useEffect(() => { dirty.current = pending; }, [pending]);

  useEffect(() => {
    if (!deck.root || !window.wetmytt) { onFields([]); return; }
    if (dirty.current) { setLoading(false); return; }
    let canceled = false;
    // Refreshes after our own saves are silent so the fields keep focus while typing.
    if (!loaded.current) setLoading(true);
    window.wetmytt.readContent(deck.root, deck.generation!).then(next => {
      if (canceled) return;
      loaded.current = true;
      setSource(current => current === next ? current : next); setError(''); onFields(textFields(JSON.parse(next)));
    }).catch(err => {
      if (!canceled) { loaded.current = false; setError(`Cannot edit deck.json: ${String(err)}`); setSource(null); onFields([]); }
    }).finally(() => { if (!canceled) setLoading(false); });
    return () => { canceled = true; };
  }, [deck.root, deck.generation, revision, reload, onFields]);

  useEffect(() => {
    if (!active || selection?.path == null || loading) return;
    const input = Array.from(panel.current?.querySelectorAll<HTMLElement>('textarea[data-path], input[data-path]') || []).find(item => item.dataset.path === selection.path);
    input?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    input?.focus({ preventScroll: true });
  }, [active, selection, loading, doc]);

  useEffect(() => { onSourceChange(source); }, [source, onSourceChange]);
  useEffect(() => { onBlockedChange(pending || saving); }, [pending, saving, onBlockedChange]);

  async function save(path: string) {
    if (!deck.root || !window.wetmytt || source === null || saving || disabled) return;
    const sent = drafts[path];
    setSaving(true); setError('');
    try {
      const next = await window.wetmytt.saveContent(deck.root, deck.generation!, source, path, sent);
      if (!mounted.current) return;
      // Keep anything typed while this save was in flight; the next autosave picks it up.
      setDrafts(current => {
        if (!same(current[path], sent)) return current;
        const remaining = { ...current }; delete remaining[path];
        return remaining;
      });
      setSource(next); onFields(textFields(JSON.parse(next)));
      setStatus('All changes saved. The preview updates automatically.');
    } catch (err) { if (mounted.current) setError(String(err)); }
    finally { if (mounted.current) setSaving(false); }
  }

  // Autosave: a short pause after typing, or immediately on blur and structural edits.
  useEffect(() => {
    const path = Object.keys(drafts)[0];
    if (path === undefined || saving || disabled || error || source === null) return;
    const timer = setTimeout(() => void save(path), eager ? 0 : AUTOSAVE_DELAY);
    return () => clearTimeout(timer);
  });

  function current<T extends Value>(path: string, saved: T): T {
    return Object.hasOwn(drafts, path) ? drafts[path] as T : saved;
  }

  function update(path: string, next: Value, saved: Value, immediate = false) {
    setDrafts(existing => {
      const copy = { ...existing };
      if (same(next, saved)) delete copy[path]; else copy[path] = next;
      return copy;
    });
    setEager(immediate); setStatus(''); setError('');
  }

  async function chooseImage(path: string, saved: string) {
    if (!deck.root || !window.wetmytt) return;
    try {
      const result = await window.wetmytt.chooseAssets(deck.root, deck.generation!);
      if (!mounted.current || !result) return;
      if (result.errors.length) setError(result.errors.join('\n'));
      if (result.imported.length) update(path, result.imported[0], saved, true);
    } catch (err) { if (mounted.current) setError(String(err)); }
  }

  const images = useMemo(() => doc === null ? [] : imagePaths(doc), [doc]);
  const flush = () => setEager(true);
  const common = { disabled, onBlur: flush };

  function wrap(path: string, label: string, control: ReactNode, key = path) {
    return <div className={`edit-field${selection?.path === path ? ' active' : ''}`} key={key}>
      <label><span title={path}>{label}</span>{control}</label>
    </div>;
  }

  function textControl(path: string, saved: string, long: boolean) {
    const value = current(path, saved);
    const props = { 'data-path': path, value, onFocus: () => onSelect(path), onChange: (event: { target: { value: string } }) => update(path, event.target.value, saved), ...common };
    return long ? <textarea {...props} rows={Math.min(8, Math.max(2, value.split('\n').length + 1))} /> : <input type="text" {...props} />;
  }

  function stringField(path: string, key: string, saved: string, peers: string[]) {
    const label = humanize(key);
    const value = current(path, saved);
    const kind = stringKind(key, value, peers);
    if (kind.kind === 'choice') {
      return wrap(path, label, <select data-path={path} value={value} onFocus={() => onSelect(path)} onChange={event => update(path, event.target.value, saved, true)} disabled={disabled}>
        {kind.options!.map(option => <option key={option} value={option}>{humanize(option)}</option>)}
      </select>);
    }
    if (kind.kind === 'color') {
      return wrap(path, label, <span className="edit-color">
        <input type="color" aria-label={`${label} picker`} value={expandHex(value)} onChange={event => update(path, event.target.value, saved)} {...common} />
        {textControl(path, saved, false)}
      </span>);
    }
    if (kind.kind === 'image') {
      const local = value && !/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(value);
      return <div className={`edit-field${selection?.path === path ? ' active' : ''}`} key={path}>
        <label><span title={path}>{label}</span>
          {local && deck.url && <img className="edit-thumb" src={new URL(value, deck.url).href} alt="" onError={event => { event.currentTarget.hidden = true; }} onLoad={event => { event.currentTarget.hidden = false; }} />}
          <input type="text" list="edit-images" data-path={path} value={value} onFocus={() => onSelect(path)} onChange={event => update(path, event.target.value, saved)} {...common} />
        </label>
        <div className="edit-field-actions"><button disabled={disabled} onClick={() => void chooseImage(path, saved)}>Choose image…</button></div>
      </div>;
    }
    return wrap(path, label, textControl(path, saved, kind.kind === 'long'));
  }

  function listField(path: string, key: string, saved: string[]) {
    const label = humanize(key);
    const items = current(path, saved);
    const commit = (next: string[], select?: string) => { update(path, next, saved, true); if (select) onSelect(select); };
    return <div className="edit-field" key={path}>
      <span className="edit-label" title={path}>{label}</span>
      <ol className="edit-list">
        {items.map((item, index) => {
          const itemPath = `${path}/${index}`;
          const props = {
            'data-path': itemPath, value: item, 'aria-label': `${label} ${index + 1}`, onFocus: () => onSelect(itemPath), ...common,
            onChange: (event: { target: { value: string } }) => update(path, items.map((entry, at) => at === index ? event.target.value : entry), saved),
          };
          return <li key={index} className={selection?.path === itemPath ? 'active' : undefined}>
            {item.includes('\n') || item.length > 60 ? <textarea {...props} rows={Math.min(6, item.split('\n').length + 1)} /> : <input type="text" {...props} />}
            <span className="edit-list-actions">
              <button aria-label={`Move ${label} ${index + 1} up`} title="Move up" disabled={disabled || index === 0} onClick={() => { const next = [...items]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; commit(next); }}>↑</button>
              <button aria-label={`Move ${label} ${index + 1} down`} title="Move down" disabled={disabled || index === items.length - 1} onClick={() => { const next = [...items]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; commit(next); }}>↓</button>
              <button aria-label={`Remove ${label} ${index + 1}`} title="Remove" disabled={disabled} onClick={() => commit(items.filter((_, at) => at !== index))}>✕</button>
            </span>
          </li>;
        })}
      </ol>
      <button className="edit-add" disabled={disabled} onClick={() => commit([...items, ''], `${path}/${items.length}`)}>+ Add {singular(label)}</button>
    </div>;
  }

  function entries(object: Entries, pointer: string, peers?: Entries[]): ReactNode[] {
    return Object.entries(object).flatMap(([key, value]) => {
      const path = pointerChild(pointer, key);
      if (!editable(doc, path)) return [];
      if (typeof value === 'string') return [stringField(path, key, value, peers ? peerValues(peers, key) : [])];
      if (typeof value === 'boolean') {
        const checked = current(path, value);
        return [<div className={`edit-field${selection?.path === path ? ' active' : ''}`} key={path}>
          <label className="edit-toggle"><input type="checkbox" data-path={path} checked={checked} onFocus={() => onSelect(path)} onChange={event => update(path, event.target.checked, value, true)} disabled={disabled} /><span title={path}>{humanize(key)}</span></label>
        </div>];
      }
      if (typeof value === 'number') {
        const number = current(path, value);
        return [wrap(path, humanize(key), <input type="number" data-path={path} value={number} onFocus={() => onSelect(path)} onChange={event => { if (event.target.value !== '' && Number.isFinite(event.target.valueAsNumber)) update(path, event.target.valueAsNumber, value); }} {...common} />)];
      }
      if (isStrings(value)) return [listField(path, key, value)];
      if (isObject(value)) return [group(path, humanize(key), entries(value, path))];
      if (Array.isArray(value)) {
        return value.flatMap((item, index) => isObject(item) ? [group(`${path}/${index}`, `${humanize(key)} ${index + 1}`, entries(item, `${path}/${index}`))] : []);
      }
      return [];
    });
  }

  function group(path: string, title: string, children: ReactNode[]) {
    return children.length ? <fieldset className="edit-group" key={path}><legend>{title}</legend>{children}</fieldset> : null;
  }

  const found = doc === null ? null : findSlides(doc);
  const root = isObject(doc) ? doc : null;
  const total = found?.slides.length ?? 0;
  const index = Math.min(Math.max(0, slide), Math.max(0, total - 1));
  const shown = found ? found.slides[index] as Entries : null;
  const title = shown ? slideTitle(shown) : '';
  const deckEntries = root && found ? Object.fromEntries(Object.entries(root).filter(([key]) => key !== found.key)) : null;
  const deckFields = deckEntries ? entries(deckEntries, '') : [];
  const hasFields = doc !== null && textFields(doc).length > 0;

  return <div className="content-editor" ref={panel} hidden={!active} role="tabpanel" id="edit-panel" aria-labelledby="edit-tab">
    <div className="edit-intro"><strong>Edit this slide</strong><p>Pick a slide to edit its text, images and options. Changes save automatically and the preview updates.</p></div>
    {!deck.root ? <p className="edit-empty">Open a deck to edit its text.</p> : <>
      <div className="edit-file"><code>deck.json</code><button disabled={disabled || saving || loading} onClick={() => { dirty.current = false; setDrafts({}); setStatus(''); setError(''); setReload(value => value + 1); }}>{pending ? 'Discard edits & reload' : 'Reload fields'}</button></div>
      {loading && <p role="status">Loading fields…</p>}
      {error && <p className="settings-error" role="alert">{error}</p>}
      {!error && (saving || pending) && <p className="edit-status" role="status">Saving…</p>}
      {!error && !saving && !pending && status && <p className="edit-status" role="status">{status}</p>}
      {selection?.path === null && selection.text && <p className="edit-status">This text has no unique match in deck.json. Choose its field below, or add a data-json-path to the slide element.</p>}
      {!loading && doc !== null && !hasFields && !images.length && <p className="edit-empty">No editable values found in deck.json.</p>}
      <datalist id="edit-images">{images.map(image => <option key={image} value={image} />)}</datalist>
      {root && found && shown && <section className="edit-slide" aria-label={`Slide ${index + 1}`}>
        <header className="edit-slide-head"><span>Slide {index + 1} of {total}</span>{title && <strong>{title}</strong>}</header>
        {entries(shown, pointerChild(pointerChild('', found.key), index), found.slides as Entries[])}
      </section>}
      {root && !found && entries(root, '')}
      {deckFields.some(Boolean) && <details className="edit-deck"><summary>Deck settings</summary>{deckFields}</details>}
    </>}
  </div>;
}
