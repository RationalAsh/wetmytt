// Run through `npm run screenshots:readme` after installing dependencies.
// Capture real UI in a disposable profile, without user files or credentials.
import { app, BrowserWindow, dialog } from 'electron';
import fs from 'node:fs/promises';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'node:net';
import assert from 'node:assert/strict';
import { MCP_PORT } from '../electron/mcp.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scenes = ['welcome', 'workspace', 'file-menu', 'editing', 'presentation'];
const requested = process.argv.slice(2);
const selected = new Set(requested.length ? requested : scenes);
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wetmytt-readme-'));
const output = path.join(project, 'docs/screenshots');
const deck = path.join(directory, 'Okay, hear me out');
app.setPath('userData', path.join(directory, 'profile'));
app.setPath('sessionData', path.join(directory, 'profile'));
delete process.env.WETMYTT_DEV_URL;
// Let an installed copy of the app keep its own agent connection.
const listen = Server.prototype.listen;
Server.prototype.listen = function (port, ...args) {
  return listen.call(this, port === MCP_PORT ? 0 : port, ...args);
};
app.on('quit', () => rmSync(directory, { recursive: true, force: true }));
const timeout = setTimeout(() => { console.error('README capture timed out.'); app.exit(1); }, 60000);
const waitFor = async (predicate, description) => {
  const deadline = Date.now() + 15000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};

app.whenReady().then(async () => {
  assert.ok([...selected].every(name => scenes.includes(name)), `Choose screenshot names from: ${scenes.join(', ')}`);
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: deck });
  dialog.showErrorBox = (title, message) => { throw new Error(`${title}: ${message}`); };
  await import('../electron/main.js');
  let window;
  await waitFor(() => { window = BrowserWindow.getAllWindows().find(item => item.isVisible()); return window; }, 'the app window');
  window.setContentSize(1440, 940);
  const js = source => window.webContents.executeJavaScript(source);
  const preview = async source => {
    const frame = window.webContents.mainFrame.frames.find(item => item.url.includes('/index.html?revision='));
    return frame?.executeJavaScript(source);
  };
  const click = label => js(`(() => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === ${JSON.stringify(label)});
    if (!button || button.disabled) throw new Error('Button unavailable: ' + ${JSON.stringify(label)});
    button.click();
  })()`);
  const capture = async name => {
    if (!selected.has(name)) return;
    await js(`(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); })()`);
    assert.equal(await js(`Boolean(document.querySelector('[role="alert"]'))`), false, 'Screenshots must not contain errors.');
    const screenshot = await window.webContents.capturePage();
    await fs.writeFile(path.join(output, `${name}.jpg`), screenshot.resize({ width: 1920 }).toJPEG(90));
    console.log(`Captured ${name}.jpg`);
  };
  await fs.mkdir(output, { recursive: true });
  await waitFor(() => js(`Boolean(document.querySelector('.chat-header [aria-label="Settings"]:not(:disabled)'))`), 'hydration and settings');
  await capture('welcome');

  await click('Create a presentation');
  await waitFor(() => js(`document.querySelectorAll('.slide-thumbnail img').length === 3`), 'the starter deck and thumbnails');
  await waitFor(() => preview(`Boolean(document.querySelector('h1[data-json-path="/slides/0/title"]'))`), 'the cover slide');
  await preview(`document.fonts.ready.then(() => true)`);
  await capture('workspace');

  await js(`document.querySelector('.file-actions .menu-trigger').click()`);
  await waitFor(() => js(`Boolean(document.querySelector('[role="menuitem"]'))`), 'the File menu');
  await capture('file-menu');
  await js(`document.querySelector('.file-actions .menu-trigger').click()`);

  await preview(`document.querySelector('h1[data-json-path="/slides/0/title"]').click()`);
  await waitFor(() => js(`document.querySelector('#edit-tab').getAttribute('aria-selected') === 'true' && document.activeElement?.dataset.path === '/slides/0/title'`), 'click-to-edit field selection');
  assert.equal(await preview(`document.querySelector('h1').hasAttribute('data-wetmytt-selected')`), true);
  await js(`(() => {
    const input = document.querySelector('textarea[data-path="/slides/0/title"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Okay,\\nlet’s make a point.');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(() => js(`Boolean(document.querySelector('.edit-field.active .edit-field-actions'))`), 'the Save text button');
  // Let the editor's smooth scroll settle before capturing the selected field.
  await waitFor(() => js(`(() => {
    const field = document.querySelector('.edit-field.active').getBoundingClientRect();
    const panel = document.querySelector('#edit-panel').getBoundingClientRect();
    return field.top >= panel.top && field.bottom <= panel.bottom;
  })()`), 'the complete selected field');
  await capture('editing');
  // Verify the pictured action really saves through IPC and refreshes the slide.
  await click('Save text');
  await waitFor(() => preview(`document.querySelector('h1')?.textContent === 'Okay,\\nlet’s make a point.'`), 'the saved text in the preview');
  assert.equal(JSON.parse(await fs.readFile(path.join(deck, 'deck.json'), 'utf8')).slides[0].title, 'Okay,\nlet’s make a point.');

  await js(`document.querySelector('[aria-label="Next slide"]').click()`);
  await waitFor(() => preview(`Boolean(document.querySelector('[data-slide]:not([hidden]) img')?.complete)`), 'the illustrated second slide');
  await js(`document.querySelector('[aria-label="Present"]').click()`);
  await waitFor(() => window.isFullScreen() && js(`document.querySelector('.app').classList.contains('presenting')`), 'presentation mode');
  await waitFor(() => js(`getComputedStyle(document.querySelector('.topbar')).display === 'none'`), 'the hidden application shell');
  await capture('presentation');
  window.setFullScreen(false);
  await waitFor(() => !window.isFullScreen(), 'leaving full screen');
  await js('window.wetmytt.close()');
  clearTimeout(timeout);
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
