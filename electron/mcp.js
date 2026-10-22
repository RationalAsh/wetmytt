import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runTool } from './agent.js';
import { screenshotSlide } from './screenshot.js';
const root = path.resolve(process.argv[2] || '.');
await fs.access(path.join(root, 'index.html'));
const server = new McpServer({ name: 'wetmytt', version: '0.1.0' });
for (const [name, description, inputSchema] of [
  ['list_files', 'List presentation files.', {}],
  ['read_file', 'Read a presentation text file.', { path: z.string() }],
  ['write_file', 'Create or replace a presentation text file. Read before writing.', { path: z.string(), content: z.string() }],
]) {
  server.registerTool(name, { description, inputSchema }, async args => {
    try { return { content: [{ type: 'text', text: await runTool(root, name, args) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
}
server.registerTool('screenshot_slide', {
  description: 'Get a PNG screenshot of a slide at 1280×720. Slide numbers start at 1. Returns the image directly; does not change the app preview or write files into the deck.',
  inputSchema: { slide: z.number().int().min(1).describe('Slide number, starting at 1.') },
}, async ({ slide }) => {
  try {
    const png = await screenshotSlide(root, slide);
    return { content: [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error.message }] };
  }
});
await server.connect(new StdioServerTransport());
