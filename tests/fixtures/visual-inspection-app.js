import { app, nativeImage } from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chat } from '../../electron/agent.js';
import { screenshotSlide } from '../../electron/screenshot.js';

const [directory] = process.argv.slice(2);
app.setPath('userData', directory);
app.setPath('sessionData', directory);
app.dock?.hide();
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const root = path.join(directory, 'deck');
  await fs.mkdir(root);
  const html = color => `<html><body style="margin:0"><section data-slide style="height:100vh;background:${color}">Slide inspection</section></body></html>`;
  await fs.writeFile(path.join(root, 'index.html'), html('red'));
  const shots = [];
  let requests = 0;
  const shot = id => ({ id, type: 'function', function: { name: 'screenshot_slide', arguments: '{"slide":1}' } });
  const reply = (content, tool_calls = []) => Response.json({ choices: [{ message: { content, tool_calls } }] });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url !== 'https://api.openai.com/v1/chat/completions') return originalFetch(url, options);
    const body = JSON.parse(options.body);
    requests++;
    if (requests === 1) return reply(null, [shot('before')]);
    if (requests === 3) return reply(null, [shot('after')]);
    const urlData = body.messages.at(-1).content[1].image_url.url;
    const image = nativeImage.createFromDataURL(urlData);
    assert.deepEqual(image.getSize(), { width: 1280, height: 720 });
    shots.push(urlData);
    // Sample away from the label. Electron bitmap bytes use BGRA on macOS.
    const pixel = image.crop({ x: 1000, y: 500, width: 1, height: 1 }).toBitmap();
    if (requests === 2) {
      assert.ok(pixel[2] > pixel[0] + 100, 'First screenshot should be red.');
      return reply('Correcting slide layout.', [{ id: 'edit', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'index.html', content: html('blue') }) } }]);
    }
    assert.ok(pixel[0] > pixel[2] + 100, 'Reinspection must show the blue edit.');
    return reply('Inspected the updated slide.');
  };
  const result = await chat({ root, settings: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'test', apiKey: 'test' }, history: [{ role: 'user', content: 'Inspect and fix the slide.' }], signal: new AbortController().signal, screenshotSlide });
  assert.equal(result.content, 'Inspected the updated slide.');
  assert.equal(requests, 4);
  assert.equal(shots.length, 2);
  assert.notEqual(shots[0], shots[1]);
  await assert.rejects(screenshotSlide(root, 2), /does not exist/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(screenshotSlide(root, 1, { signal: controller.signal }));
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
