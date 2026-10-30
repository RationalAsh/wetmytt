import { app, BrowserWindow, dialog } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const [directory] = process.argv.slice(2);
app.setPath('userData', path.join(directory, 'profile'));
app.setPath('sessionData', path.join(directory, 'profile'));
app.whenReady().then(async () => {
  const root = path.join(directory, 'deck');
  await fs.cp(path.resolve('templates/starter'), root, { recursive: true });
  const jsonPath = path.join(root, 'deck.json');
  const deck = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
  deck.slides[0].body = deck.slides[0].title;
  await fs.writeFile(jsonPath, JSON.stringify(deck, null, 2));
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
  dialog.showErrorBox = (title, message) => { throw new Error(`${title}: ${message}`); };
  const waitFor = async predicate => {
    const deadline = Date.now() + 15000;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error('Editor UI did not reach the expected state.');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  try {
    await import('../../electron/main.js');
    let window;
    await waitFor(() => { window = BrowserWindow.getAllWindows().find(item => item.isVisible()); return window; });
    const js = async source => { try { return await window.webContents.executeJavaScript(source); } catch (error) { console.error('Shell script failed:', source); throw error; } };
    const preview = async source => {
      const frame = window.webContents.mainFrame.frames.find(item => item.url.includes('/index.html?revision='));
      return frame?.executeJavaScript(source);
    };
    await waitFor(() => js(`Boolean([...document.querySelectorAll('button')].find(b => b.classList.contains('menu-trigger') && b.textContent.startsWith('File')))`));
    await js(`document.querySelector('.file-actions .menu-trigger').click()`);
    await js(`[...document.querySelectorAll('[role=menuitem]')].find(b => b.textContent === 'Open folder…').click()`);
    await waitFor(() => js(`Boolean(document.querySelector('textarea[data-path="/slides/0/title"]'))`));
    await waitFor(() => preview(`Boolean(document.querySelector('h1'))`));
    await preview(`document.querySelector('h1').click()`);
    await waitFor(() => js(`document.activeElement?.dataset.path === '/slides/0/title' && document.querySelector('#edit-tab').getAttribute('aria-selected') === 'true'`));
    assert.equal(await preview(`document.querySelector('h1').hasAttribute('data-wetmytt-selected')`), true);
    assert.equal(await preview(`document.querySelector('p').hasAttribute('data-wetmytt-selected')`), false, 'duplicate text must use the exact pointer');
    if (process.env.WETMYTT_EDIT_SCREENSHOT) await fs.writeFile(process.env.WETMYTT_EDIT_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
    await preview(`document.querySelector('h1').removeAttribute('data-json-path'); document.querySelector('p').removeAttribute('data-json-path'); document.querySelector('p').click()`);
    await waitFor(() => js(`document.querySelector('#edit-panel').textContent.includes('no unique match')`));
    assert.equal(await preview(`document.querySelector('p').hasAttribute('data-wetmytt-selected')`), true);
    await preview(`document.querySelector('h1').dataset.jsonPath = '/slides/0/title'; document.querySelector('p').dataset.jsonPath = '/slides/0/body'; document.querySelector('h1').click()`);
    await waitFor(() => js(`document.activeElement?.dataset.path === '/slides/0/title'`));
    const setText = async value => js(`(() => { const input = document.querySelector('textarea[data-path="/slides/0/title"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await setText('Edited title\nfrom the sidebar');
    await waitFor(() => js(`Boolean([...document.querySelectorAll('button')].find(b => b.textContent === 'Save text'))`));
    await js(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Save text').click()`);
    await waitFor(async () => JSON.parse(await fs.readFile(jsonPath, 'utf8')).slides[0].title === 'Edited title\nfrom the sidebar');
    assert.equal(JSON.parse(await fs.readFile(jsonPath, 'utf8')).slides[0].body, deck.slides[0].body);
    await waitFor(() => preview(`document.querySelector('h1')?.textContent === ${JSON.stringify('Edited title\nfrom the sidebar')}`));
    await waitFor(() => preview(`document.querySelector('h1')?.hasAttribute('data-wetmytt-selected')`));
    // Old decks without explicit bindings still map unique text.
    await preview(`document.querySelector('h1').removeAttribute('data-json-path'); document.querySelector('h1').click()`);
    await waitFor(() => js(`document.activeElement?.dataset.path === '/slides/0/title'`));
    await js(`document.querySelector('[aria-label="Toggle sidebar"]').click()`);
    await preview(`document.querySelector('h1').click()`);
    await waitFor(() => js(`getComputedStyle(document.querySelector('.sidebar')).display !== 'none'`));
    await setText('Unsaved local draft');
    const external = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
    external.slides[0].body = 'Changed by an external editor';
    await fs.writeFile(jsonPath, JSON.stringify(external, null, 2));
    await new Promise(resolve => setTimeout(resolve, 500));
    await js(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Save text').click()`);
    await waitFor(() => js(`document.querySelector('#edit-panel [role="alert"]')?.textContent.includes('changed on disk')`));
    assert.equal(JSON.parse(await fs.readFile(jsonPath, 'utf8')).slides[0].body, external.slides[0].body);
    assert.equal(await js(`document.querySelector('textarea[data-path="/slides/0/title"]').value`), 'Unsaved local draft');
    await js(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Discard edits & reload').click()`);
    await waitFor(() => js(`document.querySelector('textarea[data-path="/slides/0/body"]').value === 'Changed by an external editor'`));
    await js(`document.querySelector('[aria-label="Present"]').click()`);
    await waitFor(() => preview(`!document.querySelector('[data-wetmytt-selected]')`));
    console.log('Edit integration passed: selection, duplicate text, field focus, saving, preview refresh, fallback mapping, sidebar reopening, external conflict, reload, presentation mode.');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
}).catch(error => { console.error(error); app.exit(1); });
