import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runTool } from './agent.js';
const root = path.resolve(process.argv[2] || '.');
await fs.access(path.join(root, 'index.html'));
const server = new McpServer({ name: 'decklet', version: '0.1.0' });
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
await server.connect(new StdioServerTransport());
