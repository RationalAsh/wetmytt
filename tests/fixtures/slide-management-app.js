import { app, BrowserWindow, dialog } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { exportDeckPDF } from '../../electron/pdf.js';

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
    const js = async source => { if (process.env.WETMYTT_MANAGE_TRACE) console.log('Shell:', source.slice(0, 120)); try { return await window.webContents.executeJavaScript(source); } catch (error) { console.error('Shell script failed:', source); throw error; } };
    const preview = async source => {
      if (process.env.WETMYTT_MANAGE_TRACE) console.log('Preview:', source.slice(0, 120));
      const frame = window.webContents.mainFrame.frames.find(item => item.url.includes('/index.html?revision='));
      // An iframe can be replaced between discovery and evaluation during reload.
      // Bound each poll so a destroyed frame cannot stall the entire test.
      let timer;
      try {
        return await Promise.race([
          frame?.executeJavaScript(source).catch(() => undefined),
          new Promise(resolve => { timer = setTimeout(resolve, 1000); }),
        ]);
      } finally { clearTimeout(timer); }
    };
    await waitFor(() => js(`Boolean([...document.querySelectorAll('button')].find(b => b.classList.contains('menu-trigger') && b.textContent.startsWith('File')))`));
    await js(`document.querySelector('.file-actions .menu-trigger').click()`);
    await js(`[...document.querySelectorAll('[role=menuitem]')].find(b => b.textContent === 'Open folder…').click()`);
    const ready = async count => waitFor(() => js(`document.querySelectorAll('.slide-thumbnail').length === ${count} && Boolean(document.querySelector('.thumbnail-actions:not(:disabled)'))`));
    const read = async () => JSON.parse(await fs.readFile(jsonPath, 'utf8'));
    const action = async (index, label) => {
      if (process.env.WETMYTT_MANAGE_TRACE) console.log('Slide action:', index, label);
      await js(`document.querySelectorAll('.thumbnail-actions')[${index}].click()`);
      await waitFor(() => js(`Boolean(document.querySelector('.slide-action-menu'))`));
      await js(`[...document.querySelectorAll('.slide-action-menu button')].find(b => b.textContent === ${JSON.stringify(label)}).click()`);
    };
    const selected = async id => waitFor(() => js(`document.querySelector('.slide-thumbnail[aria-current=true]')?.dataset.slideId === ${JSON.stringify('id:' + id)}`));
    await ready(3);
    assert.equal(await js(`Boolean(document.querySelector('textarea[data-path="/slides/0/id"]'))`), false);
    const original = await read();
    // Keyboard menu navigation and Escape return focus to the trigger.
    await js(`document.querySelector('.thumbnail-actions').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
    await waitFor(() => js(`document.activeElement?.textContent === 'Duplicate'`));
    await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
    assert.equal(await js(`document.activeElement.textContent`), 'Delete…');
    await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    assert.equal(await js(`document.activeElement.getAttribute('aria-label')`), 'Manage slide 1');
    if (process.env.WETMYTT_MANAGE_SCREENSHOT) {
      await waitFor(() => js(`document.querySelectorAll('.slide-thumbnail img').length === 3`));
      await js(`document.querySelector('.thumbnail-actions').click()`);
      await fs.writeFile(process.env.WETMYTT_MANAGE_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
      await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    }
    // Duplicate inserts and selects a fresh ID, then moves retain that selection.
    await action(0, 'Duplicate');
    await ready(4);
    const copied = (await read()).slides[1];
    assert.notEqual(copied.id, original.slides[0].id);
    assert.deepEqual(copied, { ...original.slides[0], id: copied.id });
    await selected(copied.id);
    await waitFor(() => js(`document.activeElement?.dataset.slideId === ${JSON.stringify('id:' + copied.id)}`));
    await action(1, 'Move later');
    await ready(4); await selected(copied.id);
    assert.equal((await read()).slides[2].id, copied.id);
    await action(2, 'Move earlier');
    await ready(4); await selected(copied.id);
    assert.equal((await read()).slides[1].id, copied.id);
    // Both presentation navigation and the actual PDF printing loop use saved array order.
    const orderedIds = (await read()).slides.map(slide => slide.id);
    for (let index = 0; index < orderedIds.length; index++) {
      await js(`document.querySelectorAll('.slide-thumbnail')[${index}].click()`);
      await waitFor(() => preview(`document.querySelector('[data-slide]:not([hidden])')?.dataset.slideId === ${JSON.stringify(orderedIds[index])}`));
    }
    await js(`document.querySelectorAll('.slide-thumbnail')[1].click()`);
    await selected(copied.id);
    const printedIds = [];
    const inspectPrint = (_event, window) => {
      const print = window.webContents.printToPDF.bind(window.webContents);
      window.webContents.printToPDF = async options => {
        printedIds.push(await window.webContents.executeJavaScript(`document.querySelector('[data-slide]:not([hidden])').dataset.slideId`));
        return print(options);
      };
    };
    app.on('browser-window-created', inspectPrint);
    try {
      if (process.env.WETMYTT_MANAGE_TRACE) console.log('Export reordered slides');
      const pdf = await exportDeckPDF(root);
      if (process.env.WETMYTT_MANAGE_TRACE) console.log('Export complete');
      assert.deepEqual(printedIds, orderedIds);
      assert.equal((await PDFDocument.load(pdf.bytes)).getPageCount(), orderedIds.length);
    } finally { app.removeListener('browser-window-created', inspectPrint); }
    // Cancel confirmation keeps the complete saved deck unchanged.
    await action(1, 'Delete…');
    await waitFor(() => js(`document.querySelector('.slide-delete-dialog').open`));
    const beforeCancel = await fs.readFile(jsonPath, 'utf8');
    await js(`[...document.querySelectorAll('.slide-delete-dialog button')].find(b => b.textContent === 'Cancel').click()`);
    assert.equal(await fs.readFile(jsonPath, 'utf8'), beforeCancel);
    await action(1, 'Delete…');
    await waitFor(() => js(`document.querySelector('.slide-delete-dialog').open`));
    await js(`[...document.querySelectorAll('.slide-delete-dialog button')].find(b => b.textContent === 'Delete slide').click()`);
    await ready(3); await selected(original.slides[1].id);
    // The selected second slide now has the correct index-based text binding.
    await waitFor(() => preview(`document.querySelector('[data-slide]:not([hidden]) h1')?.dataset.jsonPath === '/slides/1/title'`));
    await preview(`document.querySelector('[data-slide]:not([hidden]) h1').click()`);
    await waitFor(() => js(`document.activeElement?.dataset.path === '/slides/1/title'`));
    await js(`(() => { const input = document.querySelector('textarea[data-path="/slides/1/title"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Draft title'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor(() => js(`[...document.querySelectorAll('.thumbnail-actions')].every(b => b.disabled)`));
    assert.ok(await js(`document.querySelector('.slide-management-status').textContent.includes('Save or discard')`));
    await js(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Save text').click()`);
    await ready(3);
    assert.equal((await read()).slides.find(s => s.id === original.slides[1].id).title, 'Draft title');
    // Non-selected deletion preserves the selected ID; the last slide cannot be deleted.
    await action(0, 'Delete…');
    await waitFor(() => js(`document.querySelector('.slide-delete-dialog').open`));
    await js(`[...document.querySelectorAll('.slide-delete-dialog button')].find(b => b.textContent === 'Delete slide').click()`);
    await ready(2); await selected(original.slides[1].id);
    await action(1, 'Delete…');
    await waitFor(() => js(`document.querySelector('.slide-delete-dialog').open`));
    await js(`[...document.querySelectorAll('.slide-delete-dialog button')].find(b => b.textContent === 'Delete slide').click()`);
    await ready(1); await selected(original.slides[1].id);
    await js(`document.querySelector('.thumbnail-actions').click()`);
    assert.equal(await js(`[...document.querySelectorAll('.slide-action-menu button')].find(b => b.textContent === 'Delete…').disabled`), true);
    await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    // Stale revision requests and stale JSON sources cannot change the file.
    const snapshot = await js(`window.wetmytt.state()`);
    const prior = await fs.readFile(jsonPath, 'utf8');
    const external = await read(); external.slides[0].body = 'External update';
    await fs.writeFile(jsonPath, JSON.stringify(external, null, 2));
    await ready(1);
    assert.equal(await js(`(async () => { try { await window.wetmytt.mutateSlide(${JSON.stringify(snapshot.root)}, ${snapshot.generation}, ${snapshot.contentRevision}, ${JSON.stringify(prior)}, ${JSON.stringify(['id:' + external.slides[0].id])}, { type: 'duplicate', id: ${JSON.stringify(external.slides[0].id)} }); return false; } catch { return true; } })()`), true);
    assert.equal((await read()).slides.length, 1);
    await waitFor(() => preview(`document.querySelector('[data-slide] .body')?.textContent === 'External update'`));
    await ready(1);
    await preview(`document.querySelector('[data-slide]').dataset.slideId = 'wrong-id'`);
    await js(`document.querySelector('.slide-thumbnail').click()`);
    await waitFor(() => js(`document.querySelector('.slide-management-status')?.textContent.includes('do not match')`));
    assert.equal(await js(`document.querySelector('.thumbnail-actions').disabled`), true);
    await preview(`document.querySelector('[data-slide]').dataset.slideId = ${JSON.stringify(external.slides[0].id)}`);
    await js(`document.querySelector('.slide-thumbnail').click()`);
    await ready(1);
    // Legacy/custom HTML stays viewable while structural controls are unavailable.
    delete external.wetmytt;
    await fs.writeFile(jsonPath, JSON.stringify(external));
    await waitFor(() => js(`document.querySelector('.slide-management-status')?.textContent.includes('not opted in')`));
    await waitFor(() => preview(`document.querySelectorAll('[data-slide]').length === 1`));
    await waitFor(() => js(`document.querySelectorAll('.thumbnail-actions').length === 1 && document.querySelector('.thumbnail-actions').disabled`));
    // Switching deck generations rejects outstanding requests from the previous deck.
    const old = await js(`window.wetmytt.state()`);
    await js(`window.wetmytt.close()`);
    assert.equal(await js(`(async () => { try { await window.wetmytt.readSlideManagement(${JSON.stringify(old.root)}, ${old.generation}, ${old.contentRevision}); return false; } catch { return true; } })()`), true);
    console.log('Slide management integration passed.');
    app.exit(0);
  } catch (error) {
    const window = BrowserWindow.getAllWindows().find(item => item.isVisible());
    if (window) {
      console.error(await window.webContents.executeJavaScript(`JSON.stringify({ focus: document.activeElement?.outerHTML.slice(0, 300), dialogs: [...document.querySelectorAll('dialog')].map(d => d.open), status: document.querySelector('.slide-management-status')?.textContent, alert: document.querySelector('[role=alert]')?.textContent, fields: document.querySelectorAll('textarea').length, selected: document.querySelector('.slide-thumbnail[aria-current=true]')?.dataset.slideId, editPanel: document.querySelector('#edit-panel')?.textContent.slice(0, 400) })`));
    }
    console.error(error); app.exit(1);
  }
}).catch(error => { console.error(error); app.exit(1); });
