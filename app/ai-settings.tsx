'use client';

import { useEffect, useRef, useState } from 'react';
import type { Provider, Settings } from './bridge';
import { normalizeSettings, providers } from '../shared/ai.js';

export function AISettings({ saved, desktop, onClose, onSaved }: { saved: Settings; desktop: boolean; onClose(): void; onSaved(settings: Settings, persistedKey: boolean): void }) {
  const [draft, setDraft] = useState(saved);
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const sameConnection = draft.provider === saved.provider && draft.baseUrl.replace(/\/+$/, '') === saved.baseUrl.replace(/\/+$/, '');
  const hasSavedKey = sameConnection && saved.hasKey;
  const provider = providers[draft.provider];
  const local = (() => { try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(draft.baseUrl).hostname); } catch { return false; } })();
  const keyRequired = !(draft.provider === 'ollama' && local);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    dialog.current?.querySelector<HTMLElement>('input:checked')?.focus();
    return () => previous?.focus();
  }, []);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving || !window.wetmytt) return;
    setError('');
    try {
      normalizeSettings({ ...draft, apiKey: key || (hasSavedKey ? 'saved-key' : '') });
      setSaving(true);
      const result = await window.wetmytt.saveSettings({ provider: draft.provider, baseUrl: draft.baseUrl, model: draft.model, ...(key ? { apiKey: key } : {}) });
      onSaved(await window.wetmytt.settings(), result.persistedKey);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setSaving(false); }
  }

  async function removeKey() {
    if (saving || !window.wetmytt) return;
    setSaving(true); setError('');
    try {
      const result = await window.wetmytt.saveSettings({ provider: saved.provider, baseUrl: saved.baseUrl, model: saved.model, apiKey: '' });
      onSaved(await window.wetmytt.settings(), result.persistedKey);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setSaving(false); }
  }

  return <div className="modal-backdrop" onClick={() => { if (!saving) onClose(); }}>
    <section ref={dialog} className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={event => event.stopPropagation()} onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape' && !saving) onClose();
      if (event.key === 'Tab') {
        const elements = Array.from(dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary')).filter(element => element.getClientRects().length);
        const first = elements[0], last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <div className="modal-heading"><h2 id="settings-title">Bring your own AI</h2><button className="icon-button" aria-label="Close settings" disabled={saving} onClick={onClose}>×</button></div>
      <p>Choose your provider and a model with tool calling. Your AI can read and edit files in this deck.</p>
      <form onSubmit={save}>
        <fieldset disabled={saving} className="connection-fields">
          <legend className="provider-label">Provider</legend>
          <div className="provider-picker">
            {(Object.keys(providers) as Provider[]).map(id => <label className={draft.provider === id ? 'active' : ''} key={id}>
              <input type="radio" name="provider" value={id} checked={draft.provider === id} onChange={() => {
                setDraft(id === saved.provider ? saved : { provider: id, baseUrl: providers[id].baseUrl, model: '', hasKey: false });
                setKey(''); setError('');
              }} /><span>{providers[id].name}</span>
            </label>)}
          </div>
          <p className="provider-hint" id="provider-hint">{provider.hint}</p>
          <label>Model ID<input required aria-describedby="provider-hint" value={draft.model} onChange={event => setDraft({ ...draft, model: event.target.value })} placeholder="Enter your provider’s model ID" spellCheck={false} /></label>
          <label>API key{!keyRequired && <span className="field-optional">Optional for local Ollama</span>}<input type="password" autoComplete="off" required={keyRequired && !hasSavedKey} value={key} onChange={event => setKey(event.target.value)} placeholder={hasSavedKey ? 'Key saved · leave blank to keep it' : 'Paste your API key'} /></label>
          <details className="endpoint-settings" open={draft.baseUrl !== provider.baseUrl || undefined}><summary>Advanced · API base URL</summary><label>Base URL<input required type="url" value={draft.baseUrl} onChange={event => { setDraft({ ...draft, baseUrl: event.target.value }); setKey(''); }} spellCheck={false} /></label><small>Use the selected provider’s API format. Changing the provider or URL requires a new key.</small></details>
        </fieldset>
        {error && <div className="settings-error" role="alert">{error}</div>}
        <small>Keys are encrypted with your operating system when available. Chat stays in memory for this session. Saving does not verify model access.</small>
        <div className="settings-buttons">{hasSavedKey && <button type="button" disabled={saving} onClick={() => void removeKey()}>Remove saved key</button>}<button type="button" disabled={saving} onClick={onClose}>Cancel</button><button className="primary" disabled={!desktop || saving}>{saving ? 'Saving…' : 'Save connection'}</button></div>
      </form>
      <div className="mcp-note"><strong>Prefer an external agent?</strong><p>Run Codex in the deck folder for direct editing, or use “Connect to Codex” in the toolbar for files and slide screenshots.</p></div>
    </section>
  </div>;
}
