import { app, BrowserWindow, dialog, ipcMain, shell, Menu, safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chokidar from 'chokidar';
import { serveFolder } from './server.js';
import { chat } from './agent.js';
import { inferProvider, normalizeSettings } from '../shared/ai.js';
import { createDeck } from './decks.js';
import { importAssets } from './files.js';
import { loadMcpToken, startMcpServer } from './mcp.js';
import { screenshotSlide } from './screenshot.js';
import { connectCodex } from './codex-plugin.js';
import { exportDeckPDF } from './pdf.js';
import { listChats, loadChat, runConversation } from './chats.js';

app.setName('Welcome to My TED Talk');

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let window, shellServer, deckServer, watcher, root, pendingChat, shellOrigin, watchTimer;
let exportingPDF = false;
let mcp, mcpError, mcpToken, connectingCodex, generation = 0;
let settings = { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: '', apiKey: '' };
const state = () => ({ root, generation, url: deckServer?.url, name: root ? path.basename(root) : null });
const notify = (name, data) => { if (window && !window.isDestroyed()) window.webContents.send(name, data); };

async function openDeck(folder) {
  await fs.access(path.join(folder, 'index.html'));
  const next = await serveFolder(folder, { deck: true });
  pendingChat?.abort();
  await watcher?.close();
  clearTimeout(watchTimer);
  await deckServer?.close();
  root = folder; deckServer = next; generation++;
  watcher = chokidar.watch(root, { ignored: /(^|[/\\])\.|node_modules/, ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 } });
  watcher.on('all', () => { clearTimeout(watchTimer); watchTimer = setTimeout(() => notify('deck:changed', state()), 100); });
  watcher.on('error', error => console.error('Deck watcher:', error.message));
  notify('deck:changed', state());
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
const settingsPath = path.join(app.getPath('userData'), 'ai-settings.json');
try {
  // Keep existing connections when upgrading from the original app name.
  const savedText = await fs.readFile(settingsPath, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return fs.readFile(path.join(app.getPath('appData'), 'decklet', 'ai-settings.json'), 'utf8');
  });
  const saved = JSON.parse(savedText);
  settings = normalizeSettings({ provider: saved.provider ?? inferProvider(saved.baseUrl), baseUrl: saved.baseUrl, model: saved.model, apiKey: saved.encryptedKey && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(saved.encryptedKey, 'base64')) : '' }, {}, { requireKey: false });
} catch {}

try {
  mcpToken = await loadMcpToken(app.getPath('userData'));
  mcp = await startMcpServer({ getDeck: () => ({ root, generation }), screenshotSlide, token: mcpToken });
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
handle('deck:state', state);
handle('deck:import-assets', (expectedRoot, sources) => {
  if (!root || root !== expectedRoot) throw new Error('The open project changed. Drop the files again.');
  return importAssets(root, sources);
});
handle('deck:close', async () => {
  pendingChat?.abort();
  await watcher?.close();
  clearTimeout(watchTimer);
  await deckServer?.close();
  watcher = undefined; deckServer = undefined; root = undefined; generation++;
  window.setFullScreen(false);
  notify('deck:changed', state());
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
  await createDeck(result.filePath);
  return openDeck(result.filePath);
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
handle('ai:settings', () => ({ provider: settings.provider, baseUrl: settings.baseUrl, model: settings.model, hasKey: Boolean(settings.apiKey) }));
handle('ai:save', async value => {
  // An explicit empty key is the "Remove saved key" action.
  const next = normalizeSettings(value, settings, { requireKey: value.apiKey !== '' });
  await fs.writeFile(settingsPath, JSON.stringify({ provider: next.provider, baseUrl: next.baseUrl, model: next.model, encryptedKey: next.apiKey && safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(next.apiKey).toString('base64') : null }), { mode: 0o600 });
  settings = next;
  return { persistedKey: !settings.apiKey || safeStorage.isEncryptionAvailable() };
});
handle('ai:cancel', () => pendingChat?.abort());
const chatRoot = expectedRoot => {
  if (!root || root !== expectedRoot) throw new Error('The open project changed. Please try again.');
  return root;
};
handle('ai:chats', expectedRoot => listChats(chatRoot(expectedRoot)));
handle('ai:load-chat', (expectedRoot, id) => loadChat(chatRoot(expectedRoot), id));
handle('ai:chat', async (expectedRoot, id, text) => {
  const folder = chatRoot(expectedRoot);
  if (pendingChat) throw new Error('A request is already running.');
  const connection = normalizeSettings({ ...settings });
  pendingChat = new AbortController();
  const signal = pendingChat.signal;
  try { return await runConversation({ root: folder, id, text, settings: connection, signal, chat, onActivity: text => { if (root === folder && !signal.aborted) notify('ai:activity', text); } }); }
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
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.on('enter-full-screen', () => notify('deck:fullscreen', true));
  window.on('leave-full-screen', () => notify('deck:fullscreen', false));
  await window.loadURL(url);
}
Menu.setApplicationMenu(Menu.buildFromTemplate([
  ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
  { label: 'File', submenu: [{ label: 'Open presentation…', accelerator: 'CmdOrCtrl+O', click: async () => { const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'] }); if (!result.canceled) openDeck(result.filePaths[0]).catch(error => dialog.showErrorBox('Could not open deck', error.message)); } }, { role: 'close' }] },
  { role: 'editMenu' }, { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { role: 'togglefullscreen' }] },
 ]));
await createWindow();
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
app.on('window-all-closed', () => { pendingChat?.abort(); if (process.platform !== 'darwin') app.quit(); });
let quitting = false;
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault(); quitting = true;
  pendingChat?.abort(); generation++;
  Promise.allSettled([mcp?.close(), watcher?.close(), deckServer?.close(), shellServer?.close()]).finally(() => app.quit());
});
}).catch(error => {
  console.error(error);
  dialog.showErrorBox('Welcome to My TED Talk could not start', error.message);
  app.quit();
});
