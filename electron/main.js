import { app, BrowserWindow, dialog, ipcMain, shell, Menu, safeStorage, autoUpdater as nativeUpdater } from 'electron';
import electronUpdater from 'electron-updater';
import { createUpdates } from './updates.js';
import { createUpdateLog } from './update-log.js';
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
import { runTool, withProject } from './tools.js';
import { loadMcpToken, startMcpServer } from './mcp.js';
import { screenshotSlide, createThumbnailRenderer } from './screenshot.js';
import { connectCodex } from './codex-plugin.js';
import { connectClaude } from './claude-extension.js';
import { exportDeckPDF } from './pdf.js';
import { listChats, loadChat, runConversation } from './chats.js';
import { readSlideManagement, mutateSlide } from './slide-management.js';
import { readContent, saveContent, withContentWrite } from './content.js';
import { currentBranch, gitFilesAction, gitInit, gitHistory, gitSummary, gitBranches, gitBranchAction, restoreLastSave } from './git.js';
import { readProjectFiles } from './project-files.js';
import { createRecentFolders } from './recent-folders.js';
import { projectUrl } from './agent-metadata.js';

app.setName('Welcome to My TED Talk');

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let window, shellServer, deckServer, watcher, root, pendingChat, shellOrigin, watchTimer;
let exportingPDF = false;
// True only while the app's own presentation mode owns full screen.
let presenting = false;
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
app.setAboutPanelOptions({
  applicationName: app.name,
  applicationVersion: app.getVersion(),
  copyright: 'Copyright © 2026 Ashwin Narayan',
  credits: 'Made by Ashwin Narayan.\nLicensed under the MIT License.',
});
let quitting = false, cleanupPromise;
const updatesEnabled = app.isPackaged && process.platform === 'darwin' && !process.env.WETMYTT_DEV_URL && process.env.NODE_ENV !== 'development';
if (updatesEnabled) {
  await cleanInstalledUpdateCache(path.join(app.getPath('home'), 'Library', 'Caches', 'wetmytt-updater'), app.getVersion())
    .catch(error => console.warn('Could not clean installed update cache:', error.message));
}
const updateLogPath = path.join(app.getPath('logs'), 'updates.log');
const updateLog = createUpdateLog(updateLogPath, { context: { version: app.getVersion(), arch: process.arch, platform: process.platform } });
if (updatesEnabled) electronUpdater.autoUpdater.logger = updateLog.logger;
const updates = createUpdates({
  logger: updateLog.logger,
  updater: electronUpdater.autoUpdater, nativeUpdater,
  enabled: updatesEnabled,
  notify: status => notify('updates:changed', status),
  beforeRestart: () => { quitting = true; return cleanup(); },
});
async function showUpdateLog() {
  updateLog.logger.info('Update log requested');
  await updateLog.flush();
  shell.showItemInFolder(updateLogPath);
}
handle('updates:log', showUpdateLog);
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
handle('deck:files', (folder, version) => readProjectFiles(contentRoot(folder, version), projectOperations.signal));
handle('deck:git-summary', (folder, version) => gitSummary(contentRoot(folder, version), projectOperations.signal));
handle('deck:history', (folder, version, page) => gitHistory(contentRoot(folder, version), page, projectOperations.signal));
handle('deck:branches', (folder, version) => gitBranches(contentRoot(folder, version), projectOperations.signal));
let filesBusy = false;
let changingWorktree = false;
handle('deck:branch-action', async (folder, version, action, name) => {
  contentRoot(folder, version);
  if (filesBusy || pendingChat || exportingPDF) throw new Error('Wait for the current operation before changing branches.');
  filesBusy = true; changingWorktree = true;
  const signal = projectOperations.signal;
  try {
    return await withProject(folder, () => withContentWrite(folder, async () => {
      contentRoot(folder, version);
      await gitBranchAction(folder, action, name, signal);
      contentRoot(folder, version);
      invalidateThumbnails();
      await notifyDeck();
    }), signal);
  } finally { filesBusy = false; changingWorktree = false; }
});
handle('deck:restore-last-save', async (folder, version) => {
  contentRoot(folder, version);
  if (filesBusy || pendingChat || exportingPDF) throw new Error('Wait for the current operation before restoring.');
  filesBusy = true; changingWorktree = true;
  const signal = projectOperations.signal;
  try {
    return await withProject(folder, () => withContentWrite(folder, async () => {
      contentRoot(folder, version);
      const result = await restoreLastSave(folder, signal);
      contentRoot(folder, version);
      invalidateThumbnails();
      await notifyDeck();
      return result;
    }), signal);
  } finally { filesBusy = false; changingWorktree = false; }
});
handle('deck:git-action', async (folder, version, action, paths, message) => {
  contentRoot(folder, version);
  if (filesBusy || pendingChat || exportingPDF) throw new Error('Wait for the current operation before changing Git.');
  filesBusy = true;
  const signal = projectOperations.signal;
  try {
    const result = action === 'init' ? await gitInit(folder, signal) : await gitFilesAction(folder, action, paths, message, signal);
    contentRoot(folder, version);
    await notifyDeck();
    return result;
  } finally { filesBusy = false; }
});
handle('deck:save-content', (folder, version, source, pointer, text) => saveContent(contentRoot(folder, version), source, pointer, text, () => {
  contentRoot(folder, version);
  if (changingWorktree) throw new Error('Wait for the current project operation to finish.');
}));
const slideGuard = (folder, version, revision) => {
  contentRoot(folder, version);
  if (changingWorktree || revision !== contentRevision || !contentSettled) throw new Error('The presentation changed. Wait for it to reload before managing slides.');
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
  if (changingWorktree) throw new Error('Wait for the current project operation to finish.');
  if (!root || root !== expectedRoot) throw new Error('The open project changed. Drop the files again.');
  return runTool(root, 'import_assets', { sources }, projectOperations.signal).then(JSON.parse);
});
handle('deck:choose-assets', async (expectedRoot, expectedGeneration) => {
  if (changingWorktree) throw new Error('Wait for the current project operation to finish.');
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
  if (presenting) { presenting = false; window.setFullScreen(false); }
  await notifyDeck();
  return state();
});
// Shared by the toolbar and the File menu.
async function chooseAndOpenDeck() {
  const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'], title: 'Open presentation folder' });
  if (!result.canceled) return openDeck(result.filePaths[0]);
  return null;
}
async function chooseAndCreateDeck() {
  const result = await dialog.showSaveDialog(window, { title: 'Create presentation folder', defaultPath: path.join(app.getPath('documents'), 'Untitled presentation'), buttonLabel: 'Create presentation' });
  if (result.canceled || !result.filePath) return null;
  return createPresentation(result.filePath);
}
handle('deck:open', chooseAndOpenDeck);
handle('deck:create', chooseAndCreateDeck);
handle('deck:export-pdf', async expectedRoot => {
  if (!root || root !== expectedRoot) throw new Error('The open project changed. Please export again.');
  if (changingWorktree) throw new Error('Wait for the current project operation to finish.');
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
handle('deck:present', value => {
  // Leaving a presentation must not exit full screen the user entered themselves.
  if (!value && !presenting) return;
  presenting = Boolean(value);
  window.setFullScreen(presenting);
});
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
  if (changingWorktree) throw new Error('Wait for the current project operation to finish.');
  if (pendingChat) throw new Error('A request is already running.');
  pendingChat = new AbortController();
  const signal = pendingChat.signal;
  const deckGeneration = generation;
  try {
    const connection = await settings.connection();
    signal.throwIfAborted();
    if (root !== folder || generation !== deckGeneration) throw new Error('The open project changed. Please try again.');
    const progress = value => {
      if (!signal.aborted && root === folder && generation === deckGeneration) notify('ai:progress', { root: folder, generation: deckGeneration, runId, ...value });
    };
    return await runConversation({ root: folder, id, text, settings: connection, signal, onActivity: operation => progress({ operation }),
      chat: options => chat({ ...options, screenshotSlide, onText: text => progress({ text }) }),
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
  window.webContents.on('before-input-event', (event, input) => {
    // Handle this before page input, including when focus is inside a slide.
    if (process.platform === 'darwin' && input.type === 'keyDown' && input.key === ',' && input.meta && !input.control && !input.alt && !input.shift) {
      event.preventDefault();
      notify('app:settings');
    }
    // Exit even when keyboard focus is inside custom slide HTML.
    if (presenting && input.type === 'keyDown' && input.key === 'Escape') {
      presenting = false;
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
  // Ordinary macOS full screen keeps the workspace visible; only Present hides it.
  window.on('enter-full-screen', () => { if (presenting) notify('deck:fullscreen', true); });
  window.on('leave-full-screen', () => { presenting = false; notify('deck:fullscreen', false); });
  await window.loadURL(url);
}
refreshRecentFolders = () => {
  notify('recent:changed', recentFolders.list());
  buildApplicationMenu();
};
function reportProblem() {
  const body = [
    '**What happened?**', '', '', '**What did you expect?**', '', '', '**Steps to reproduce**', '1. ', '',
    '**Environment**', `- App version: ${app.getVersion()}`, `- Architecture: ${process.arch}`, `- macOS: ${process.getSystemVersion()}`, '',
    'For update problems, attach updates.log from Help → Show Update Log.',
  ].join('\n');
  return shell.openExternal(`${projectUrl}/issues/new?${new URLSearchParams({ body })}`);
}
function buildApplicationMenu() {
const menuError = title => error => dialog.showErrorBox(title, error.message);
Menu.setApplicationMenu(Menu.buildFromTemplate([
  ...(process.platform === 'darwin' ? [{ label: app.name, submenu: [
    { role: 'about' }, { type: 'separator' },
    { label: 'Settings…', accelerator: 'Command+,', click: () => notify('app:settings') },
    { type: 'separator' }, { role: 'services' },
    { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
    { type: 'separator' },
    { label: `Quit ${app.name}`, accelerator: 'Command+Q', click: () => app.quit() },
  ] }] : []),
  { label: 'File', submenu: [
    { label: 'New presentation…', accelerator: 'CmdOrCtrl+N', click: () => { void chooseAndCreateDeck().catch(menuError('Could not create presentation')); } },
    { label: 'Open presentation…', accelerator: 'CmdOrCtrl+O', click: () => { void chooseAndOpenDeck().catch(menuError('Could not open deck')); } },
    { label: 'Open recent', submenu: [
      ...recentFolders.list().map(folder => ({ label: folder, click: () => { void openDeck(folder).catch(menuError('Could not open deck')); } })),
      ...(recentFolders.list().length ? [{ type: 'separator' }, { label: 'Clear recent folders', click: () => { void recentFolders.clear().then(refreshRecentFolders).catch(menuError('Could not clear recent folders')); } }] : [{ label: 'No recent folders', enabled: false }]),
    ] },
    { type: 'separator' }, { role: 'close' },
  ] },
  { role: 'editMenu' },
  // Reloading the shell mid-request loses UI state, so keep it to development builds.
  { label: 'View', submenu: [...(app.isPackaged ? [] : [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }]), { role: 'togglefullscreen' }] },
  { role: 'windowMenu' },
  { role: 'help', submenu: [
    { label: `${app.name} Help`, click: () => { void shell.openExternal(`${projectUrl}#readme`); } },
    { label: 'Release Notes', click: () => { void shell.openExternal(`${projectUrl}/releases/tag/v${app.getVersion()}`); } },
    { type: 'separator' },
    { label: 'Report a Problem…', click: () => { void reportProblem().catch(menuError('Could not open the issue form')); } },
    { label: 'Show Update Log', click: () => { void showUpdateLog().catch(menuError('Could not open the update log')); } },
  ] },
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
