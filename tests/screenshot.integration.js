import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Read the first pixel of Electron's RGB/RGBA PNG without another image dependency.
function inspectPNG(data) {
  const png = Buffer.from(data, 'base64');
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(png.readUInt32BE(16), 1280);
  assert.equal(png.readUInt32BE(20), 720);
  assert.equal(png[24], 8);
  assert.ok([2, 6].includes(png[25]));
  const chunks = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  // Every PNG filter has a zero predictor at the first pixel of the first row.
  return [...inflateSync(Buffer.concat(chunks)).subarray(1, 4)];
}

test('MCP screenshot tool captures requested slides, fresh edits, and the starter deck', { timeout: 90000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wetmytt-screenshot-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'deck');
  await fs.mkdir(root);
  // Simulate a custom renderer that creates slide containers after page load.
  await fs.writeFile(path.join(root, 'index.html'), `<html><body>
    <style>html,body { margin:0; width:100%; height:100% } [data-slide] { width:100%; height:100% } [hidden] { display:none!important }</style>
    <script>setTimeout(() => { document.body.insertAdjacentHTML('beforeend', '<section data-slide style="background:rgb(255,0,0)"></section><section data-slide style="background:rgb(0,255,0)"></section>'); }, 200);</script>
  </body></html>`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../electron/mcp.js', import.meta.url)), root],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'screenshot-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['list_files', 'read_file', 'screenshot_slide', 'write_file']);
  for (const [slide, dominantChannel] of [[2, 1], [1, 0]]) {
    const result = await client.callTool({ name: 'screenshot_slide', arguments: { slide } });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.equal(result.content[0].type, 'image');
    assert.equal(result.content[0].mimeType, 'image/png');
    // Captures retain the display's color profile (e.g. Display P3 on macOS).
    const pixel = inspectPNG(result.content[0].data);
    assert.ok(pixel[dominantChannel] > 200);
    assert.ok(pixel.every((value, channel) => channel === dominantChannel || value < pixel[dominantChannel] - 100));
  }
  const outOfRange = await client.callTool({ name: 'screenshot_slide', arguments: { slide: 3 } });
  assert.equal(outOfRange.isError, true);
  assert.match(outOfRange.content[0].text, /Slide 3 does not exist.*2 slides/);
  for (const slide of [0, -1, 1.5]) {
    const result = await client.callTool({ name: 'screenshot_slide', arguments: { slide } });
    assert.equal(result.isError, true);
  }
  assert.deepEqual(await fs.readdir(root), ['index.html']);
  await fs.cp(fileURLToPath(new URL('../templates/starter/', import.meta.url)), root, { recursive: true });
  const starter = await client.callTool({ name: 'screenshot_slide', arguments: { slide: 2 } });
  assert.ok(!starter.isError, JSON.stringify(starter));
  const background = inspectPNG(starter.content[0].data);
  assert.ok(background.every((value, channel) => Math.abs(value - [244, 242, 248][channel]) < 5));
});
