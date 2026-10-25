import { app, BrowserWindow, dialog, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const [directory] = process.argv.slice(2);
app.setPath('userData', path.join(directory, 'profile'));
app.setPath('sessionData', path.join(directory, 'profile'));
app.whenReady().then(async () => {
  const root = path.join(directory, 'A presentation with a deliberately long name');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'deck.json'), '{}');
  const html = (count, color = '#5b38b8') => `<html><body><style>
    html,body { margin:0; width:100%; height:100%; font-family:Arial; }
    [data-slide] { height:100%; display:flex; align-items:center; justify-content:center; background:${color}; color:white; font-size:80px; }
    [hidden] { display:none!important; }
    </style>${Array.from({ length: count }, (_, index) => `<section data-slide>Slide ${index + 1}</section>`).join('')}</body></html>`;
  await fs.writeFile(path.join(root, 'index.html'), html(24));
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
  dialog.showErrorBox = (title, message) => { throw new Error(`${title}: ${message}`); };
  let revealed;
  shell.openPath = async target => { revealed = target; return ''; };
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 20000;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  try {
    await import('../../electron/main.js');
    let window;
    await waitFor(() => { window = BrowserWindow.getAllWindows().find(item => item.isVisible()); return window; }, 'app window');
    const js = source => window.webContents.executeJavaScript(source);
    const clickMenu = async text => {
      await js(`document.querySelector('.file-actions .menu-trigger').click()`);
      await js(`[...document.querySelectorAll('[role=menuitem]')].find(b => b.textContent === ${JSON.stringify(text)}).click()`);
    };
    await waitFor(() => js(`Boolean(document.querySelector('.file-actions .menu-trigger'))`), 'File menu');
    await clickMenu('Open folder…');
    await waitFor(() => js(`document.querySelectorAll('.slide-thumbnail').length === 24`), '24 thumbnails');
    await waitFor(() => js(`Boolean(document.querySelector('.slide-thumbnail img'))`), 'thumbnail capture');
    assert.equal(await js(`document.querySelector('.slide-thumbnail[aria-current=true]').dataset.index`), '0');
    assert.equal(await js(`document.querySelectorAll('.slide-thumbnail img').length < 24`), true, 'offscreen thumbnails are lazy');
    assert.equal(await js(`document.querySelector('.thumbnail-viewport').dataset.fadeRight`), 'true');
    const first = await js(`document.querySelector('.slide-thumbnail img').src`);
    await clickMenu('Show files');
    assert.equal(revealed, await fs.realpath(root));
    assert.equal(await js(`Boolean(document.querySelector('.deck-heading .folder-path'))`), false);

    await js(`document.querySelector('[aria-label="Scroll thumbnails right"]').click()`);
    await waitFor(() => js(`document.querySelector('.thumbnail-viewport').scrollLeft > 30`), 'chevron scroll');
    assert.equal(await js(`document.querySelector('.slide-thumbnail[aria-current=true]').dataset.index`), '0', 'scrolling does not change slides');
    await js(`(() => { const input = document.querySelector('.thumbnail-seeker'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '1000'); input.dispatchEvent(new Event('input', { bubbles:true })); })()`);
    await waitFor(() => js(`document.querySelector('.thumbnail-viewport').dataset.fadeRight === 'false'`), 'seek to end');
    await js(`document.querySelector('[data-index="23"]').click()`);
    await waitFor(() => js(`document.querySelector('.slide-thumbnail[aria-current=true]')?.dataset.index === '23'`), 'click navigation');
    await waitFor(() => js(`Boolean(document.querySelector('[data-index="23"] img'))`), 'last thumbnail capture');
    const preview = window.webContents.mainFrame.frames.find(item => item.url.includes('/index.html?revision='));
    assert.equal(await preview.executeJavaScript(`document.querySelectorAll('[data-slide]')[23].hidden`), false);
    await js(`document.querySelector('[data-index="23"]').dispatchEvent(new KeyboardEvent('keydown', { key:'Home', bubbles:true }))`);
    await waitFor(() => js(`document.querySelector('.slide-thumbnail[aria-current=true]')?.dataset.index === '0' && document.querySelector('.thumbnail-viewport').scrollLeft < 1`), 'keyboard navigation and active slide visibility');
    assert.equal(await js(`document.querySelector('.slide-thumbnail img').src`), first, 'scrolling reuses cached previews');
    if (process.env.WETMYTT_THUMBNAIL_SCREENSHOT) await fs.writeFile(process.env.WETMYTT_THUMBNAIL_SCREENSHOT, (await window.webContents.capturePage()).toPNG());

    window.setSize(900, 700);
    await waitFor(() => js(`innerWidth <= 900`), 'compact layout');
    assert.equal(await js(`document.querySelector('.deck-heading').scrollWidth <= document.querySelector('.deck-heading').clientWidth`), true, 'long title does not overflow');
    await js(`document.querySelector('[aria-label="Toggle sidebar"]').click()`);
    await waitFor(() => js(`getComputedStyle(document.querySelector('.sidebar')).display === 'none'`), 'sidebar toggle');
    await fs.writeFile(path.join(root, 'index.html'), html(2, '#dd7020'));
    await waitFor(() => js(`document.querySelectorAll('.slide-thumbnail').length === 2`), 'removed slides');
    await waitFor(() => js(`document.querySelector('.slide-thumbnail img')?.src !== ${JSON.stringify(first)} && Boolean(document.querySelector('.slide-thumbnail img'))`), 'fresh thumbnails');
    await waitFor(() => js(`document.querySelector('.thumbnail-seeker').disabled`), 'no overflow');
    assert.equal(await js(`document.querySelector('[aria-label="Scroll thumbnails right"]').disabled`), true);
    assert.equal(await js(`(async () => { const state = await window.wetmytt.state(); try { await window.wetmytt.thumbnails(state.root, state.generation, [-1]); return false; } catch { return true; } })()`), true, 'invalid requests are rejected');
    // Hold captures in the readiness wait, then refresh the deck mid-request.
    // Expected cancellations must resolve quietly, rather than reject over IPC.
    await fs.writeFile(path.join(root, 'index.html'), '<html><body>Waiting for slides</body></html>');
    await waitFor(() => js(`document.querySelectorAll('.slide-thumbnail').length === 0`), 'empty deck refresh');
    await js(`void (async () => { const state = await window.wetmytt.state(); window.pendingThumbnail = window.wetmytt.thumbnails(state.root, state.generation, [0]); })()`);
    await waitFor(() => BrowserWindow.getAllWindows().some(item => item !== window), 'capture in progress');
    await fs.writeFile(path.join(root, 'index.html'), html(2, '#dd7020'));
    assert.equal(await js(`window.pendingThumbnail`), null, 'refresh cancellation is a normal IPC response');
    await waitFor(() => js(`document.querySelectorAll('.slide-thumbnail img').length === 2`), 'capture recovery after cancellation');
    await clickMenu('Close project');
    await waitFor(() => js(`!document.querySelector('.slide-thumbnails')`), 'project close');
    await clickMenu('Open folder…');
    await waitFor(() => js(`document.querySelectorAll('.slide-thumbnail img').length === 2`), 'project reopen');
    console.log('Thumbnail integration passed.');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
}).catch(error => { console.error(error); app.exit(1); });
