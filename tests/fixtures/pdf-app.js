import { app, BrowserWindow, dialog } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName } from 'pdf-lib';
import { exportDeckPDF } from '../../electron/pdf.js';

const [directory, output] = process.argv.slice(2);
app.setPath('userData', path.join(directory, 'profile'));
app.setPath('sessionData', path.join(directory, 'profile'));
app.whenReady().then(async () => {
const root = path.join(directory, 'deck');
await fs.mkdir(root, { recursive: true });
let cancel = false, saves = 0;
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
dialog.showSaveDialog = async () => { saves++; return { canceled: cancel, filePath: path.join(output, 'vector-deck.pdf') }; };
dialog.showErrorBox = (title, message) => { throw new Error(`${title}: ${message}`); };

const waitFor = async predicate => {
  const deadline = Date.now() + 25000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('App UI did not reach the expected state.');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};
const writeDeck = async (width, height, broken = false) => {
  await fs.writeFile(path.join(root, 'background.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><rect width="30" height="30" fill="#ff8800"/></svg>');
  await fs.writeFile(path.join(root, 'index.html'), `<!doctype html><html><head><title>Vector export</title><style>
    html,body,#slides {margin:0; width:100%;height:100%;background:#123456}
    [data-slide] {width:${width};height:${height};position:relative;box-sizing:border-box;color:white;background:#123456;font:32px Arial}
    [hidden] {display:none!important} h1{margin:0;font-size:7vw} footer{position:absolute;bottom:0;right:0;font-size:24px}
    @media print { [data-slide] {display:none!important} }
  </style></head><body><main id="slides"></main><script>
    setTimeout(() => { document.querySelector('#slides').innerHTML = ${JSON.stringify(`<section data-slide><h1>Selectable vector title</h1><svg width="120" height="120" viewBox="0 0 120 120"><circle cx="60" cy="60" r="50" fill="#ddf875"/></svg><footer>EDGE ONE</footer></section><section data-slide style="background:#552266"><h1>Second slide</h1><div style="width:30px;height:30px;background-image:url('background.svg')"></div><img loading="lazy" src="${broken ? 'missing.svg' : 'background.svg'}"><footer>EDGE TWO</footer></section>`)}; }, 150);
  </script></body></html>`);
};

try {
  await fs.mkdir(output, { recursive: true });
  await writeDeck('100%', '100%');
  await import('../../electron/main.js');
  await app.whenReady();
  let window;
  await waitFor(() => { window = BrowserWindow.getAllWindows().find(item => item.isVisible()); return window; });
  const js = source => window.webContents.executeJavaScript(source);
  await waitFor(() => js(`Boolean([...document.querySelectorAll('button')].find(b => b.textContent === 'Open folder'))`));
  await js(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Open folder').click()`);
  await waitFor(() => js(`Boolean(document.querySelector('iframe'))`));
  const exportClick = async () => {
    await waitFor(() => js(`Boolean([...document.querySelectorAll('button')].find(b => b.textContent === 'Export PDF' && !b.disabled))`));
    await js(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Export PDF').click()`);
    await waitFor(() => js(`Boolean([...document.querySelectorAll('button')].find(b => b.textContent === 'Export PDF' && !b.disabled))`));
  };
  await exportClick();
  assert.equal(saves, 1);
  assert.match(await js(`document.body.textContent`), /Exported 2 slides/);
  const target = path.join(output, 'vector-deck.pdf');
  const original = await fs.readFile(target);
  const pdf = await PDFDocument.load(original);
  assert.equal(pdf.getPageCount(), 2);
  for (const page of pdf.getPages()) {
    assert.ok(Math.abs(page.getWidth() - 960) < 1);
    assert.ok(Math.abs(page.getHeight() - 540) < 1);
    assert.ok(page.node.Resources().lookup(PDFName.of('Font')).keys().length > 0, 'text must remain PDF font objects');
  }
  cancel = true;
  await exportClick();
  assert.deepEqual(await fs.readFile(target), original);
  cancel = false;
  await writeDeck('100%', '100%', true);
  await exportClick();
  assert.match(await js(`document.querySelector('[role=alert]').textContent`), /decode|asset|load/i);
  assert.deepEqual(await fs.readFile(target), original, 'failure must not overwrite an existing PDF');
  assert.equal(BrowserWindow.getAllWindows().length, 1, 'export windows must be destroyed');
  await writeDeck('100%', '100%');
  const htmlPath = path.join(root, 'index.html');
  const html = await fs.readFile(htmlPath, 'utf8');
  await fs.writeFile(htmlPath, html.replace('<style>', '<style>@font-face {font-family:ExportFont;src:url(missing.woff2)}').replace('font:32px Arial', 'font:32px ExportFont'));
  await exportClick();
  assert.match(await js(`document.querySelector('[role=alert]').textContent`), /font|asset/i);
  assert.deepEqual(await fs.readFile(target), original, 'a failed font must not overwrite the PDF');
  const starter = await exportDeckPDF(path.resolve('templates/starter'));
  await fs.writeFile(path.join(output, 'starter-deck.pdf'), starter.bytes);
  assert.equal(starter.pages, JSON.parse(await fs.readFile('templates/starter/deck.json', 'utf8')).slides.length);
  console.log('PDF integration passed: actual app UI, vector fonts, dimensions, cancellation, failed assets, cleanup and starter deck.');
  app.exit(0);
} catch (error) { console.error(error); app.exit(1); }

}).catch(error => { console.error(error); app.exit(1); });
