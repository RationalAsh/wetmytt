'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import brandIcon from '../electron/assets/icon.svg';
import { SlideThumbnails } from './slide-thumbnails';
import { FileMenu, ConnectMenu, RecentFolders } from './project-menus';
import { version } from '../package.json';
import type { ConversationEvent, ConversationSummary, Deck, Message, Settings, SlideManagement, SlideOperation } from './bridge';
import { AISettings } from './ai-settings';
import { UpdateBanner, UpdateSettingsButton } from './app-updates';
import { DEFAULT_MAX_TURNS } from '../shared/ai.js';
import { AgentConnection } from './agent-connection';
import { ChatThread } from './chat-thread';
import { FilesPanel } from './files-panel';
import { GitStatus, HistoryPanel, useGitSummary } from './git-history';
import { ContentEditor, type TextField, type TextSelection } from './content-editor';
import { conversationTokens } from '../shared/ai.js';
import { textFields } from '../shared/content';

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

function ContextMeter({ used, limit, connected }: { used: number; limit: number | null; connected: boolean }) {
  const percent = connected && limit && limit > 0 && used >= 0 ? used / limit * 100 : null;
  const shown = percent == null ? null : Math.round(percent);
  const label = !connected ? 'Connect a model to see context usage' : shown == null ? 'Context usage unavailable' : `${shown}% context used`;
  const fill = percent == null ? 0 : Math.min(percent, 100);
  const radius = 7.25;
  const circumference = 2 * Math.PI * radius;
  const tone = shown != null && shown >= 90 ? 'full' : shown != null && shown >= 75 ? 'high' : '';
  return <span className={['context-meter', percent == null ? 'unknown' : '', tone].filter(Boolean).join(' ')} tabIndex={0} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={shown == null ? undefined : Math.min(shown, 100)} aria-valuetext={label} aria-label={label} data-percent={shown ?? ''}>
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
      <circle cx="11" cy="11" r={radius} />
      {fill > 0 && <circle className="context-fill" cx="11" cy="11" r={radius} strokeDasharray={`${circumference} ${circumference}`} strokeDashoffset={circumference * (1 - fill / 100)} />}
    </svg>
    <span className="context-tooltip" role="tooltip">{label}</span>
  </span>;
}

export default function Home() {
  const [deck, setDeck] = useState<Deck>({});
  const gitSummary = useGitSummary(deck);
  const [revision, setRevision] = useState(0);
  const [previewRevision, setPreviewRevision] = useState<number | undefined>(undefined);
  const [management, setManagement] = useState<(SlideManagement & { revision: number }) | null>(null);
  const [managedSlides, setManagedSlides] = useState(false);
  const [editorSource, setEditorSource] = useState<string | null>(null);
  const [recoveryVersion, setRecoveryVersion] = useState(0);
  const [textBlocked, setTextBlocked] = useState(false);
  const [managing, setManaging] = useState(false);
  const managingRef = useRef(false);
  const recovery = useRef<{ source: string; ids: string[]; selected: string; focus: string; revision: number } | null>(null);
  const [deleteRequest, setDeleteRequest] = useState<SlideOperation | null>(null);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const [slideIds, setSlideIds] = useState<string[]>([]);
  const [sidebar, setSidebar] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<'chat' | 'edit' | 'files' | 'history'>('chat');
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
  const [busy, setBusy] = useState(false);
  const [requestProgress, setRequestProgress] = useState({ startedAt: 0, operation: '', text: '', stopping: false });
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [assetStatus, setAssetStatus] = useState('');
  const [agentOpen, setAgentOpen] = useState<'Codex' | 'Claude' | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<'chat' | 'connection'>('chat');
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  function openSettings(section: 'chat' | 'connection') { if (settingsLoaded) { setSettingsSection(section); setSettingsOpen(true); } }
  const [settings, setSettings] = useState<Settings>({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: '', hasKey: false, maxTurns: DEFAULT_MAX_TURNS });
  const [contextUsed, setContextUsed] = useState(0);
  const [contextLimit, setContextLimit] = useState<number | null>(null);
  const [desktop, setDesktop] = useState(true);
  const iframe = useRef<HTMLIFrameElement>(null);
  const slideRef = useRef(0);
  const deckRef = useRef<Deck>({});
  const session = useRef(0);
  const chatSession = useRef(0);
  const activeRun = useRef<string | null>(null);
  const dragTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setManagement(null);
    if (!deck.root || deck.generation === undefined || deck.contentRevision === undefined || deck.contentSettled === false || !window.wetmytt) return;
    let cancelled = false;
    void window.wetmytt.readSlideManagement(deck.root, deck.generation, deck.contentRevision).then(value => {
      if (!cancelled) setManagement({ ...value, revision: deck.contentRevision! });
    }).catch(() => { if (!cancelled) setManagement(null); });
    return () => { cancelled = true; };
  }, [deck.root, deck.generation, deck.contentRevision, deck.contentSettled]);

  useEffect(() => {
    const pending = recovery.current;
    if (!pending || !management || management.revision !== deck.contentRevision || !managedSlides || management.source !== pending.source || slideIds.length !== pending.ids.length || pending.ids.some((id, index) => slideIds[index] !== `id:${id}`)) return;
    recovery.current = null;
    const index = pending.ids.indexOf(pending.selected);
    slideRef.current = Math.max(0, index); setSlide(Math.max(0, index));
    iframe.current?.contentWindow?.postMessage({ type: 'wetmytt:navigate', index: Math.max(0, index) }, new URL(deck.url!).origin);
    const currentSession = session.current;
    requestAnimationFrame(() => {
      if (session.current !== currentSession) return;
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.slide-thumbnail')).find(item => item.dataset.slideId === `id:${pending.focus}`);
      button?.focus({ preventScroll: true });
      managingRef.current = false; setManaging(false);
    });
  }, [management, managedSlides, slideIds, deck.url, deck.contentRevision, recoveryVersion]);

  useEffect(() => {
    if (!recovery.current) return;
    const currentSession = session.current;
    const timer = setTimeout(() => {
      if (!recovery.current || session.current !== currentSession) return;
      recovery.current = null; managingRef.current = false; setManaging(false);
      setError('The slide change was saved, but the preview did not reload with matching slides. Check the deck renderer.');
    }, 15000);
    return () => clearTimeout(timer);
  }, [recoveryVersion]);

  // A later external edit must not leave the app waiting for an obsolete result.
  useEffect(() => {
    if (management && recovery.current && management.revision > recovery.current.revision && management.source !== recovery.current.source) {
      recovery.current = null; managingRef.current = false; setManaging(false);
      setError('The presentation changed again. Slide management has reloaded.');
    }
  }, [management]);

  useEffect(() => {
    const dialog = deleteDialog.current;
    if (deleteRequest && !dialog?.open) dialog?.showModal();
    else if (!deleteRequest && dialog?.open) dialog.close();
  }, [deleteRequest]);

  useEffect(() => { setDeleteRequest(null); }, [deck.root, deck.generation, deck.contentRevision]);

  const slideDisabledReason = !management || management.revision !== deck.contentRevision ? 'Loading slide management…' : !management.supported ? management.reason
    : !managedSlides || management.ids.length !== slideIds.length || management.ids.some((id, index) => slideIds[index] !== `id:${id}`) ? 'Rendered slides do not match deck.json.'
    : textBlocked ? 'Save or discard text edits before managing slides.'
    : editorSource !== null && editorSource !== management.source ? 'Waiting for the saved presentation to reload.'
    : managing || busy || exporting || deck.contentSettled === false ? 'Wait for the current operation to finish.' : '';

  async function manageSlide(operation: SlideOperation, confirmed = false) {
    if (slideDisabledReason || managingRef.current || !management || !deck.root || !window.wetmytt) return;
    if (operation.type === 'delete' && !confirmed) { setDeleteRequest(operation); return; }
    const currentSession = session.current;
    const selected = management.ids[slideRef.current];
    const targetIndex = management.ids.indexOf(operation.id);
    managingRef.current = true; setManaging(true); setError(''); setDeleteRequest(null);
    try {
      const result = await window.wetmytt.mutateSlide(deck.root, deck.generation!, deck.contentRevision!, management.source, slideIds, operation);
      if (session.current !== currentSession) return;
      const nextSelected = result.duplicateId || (result.ids.includes(selected) ? selected : result.ids[Math.min(targetIndex, result.ids.length - 1)]);
      recovery.current = { revision: deck.contentRevision!, source: result.source, ids: result.ids, selected: nextSelected, focus: result.duplicateId || (result.ids.includes(operation.id) ? operation.id : nextSelected) };
      setSelection(null); setFields(textFields(JSON.parse(result.source)));
      // Read the current snapshot in case the watcher finished before the reply.
      const current = await window.wetmytt.state();
      if (session.current === currentSession && current.root === deck.root && current.generation === deck.generation) {
        if (current.contentRevision !== deckRef.current.contentRevision || (current.contentSettled && deckRef.current.contentSettled === false)) receiveDeck(current);
        setRecoveryVersion(value => value + 1);
      }
    } catch (err) {
      if (session.current === currentSession) { recovery.current = null; managingRef.current = false; setManaging(false); setError(String(err)); }
    }
  }

  const [recentFolders, setRecentFolders] = useState<string[]>([]);
  async function recentAction(action: 'open' | 'remove' | 'clear', folder = '') {
    const api = window.wetmytt;
    if (!api) return;
    setError('');
    try {
      if (action === 'open') await api.openRecent(folder);
      else if (action === 'remove') await api.removeRecent(folder);
      else await api.clearRecent();
    } catch (err) { setError(String(err)); }
  }
  const recentProps = { folders: recentFolders, onOpen: (folder: string) => { void recentAction('open', folder); }, onRemove: (folder: string) => { void recentAction('remove', folder); }, onClear: () => { void recentAction('clear'); } };

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
    const current = deckRef.current;
    // Metadata lookups can complete after newer watcher notifications.
    if ((next.generation ?? -1) < (current.generation ?? -1) ||
      (next.generation === current.generation && ((next.contentRevision ?? -1) < (current.contentRevision ?? -1) ||
        (next.contentRevision === current.contentRevision && current.contentSettled === true && next.contentSettled === false)))) return;
    if (deckRef.current.root !== next.root || deckRef.current.generation !== next.generation) {
      session.current++;
      recovery.current = null; managingRef.current = false; setManaging(false); setManagement(null); setDeleteRequest(null); setTextBlocked(false); setEditorSource(null);
      setFields([]); setSelection(null);
      const currentChat = ++chatSession.current;
      setConversationId(null); setConversations([]); setLoadingChat(Boolean(next.root)); setContextUsed(0);
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
              setConversationId(latest.id); setMessages(latest.messages); setContextUsed(conversationTokens(latest.requests));
            }
          } catch (err) { if (chatSession.current === currentChat) setError(String(err)); }
          finally { if (chatSession.current === currentChat) setLoadingChat(false); }
        })();
      }
      slideRef.current = 0; setSlide(0); setCount(0); setMessages([]); setError('');
      activeRun.current = null; setBusy(false);
      clearDrag(); setAssetStatus(''); setExportStatus('');
    }
    // Wait for the reloaded preview's slide count before requesting thumbnails;
    // the previous count can include slides that were just removed.
    setCount(0);
    setPreviewRevision(next.contentRevision);
    deckRef.current = next; setDeck(next); setRevision(value => value + 1);
  }, [clearDrag]);

  useEffect(() => {
    const api = window.wetmytt;
    if (!api) { setDesktop(false); setSettingsLoaded(true); return; }
    api.state().then(receiveDeck).catch(err => setError(String(err)));
    api.recentFolders().then(setRecentFolders).catch(err => setError(String(err)));
    api.settings().then(setSettings).catch(err => setError(String(err))).finally(() => setSettingsLoaded(true));
    const unsubscribers = [api.on('recent:changed', setRecentFolders), api.on('recent:error', setError), api.on('deck:invalidated', (next: Deck) => {
      if (next.root !== deckRef.current.root || next.generation !== deckRef.current.generation) return;
      const invalid = { ...deckRef.current, ...next };
      deckRef.current = invalid; setDeck(invalid); setCount(0); setSlideIds([]); setManagedSlides(false);
    }), api.on('deck:changed', receiveDeck), api.on('ai:conversation', (event: ConversationEvent) => {
      if (event.runId !== activeRun.current || event.root !== deckRef.current.root || event.generation !== deckRef.current.generation) return;
      setConversationId(event.conversation.id); setMessages(event.conversation.messages);
      if (event.conversation.requests.at(-1)?.status !== 'running') setRequestProgress(current => ({ ...current, text: '', operation: 'Finishing request…' }));
    }), api.on('ai:progress', (event: { runId: string; root: string; generation: number; operation?: string; text?: string }) => {
      if (event.runId !== activeRun.current || event.root !== deckRef.current.root || event.generation !== deckRef.current.generation) return;
      setRequestProgress(current => current.stopping ? current : { ...current, ...(event.operation !== undefined ? { operation: event.operation } : {}), ...(event.text !== undefined ? { text: event.text } : {}) });
    }), api.on('deck:fullscreen', setPresenting)];
    return () => unsubscribers.forEach(unsubscribe => unsubscribe());
  }, [receiveDeck]);
  useEffect(() => {
    if (!settingsLoaded) return;
    return window.wetmytt?.on('app:settings', () => {
      setSettingsSection('chat'); setSettingsOpen(true);
    });
  }, [settingsLoaded]);
  useEffect(() => {
    const api = window.wetmytt;
    if (!api || busy) return;
    let active = true;
    // Refresh independently so metadata cannot hold up a reply or Stop.
    void api.context().then(value => {
      if (active) setContextLimit(typeof value === 'number' && value > 0 ? value : null);
    }).catch(() => { if (active) setContextLimit(null); });
    return () => { active = false; };
  }, [settings, busy]);
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!deckRef.current.url || event.source !== iframe.current?.contentWindow || event.origin !== new URL(deckRef.current.url).origin) return;
      if (event.data?.type === 'wetmytt:state' && deckRef.current.contentSettled !== false && event.data.revision === String(deckRef.current.contentRevision) && Array.isArray(event.data.slides) && event.data.slides.every((id: unknown) => typeof id === 'string') && Number.isInteger(event.data.index) && Number.isInteger(event.data.count)) {
        setManagedSlides(event.data.managedSlides === true);
        slideRef.current = event.data.index; setSlide(event.data.index); setCount(event.data.count); setSlideIds(event.data.slides);
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
      if ((event.target as HTMLElement).closest('input, textarea, select, [contenteditable], dialog, [role="menu"], [data-slide-thumbnails]')) return;
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

  const configurePreview = useCallback(() => {
    if (!deck.url) return;
    iframe.current?.contentWindow?.postMessage({ type: 'wetmytt:edit', enabled: !presenting && !managing, fields, path: selection?.path ?? null }, new URL(deck.url).origin);
  }, [deck.url, presenting, managing, fields, selection]);
  useEffect(configurePreview, [configurePreview, revision]);

  async function choose(create: boolean) {
    try { await (create ? window.wetmytt?.create() : window.wetmytt?.open()); }
    catch (err) { setError(String(err)); }
  }
  async function exportPDF() {
    if (!deck.root || !window.wetmytt || exporting || managingRef.current) return;
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
    setConversationId(null); setMessages([]); setError(''); setContextUsed(0);
  }
  async function loadConversation(id: string) {
    if (!id || busy || loadingChat || !deck.root || !window.wetmytt) return;
    const currentChat = ++chatSession.current;
    setLoadingChat(true); setError('');
    try {
      const saved = await window.wetmytt.loadChat(deck.root, id);
      if (chatSession.current !== currentChat) return;
      setConversationId(saved.id); setMessages(saved.messages); setContextUsed(conversationTokens(saved.requests));
    } catch (err) { if (chatSession.current === currentChat) setError(String(err)); }
    finally { if (chatSession.current === currentChat) setLoadingChat(false); }
  }
  async function send(text: string) {
    if (!text.trim() || managingRef.current || busy || activeRun.current || loadingChat || !deck.root || !window.wetmytt) return;
    if (!settings.model) { openSettings('connection'); return; }
    const history: Message[] = [...messages, { role: 'user', content: text.trim() }];
    const currentSession = session.current;
    const runId = crypto.randomUUID();
    activeRun.current = runId;
    setRequestProgress({ startedAt: Date.now(), operation: 'Preparing request…', text: '', stopping: false });
    setMessages(history); setBusy(true); setError('');
    try {
      const result = await window.wetmytt!.chat(deck.root, conversationId, text.trim(), runId);
      if (session.current !== currentSession) return;
      setConversationId(result.conversation.id); setMessages(result.conversation.messages); setContextUsed(conversationTokens(result.conversation.requests));
      if (result.error) setError(result.error);
      const saved = await window.wetmytt!.chats(deck.root);
      if (session.current === currentSession) setConversations(saved);
    } catch (err) { if (session.current === currentSession) setError(String(err)); }
    finally { if (session.current === currentSession) { activeRun.current = null; setBusy(false); } }
  }

  return <main className={presenting ? 'app presenting' : 'app'}>
    <header className="topbar">
      <div className="brand"><Image className="brand-mark" src={brandIcon} width={38} height={38} alt="" /><strong><span>Welcome to</span>My TED Talk<span className="brand-period">.</span></strong><span className="release-badge" aria-label={`App version ${version}`}>v{version}</span></div>
      <div className="file-actions">
        <FileMenu desktop={desktop} hasDeck={Boolean(deck.root)} exporting={exporting} managing={managing} {...recentProps} onNew={() => void choose(true)} onChoose={() => void choose(false)} onAssets={() => void chooseAssets()} onReveal={() => { void window.wetmytt?.reveal().catch(err => setError(String(err))); }} onExport={() => void exportPDF()} onClose={() => void closeProject()} />
        <ConnectMenu desktop={desktop} onConnect={setAgentOpen} />
      </div>
      <div className="top-actions">
        <button className="primary icon-button" title="Present" aria-label="Present" disabled={!deck.root} onClick={() => void present(true)}><Icon name="play" /></button>
        <button className={sidebar ? 'icon-button selected' : 'icon-button'} title="Toggle sidebar" aria-label="Toggle sidebar" aria-pressed={sidebar} onClick={() => setSidebar(!sidebar)}><Icon name="chat" /></button>
      </div>
    </header>
    <UpdateBanner />
    {!desktop && <div className="browser-notice">This is the web preview. Run <code>npm run dev</code> to use folders and AI in Electron.</div>}
    {error && <div className="error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><Icon name="close" size={15} /></button></div>}
    {exportStatus && <div className="asset-status" role="status"><span>{exportStatus}</span><button aria-label="Dismiss export notification" onClick={() => setExportStatus('')}><Icon name="close" size={15} /></button></div>}
    {assetStatus && <div className="asset-status" role="status"><span>{assetStatus}</span><button aria-label="Dismiss asset notification" onClick={() => setAssetStatus('')}><Icon name="close" size={15} /></button></div>}
    {dragging && deck.root && <div className="asset-drop-overlay"><div><Icon name="folder" size={32} /><strong>Drop files to add assets</strong><span>Copy to {deck.name}/assets/</span></div></div>}
    <div className="workspace">
      <section className="editor">
        <div className={deck.root ? "deck-heading has-thumbnails" : "deck-heading"}><div className="deck-title"><span className="eyebrow">YOUR PRESENTATION</span><h1 title={deck.name || undefined}>{deck.name || 'Got a point? Make it.'}</h1></div>{deck.root && <SlideThumbnails key={`${deck.root}:${deck.generation}:${deck.contentRevision}`} deck={deck} ids={slideIds} count={count} slide={slide} onNavigate={navigate} disabledReason={slideDisabledReason} onAction={manageSlide} />}</div>
        <div className="canvas-area">
          {deck.url ? <div className="slide-frame"><iframe ref={iframe} title="Presentation slide" src={`${deck.url}index.html?revision=${revision}&contentRevision=${previewRevision}`} sandbox="allow-scripts allow-same-origin" onLoad={() => { navigate(slideRef.current); configurePreview(); }} /></div> : <div className="welcome-card">
            <div className="welcome-spotlight" aria-hidden="true" /><span className="welcome-tag"><span />THE FLOOR IS YOURS</span>
            <h2>Okay,<br /><em>hear me out.</em></h2>
            <p>Big opinions. Questionable theories. Your next great idea.<br />Give them a few slides. Make your point.</p>
            <div className="welcome-actions"><button className="primary" disabled={!desktop} onClick={() => void choose(true)}><Icon name="plus" />Create a presentation</button><button disabled={!desktop} onClick={() => void choose(false)}>Open a folder <span>↗</span></button></div>
            <div className="stage-card" aria-hidden="true"><span>01 / A VERY IMPORTANT TALK</span><strong>I made<br />slides<span>about it.</span></strong><div className="stage-line" /><small>WETMYTT / PRESS PLAY ↗</small></div>
          </div>}
        </div>
        {!deck.root && desktop && <RecentFolders {...recentProps} />}
        {deck.root && slideDisabledReason && <p className="slide-management-status" role="status">{slideDisabledReason}</p>}
        <dialog ref={deleteDialog} className="slide-delete-dialog" aria-labelledby="slide-delete-title" onCancel={() => setDeleteRequest(null)} onClose={() => { if (!deleteDialog.current?.open) setDeleteRequest(null); }}>
          <h2 id="slide-delete-title">Delete slide {deleteRequest && management ? management.ids.indexOf(deleteRequest.id) + 1 : ''}?</h2>
          <p>{deleteRequest && management?.titles[management.ids.indexOf(deleteRequest.id)]}</p>
          <p>This removes the slide from your presentation.</p>
          <div><button autoFocus onClick={() => setDeleteRequest(null)}>Cancel</button><button disabled={!!slideDisabledReason} onClick={() => { if (deleteRequest) void manageSlide(deleteRequest, true); }}>Delete slide</button></div>
        </dialog>
        <footer className="slide-controls"><div className="folder-status"><span className="live-status"><span />{deck.root ? 'Watching your folder' : 'Everything lives in your folder'}</span>{deck.root && <GitStatus deck={deck} summary={gitSummary} disabled={busy || managing || exporting || deck.contentSettled === false} />}</div><div className="pagination"><button className="icon-button" aria-label="Previous slide" disabled={!count || slide === 0} onClick={() => navigate(slide - 1)}><Icon name="left" size={17} /></button><span>{count ? String(slide + 1).padStart(2, '0') : '—'}<b>/</b>{count ? String(count).padStart(2, '0') : '—'}</span><button className="icon-button" aria-label="Next slide" disabled={!count || slide >= count - 1} onClick={() => navigate(slide + 1)}><Icon name="right" size={17} /></button></div><span className="key-hint"><kbd>←</kbd><kbd>→</kbd> to navigate</span></footer>
      </section>
      <aside className="sidebar" style={sidebar ? undefined : { display: 'none' }}>
        <div className="chat-header"><div><Icon name="spark" /><strong>Backstage</strong></div><div><button className="icon-button" title="New conversation (clear context)" aria-label="New conversation" disabled={!deck.root || busy || loadingChat} onClick={newConversation}><Icon name="plus" size={17} /></button><UpdateSettingsButton disabled={!settingsLoaded} onClick={() => openSettings('chat')}><Icon name="settings" size={17} /></UpdateSettingsButton><button className="icon-button" title="Hide sidebar" aria-label="Hide sidebar" onClick={() => setSidebar(false)}><Icon name="close" size={17} /></button></div></div>
        <div className="sidebar-tabs" role="tablist" aria-label="Sidebar">
          <button role="tab" id="chat-tab" aria-selected={sidebarTab === 'chat'} aria-controls="chat-panel" onClick={() => setSidebarTab('chat')}>Chat</button>
          <button role="tab" id="edit-tab" aria-selected={sidebarTab === 'edit'} aria-controls="edit-panel" onClick={() => setSidebarTab('edit')}>Edit</button>
          <button role="tab" id="files-tab" aria-selected={sidebarTab === 'files'} aria-controls="files-panel" onClick={() => setSidebarTab('files')}>Files</button>
          <button role="tab" id="history-tab" aria-selected={sidebarTab === 'history'} aria-controls="history-panel" onClick={() => setSidebarTab('history')}>History</button>
        </div>
        <HistoryPanel key={`history:${deck.root}:${deck.generation}`} deck={deck} summary={gitSummary} active={sidebarTab === 'history' && sidebar} />
        <FilesPanel key={`files:${deck.root}:${deck.generation}`} deck={deck} revision={revision} active={sidebarTab === 'files' && sidebar} disabled={busy || managing || exporting} />
        <ContentEditor key={`${deck.root}:${deck.generation}`} deck={deck} revision={revision} active={sidebarTab === 'edit' && sidebar} selection={selection} slide={slide} onFields={setFields} onBlockedChange={setTextBlocked} onSourceChange={setEditorSource} disabled={managing} onSelect={path => setSelection(current => current?.path === path ? current : { path, token: Date.now() })} />
        <div className="chat-panel" id="chat-panel" role="tabpanel" aria-labelledby="chat-tab" hidden={sidebarTab !== 'chat'}>
        <div className="conversation-controls">
          <select aria-label="Saved conversations" value={conversationId || ''} disabled={!deck.root || busy || loadingChat} onChange={event => void loadConversation(event.target.value)}>
            <option value="" disabled>{loadingChat ? 'Loading conversations…' : 'New conversation'}</option>
            {conversations.map(saved => <option key={saved.id} value={saved.id}>{saved.title} · {new Date(saved.updatedAt).toLocaleDateString()} · {saved.provider}/{saved.model}</option>)}
          </select>
          <span title="Saved in this project's .wetmytt/chats/ folder. Resuming uses the model selected below.">{deck.root ? 'Auto-saved to .wetmytt/chats/' : 'Open a deck to save conversations'}</span>
        </div>
        <ChatThread key={`${deck.root}:${deck.generation}:${chatSession.current}`} messages={messages} busy={busy} progress={requestProgress} loading={loadingChat} disabled={!deck.root || !desktop || managing} connected={Boolean(settings.model)}
          onSend={send} onCancel={async () => {
            const runId = activeRun.current;
            setRequestProgress(current => ({ ...current, stopping: true }));
            try { await window.wetmytt?.cancel(); }
            catch (err) { if (activeRun.current === runId) { setRequestProgress(current => ({ ...current, stopping: false })); setError(String(err)); } }
          }} onConnect={() => openSettings('connection')}
          intro={<div className="chat-intro"><span className="spark-tile"><Icon name="spark" size={25} /></span><h2>You bring the idea.<br />We’ll bring the slides.</h2><p>Find your opening. Cut the waffle. Land the ending. Tell your AI what you’re thinking.</p><div className="suggestions">{['Give this deck a stronger opening', 'Make the slides more concise', 'Give this deck a bold stage presence'].map((text, i) => <button key={text} disabled={!deck.root || busy || loadingChat || managing} onClick={() => void send(text)}><span>{['↗', '≋', '◐'][i]}</span>{text}<span>↗</span></button>)}</div><div className="agent-note"><Icon name="terminal" size={17} /><p>Already have an agent?<br /><span>Run it in your deck folder. We’ll keep up.</span></p></div></div>}
          footer={<div className="composer-model"><button type="button" className="model-select" disabled={!settingsLoaded} onClick={() => openSettings('connection')}><span className={settings.model ? 'connection-dot connected' : 'connection-dot'} />{settings.model || 'Connect your AI'}</button><ContextMeter used={contextUsed} limit={contextLimit} connected={Boolean(settings.model)} /></div>}
        />
        </div>
      </aside>
    </div>
    {presenting && <button className="exit-present" onClick={() => void present(false)}>Exit presentation <kbd>esc</kbd></button>}
    {agentOpen && <AgentConnection key={agentOpen} agent={agentOpen} onClose={() => setAgentOpen(null)} />}
    {settingsOpen && <AISettings saved={settings} desktop={desktop} initialSection={settingsSection} onClose={() => setSettingsOpen(false)} onSaved={(next, persistedKey) => {
      setSettings(next); setSettingsOpen(false);
      if (!persistedKey) setError('OS encryption is unavailable. Your API key is kept only for this session.');
    }} />}
  </main>;
}
