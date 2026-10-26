import { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { serveFolder } from './server.js';
import { prepareStaticSlide } from './static-slide.js';

// Print the live DOM, one slide at a time. Combining PDF pages preserves text,
// fonts, paths and SVGs; capturePage must never be used in this export path.
export async function exportDeckPDF(root) {
  let server, window, timer;
  const render = async () => {
    server = await serveFolder(root, { deck: true });
    window = new BrowserWindow({
      width: 1280, height: 720, useContentSize: true, show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
        backgroundThrottling: false, partition: `pdf-${randomUUID()}` },
    });
    const contents = window.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', event => event.preventDefault());
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    const failures = new Set();
    contents.session.webRequest.onBeforeRequest((details, callback) => {
      const allowed = details.url.startsWith(server.url) || /^(data:|blob:)/.test(details.url);
      if (!allowed) failures.add(details.url);
      callback({ cancel: !allowed });
    });
    contents.session.webRequest.onCompleted(details => {
      if (details.statusCode >= 400 && !details.url.endsWith('/favicon.ico')) failures.add(details.url);
    });
    contents.session.webRequest.onErrorOccurred(details => {
      if (!details.url.endsWith('/favicon.ico')) failures.add(details.url);
    });
    // Use screen styles, even for decks with their own printer styles. Each
    // page retains the presentation viewport (vw/vh and container units).
    await window.loadURL(`${server.url}index.html`);
    contents.debugger.attach('1.3');
    await contents.debugger.sendCommand('Emulation.setEmulatedMedia', { media: 'screen' });

    const pdf = await PDFDocument.create();
    let count;
    for (let index = 0; count === undefined || index < count; index++) {
      const page = await contents.executeJavaScript(`(${prepareStaticSlide.toString()})(${index})`);
      count ??= page.count;
      if (page.count !== count) throw new Error('Slides changed during export. Please try again.');
      if (failures.size) throw new Error('PDF export could not load an asset: ' + [...failures][0]);
      const css = await contents.insertCSS(`
        @page { size: 1280px 720px; margin: 0; }
        html { width: 1280px !important; height: 720px !important; overflow: hidden !important; }
        *, *::before, *::after { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
      `);
      try {
        const bytes = await contents.printToPDF({
          printBackground: true, displayHeaderFooter: false, preferCSSPageSize: true,
          pageSize: { width: 1280 / 96, height: 720 / 96 },
          margins: { top: 0, bottom: 0, left: 0, right: 0 }, scale: 1, pageRanges: '1',
        });
        const single = await PDFDocument.load(bytes);
        const [copied] = await pdf.copyPages(single, [0]);
        pdf.addPage(copied);
      } finally { await contents.removeInsertedCSS(css); }
    }
    pdf.setTitle(await contents.getTitle());
    pdf.setCreator('Welcome to My TED Talk');
    return { bytes: Buffer.from(await pdf.save()), pages: count };
  };
  try {
    return await Promise.race([render(), new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (window && !window.isDestroyed()) window.destroy();
        reject(new Error('PDF export timed out after 120 seconds. Check the deck and its local assets.'));
      }, 120000);
    })]);
  } finally {
    clearTimeout(timer);
    if (window && !window.isDestroyed()) window.destroy();
    await server?.close();
  }
}
