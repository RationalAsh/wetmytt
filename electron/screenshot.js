import { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { serveFolder } from './server.js';
import { prepareStaticSlide } from './static-slide.js';

// One owner per settled project revision. Navigation is serialized, and the
// bounded LRU contains only images whose readiness identity has been verified.
export function createThumbnailRenderer(root, { revision = '', width = 320, signal, cacheBytes = 16 * 1024 * 1024, trace = () => {} } = {}) {
  let server, window, closed = false, queue = Promise.resolve(), bytes = 0;
  const cache = new Map();
  const check = () => { signal?.throwIfAborted(); if (closed) throw new Error('Thumbnail renderer closed.'); };
  const reset = () => { if (window && !window.isDestroyed()) window.destroy(); window = undefined; };
  const close = async () => {
    closed = true; reset(); cache.clear(); bytes = 0;
    signal?.removeEventListener('abort', abort);
    await server?.close(); server = undefined;
  };
  const abort = () => { void close(); };
  signal?.addEventListener('abort', abort, { once: true });
  const start = async current => {
    current();
    if (window && !window.isDestroyed()) return window.webContents;
    server ??= await serveFolder(root, { deck: true });
    if (closed || signal?.aborted) { await server.close(); server = undefined; check(); }
    current();
    window = new BrowserWindow({
      width: 1280, height: 720, useContentSize: true, show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: `screenshot-${randomUUID()}` },
    });
    const contents = window.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', event => event.preventDefault());
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    const url = server.url;
    contents.session.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !details.url.startsWith(url) && !/^(data:|blob:)/.test(details.url) });
    });
    await window.loadURL(`${url}index.html?context=thumbnail&contentRevision=${encodeURIComponent(revision)}`);
    current();
    return contents;
  };
  const capture = async ({ index, id }) => {
    check();
    const key = JSON.stringify([revision, id, index, width]);
    if (cache.has(key)) {
      const value = cache.get(key); cache.delete(key); cache.set(key, value);
      return { index, id, revision, image: value };
    }
    let timer, rejectAbort, active = true;
    const current = () => { check(); if (!active) throw new Error('Thumbnail capture expired.'); };
    const token = randomUUID();
    const cancelled = new Promise((_, reject) => { rejectAbort = () => reject(signal.reason); });
    signal?.addEventListener('abort', rejectAbort, { once: true });
    try {
      return await Promise.race([(async () => {
        const contents = await start(current);
        trace({ phase: 'requested', revision, id, index, token });
        const ready = await contents.executeJavaScript(`(${prepareStaticSlide.toString()})(${index}, ${JSON.stringify({ context: 'thumbnail', revision: String(revision), id, token, timeout: 10000 })})`);
        current();
        if (ready.index !== index || ready.token !== token || ready.revision !== String(revision) || (id !== undefined && ready.id !== id)) throw new Error('Thumbnail readiness identity mismatch.');
        trace({ phase: 'ready', ...ready });
        const image = await contents.capturePage(undefined, { stayHidden: true, stayAwake: true });
        current();
        if (image.isEmpty()) throw new Error('Slide screenshot was empty.');
        const png = image.resize({ width, height: Math.round(width * 9 / 16) }).toPNG();
        if (png.length <= cacheBytes) {
          cache.set(key, png); bytes += png.length;
          while (bytes > cacheBytes) { const oldest = cache.keys().next().value; bytes -= cache.get(oldest).length; cache.delete(oldest); }
        }
        trace({ phase: 'captured', ...ready, bytes: png.length });
        return { index, id: ready.id, revision, image: png };
      })(), cancelled, new Promise((_, reject) => {
        timer = setTimeout(() => { active = false; reset(); reject(new Error('Slide screenshot timed out after 15 seconds.')); }, 15000);
      })]);
    } catch (error) { reset(); throw error; }
    finally { active = false; clearTimeout(timer); signal?.removeEventListener('abort', rejectAbort); }
  };
  return {
    close,
    capture(slides) {
      const operation = queue.then(async () => {
        const results = [];
        for (const slide of slides) {
          try { results.push(await capture(slide)); }
          catch (error) { check(); results.push({ ...slide, revision, error: error.message }); }
        }
        return results;
      });
      queue = operation.catch(() => {});
      return operation;
    },
  };
}

export async function screenshotSlide(root, slide, options) {
  return (await screenshotSlides(root, [slide], options))[0];
}

export async function screenshotSlides(root, slides, { width = 1280, signal } = {}) {
  if (!Array.isArray(slides) || !slides.length || slides.some(slide => !Number.isSafeInteger(slide) || slide < 1)) throw new Error('Slide must be a positive integer, starting at 1.');
  const renderer = createThumbnailRenderer(root, { width, signal });
  try {
    const results = await renderer.capture(slides.map(slide => ({ index: slide - 1 })));
    const failed = results.find(result => result.error);
    if (failed) throw new Error(failed.error);
    return results.map(result => result.image);
  } finally { await renderer.close(); }
}
