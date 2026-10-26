import { app, BrowserWindow, Menu } from 'electron';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Server } from 'node:net';
import { MCP_PORT } from '../../electron/mcp.js';

const [directory, mode] = process.argv.slice(2);
app.setPath('userData', path.join(directory, 'profile'));
app.setPath('sessionData', path.join(directory, 'profile'));
// Use isolated ports so the test can run alongside the desktop app.
const listen = Server.prototype.listen;
Server.prototype.listen = function (port, ...args) {
  return listen.call(this, port === MCP_PORT ? 0 : port, ...args);
};
const timeout = setTimeout(() => { console.error('Quit timed out'); app.exit(1); }, 20000);
app.whenReady().then(async () => {
  await import('../../electron/main.js');
  const deadline = Date.now() + 15000;
  while (!BrowserWindow.getAllWindows().some(window => window.isVisible()) || !app.listenerCount('activate')) {
    if (Date.now() > deadline) throw new Error('App did not start.');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (mode === 'closed') {
    await Promise.all(BrowserWindow.getAllWindows().map(window => new Promise(resolve => {
      window.once('closed', resolve);
      window.close();
    })));
    assert.equal(BrowserWindow.getAllWindows().length, 0);
  }
  const quit = Menu.getApplicationMenu().items[0].submenu.items.find(item => item.accelerator === 'Command+Q');
  assert.ok(quit, 'The application menu must provide Cmd+Q.');
  // Trigger Dock activation while shutdown is waiting for servers to close.
  app.on('before-quit', () => {
    const count = BrowserWindow.getAllWindows().length;
    app.emit('activate');
    assert.equal(BrowserWindow.getAllWindows().length, count, 'Quitting must not reopen the window.');
  });
  app.on('will-quit', () => {
    clearTimeout(timeout);
    console.log('Quit completed');
  });
  quit.click();
}).catch(error => { console.error(error); app.exit(1); });
