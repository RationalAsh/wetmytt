'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConversationSummary, Deck, Message, Settings } from './bridge';
import { AISettings } from './ai-settings';
import { AgentConnection } from './agent-connection';
import { MarkdownMessage } from './markdown-message';
import { ContentEditor, type TextField, type TextSelection } from './content-editor';

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    left: <path d="m14 5-7 7 7 7" />, right: <path d="m10 5 7 7-7 7" />,
    chat: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M15 4v16M6 9h5M6 13h5" /></>,
    folder: <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />,
    play: <><rect x="3" y="3" width="18" height="14" rx="2" /><path d="m10 7 5 3-5 3ZM8 21h8M12 17v4" /></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4" /></>,
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
  const [sidebarTab, setSidebarTab] = useState<'chat' | 'edit'>('chat');
  const [fields, setFields] = useState<TextField[]>([]);
  const [selection, setSelection] = useState<TextSelection | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState('');
  const [presenting, setPresenting] = useState(false);
  const [slide, setSlide] = useState(0);
  const [count, setCount] = useState(0);
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loadingChat, setLoadingChat] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState('');
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [assetStatus, setAssetStatus] = useState('');
  const [agentOpen, setAgentOpen] = useState<'Codex' | 'Claude' | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: '', hasKey: false });
  const [desktop, setDesktop] = useState(true);
  const iframe = useRef<HTMLIFrameElement>(null);
  const slideRef = useRef(0);
  const deckRef = useRef<Deck>({});
  const session = useRef(0);
  const chatSession = useRef(0);
  const bottom = useRef<HTMLDivElement>(null);
  const dragTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearDrag = useCallback(() => {
    if (dragTimer.current) clearTimeout(dragTimer.current);
    setDragging(false);
  }, []);
  const showDrag = useCallback(() => {
    if (!deckRef.current.root || !window.wetmytt) return;
    setDragging(true);
    if (dragTimer.current) clearTimeout(dragTimer.current);
    dragTimer.current = setTimeout(() => setDragging(false), 800);
  }, []);
  const addAssets = useCallback(async (files: File[]) => {
    clearDrag();
    const root = deckRef.current.root;
    if (!root || !window.wetmytt || !files.length) return;
    const currentSession = session.current;
    setAssetStatus('Adding assets…'); setError('');
    try {
      const result = await window.wetmytt.importAssets(root, files);
      if (session.current !== currentSession) return;
      setAssetStatus(result.imported.length ? `Added ${result.imported.join(', ')}` : '');
      if (result.errors.length) setError(result.errors.join('\n'));
    } catch (err) {
      if (session.current === currentSession) { setAssetStatus(''); setError(String(err)); }
    }
  }, [clearDrag]);

  async function chooseAssets() {
    const { root, generation } = deckRef.current;
    if (!root || generation === undefined || !window.wetmytt) return;
    const currentSession = session.current;
    setError('');
    try {
      const result = await window.wetmytt.chooseAssets(root, generation);
      if (!result || session.current !== currentSession) return;
      setAssetStatus(result.imported.length ? `Added ${result.imported.join(', ')}` : '');
      if (result.errors.length) setError(result.errors.join('\n'));
    } catch (err) { if (session.current === currentSession) setError(String(err)); }
  }

  const navigate = useCallback((index: number) => {
    if (!deckRef.current.url) return;
    iframe.current?.contentWindow?.postMessage({ type: 'wetmytt:navigate', index }, new URL(deckRef.current.url).origin);
  }, []);
  const present = useCallback(async (value: boolean) => {
    try { await window.wetmytt?.present(value); setPresenting(value); }
    catch (err) { setError(String(err)); }
  }, []);
  const receiveDeck = useCallback((next: Deck) => {
    if (deckRef.current.root !== next.root || deckRef.current.generation !== next.generation) {
      session.current++;
      setFields([]); setSelection(null);
      const currentChat = ++chatSession.current;
      setConversationId(null); setConversations([]); setLoadingChat(Boolean(next.root));
      if (next.root && window.wetmytt) {
        const api = window.wetmytt, folder = next.root;
        void (async () => {
          try {
            const saved = await api.chats(folder);
            if (chatSession.current !== currentChat) return;
            setConversations(saved);
            if (saved.length) {
              const latest = await api.loadChat(folder, saved[0].id);
              if (chatSession.current !== currentChat) return;
              setConversationId(latest.id); setMessages(latest.messages);
            }
          } catch (err) { if (chatSession.current === currentChat) setError(String(err)); }
          finally { if (chatSession.current === currentChat) setLoadingChat(false); }
        })();
      }
      slideRef.current = 0; setSlide(0); setCount(0); setMessages([]); setError('');
      setDraft(''); setBusy(false); setActivity('');
      clearDrag(); setAssetStatus(''); setExportStatus('');
    }
    deckRef.current = next; setDeck(next); setRevision(value => value + 1);
  }, [clearDrag]);

  useEffect(() => {
    const api = window.wetmytt;
    if (!api) { setDesktop(false); return; }
    api.state().then(receiveDeck).catch(err => setError(String(err)));
    api.settings().then(setSettings).catch(err => setError(String(err)));
    const unsubscribers = [api.on('deck:changed', receiveDeck), api.on('ai:activity', setActivity), api.on('deck:fullscreen', setPresenting)];
    return () => unsubscribers.forEach(unsubscribe => unsubscribe());
  }, [receiveDeck]);
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!deckRef.current.url || event.source !== iframe.current?.contentWindow || event.origin !== new URL(deckRef.current.url).origin) return;
      if (event.data?.type === 'wetmytt:state' && Number.isInteger(event.data.index) && Number.isInteger(event.data.count)) {
        slideRef.current = event.data.index; setSlide(event.data.index); setCount(event.data.count);
      }
      if (event.data?.type === 'wetmytt:select' && (event.data.path === null || typeof event.data.path === 'string')) {
        setSelection({ path: event.data.path, text: typeof event.data.text === 'string' ? event.data.text : '', token: Date.now() });
        if (event.data.text || event.data.path !== null) { setSidebar(true); setSidebarTab('edit'); }
      }
      if (event.data?.type === 'wetmytt:escape') void present(false);
      if (event.data?.type === 'wetmytt:drag') showDrag();
      if (event.data?.type === 'wetmytt:drop' && Array.isArray(event.data.files) && event.data.files.every((file: unknown) => file instanceof File)) void addAssets(event.data.files);
    }
    function onKey(event: KeyboardEvent) {
      if ((event.target as HTMLElement).closest('input, textarea, select, [contenteditable], dialog')) return;
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); navigate(slideRef.current + (event.key === 'ArrowRight' ? 1 : -1)); }
      if (event.key === 'Escape') void present(false);
    }
    window.addEventListener('message', onMessage); window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('message', onMessage); window.removeEventListener('keydown', onKey); };
  }, [navigate, present, showDrag, addAssets]);
  useEffect(() => {
    function onDrag(event: DragEvent) {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = deckRef.current.root ? 'copy' : 'none';
      showDrag();
    }
    function onDrop(event: DragEvent) {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      void addAssets(Array.from(event.dataTransfer.files));
    }
    window.addEventListener('dragenter', onDrag, true);
    window.addEventListener('dragover', onDrag, true);
    window.addEventListener('drop', onDrop, true);
    window.addEventListener('dragend', clearDrag);
    window.addEventListener('blur', clearDrag);
    return () => {
      window.removeEventListener('dragenter', onDrag, true);
      window.removeEventListener('dragover', onDrag, true);
      window.removeEventListener('drop', onDrop, true);
      window.removeEventListener('dragend', clearDrag);
      window.removeEventListener('blur', clearDrag);
      if (dragTimer.current) clearTimeout(dragTimer.current);
    };
  }, [showDrag, addAssets, clearDrag]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, activity]);

  const configurePreview = useCallback(() => {
    if (!deck.url) return;
    iframe.current?.contentWindow?.postMessage({ type: 'wetmytt:edit', enabled: !presenting, fields, path: selection?.path ?? null }, new URL(deck.url).origin);
  }, [deck.url, presenting, fields, selection]);
  useEffect(configurePreview, [configurePreview, revision]);

  async function choose(create: boolean) {
    try { await (create ? window.wetmytt?.create() : window.wetmytt?.open()); }
    catch (err) { setError(String(err)); }
  }
  async function exportPDF() {
    if (!deck.root || !window.wetmytt || exporting) return;
    const currentSession = session.current;
    setExporting(true); setExportStatus(''); setError('');
    try {
      const result = await window.wetmytt.exportPDF(deck.root);
      if (result && session.current === currentSession) setExportStatus(`Exported ${result.pages} ${result.pages === 1 ? 'slide' : 'slides'} to ${result.path}`);
    } catch (err) { if (session.current === currentSession) setError(String(err)); }
    finally { setExporting(false); }
  }
  async function closeProject() {
    try { await window.wetmytt?.close(); }
    catch (err) { setError(String(err)); }
  }
  function newConversation() {
    if (busy || loadingChat) return;
    chatSession.current++;
    setConversationId(null); setMessages([]); setDraft(''); setError(''); setActivity('');
  }
  async function loadConversation(id: string) {
    if (!id || busy || loadingChat || !deck.root || !window.wetmytt) return;
    const currentChat = ++chatSession.current;
    setLoadingChat(true); setError('');
    try {
      const saved = await window.wetmytt.loadChat(deck.root, id);
      if (chatSession.current !== currentChat) return;
      setConversationId(saved.id); setMessages(saved.messages); setDraft('');
    } catch (err) { if (chatSession.current === currentChat) setError(String(err)); }
    finally { if (chatSession.current === currentChat) setLoadingChat(false); }
  }
  async function send(text = draft) {
    if (!text.trim() || busy || loadingChat || !deck.root) return;
    if (!settings.model) { setSettingsOpen(true); return; }
    const history: Message[] = [...messages, { role: 'user', content: text.trim() }];
    const currentSession = session.current;
    setMessages(history); setDraft(''); setBusy(true); setActivity('Thinking…'); setError('');
    try {
      const result = await window.wetmytt!.chat(deck.root, conversationId, text.trim());
      if (session.current !== currentSession) return;
      setConversationId(result.conversation.id); setMessages(result.conversation.messages);
      if (result.error) setError(result.error);
      const saved = await window.wetmytt!.chats(deck.root);
      if (session.current === currentSession) setConversations(saved);
    } catch (err) { if (session.current === currentSession) setError(String(err)); }
    finally { if (session.current === currentSession) { setBusy(false); setActivity(''); } }
  }

  return <main className={presenting ? 'app presenting' : 'app'}>
    <header className="topbar">
      <div className="brand"><span className="brand-mark" aria-hidden="true"><span /></span><strong><span>Welcome to</span>My TED Talk<span className="brand-period">.</span></strong><span className="alpha">EARLY BUILD</span></div>
      <div className="file-actions"><button onClick={() => void choose(false)} disabled={!desktop}><Icon name="folder" />Open folder</button><button onClick={() => void choose(true)} disabled={!desktop}><Icon name="plus" />New deck</button>{deck.root && <><button onClick={() => void chooseAssets()} disabled={!desktop}><Icon name="plus" />Add assets</button><button onClick={() => void closeProject()} disabled={!desktop}><Icon name="close" />Close project</button></>}</div>
      <div className="top-actions"><button disabled={!desktop || !deck.root || exporting} onClick={() => void exportPDF()} aria-busy={exporting}><Icon name="download" />{exporting ? 'Exporting…' : 'Export PDF'}</button><button className="agent-connect" disabled={!desktop} onClick={() => setAgentOpen('Codex')}><Icon name="terminal" />Connect to Codex</button><button className="agent-connect" disabled={!desktop} onClick={() => setAgentOpen('Claude')}><Icon name="terminal" />Connect to Claude</button><button className={sidebar ? 'icon-button selected' : 'icon-button'} title="Toggle sidebar" aria-label="Toggle sidebar" aria-pressed={sidebar} onClick={() => setSidebar(!sidebar)}><Icon name="chat" /></button><button className="primary" disabled={!deck.root} onClick={() => void present(true)}><Icon name="play" />Present</button></div>
    </header>
    {!desktop && <div className="browser-notice">This is the web preview. Run <code>npm run dev</code> to use folders and AI in Electron.</div>}
    {error && <div className="error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><Icon name="close" size={15} /></button></div>}
    {exportStatus && <div className="asset-status" role="status"><span>{exportStatus}</span><button aria-label="Dismiss export notification" onClick={() => setExportStatus('')}><Icon name="close" size={15} /></button></div>}
    {assetStatus && <div className="asset-status" role="status"><span>{assetStatus}</span><button aria-label="Dismiss asset notification" onClick={() => setAssetStatus('')}><Icon name="close" size={15} /></button></div>}
    {dragging && deck.root && <div className="asset-drop-overlay"><div><Icon name="folder" size={32} /><strong>Drop files to add assets</strong><span>Copy to {deck.name}/assets/</span></div></div>}
    <div className="workspace">
      <section className="editor">
        <div className="deck-heading"><div><span className="eyebrow">YOUR PRESENTATION</span><h1>{deck.name || 'Got a point? Make it.'}</h1></div>{deck.root && <button className="folder-path" title={deck.root} onClick={() => void window.wetmytt?.reveal()}><Icon name="folder" size={15} />Show files</button>}</div>
        <div className="canvas-area">
          {deck.url ? <div className="slide-frame"><iframe ref={iframe} title="Presentation slide" src={`${deck.url}index.html?revision=${revision}`} sandbox="allow-scripts allow-same-origin" onLoad={() => { navigate(slideRef.current); configurePreview(); }} /></div> : <div className="welcome-card">
            <div className="welcome-spotlight" aria-hidden="true" /><span className="welcome-tag"><span />THE FLOOR IS YOURS</span>
            <h2>Okay,<br /><em>hear me out.</em></h2>
            <p>Big opinions. Questionable theories. Your next great idea.<br />Give them a few slides. Make your point.</p>
            <div className="welcome-actions"><button className="primary" disabled={!desktop} onClick={() => void choose(true)}><Icon name="plus" />Create a presentation</button><button disabled={!desktop} onClick={() => void choose(false)}>Open a folder <span>↗</span></button></div>
            <div className="stage-card" aria-hidden="true"><span>01 / A VERY IMPORTANT TALK</span><strong>I made<br />slides<span>about it.</span></strong><div className="stage-line" /><small>WETMYTT / PRESS PLAY ↗</small></div>
          </div>}
        </div>
        <footer className="slide-controls"><span className="live-status"><span />{deck.root ? 'Watching your folder' : 'Everything lives in your folder'}</span><div className="pagination"><button className="icon-button" aria-label="Previous slide" disabled={!count || slide === 0} onClick={() => navigate(slide - 1)}><Icon name="left" size={17} /></button><span>{count ? String(slide + 1).padStart(2, '0') : '—'}<b>/</b>{count ? String(count).padStart(2, '0') : '—'}</span><button className="icon-button" aria-label="Next slide" disabled={!count || slide >= count - 1} onClick={() => navigate(slide + 1)}><Icon name="right" size={17} /></button></div><span className="key-hint"><kbd>←</kbd><kbd>→</kbd> to navigate</span></footer>
        <div className="local-note"><Icon name="terminal" size={14} /><span>Your editor, your agent, your files. Changes appear automatically.</span></div>
      </section>
      <aside className="sidebar" style={sidebar ? undefined : { display: 'none' }}>
        <div className="chat-header"><div><Icon name="spark" /><strong>Backstage</strong></div><div><button className="icon-button" title="New conversation (clear context)" aria-label="New conversation" disabled={!deck.root || busy || loadingChat} onClick={newConversation}><Icon name="plus" size={17} /></button><button className="icon-button" title="AI settings" aria-label="AI settings" onClick={() => setSettingsOpen(true)}><Icon name="settings" size={17} /></button><button className="icon-button" title="Hide sidebar" aria-label="Hide sidebar" onClick={() => setSidebar(false)}><Icon name="close" size={17} /></button></div></div>
        <div className="sidebar-tabs" role="tablist" aria-label="Sidebar">
          <button role="tab" id="chat-tab" aria-selected={sidebarTab === 'chat'} aria-controls="chat-panel" onClick={() => setSidebarTab('chat')}>Chat</button>
          <button role="tab" id="edit-tab" aria-selected={sidebarTab === 'edit'} aria-controls="edit-panel" onClick={() => setSidebarTab('edit')}>Edit</button>
        </div>
        <ContentEditor key={`${deck.root}:${deck.generation}`} deck={deck} revision={revision} active={sidebarTab === 'edit' && sidebar} selection={selection} onFields={setFields} onSelect={path => setSelection(current => current?.path === path ? current : { path, token: Date.now() })} />
        <div className="chat-panel" id="chat-panel" role="tabpanel" aria-labelledby="chat-tab" hidden={sidebarTab !== 'chat'}>
        <div className="conversation-controls">
          <select aria-label="Saved conversations" value={conversationId || ''} disabled={!deck.root || busy || loadingChat} onChange={event => void loadConversation(event.target.value)}>
            <option value="" disabled>{loadingChat ? 'Loading conversations…' : 'New conversation'}</option>
            {conversations.map(saved => <option key={saved.id} value={saved.id}>{saved.title} · {new Date(saved.updatedAt).toLocaleDateString()} · {saved.provider}/{saved.model}</option>)}
          </select>
          <span title="Saved in this project's .wetmytt/chats/ folder. Resuming uses the model selected below.">{deck.root ? 'Auto-saved to .wetmytt/chats/' : 'Open a deck to save conversations'}</span>
        </div>
        <div className="chat-messages">
          {messages.length === 0 ? <div className="chat-intro"><span className="spark-tile"><Icon name="spark" size={25} /></span><h2>You bring the idea.<br />We’ll bring the slides.</h2><p>Find your opening. Cut the waffle. Land the ending. Tell your AI what you’re thinking.</p><div className="suggestions">{['Give this deck a stronger opening', 'Make the slides more concise', 'Give this deck a bold stage presence'].map((text, i) => <button key={text} disabled={!deck.root || busy || loadingChat} onClick={() => void send(text)}><span>{['↗', '≋', '◐'][i]}</span>{text}<span>↗</span></button>)}</div><div className="agent-note"><Icon name="terminal" size={17} /><p>Already have an agent?<br /><span>Run it in your deck folder. We’ll keep up.</span></p></div></div> : messages.map((message, index) => <div key={index} className={`message ${message.role}`}><span>{message.role === 'user' ? 'YOU' : 'WETMYTT'}</span>{message.role === 'assistant' ? <MarkdownMessage>{message.content}</MarkdownMessage> : <p>{message.content}</p>}</div>)}
          {busy && <div className="activity" role="status"><span />{activity}</div>}<div ref={bottom} />
        </div>
        <form className="composer" onSubmit={event => { event.preventDefault(); void send(); }}><textarea aria-label="Message your creative partner" placeholder={deck.root ? 'What’s your big idea?' : 'Open a deck to start creating…'} value={draft} disabled={!deck.root || busy || loadingChat} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} /><div><button type="button" className="model-select" onClick={() => setSettingsOpen(true)}><span className={settings.model ? 'connection-dot connected' : 'connection-dot'} />{settings.model || 'Connect your AI'}<span>⌄</span></button>{busy ? <button type="button" className="send-button" aria-label="Stop generation" onClick={() => void window.wetmytt?.cancel()}><Icon name="stop" size={16} /></button> : <button className="send-button" aria-label="Send message" disabled={!deck.root || loadingChat || !draft.trim()}><Icon name="send" size={18} /></button>}</div></form>
        <div className="chat-footnote">Your talk. Your files. Your call.</div>
        </div>
      </aside>
    </div>
    {presenting && <button className="exit-present" onClick={() => void present(false)}>Exit presentation <kbd>esc</kbd></button>}
    {agentOpen && <AgentConnection key={agentOpen} agent={agentOpen} onClose={() => setAgentOpen(null)} />}
    {settingsOpen && <AISettings saved={settings} desktop={desktop} onClose={() => setSettingsOpen(false)} onSaved={(next, persistedKey) => {
      setSettings(next); setSettingsOpen(false);
      if (!persistedKey) setError('OS encryption is unavailable. Your API key is kept only for this session.');
    }} />}
  </main>;
}
