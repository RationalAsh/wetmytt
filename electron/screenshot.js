import { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { serveFolder } from './server.js';

// Called inside the running app; each capture gets an isolated hidden window.
export async function screenshotSlide(root, slide) {
  return (await screenshotSlides(root, [slide]))[0];
}

// A thumbnail batch shares one renderer and server, rather than loading the deck
// again for every slide. Callers can cancel a batch when the project changes.
export async function screenshotSlides(root, slides, { width = 1280, signal } = {}) {
  if (!Array.isArray(slides) || !slides.length || slides.some(slide => !Number.isSafeInteger(slide) || slide < 1)) throw new Error('Slide must be a positive integer, starting at 1.');
  signal?.throwIfAborted();
  let server, window, timer, timedOut = false;
  const capture = async () => {
    try {
      server = await serveFolder(root, { deck: true });
      if (timedOut) throw new Error('Slide screenshot timed out.');
      signal?.throwIfAborted();
      window = new BrowserWindow({
        width: 1280, height: 720, useContentSize: true, show: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: `screenshot-${randomUUID()}` },
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
      const images = [];
      for (const slide of slides) {
        signal?.throwIfAborted();
        await contents.executeJavaScript(`(async () => {
          const slide = ${slide};
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
        images.push(image.resize({ width, height: Math.round(width * 9 / 16) }).toPNG());
      }
      return images;
    } finally {
      if (window && !window.isDestroyed()) window.destroy();
      await server?.close();
    }
  };
  let rejectAbort;
  const cancelled = new Promise((_, reject) => { rejectAbort = reject; });
  const abort = () => {
    if (window && !window.isDestroyed()) window.destroy();
    rejectAbort(signal.reason);
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    return await Promise.race([capture(), cancelled, new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        if (window && !window.isDestroyed()) window.destroy();
        reject(new Error('Slide screenshot timed out after 25 seconds.'));
      }, 25000);
    })]);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
