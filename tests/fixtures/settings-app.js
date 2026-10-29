import { app, BrowserWindow, dialog } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Server } from 'node:net';
import { MCP_PORT } from '../../electron/mcp.js';

const [directory, phase] = process.argv.slice(2);
app.setPath('userData', path.join(directory, 'profile'));
app.setPath('sessionData', path.join(directory, 'profile'));
app.whenReady().then(async () => {
  dialog.showErrorBox = (title, message) => { throw new Error(`${title}: ${message}`); };
  const listen = Server.prototype.listen;
  Server.prototype.listen = function (port, ...args) { return listen.call(this, port === MCP_PORT ? 0 : port, ...args); };
  const waitFor = async predicate => {
    const deadline = Date.now() + 15000;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error('Settings UI did not reach the expected state.');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  try {
    await import('../../electron/main.js');
    let window;
    await waitFor(() => { window = BrowserWindow.getAllWindows().find(item => item.isVisible()); return window; });
    const js = source => window.webContents.executeJavaScript(source);
    await waitFor(() => js(`Boolean(document.querySelector('.top-actions [aria-label="Settings"]:not(:disabled)'))`));
    await js(`document.querySelector('.top-actions [aria-label="Settings"]').click()`);
    await waitFor(() => js(`Boolean(document.querySelector('#max-turns'))`));
    assert.equal(await js(`document.querySelector('#max-turns').value`), phase === 'save' ? '300' : '72');
    assert.equal((await js('window.wetmytt.updateState()')).phase, 'disabled');
    assert.equal((await js('window.wetmytt.checkForUpdates()')).phase, 'disabled');
    await js('window.wetmytt.restartToUpdate()');
    if (phase === 'save') {
      // Exercise the real preload subscription and UI without contacting GitHub
      // or installing an update in this unpackaged test app.
      window.webContents.send('updates:changed', { phase: 'downloading', version: '0.4.0' });
      await waitFor(() => js(`document.querySelector('.update-badge')?.textContent.includes('Downloading')`));
      assert.equal(await js(`document.querySelector('.update-badge button') === null`), true);
      window.webContents.send('updates:changed', { phase: 'downloaded', version: '0.4.0' });
      await waitFor(() => js(`document.querySelector('.update-badge button')?.textContent === 'Restart to Update'`));
      assert.equal(await js(`document.querySelector('.app-updates button').textContent.trim()`), 'Restart to Update');
      window.webContents.send('updates:changed', { phase: 'error', version: '0.4.0', message: 'Check your connection and try again.' });
      await waitFor(() => js(`document.querySelector('.update-badge button')?.textContent.includes('Retry')`));
      window.webContents.send('updates:changed', { phase: 'disabled' });
      await waitFor(() => js(`document.querySelector('.update-badge') === null`));
    }
    window.setMinimumSize(480, 600);
    for (const [width, height] of [[1100, 760], [580, 720]]) {
      window.setSize(width, height);
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(await js(`(() => { const e = document.querySelector('.preferences-page'), r = e.getBoundingClientRect(); return e.scrollWidth <= e.clientWidth && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })()`), true);
    }
    window.setSize(1100, 760);
    if (process.env.WETMYTT_SETTINGS_SCREENSHOT) await fs.writeFile(process.env.WETMYTT_SETTINGS_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
    if (phase === 'save') {
      // Use React's native input setter so this exercises the actual form state.
      await js(`(() => { const input = document.querySelector('#max-turns'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '72'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await js(`document.querySelector('.settings-buttons .primary').click()`);
      await waitFor(() => js(`!document.querySelector('.preferences-page')`));
      assert.equal((await js(`window.wetmytt.settings()`)).maxTurns, 72);
      assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'profile/ai-settings.json'), 'utf8')).maxTurns, 72);
      await assert.rejects(js(`window.wetmytt.savePreferences({ maxTurns: 0 })`), /whole number/);
    } else if (phase === 'reload') {
      assert.equal((await js(`window.wetmytt.settings()`)).model, '');
      // Configuring or removing a connection must retain the saved turn limit.
      await js(`window.wetmytt.saveSettings({ provider: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'test', apiKey: '' })`);
      assert.equal((await js(`window.wetmytt.settings()`)).maxTurns, 72);
    } else {
      await js(`document.querySelectorAll('.settings-nav button')[1].click()`);
      await waitFor(() => js(`Boolean(document.querySelector('input[name="provider"]'))`));
      assert.equal(await js(`document.querySelector('input[name="provider"]:checked').value`), 'ollama');
      await js(`document.querySelector('input[name="provider"][value="gemini"]').click()`);
      assert.equal(await js(`document.querySelector('input[name="provider"]:checked').value`), 'gemini');
      assert.equal(await js(`document.querySelector('input[type="url"]').value`), 'https://generativelanguage.googleapis.com/v1beta/openai');
      assert.equal(await js(`document.querySelector('input[type="password"]').required`), true);
      assert.match(await js(`document.querySelector('#provider-hint').textContent`), /Google AI Studio/);
      for (const [width, height] of [[1100, 760], [580, 720]]) {
        window.setSize(width, height);
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(await js(`(() => { const e = document.querySelector('.provider-picker'); return e.children.length === 5 && e.scrollWidth <= e.clientWidth; })()`), true);
      }
    }
    console.log(`Settings ${phase} checks passed.`);
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
