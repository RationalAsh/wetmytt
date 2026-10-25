import { app, BrowserWindow, dialog, Menu } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const [directory] = process.argv.slice(2);
app.setPath('userData', path.join(directory, 'profile'));
app.setPath('sessionData', path.join(directory, 'profile'));
app.whenReady().then(async () => {
  const first = path.join(directory, 'First deck'), second = path.join(directory, 'Second deck');
  await fs.cp(path.resolve('templates/starter'), first, { recursive: true });
  await fs.cp(first, second, { recursive: true });
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [first] });
  dialog.showErrorBox = (title, message) => { throw new Error(`${title}: ${message}`); };
  const waitFor = async predicate => {
    const deadline = Date.now() + 15000;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error('Recent-folders UI did not reach the expected state.');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  try {
    await import('../../electron/main.js');
    let window;
    await waitFor(() => { window = BrowserWindow.getAllWindows().find(item => item.isVisible()); return window; });
    const js = source => window.webContents.executeJavaScript(source);
    await waitFor(() => js(`Boolean(document.querySelector('.file-actions .menu-trigger'))`));
    window.setSize(900, 620);
    const click = text => js(`[...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(text)}).click()`);
    await js(`document.querySelector('.file-actions .menu-trigger').click()`);
    await click('Open folder…');
    await waitFor(() => js(`document.querySelector('h1').textContent === 'First deck'`));
    await waitFor(() => js(`window.wetmytt.recentFolders().then(items => items.length === 1)`));
    // Open a second folder through the normal picker.
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [second] });
    await js(`window.wetmytt.open()`);
    await waitFor(() => js(`document.querySelector('h1').textContent === 'Second deck'`));
    await js(`document.querySelector('.file-actions .menu-trigger').click()`);
    await click('Open recent ⌄');
    await waitFor(() => js(`document.querySelectorAll('.recent-menu-list li').length === 2`));
    await js(`document.querySelectorAll('.recent-menu-list .recent-open')[1].click()`);
    await waitFor(() => js(`document.querySelector('h1').textContent === 'First deck'`));
    assert.equal((await js(`window.wetmytt.recentFolders()`))[0], await fs.realpath(first));
    await fs.rename(second, `${second}-moved`);
    await js(`document.querySelector('.file-actions .menu-trigger').click()`);
    await js(`document.querySelectorAll('.recent-menu-list .recent-open')[1].click()`);
    await waitFor(() => js(`Boolean(document.querySelector('[role=alert]'))`));
    assert.equal(await js(`document.querySelector('h1').textContent`), 'First deck');
    await js(`document.querySelector('.file-actions .menu-trigger').click()`);
    await click('Close project');
    await waitFor(() => js(`document.querySelectorAll('.recent-folders li').length === 2`));
    assert.equal(await js(`document.querySelector('.topbar').scrollWidth <= document.querySelector('.topbar').clientWidth`), true);
    assert.equal(await js(`(() => { const r = document.querySelector('.recent-folders').getBoundingClientRect(); return r.height >= 80 && r.bottom <= innerHeight; })()`), true);
    await js(`document.querySelector('.file-actions .menu-trigger').click()`);
    await js(`document.querySelector('.file-actions .menu-trigger').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
    assert.equal(await js(`document.activeElement.textContent`), 'New deck…');
    await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    assert.equal(await js(`document.activeElement.classList.contains('menu-trigger')`), true);
    if (process.env.WETMYTT_RECENT_SCREENSHOT) await fs.writeFile(process.env.WETMYTT_RECENT_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
    await js(`document.querySelector('.recent-remove').click()`);
    await waitFor(() => js(`document.querySelectorAll('.recent-folders li').length === 1`));
    await click('Clear recent folders');
    await waitFor(() => js(`document.querySelectorAll('.recent-folders li').length === 0`));
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'profile/recent-folders.json'), 'utf8')), []);
    assert.equal(Menu.getApplicationMenu().items.find(item => item.label === 'File').submenu.items.some(item => item.label === 'Open recent'), true);
    await js(`document.querySelector('.top-actions .menu-trigger').click()`);
    assert.equal(await js(`document.querySelector('[role=menu]').textContent.includes('Connect to Codex') && document.querySelector('[role=menu]').textContent.includes('Connect to Claude')`), true);
    console.log('Recent-folders integration passed: switching, missing folder, welcome list, removal, clearing, native menu, keyboard access, 900×620 layout, Connect menu.');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
}).catch(error => { console.error(error); app.exit(1); });
