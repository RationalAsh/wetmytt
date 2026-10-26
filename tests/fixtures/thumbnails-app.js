import { app, BrowserWindow, dialog, shell, nativeImage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createThumbnailRenderer } from '../../electron/screenshot.js';

const [directory] = process.argv.slice(2);
app.setPath('userData', path.join(directory, 'profile'));
app.setPath('sessionData', path.join(directory, 'profile'));
// Standalone render checks intentionally destroy their final window.
app.on('window-all-closed', () => {});
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
    // Pixel checks catch repeated captures even when encoded URLs differ.
    const staticRoot = path.join(directory, 'static');
    await fs.mkdir(staticRoot);
    await fs.writeFile(path.join(staticRoot, 'index.html'), `<html><head><style>
      html,body {margin:0;width:100%;height:100%} [data-slide] {width:100%;height:100%;position:relative}
      [hidden] {display:none!important} .reveal {position:absolute;inset:0;background:#000000;opacity:0;animation:enter 30s 30s forwards}
      @keyframes enter {to {opacity:1}} @keyframes pulse {to {transform:translateX(10px)}}
      .pulse {animation:pulse 1s infinite}
      canvas {width:100%;height:100%}
    </style></head><body>
      <section data-slide data-slide-id="entrance" style="background:red"><div class="reveal"></div><span class="pulse">Infinite</span></section>
      <section data-slide data-slide-id="hook"><canvas width="1280" height="720"></canvas><video></video></section>
      <section data-slide data-slide-id="failure"></section>
      <section data-slide data-slide-id="last" style="background:#ff0000"></section>
      <script>
        document.querySelector('.reveal').addEventListener('animationend', () => {
          const follow = document.createElement('div'); follow.className = 'reveal'; follow.style.background = '#00ff00';
          document.querySelector('[data-slide]').append(follow);
        }, { once: true });
        window.wetmyttPrepareThumbnail = async ({slide,id,context}) => {
          if (context !== 'thumbnail' || window.wetmyttContext !== 'thumbnail') throw Error('Missing thumbnail context');
          if (id === 'id:failure') throw Error('Intentional custom failure');
          if (id === 'id:hook') {
            await new Promise(resolve => setTimeout(resolve, 10));
            const canvas = slide.querySelector('canvas'), ctx = canvas.getContext('2d');
            ctx.fillStyle = '#0000ff'; ctx.fillRect(0,0,1280,720);
            slide.querySelector('video').poster = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"/>');
          }
        };
      </script>
    </body></html>`);
    const trace = [], started = Date.now();
    const renderer = createThumbnailRenderer(staticRoot, { revision: 7, trace: event => trace.push(event) });
    const pixel = png => [...nativeImage.createFromBuffer(png).toBitmap().subarray(0, 3)]; // BGRA
    try {
      const result = await renderer.capture(['entrance', 'hook', 'failure', 'last'].map((id, index) => ({ index, id: 'id:' + id })));
      assert.ok(pixel(result[0].image)[1] > 200, 'delayed entrance finishes without waiting a minute');
      assert.ok(pixel(result[1].image)[0] > 200, 'async hook draws a static blue canvas');
      assert.match(result[2].error, /Intentional custom failure/);
      assert.ok(pixel(result[3].image)[2] > 200, 'failed slide does not prevent subsequent red capture');
      const captures = trace.filter(event => event.phase === 'captured').length;
      const cached = await renderer.capture([{ index: 0, id: 'id:entrance' }]);
      assert.deepEqual(cached[0].image, result[0].image);
      assert.equal(trace.filter(event => event.phase === 'captured').length, captures, 'cache avoids capture');
      assert.equal(BrowserWindow.getAllWindows().length, 1, 'batches reuse one renderer');
      const mismatch = await renderer.capture([{ index: 3, id: 'id:entrance' }]);
      assert.match(mismatch[0].error, /identity changed/);
      console.log('Static thumbnail fixture:', JSON.stringify({ milliseconds: Date.now() - started, captures, memory: process.memoryUsage().rss }));
    } finally { await renderer.close(); }
    assert.equal(BrowserWindow.getAllWindows().length, 0, 'renderer closes after its revision');
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
    assert.equal(await js(`(async () => { const state = await window.wetmytt.state(); try { await window.wetmytt.thumbnails(state.root, state.generation, state.contentRevision, [{ index: -1, id: 'bad' }]); return false; } catch { return true; } })()`), true, 'invalid requests are rejected');
    // Hold captures in the readiness wait, then refresh the deck mid-request.
    // Expected cancellations must resolve quietly, rather than reject over IPC.
    await fs.writeFile(path.join(root, 'index.html'), '<html><body>Waiting for slides</body></html>');
    await waitFor(() => js(`document.querySelectorAll('.slide-thumbnail').length === 0`), 'empty deck refresh');
    await js(`void (async () => { const state = await window.wetmytt.state(); window.pendingThumbnail = window.wetmytt.thumbnails(state.root, state.generation, state.contentRevision, [{ index: 0, id: 'index:' + state.contentRevision + ':0' }]); })()`);
    await waitFor(() => BrowserWindow.getAllWindows().some(item => item !== window), 'capture in progress');
    await fs.writeFile(path.join(root, 'index.html'), html(2, '#dd7020'));
    assert.equal(await js(`window.pendingThumbnail`), null, 'refresh cancellation is a normal IPC response');
    await waitFor(() => js(`document.querySelectorAll('.slide-thumbnail img').length === 2`), 'capture recovery after cancellation');
    const colors = { red: '#ff0000', blue: '#0000ff', green: '#00ff00' };
    const ordered = order => `<html><body><style>html,body{margin:0;width:100%;height:100%}[data-slide]{width:100%;height:100%;background:var(--color)}[hidden]{display:none!important}</style>${order.map(id => `<section data-slide data-slide-id="${id}" style="--color:${colors[id]}"></section>`).join('')}</body></html>`;
    const verifyOrder = async order => {
      await waitFor(() => js(`(async () => { const state = await window.wetmytt.state(); return state.contentSettled && document.querySelector('[data-slide-thumbnails]')?.dataset.contentRevision === String(state.contentRevision) && document.querySelectorAll('.slide-thumbnail img').length === ${order.length}; })()`), 'settled ordered thumbnails');
      const urls = await js(`[...document.querySelectorAll('.slide-thumbnail img')].map(img => img.src)`);
      for (const [index, id] of order.entries()) {
        const channels = pixel(Buffer.from(urls[index].split(',')[1], 'base64'));
        assert.ok(channels[{ red: 2, blue: 0, green: 1 }[id]] > 200, `correct pixels for ${id} at ${index}: ${channels}`);
      }
    };
    for (const order of [['red', 'blue', 'green'], ['green', 'red', 'blue'], ['blue', 'green']]) {
      const before = await js(`(async () => (await window.wetmytt.state()).contentRevision)()`);
      await fs.writeFile(path.join(root, 'index.html'), ordered(order));
      await waitFor(() => js(`(async () => { const state = await window.wetmytt.state(); return state.contentSettled && state.contentRevision > ${before} && document.querySelector('[data-slide-thumbnails]')?.dataset.contentRevision === String(state.contentRevision) && document.querySelectorAll('.slide-thumbnail img').length === ${order.length}; })()`), 'new content revision');
      await verifyOrder(order);
      assert.ok(BrowserWindow.getAllWindows().length <= 2, 'edits retain at most one hidden renderer');
    }
    // Hold one revision inside a hook while HTML and asset saves replace it.
    await fs.writeFile(path.join(root, 'palette.css'), 'body { color: white }');
    await fs.writeFile(path.join(root, 'index.html'), ordered(['blue', 'green']).replace('<body>', '<head><link rel="stylesheet" href="palette.css"></head><body>').replace('</body>', `<script>window.wetmyttPrepareThumbnail = async () => { window.waitingThumbnail = true; await new Promise(resolve => setTimeout(resolve, 3000)); };</script></body>`));
    await waitFor(async () => {
      const hidden = BrowserWindow.getAllWindows().find(item => item !== window);
      return hidden && hidden.webContents.executeJavaScript('Boolean(window.waitingThumbnail)').catch(() => false);
    }, 'capture waiting in custom hook');
    await js(`void (async () => { const state = await window.wetmytt.state(); window.pendingThumbnail = window.wetmytt.thumbnails(state.root, state.generation, state.contentRevision, [{index:0,id:'id:blue'}, {index:1,id:'id:green'}]); })()`);
    await fs.writeFile(path.join(root, 'palette.css'), 'body { color: black }');
    await fs.writeFile(path.join(root, 'extra.json'), '{"updated":true}');
    await fs.writeFile(path.join(root, 'index.html'), ordered(['green', 'blue']));
    assert.equal(await js('window.pendingThumbnail'), null, 'multi-file saves cancel queued or running old revision');
    await verifyOrder(['green', 'blue']);
    // Legacy identity must also be scoped to a new revision on same-count edits.
    for (const order of [['red', 'green'], ['blue', 'red']]) {
      const before = await js(`(async () => (await window.wetmytt.state()).contentRevision)()`);
      await fs.writeFile(path.join(root, 'index.html'), ordered(order).replace(/ data-slide-id="[^"]+"/g, ''));
      await waitFor(() => js(`(async () => { const state = await window.wetmytt.state(); return state.contentSettled && state.contentRevision > ${before} && document.querySelector('[data-slide-thumbnails]')?.dataset.contentRevision === String(state.contentRevision) && document.querySelectorAll('.slide-thumbnail img').length === 2; })()`), 'legacy revision rebuilt');
      await verifyOrder(order);
    }
    await clickMenu('Close project');
    await waitFor(() => js(`!document.querySelector('.slide-thumbnails')`), 'project close');
    await clickMenu('Open folder…');
    await waitFor(() => js(`document.querySelectorAll('.slide-thumbnail img').length === 2`), 'project reopen');
    console.log('Thumbnail integration passed.');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
}).catch(error => { console.error(error); app.exit(1); });
