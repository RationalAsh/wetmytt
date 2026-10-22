import { app, BrowserWindow, dialog, ipcMain, shell, Menu, safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chokidar from 'chokidar';
import { serveFolder } from './server.js';
import { chat } from './agent.js';
import { createDeck } from './decks.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let window, shellServer, deckServer, watcher, root, pendingChat, shellOrigin, watchTimer;
let settings = { baseUrl: 'https://api.openai.com/v1', model: '', apiKey: '' };
const state = () => ({ root, url: deckServer?.url, name: root ? path.basename(root) : null });
const notify = (name, data) => { if (window && !window.isDestroyed()) window.webContents.send(name, data); };

async function openDeck(folder) {
  await fs.access(path.join(folder, 'index.html'));
  const next = await serveFolder(folder, { deck: true });
  pendingChat?.abort();
  await watcher?.close();
  clearTimeout(watchTimer);
  await deckServer?.close();
  root = folder; deckServer = next;
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
app.whenReady().then(async () => {
const settingsPath = path.join(app.getPath('userData'), 'ai-settings.json');
try {
  const saved = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  settings = { baseUrl: saved.baseUrl, model: saved.model, apiKey: saved.encryptedKey && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(saved.encryptedKey, 'base64')) : '' };
} catch {}

handle('deck:state', state);
handle('deck:close', async () => {
  pendingChat?.abort();
  await watcher?.close();
  clearTimeout(watchTimer);
  await deckServer?.close();
  watcher = undefined; deckServer = undefined; root = undefined;
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
handle('deck:reveal', () => root ? shell.openPath(root) : undefined);
handle('deck:present', value => { window.setFullScreen(Boolean(value)); });
handle('ai:settings', () => ({ baseUrl: settings.baseUrl, model: settings.model, hasKey: Boolean(settings.apiKey) }));
handle('ai:save', async value => {
  const endpoint = new URL(value.baseUrl);
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) throw new Error('Use HTTPS, or HTTP for a local model.');
  settings = { baseUrl: endpoint.href, model: String(value.model), apiKey: value.apiKey === undefined ? settings.apiKey : String(value.apiKey) };
  await fs.writeFile(settingsPath, JSON.stringify({ baseUrl: settings.baseUrl, model: settings.model, encryptedKey: settings.apiKey && safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(settings.apiKey).toString('base64') : null }), { mode: 0o600 });
  return { persistedKey: !settings.apiKey || safeStorage.isEncryptionAvailable() };
});
handle('ai:cancel', () => pendingChat?.abort());
handle('ai:chat', async history => {
  if (!root) throw new Error('Open a presentation first.');
  if (pendingChat) throw new Error('A request is already running.');
  if (!Array.isArray(history) || history.length > 100 || history.some(m => !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || m.content.length > 50000)) throw new Error('Invalid or oversized chat history.');
  pendingChat = new AbortController();
  const signal = AbortSignal.any([pendingChat.signal, AbortSignal.timeout(180000)]);
  try { return await chat({ root, settings: { ...settings }, history, signal, onActivity: text => notify('ai:activity', text) }); }
  finally { pendingChat = undefined; }
});

async function createWindow() {
  if (!shellServer && !process.env.DECKLET_DEV_URL) shellServer = await serveFolder(path.join(project, 'out'));
  const url = process.env.DECKLET_DEV_URL || shellServer.url;
  shellOrigin = new URL(url).origin;
  window = new BrowserWindow({ width: 1440, height: 940, minWidth: 900, minHeight: 620, backgroundColor: '#f6f5f1', title: 'Decklet', webPreferences: { preload: path.join(project, 'electron/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
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
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
app.on('window-all-closed', () => { pendingChat?.abort(); if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { pendingChat?.abort(); watcher?.close(); deckServer?.close(); shellServer?.close(); });
}).catch(error => {
  console.error(error);
  dialog.showErrorBox('Decklet could not start', error.message);
  app.quit();
});
