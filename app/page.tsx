'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Deck, Message, Settings } from './bridge';

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    left: <path d="m14 5-7 7 7 7" />, right: <path d="m10 5 7 7-7 7" />,
    chat: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M15 4v16M6 9h5M6 13h5" /></>,
    folder: <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />,
    play: <><rect x="3" y="3" width="18" height="14" rx="2" /><path d="m10 7 5 3-5 3ZM8 21h8M12 17v4" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    send: <><path d="M12 19V5m-6 6 6-6 6 6" /></>,
    settings: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" /><circle cx="15" cy="17" r="3" /></>,
    spark: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z" /></>,
    terminal: <><path d="m5 7 5 5-5 5M13 17h6" /></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export default function Home() {
  const [deck, setDeck] = useState<Deck>({});
  const [revision, setRevision] = useState(0);
  const [sidebar, setSidebar] = useState(true);
  const [presenting, setPresenting] = useState(false);
  const [slide, setSlide] = useState(0);
  const [count, setCount] = useState(0);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState('');
  const [error, setError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>({ baseUrl: 'https://api.openai.com/v1', model: '', hasKey: false });
  const [key, setKey] = useState('');
  const [desktop, setDesktop] = useState(true);
  const iframe = useRef<HTMLIFrameElement>(null);
  const slideRef = useRef(0);
  const deckRef = useRef<Deck>({});
  const session = useRef(0);
  const bottom = useRef<HTMLDivElement>(null);

  const navigate = useCallback((index: number) => {
    if (!deckRef.current.url) return;
    iframe.current?.contentWindow?.postMessage({ type: 'decklet:navigate', index }, new URL(deckRef.current.url).origin);
  }, []);
  const present = useCallback(async (value: boolean) => {
    try { await window.decklet?.present(value); setPresenting(value); }
    catch (err) { setError(String(err)); }
  }, []);
  const receiveDeck = useCallback((next: Deck) => {
    if (deckRef.current.root !== next.root) {
      session.current++;
      slideRef.current = 0; setSlide(0); setCount(0); setMessages([]); setError('');
      setDraft(''); setBusy(false); setActivity('');
    }
    deckRef.current = next; setDeck(next); setRevision(value => value + 1);
  }, []);

  useEffect(() => {
    const api = window.decklet;
    if (!api) { setDesktop(false); return; }
    api.state().then(receiveDeck).catch(err => setError(String(err)));
    api.settings().then(setSettings).catch(err => setError(String(err)));
    const unsubscribers = [api.on('deck:changed', receiveDeck), api.on('ai:activity', setActivity), api.on('deck:fullscreen', setPresenting)];
    return () => unsubscribers.forEach(unsubscribe => unsubscribe());
  }, [receiveDeck]);
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!deckRef.current.url || event.source !== iframe.current?.contentWindow || event.origin !== new URL(deckRef.current.url).origin) return;
      if (event.data?.type === 'decklet:state' && Number.isInteger(event.data.index) && Number.isInteger(event.data.count)) {
        slideRef.current = event.data.index; setSlide(event.data.index); setCount(event.data.count);
      }
      if (event.data?.type === 'decklet:escape') void present(false);
    }
    function onKey(event: KeyboardEvent) {
      if ((event.target as HTMLElement).closest('input, textarea, select, [contenteditable], dialog')) return;
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); navigate(slideRef.current + (event.key === 'ArrowRight' ? 1 : -1)); }
      if (event.key === 'Escape') void present(false);
    }
    window.addEventListener('message', onMessage); window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('message', onMessage); window.removeEventListener('keydown', onKey); };
  }, [navigate, present]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, activity]);

  async function choose(create: boolean) {
    try { await (create ? window.decklet?.create() : window.decklet?.open()); }
    catch (err) { setError(String(err)); }
  }
  async function closeProject() {
    try { await window.decklet?.close(); }
    catch (err) { setError(String(err)); }
  }
  async function send(text = draft) {
    if (!text.trim() || busy || !deck.root) return;
    if (!settings.model) { setSettingsOpen(true); return; }
    const history: Message[] = [...messages, { role: 'user', content: text.trim() }];
    const currentSession = session.current;
    setMessages(history); setDraft(''); setBusy(true); setActivity('Thinking…'); setError('');
    try {
      const content = await window.decklet!.chat(history);
      if (session.current === currentSession) setMessages([...history, { role: 'assistant', content }]);
    } catch (err) { if (session.current === currentSession) setError(String(err)); }
    finally { if (session.current === currentSession) { setBusy(false); setActivity(''); } }
  }
  async function saveSettings(event: React.FormEvent) {
    event.preventDefault();
    try {
      const result = await window.decklet!.saveSettings({ baseUrl: settings.baseUrl, model: settings.model, ...(key ? { apiKey: key } : {}) });
      setSettings(await window.decklet!.settings()); setKey(''); setSettingsOpen(false);
      if (!result.persistedKey) setError('OS encryption is unavailable. Your API key is kept only for this session.');
    } catch (err) { setError(String(err)); }
  }

  return <main className={presenting ? 'app presenting' : 'app'}>
    <header className="topbar">
      <div className="brand"><span className="brand-mark">d<span>·</span></span><strong>decklet</strong><span className="alpha">EARLY BUILD</span></div>
      <div className="file-actions"><button onClick={() => void choose(false)} disabled={!desktop}><Icon name="folder" />Open folder</button><button onClick={() => void choose(true)} disabled={!desktop}><Icon name="plus" />New deck</button>{deck.root && <button onClick={() => void closeProject()} disabled={!desktop}><Icon name="close" />Close project</button>}</div>
      <div className="top-actions"><button className={sidebar ? 'icon-button selected' : 'icon-button'} title="Toggle chat sidebar" aria-label="Toggle chat sidebar" aria-pressed={sidebar} onClick={() => setSidebar(!sidebar)}><Icon name="chat" /></button><button className="primary" disabled={!deck.root} onClick={() => void present(true)}><Icon name="play" />Present</button></div>
    </header>
    {!desktop && <div className="browser-notice">This is the web preview. Run <code>npm run dev</code> to use folders and AI in Electron.</div>}
    {error && <div className="error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><Icon name="close" size={15} /></button></div>}
    <div className="workspace">
      <section className="editor">
        <div className="deck-heading"><div><span className="eyebrow">YOUR PRESENTATION</span><h1>{deck.name || 'A little idea. A great deck.'}</h1></div>{deck.root && <button className="folder-path" title={deck.root} onClick={() => void window.decklet?.reveal()}><Icon name="folder" size={15} />Show files</button>}</div>
        <div className="canvas-area">
          {deck.url ? <div className="slide-frame"><iframe ref={iframe} title="Presentation slide" src={`${deck.url}index.html?revision=${revision}`} sandbox="allow-scripts allow-same-origin" onLoad={() => navigate(slideRef.current)} /></div> : <div className="welcome-card">
            <div className="welcome-grid" /><span className="welcome-tag"><span />FROM THOUGHT TO SLIDE</span>
            <h2>Your next big idea<br />starts with a <em>little deck.</em></h2>
            <p>Plain files. An open canvas. A creative partner.<br />Make something worth presenting.</p>
            <div className="welcome-actions"><button className="primary" disabled={!desktop} onClick={() => void choose(true)}><Icon name="plus" />Create a presentation</button><button disabled={!desktop} onClick={() => void choose(false)}>Open a folder <span>↗</span></button></div>
            <div className="paper-stack"><div /><div /><div><span>01 / YOUR NEXT IDEA</span><strong>Less busywork.<br /><i>More possibility.</i></strong><small>MADE WITH DECKLET ↗</small></div></div>
          </div>}
        </div>
        <footer className="slide-controls"><span className="live-status"><span />{deck.root ? 'Watching your folder' : 'Everything lives in your folder'}</span><div className="pagination"><button className="icon-button" aria-label="Previous slide" disabled={!count || slide === 0} onClick={() => navigate(slide - 1)}><Icon name="left" size={17} /></button><span>{count ? String(slide + 1).padStart(2, '0') : '—'}<b>/</b>{count ? String(count).padStart(2, '0') : '—'}</span><button className="icon-button" aria-label="Next slide" disabled={!count || slide >= count - 1} onClick={() => navigate(slide + 1)}><Icon name="right" size={17} /></button></div><span className="key-hint"><kbd>←</kbd><kbd>→</kbd> to navigate</span></footer>
        <div className="local-note"><Icon name="terminal" size={14} /><span>Your editor, your agent, your files. Changes appear automatically.</span></div>
      </section>
      {sidebar && <aside className="sidebar">
        <div className="chat-header"><div><Icon name="spark" /><strong>Creative partner</strong></div><div><button className="icon-button" title="AI settings" aria-label="AI settings" onClick={() => setSettingsOpen(true)}><Icon name="settings" size={17} /></button><button className="icon-button" title="Hide chat" aria-label="Hide chat" onClick={() => setSidebar(false)}><Icon name="close" size={17} /></button></div></div>
        <div className="chat-messages">
          {messages.length === 0 ? <div className="chat-intro"><span className="spark-tile"><Icon name="spark" size={25} /></span><h2>A second pair<br />of creative hands.</h2><p>Shape a story, simplify a slide, or try a whole new direction. Just ask.</p><div className="suggestions">{['Give this deck a stronger opening', 'Make the slides more concise', 'Try a warm, editorial visual style'].map((text, i) => <button key={text} disabled={!deck.root || busy} onClick={() => void send(text)}><span>{['↗', '≋', '◐'][i]}</span>{text}<span>↗</span></button>)}</div><div className="agent-note"><Icon name="terminal" size={17} /><p>Already have an agent?<br /><span>Run it in your deck folder. We’ll keep up.</span></p></div></div> : messages.map((message, index) => <div key={index} className={`message ${message.role}`}><span>{message.role === 'user' ? 'YOU' : 'DECKLET'}</span><p>{message.content}</p></div>)}
          {busy && <div className="activity" role="status"><span />{activity}</div>}<div ref={bottom} />
        </div>
        <form className="composer" onSubmit={event => { event.preventDefault(); void send(); }}><textarea aria-label="Message your creative partner" placeholder={deck.root ? 'What are we making?' : 'Open a deck to start creating…'} value={draft} disabled={!deck.root || busy} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} /><div><button type="button" className="model-select" onClick={() => setSettingsOpen(true)}><span className={settings.model ? 'connection-dot connected' : 'connection-dot'} />{settings.model || 'Connect your AI'}<span>⌄</span></button>{busy ? <button type="button" className="send-button" aria-label="Stop generation" onClick={() => void window.decklet?.cancel()}><Icon name="stop" size={16} /></button> : <button className="send-button" aria-label="Send message" disabled={!deck.root || !draft.trim()}><Icon name="send" size={18} /></button>}</div></form>
        <div className="chat-footnote">Your key. Your files. Your creative process.</div>
      </aside>}
    </div>
    {presenting && <button className="exit-present" onClick={() => void present(false)}>Exit presentation <kbd>esc</kbd></button>}
    {settingsOpen && <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}><section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Escape') setSettingsOpen(false); }}><div className="modal-heading"><Icon name="spark" /><h2 id="settings-title">Bring your own AI</h2><button className="icon-button" aria-label="Close settings" onClick={() => setSettingsOpen(false)}><Icon name="close" /></button></div><p>Connect any OpenAI-compatible provider with tool calling. Sending a message lets the model read and edit files in this deck.</p><form onSubmit={saveSettings}><label>API base URL<input autoFocus required type="url" value={settings.baseUrl} onChange={event => setSettings({ ...settings, baseUrl: event.target.value })} placeholder="https://api.openai.com/v1" /></label><label>Model<input required value={settings.model} onChange={event => setSettings({ ...settings, model: event.target.value })} placeholder="Your provider’s model ID" /></label><label>API key<input type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} placeholder={settings.hasKey ? 'Key saved · leave blank to keep it' : 'Optional for local models'} /></label><small>Keys are encrypted with your operating system when available. Chat is kept in memory for this session.</small><div className="settings-buttons">{settings.hasKey && <button type="button" onClick={async () => { try { await window.decklet!.saveSettings({ ...settings, apiKey: '' }); setSettings(await window.decklet!.settings()); } catch (err) { setError(String(err)); } }}>Remove key</button>}<button className="primary" disabled={!desktop}>Save connection</button></div></form><div className="mcp-note"><strong>Prefer an external agent?</strong><p>Hide this sidebar and run Codex in the deck folder, or connect the stdio MCP server:</p><code>node electron/mcp.js /path/to/deck</code></div></section></div>}
  </main>;
}
