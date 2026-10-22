import { app, BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { serveFolder } from './server.js';

const [root, requestedSlide, directory] = process.argv.slice(2);
app.setPath('userData', directory);
app.setPath('sessionData', directory);
app.dock?.hide();

// Do not await whenReady at module scope: Electron waits for ESM evaluation.
app.whenReady().then(async () => {
  let server, window;
  try {
    server = await serveFolder(root, { deck: true });
    window = new BrowserWindow({
      width: 1280, height: 720, useContentSize: true, show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: 'screenshot' },
    });
    const contents = window.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', event => event.preventDefault());
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    // Keep all requests within this deck, including redirects and custom scripts.
    contents.session.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !details.url.startsWith(server.url) && !/^(data:|blob:)/.test(details.url) });
    });
    await window.loadURL(`${server.url}index.html`);
    await contents.executeJavaScript(`(async () => {
      const slide = ${Number(requestedSlide)};
      const ready = async () => {
        const deadline = Date.now() + 10000;
        while (!document.querySelector('[data-slide]')) {
          if (Date.now() > deadline) throw new Error('No slides found. Mark slide containers with data-slide and keep a closing </body> tag.');
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        const count = document.querySelectorAll('[data-slide]').length;
        if (slide > count) throw new Error('Slide ' + slide + ' does not exist. This deck has ' + count + ' slides.');
        await new Promise(resolve => {
          const listener = event => {
            if (event.source === window && event.data?.type === 'wetmytt:state' && event.data.index === slide - 1) {
              removeEventListener('message', listener);
              resolve();
            }
          };
          addEventListener('message', listener);
          window.postMessage({ type: 'wetmytt:navigate', index: slide - 1 }, location.origin);
        });
        const active = document.querySelectorAll('[data-slide]')[slide - 1];
        await Promise.all([...active.querySelectorAll('img')].map(image => image.decode().catch(() => {})));
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      };
      let timer;
      try {
        await Promise.race([ready(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Slide did not finish rendering within 10 seconds. Check the navigation bridge and local assets.')), 11000);
        })]);
      } finally { clearTimeout(timer); }
    })()`);
    const image = await contents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    if (image.isEmpty()) throw new Error('Slide screenshot was empty.');
    await fs.writeFile(path.join(directory, 'slide.png'), image.resize({ width: 1280, height: 720 }).toPNG());
  } catch (error) {
    await fs.writeFile(path.join(directory, 'error.txt'), error.message);
    process.exitCode = 1;
  } finally {
    window?.destroy();
    await server?.close();
    app.exit(process.exitCode || 0);
  }
});
