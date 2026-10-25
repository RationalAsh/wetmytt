'use client';

import { useEffect, useRef, useState } from 'react';
import type { Provider, Settings } from './bridge';
import { DEFAULT_MAX_TURNS, MAX_TURNS, normalizeMaxTurns, normalizeSettings, providers } from '../shared/ai.js';

export function AISettings({ saved, desktop, initialSection = 'chat', onClose, onSaved }: { saved: Settings; desktop: boolean; initialSection?: 'chat' | 'connection'; onClose(): void; onSaved(settings: Settings, persistedKey: boolean): void }) {
  const [draft, setDraft] = useState(saved);
  const [section, setSection] = useState(initialSection);
  const [turns, setTurns] = useState(String(saved.maxTurns));
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
    dialog.current?.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
    return () => previous?.focus();
  }, []);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving || !window.wetmytt) return;
    setError('');
    try {
      if (section === 'chat') normalizeMaxTurns(Number(turns));
      else normalizeSettings({ ...draft, apiKey: key || (hasSavedKey ? 'saved-key' : '') });
      setSaving(true);
      const result = section === 'chat'
        ? await window.wetmytt.savePreferences({ maxTurns: Number(turns) })
        : await window.wetmytt.saveSettings({ provider: draft.provider, baseUrl: draft.baseUrl, model: draft.model, ...(key ? { apiKey: key } : {}) });
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
    <section ref={dialog} className="settings-modal preferences-page" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={event => event.stopPropagation()} onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape' && !saving) onClose();
      if (event.key === 'Tab') {
        const elements = Array.from(dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary')).filter(element => element.getClientRects().length);
        const first = elements[0], last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <div className="modal-heading"><div><span className="settings-eyebrow">YOUR WORKSPACE</span><h2 id="settings-title">Settings</h2></div><button className="icon-button" aria-label="Close settings" disabled={saving} onClick={onClose}>×</button></div>
      <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">
        <button type="button" data-initial-focus={initialSection === 'chat' || undefined} aria-current={section === 'chat' ? 'page' : undefined} disabled={saving} onClick={() => { setSection('chat'); setError(''); }}><span>Chat</span><small>Editing &amp; turn limits</small></button>
        <button type="button" data-initial-focus={initialSection === 'connection' || undefined} aria-current={section === 'connection' ? 'page' : undefined} disabled={saving} onClick={() => { setSection('connection'); setError(''); }}><span>AI connection</span><small>Provider &amp; model</small></button>
      </nav>
      <div className="settings-content">
      <div className="settings-section-heading"><h3>{section === 'chat' ? 'Chat preferences' : 'Bring your own AI.'}</h3><p>{section === 'chat' ? 'Choose how much your AI can do in a single request.' : 'Connect a provider and a model that supports tool calling.'}</p></div>
      <form onSubmit={save}>
        {section === 'chat' ? <fieldset disabled={saving} className="connection-fields">
          <div className="turn-setting">
            <div className="turn-setting-heading"><label htmlFor="max-turns">Maximum turns per request</label><span className="setting-default">Default {DEFAULT_MAX_TURNS}</span></div>
            <p>A turn is one model response. Your AI may use it to inspect files, make edits, or reply to you.</p>
            <div className="turn-input-row"><input id="max-turns" type="number" min={1} max={MAX_TURNS} step={1} required value={turns} onChange={event => setTurns(event.target.value)} aria-describedby="turn-help" /><span>turns</span><button type="button" disabled={saving || turns === String(DEFAULT_MAX_TURNS)} onClick={() => setTurns(String(DEFAULT_MAX_TURNS))}>Reset to default</button></div>
            <small id="turn-help">Choose 1–{MAX_TURNS} turns. Higher limits allow longer edits and may use more time and tokens.</small>
          </div>
          <div className="settings-info"><strong>Applies to your next request</strong><p>This limit works with every provider. You can stop a request at any time; completed edits stay saved.</p></div>
        </fieldset> : <>

        <fieldset disabled={saving} className="connection-fields">
          <legend className="provider-label">Provider</legend>
          <div className="provider-picker">
            {(Object.keys(providers) as Provider[]).map(id => <label className={draft.provider === id ? 'active' : ''} key={id}>
              <input type="radio" name="provider" value={id} checked={draft.provider === id} onChange={() => {
                setDraft(id === saved.provider ? saved : { provider: id, baseUrl: providers[id].baseUrl, model: '', hasKey: false, maxTurns: saved.maxTurns });
                setKey(''); setError('');
              }} /><span>{providers[id].name}</span>
            </label>)}
          </div>
          <p className="provider-hint" id="provider-hint">{provider.hint}</p>
          <label>Model ID<input required aria-describedby="provider-hint" value={draft.model} onChange={event => setDraft({ ...draft, model: event.target.value })} placeholder="Enter your provider’s model ID" spellCheck={false} /></label>
          <label>API key{!keyRequired && <span className="field-optional">Optional for local Ollama</span>}<input type="password" autoComplete="off" required={keyRequired && !hasSavedKey} value={key} onChange={event => setKey(event.target.value)} placeholder={hasSavedKey ? 'Key saved · leave blank to keep it' : 'Paste your API key'} /></label>
          <details className="endpoint-settings" open={draft.baseUrl !== provider.baseUrl || undefined}><summary>Advanced · API base URL</summary><label>Base URL<input required type="url" value={draft.baseUrl} onChange={event => { setDraft({ ...draft, baseUrl: event.target.value }); setKey(''); }} spellCheck={false} /></label><small>Use the selected provider’s API format. Changing the provider or URL requires a new key.</small></details>
        </fieldset>
        </>}
        {error && <div className="settings-error" role="alert">{error}</div>}
        {section === 'connection' && <small>Keys are encrypted with your operating system when available. Conversations are saved in your deck folder. Saving does not verify model access.</small>}
        <div className="settings-buttons">{section === 'connection' && hasSavedKey && <button type="button" disabled={saving} onClick={() => void removeKey()}>Remove saved key</button>}<button type="button" disabled={saving} onClick={onClose}>Cancel</button><button className="primary" disabled={!desktop || saving}>{saving ? 'Saving…' : 'Save changes'}</button></div>
      </form>
      {section === 'connection' && <div className="mcp-note"><strong>Prefer an external agent?</strong><p>Run Codex in the deck folder for direct editing, or use “Connect to Codex” or “Connect to Claude” in the toolbar for files and slide screenshots.</p></div>}
      </div>
      </div>
    </section>
  </div>;
}
