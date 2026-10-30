import { app, BrowserWindow, dialog, ipcMain, shell, Menu, safeStorage, autoUpdater as nativeUpdater } from 'electron';
import electronUpdater from 'electron-updater';
import { createUpdates } from './updates.js';
import { cleanInstalledUpdateCache } from './update-cache.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chokidar from 'chokidar';
import { serveFolder } from './server.js';
import { chat } from './agent.js';
import { contextLimit } from './providers.js';
import { createAISettings } from './ai-settings.js';
import { createDeck } from './decks.js';
import { runTool } from './tools.js';
import { loadMcpToken, startMcpServer } from './mcp.js';
import { screenshotSlide, createThumbnailRenderer } from './screenshot.js';
import { connectCodex } from './codex-plugin.js';
import { connectClaude } from './claude-extension.js';
import { exportDeckPDF } from './pdf.js';
import { listChats, loadChat, runConversation } from './chats.js';
import { readSlideManagement, mutateSlide } from './slide-management.js';
import { readContent, saveContent } from './content.js';
import { currentBranch } from './git.js';
import { createRecentFolders } from './recent-folders.js';

app.setName('Welcome to My TED Talk');

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let window, shellServer, deckServer, watcher, root, pendingChat, shellOrigin, watchTimer;
let exportingPDF = false;
let thumbnailOperations = new AbortController();
let thumbnailRenderer, contentRevision = 0, contentSettled = true;
let openingDeck = Promise.resolve();
let recentFolders, refreshRecentFolders;
let projectOperations = new AbortController();
let mcp, mcpError, mcpToken, connectingCodex, connectingClaude, generation = 0;
const state = async () => {
  const snapshot = { root, generation, contentRevision, contentSettled, url: deckServer?.url, name: root ? path.basename(root) : null };
  return { ...snapshot, branch: snapshot.root ? await currentBranch(snapshot.root) : null };
};
const notify = (name, data) => { if (window && !window.isDestroyed()) window.webContents.send(name, data); };
function invalidateThumbnails() {
  contentRevision++; contentSettled = false;
  thumbnailOperations.abort();
  thumbnailOperations = new AbortController();
  void thumbnailRenderer?.close(); thumbnailRenderer = undefined;
  notify('deck:invalidated', { root, generation, contentRevision, contentSettled });
}
async function notifyDeck() {
  contentSettled = true;
  const snapshot = await state();
  if (snapshot.generation === generation && snapshot.contentRevision === contentRevision) notify('deck:changed', snapshot);
}

function openDeck(folder, signal) {
  const operation = openingDeck.then(() => {
    signal?.throwIfAborted();
    return performOpenDeck(folder);
  });
  openingDeck = operation.catch(() => {});
  return operation;
}

async function createPresentation(folder, signal) {
  signal?.throwIfAborted();
  await createDeck(folder);
  return openDeck(folder, signal);
}

async function performOpenDeck(folder) {
  folder = await fs.realpath(folder);
  if (!(await fs.stat(path.join(folder, 'index.html'))).isFile()) throw new Error('The presentation must contain an index.html file.');
  const next = await serveFolder(folder, { deck: true });
  pendingChat?.abort();
  await watcher?.close();
  clearTimeout(watchTimer);
  await deckServer?.close();
  root = folder; deckServer = next; generation++;
  invalidateThumbnails();
  projectOperations.abort(); projectOperations = new AbortController();
  mcp?.cancelStaleSessions();
  watcher = chokidar.watch(root, {
    ignored: filename => {
      const relative = path.relative(root, filename);
      if (relative === '.git' || relative === path.join('.git', 'HEAD')) return false;
      return /(^|[/\\])\.|(^|[/\\])node_modules([/\\]|$)/.test(relative);
    },
    ignoreInitial: true,
  });
  watcher.on('all', () => { invalidateThumbnails(); clearTimeout(watchTimer); watchTimer = setTimeout(() => { void notifyDeck(); }, 250); });
  watcher.on('error', error => console.error('Deck watcher:', error.message));
  await notifyDeck();
  try {
    await recentFolders.add(folder);
    refreshRecentFolders();
  } catch (error) {
    console.error('Could not save recent folders:', error.message);
    notify('recent:error', 'The folder opened, but its recent-folder entry could not be saved.');
  }
  return state();
}

function handle(channel, callback) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || new URL(event.senderFrame.url).origin !== shellOrigin) throw new Error('Untrusted IPC sender.');
    return callback(...args);
  });
}

// Electron waits for ESM evaluation before emitting ready. Awaiting whenReady at
// module scope would deadlock startup and leave the Dock icon bouncing.
if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(async () => {
let quitting = false, cleanupPromise;
const updatesEnabled = app.isPackaged && process.platform === 'darwin' && !process.env.WETMYTT_DEV_URL && process.env.NODE_ENV !== 'development';
if (updatesEnabled) {
  await cleanInstalledUpdateCache(path.join(app.getPath('home'), 'Library', 'Caches', 'wetmytt-updater'), app.getVersion())
    .catch(error => console.warn('Could not clean installed update cache:', error.message));
}
const updates = createUpdates({
  updater: electronUpdater.autoUpdater, nativeUpdater,
  enabled: updatesEnabled,
  notify: status => notify('updates:changed', status),
  beforeRestart: () => { quitting = true; return cleanup(); },
});
handle('updates:state', updates.state);
handle('updates:check', updates.check);
handle('updates:restart', updates.restart);
recentFolders = createRecentFolders(path.join(app.getPath('userData'), 'recent-folders.json'));
await recentFolders.load().catch(error => console.error('Could not load recent folders:', error.message));
handle('recent:list', () => recentFolders.list());
handle('recent:open', folder => {
  if (typeof folder !== 'string' || !recentFolders.list().includes(folder)) throw new Error('This folder is no longer in Open recent.');
  return openDeck(folder);
});
handle('recent:remove', async folder => { await recentFolders.remove(folder); refreshRecentFolders(); });
handle('recent:clear', async () => { await recentFolders.clear(); refreshRecentFolders(); });
const settingsPath = path.join(app.getPath('userData'), 'ai-settings.json');
const settings = createAISettings({ safeStorage, write: saved => fs.writeFile(settingsPath, JSON.stringify(saved), { mode: 0o600 }) });
try {
  // Keep existing connections when upgrading from the original app name.
  const savedText = await fs.readFile(settingsPath, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return fs.readFile(path.join(app.getPath('appData'), 'decklet', 'ai-settings.json'), 'utf8');
  });
  settings.load(JSON.parse(savedText));
} catch {}

try {
  mcpToken = await loadMcpToken(app.getPath('userData'));
  mcp = await startMcpServer({ getDeck: () => ({ root, generation }), screenshotSlide, listRecentPresentations: () => recentFolders.list(), openPresentation: openDeck, createPresentation, token: mcpToken });
} catch (error) {
  mcpError = `Could not start the agent connection: ${error.message}`;
  console.error(mcpError);
}
handle('mcp:connect-codex', async () => {
  if (!mcp) throw new Error(mcpError || 'Agent connection unavailable.');
  // Coalesce repeated clicks while the marketplace is being updated.
  if (!connectingCodex) connectingCodex = connectCodex({ url: mcp.url, token: mcpToken, openExternal: link => shell.openExternal(link) }).finally(() => { connectingCodex = undefined; });
  return connectingCodex;
});
handle('mcp:connect-claude', async () => {
  if (!mcp) throw new Error(mcpError || 'Agent connection unavailable.');
  if (!connectingClaude) connectingClaude = connectClaude({ url: mcp.url, token: mcpToken, directory: path.join(app.getPath('userData'), 'claude-extension'), openPath: filename => shell.openPath(filename) }).finally(() => { connectingClaude = undefined; });
  return connectingClaude;
});
handle('deck:state', state);
const contentRoot = (expectedRoot, expectedGeneration) => {
  if (!root || root !== expectedRoot || generation !== expectedGeneration) throw new Error('The open project changed. Please try again.');
  return root;
};
handle('deck:thumbnails', async (folder, version, revision, slides) => {
  contentRoot(folder, version);
  if (!Array.isArray(slides) || !slides.length || slides.length > 6 || slides.some(slide => !Number.isSafeInteger(slide?.index) || slide.index < 0 || typeof slide.id !== 'string')) throw new Error('Request up to six identified slide thumbnails at a time.');
  if (revision !== contentRevision || !contentSettled) return null;
  const signal = thumbnailOperations.signal;
  thumbnailRenderer ??= createThumbnailRenderer(folder, { revision, signal, trace: process.env.WETMYTT_THUMBNAIL_TRACE ? event => console.log('Thumbnail:', JSON.stringify({ root: folder, generation: version, ...event })) : undefined });
  try {
    const results = await thumbnailRenderer.capture(slides);
    if (signal.aborted || revision !== contentRevision || !contentSettled || folder !== root || version !== generation) return null;
    return results.map(({ image, ...result }) => ({ ...result, root: folder, generation: version, ...(image ? { url: `data:image/png;base64,${image.toString('base64')}` } : {}) }));
  } catch (error) {
    if (signal.aborted) return null;
    throw error;
  }
});
handle('deck:read-content', (folder, version) => readContent(contentRoot(folder, version)));
handle('deck:save-content', (folder, version, source, pointer, text) => saveContent(contentRoot(folder, version), source, pointer, text, () => contentRoot(folder, version)));
const slideGuard = (folder, version, revision) => {
  contentRoot(folder, version);
  if (revision !== contentRevision || !contentSettled) throw new Error('The presentation changed. Wait for it to reload before managing slides.');
};
handle('deck:read-slide-management', async (folder, version, revision) => {
  slideGuard(folder, version, revision);
  const result = await readSlideManagement(folder);
  slideGuard(folder, version, revision);
  return result;
});
handle('deck:mutate-slide', (folder, version, revision, source, renderedIds, operation) => {
  slideGuard(folder, version, revision);
  if (pendingChat || exportingPDF) throw new Error('Wait for the current operation before managing slides.');
  return mutateSlide(folder, source, renderedIds, operation, () => {
    slideGuard(folder, version, revision);
    if (pendingChat || exportingPDF) throw new Error('Wait for the current operation before managing slides.');
  });
});
handle('deck:import-assets', (expectedRoot, sources) => {
  if (!root || root !== expectedRoot) throw new Error('The open project changed. Drop the files again.');
  return runTool(root, 'import_assets', { sources }, projectOperations.signal).then(JSON.parse);
});
handle('deck:choose-assets', async (expectedRoot, expectedGeneration) => {
  const folder = contentRoot(expectedRoot, expectedGeneration);
  const result = await dialog.showOpenDialog(window, { properties: ['openFile', 'multiSelections'], title: 'Add assets to presentation' });
  if (result.canceled) return null;
  contentRoot(expectedRoot, expectedGeneration);
  return JSON.parse(await runTool(folder, 'import_assets', { sources: result.filePaths }, projectOperations.signal));
});
handle('deck:close', async () => {
  pendingChat?.abort();
  await watcher?.close();
  clearTimeout(watchTimer);
  await deckServer?.close();
  watcher = undefined; deckServer = undefined; root = undefined; generation++;
  invalidateThumbnails();
  projectOperations.abort(); projectOperations = new AbortController();
  mcp?.cancelStaleSessions();
  window.setFullScreen(false);
  await notifyDeck();
  return state();
});
handle('deck:open', async () => {
  const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'], title: 'Open presentation folder' });
  if (!result.canceled) return openDeck(result.filePaths[0]);
  return null;
});
handle('deck:create', async () => {
  const result = await dialog.showSaveDialog(window, { title: 'Create presentation folder', defaultPath: path.join(app.getPath('documents'), 'Untitled presentation'), buttonLabel: 'Create presentation' });
  if (result.canceled || !result.filePath) return null;
  return createPresentation(result.filePath);
});
handle('deck:export-pdf', async expectedRoot => {
  if (!root || root !== expectedRoot) throw new Error('The open project changed. Please export again.');
  if (exportingPDF) throw new Error('A PDF export is already running.');
  exportingPDF = true;
  const folder = root, deckGeneration = generation;
  let temporary;
  try {
    const result = await dialog.showSaveDialog(window, {
      title: 'Export presentation to PDF', buttonLabel: 'Export PDF',
      defaultPath: path.join(app.getPath('documents'), `${path.basename(folder)}.pdf`),
      filters: [{ name: 'PDF document', extensions: ['pdf'] }],
    });
    if (result.canceled || !result.filePath) return null;
    if (generation !== deckGeneration) throw new Error('The open project changed. Please export again.');
    const target = /\.pdf$/i.test(result.filePath) ? result.filePath : `${result.filePath}.pdf`;
    const { bytes, pages } = await exportDeckPDF(folder);
    if (generation !== deckGeneration) throw new Error('The open project changed. Please export again.');
    // Save beside the destination first, so rendering/write errors never leave
    // a partial PDF or truncate a previously exported presentation.
    temporary = path.join(path.dirname(target), `.wetmytt-${Date.now()}-${process.pid}.pdf.tmp`);
    await fs.writeFile(temporary, bytes, { flag: 'wx' });
    await fs.rename(temporary, target);
    return { path: target, pages };
  } finally {
    if (temporary) await fs.unlink(temporary).catch(() => {});
    exportingPDF = false;
  }
});
handle('deck:reveal', () => root ? shell.openPath(root) : undefined);
handle('deck:present', value => { window.setFullScreen(Boolean(value)); });
handle('ai:settings', settings.state);
handle('ai:context', () => contextLimit(settings.context()));
handle('ai:preferences', settings.savePreferences);
handle('ai:save', settings.saveConnection);
handle('ai:cancel', () => pendingChat?.abort());
const chatRoot = expectedRoot => {
  if (!root || root !== expectedRoot) throw new Error('The open project changed. Please try again.');
  return root;
};
handle('ai:chats', expectedRoot => listChats(chatRoot(expectedRoot)));
handle('ai:load-chat', (expectedRoot, id) => loadChat(chatRoot(expectedRoot), id));
handle('ai:chat', async (expectedRoot, id, text, runId) => {
  const folder = chatRoot(expectedRoot);
  if (pendingChat) throw new Error('A request is already running.');
  pendingChat = new AbortController();
  const signal = pendingChat.signal;
  const deckGeneration = generation;
  try {
    const connection = await settings.connection();
    signal.throwIfAborted();
    if (root !== folder || generation !== deckGeneration) throw new Error('The open project changed. Please try again.');
    return await runConversation({ root: folder, id, text, settings: connection, signal, chat: options => chat({ ...options, screenshotSlide }),
      onConversation: conversation => {
        if (root === folder && generation === deckGeneration) notify('ai:conversation', { root: folder, generation: deckGeneration, runId, conversation });
      },
    });
  }
  finally { pendingChat = undefined; }
});

async function createWindow() {
  if (!shellServer && !process.env.WETMYTT_DEV_URL) shellServer = await serveFolder(path.join(project, 'out'));
  const url = process.env.WETMYTT_DEV_URL || shellServer.url;
  shellOrigin = new URL(url).origin;
  window = new BrowserWindow({ width: 1440, height: 940, minWidth: 900, minHeight: 620, backgroundColor: '#f4f2f8', title: 'Welcome to My TED Talk', webPreferences: { preload: path.join(project, 'electron/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(({ url: target, referrer }) => {
    // Chat links open in the browser; slide content cannot launch external apps.
    if (referrer.url && new URL(referrer.url).origin === shellOrigin && /^https?:\/\//i.test(target)) {
      void shell.openExternal(target).catch(error => console.error('Could not open link:', error.message));
    }
    return { action: 'deny' };
  });
  window.webContents.on('before-input-event', (_event, input) => {
    // Exit even when keyboard focus is inside custom slide HTML.
    if (input.type === 'keyDown' && input.key === 'Escape') {
      window.setFullScreen(false);
      notify('deck:fullscreen', false);
    }
  });
  window.webContents.on('will-navigate', (event, target) => { if (new URL(target).origin !== shellOrigin) event.preventDefault(); });
  // assistant-ui's Copy action uses the browser Clipboard API. Only the app's
  // own main frame may write plain text; presentations and clipboard reads
  // retain the default denial.
  const canWriteClipboard = (contents, permission, details) => {
    if (contents !== window.webContents || permission !== 'clipboard-sanitized-write' || !details.isMainFrame) return false;
    try { return new URL(details.requestingUrl).origin === shellOrigin; }
    catch { return false; }
  };
  window.webContents.session.setPermissionCheckHandler((contents, permission, _origin, details) => canWriteClipboard(contents, permission, details));
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => callback(canWriteClipboard(contents, permission, details)));
  window.on('closed', () => {
    thumbnailOperations.abort(); thumbnailOperations = new AbortController();
    void thumbnailRenderer?.close(); thumbnailRenderer = undefined;
  });
  window.on('enter-full-screen', () => notify('deck:fullscreen', true));
  window.on('leave-full-screen', () => notify('deck:fullscreen', false));
  await window.loadURL(url);
}
refreshRecentFolders = () => {
  notify('recent:changed', recentFolders.list());
  buildApplicationMenu();
};
function buildApplicationMenu() {
Menu.setApplicationMenu(Menu.buildFromTemplate([
  ...(process.platform === 'darwin' ? [{ label: app.name, submenu: [
    { role: 'about' }, { type: 'separator' }, { role: 'services' },
    { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
    { type: 'separator' },
    { label: `Quit ${app.name}`, accelerator: 'Command+Q', click: () => app.quit() },
  ] }] : []),
  { label: 'File', submenu: [{ label: 'Open presentation…', accelerator: 'CmdOrCtrl+O', click: async () => { const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'] }); if (!result.canceled) openDeck(result.filePaths[0]).catch(error => dialog.showErrorBox('Could not open deck', error.message)); } }, { label: 'Open recent', submenu: [
    ...recentFolders.list().map(folder => ({ label: folder, click: () => { void openDeck(folder).catch(error => dialog.showErrorBox('Could not open deck', error.message)); } })),
    ...(recentFolders.list().length ? [{ type: 'separator' }, { label: 'Clear recent folders', click: () => { void recentFolders.clear().then(refreshRecentFolders).catch(error => dialog.showErrorBox('Could not clear recent folders', error.message)); } }] : [{ label: 'No recent folders', enabled: false }]),
  ] }, { role: 'close' }] },
  { role: 'editMenu' }, { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { role: 'togglefullscreen' }] },
 ]));
}
buildApplicationMenu();
await createWindow();
updates.start();
app.on('second-instance', () => { if (!quitting && window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
app.on('activate', () => { if (!quitting && !BrowserWindow.getAllWindows().length) createWindow(); });
app.on('window-all-closed', () => { pendingChat?.abort(); if (process.platform !== 'darwin') app.quit(); });
function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  updates.stop();
  pendingChat?.abort(); generation++; thumbnailOperations.abort();
  projectOperations.abort();
  cleanupPromise = Promise.allSettled([thumbnailRenderer?.close(), mcp?.close(), watcher?.close(), deckServer?.close(), shellServer?.close()]);
  return cleanupPromise;
}
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault(); quitting = true;
  cleanup().finally(() => app.quit());
});
}).catch(error => {
  console.error(error);
  dialog.showErrorBox('Welcome to My TED Talk could not start', error.message);
  app.quit();
});
