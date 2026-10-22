import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { runTool } from './agent.js';

export const MCP_PORT = 43187;

export async function loadMcpToken(directory) {
  const filename = path.join(directory, 'mcp-token');
  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.writeFile(filename, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const token = (await fs.readFile(filename, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid saved MCP token. Remove mcp-token from the app data folder and restart.');
  await fs.chmod(filename, 0o600);
  return token;
}

function presentationServer(getDeck, bound, screenshotSlide) {
  const server = new McpServer({ name: 'wetmytt', version: '0.1.0' }, {
    instructions: 'Tools operate on the presentation open when this MCP session connected. Call get_presentation to identify it. If the presentation changes, reconnect before making further edits.',
  });
  const currentRoot = () => {
    const current = getDeck();
    if (current.generation !== bound.generation || current.root !== bound.root) throw new Error('The open presentation changed. Reconnect MCP to work with the new presentation.');
    if (!bound.root) throw new Error('Open a presentation in the app, then reconnect MCP.');
    return bound.root;
  };
  const tool = (name, description, inputSchema, callback) => server.registerTool(name, { description, inputSchema }, async args => {
    try { return await callback(args); }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
  tool('get_presentation', 'Identify this session’s presentation and whether it is still open.', {}, async () => ({
    content: [{ type: 'text', text: JSON.stringify({ root: bound.root ?? null, name: bound.root ? path.basename(bound.root) : null, current: getDeck().generation === bound.generation && getDeck().root === bound.root }) }],
  }));
  for (const [name, description, schema] of [
    ['list_files', 'List files in this session’s presentation.', {}],
    ['read_file', 'Read a presentation text file.', { path: z.string() }],
    ['write_file', 'Create or replace a presentation text file. Read before writing.', { path: z.string(), content: z.string() }],
  ]) tool(name, description, schema, async args => ({ content: [{ type: 'text', text: await runTool(currentRoot(), name, args) }] }));
  tool('screenshot_slide', 'Get a 1280×720 PNG of a slide without changing the visible preview. Slide numbers start at 1.', {
    slide: z.number().int().min(1),
  }, async ({ slide }) => {
    const png = await screenshotSlide(currentRoot(), slide);
    currentRoot();
    return { content: [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }] };
  });
  return server;
}

export async function startMcpServer({ getDeck, screenshotSlide, token, port = MCP_PORT }) {
  if (!token) throw new Error('MCP requires an access token.');
  const sessions = new Map();
  let origin, closing = false;
  const reject = (res, status, message) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
  };
  const expectedAuth = Buffer.from(`Bearer ${token}`);
  const httpServer = http.createServer(async (req, res) => {
    try {
      if (closing) return reject(res, 503, 'App is closing.');
      if (req.headers.host !== new URL(origin).host || (req.headers.origin !== undefined && req.headers.origin !== origin)) return reject(res, 403, 'Invalid host or origin.');
      const auth = Buffer.from(req.headers.authorization || '');
      if (auth.length !== expectedAuth.length || !timingSafeEqual(auth, expectedAuth)) return reject(res, 401, 'Invalid MCP access token.');
      if (req.url !== '/mcp') return reject(res, 404, 'Not found.');
      if (!['POST', 'GET', 'DELETE'].includes(req.method)) { res.setHeader('Allow', 'POST, GET, DELETE'); return reject(res, 405, 'Method not allowed.'); }
      res.setHeader('Cache-Control', 'no-store');
      const sid = req.headers['mcp-session-id'];
      if (sid) {
        const session = sessions.get(sid);
        if (!session) return reject(res, 404, 'Session not found. Reconnect MCP.');
        session.lastActive = Date.now();
        return await session.transport.handleRequest(req, res);
      }
      if (req.method !== 'POST') return reject(res, 400, 'Initialize an MCP session first.');
      if (!req.headers['content-type']?.startsWith('application/json')) return reject(res, 415, 'Expected application/json.');
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1_100_000) return reject(res, 413, 'Request exceeds 1.1 MB.');
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); }
      catch { return reject(res, 400, 'Invalid JSON.'); }
      if (!isInitializeRequest(body)) return reject(res, 400, 'Initialize an MCP session first.');
      if (sessions.size >= 32) return reject(res, 503, 'Too many MCP sessions. Disconnect unused clients.');
      const server = presentationServer(getDeck, { ...getDeck() }, screenshotSlide);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(), enableJsonResponse: true,
        onsessioninitialized: id => sessions.set(id, { transport, server, lastActive: Date.now() }),
      });
      await server.connect(transport);
      // Preserve the SDK's cleanup callback installed by connect().
      const onclose = transport.onclose;
      transport.onclose = () => { sessions.delete(transport.sessionId); onclose?.(); };
      try { await transport.handleRequest(req, res, body); }
      finally { if (!transport.sessionId) await server.close(); }
    } catch (error) {
      console.error('MCP request failed:', error.message);
      if (!res.headersSent) reject(res, 500, 'MCP request failed.');
      else res.end();
    }
  });
  httpServer.requestTimeout = 30000;
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${httpServer.address().port}`;
  // Clients may exit without DELETE; do not retain their sessions indefinitely.
  const sweep = setInterval(() => {
    for (const session of sessions.values()) {
      if (Date.now() - session.lastActive > 30 * 60 * 1000) void session.server.close().catch(error => console.error('MCP session cleanup:', error.message));
    }
  }, 60000);
  sweep.unref();
  return {
    url: `${origin}/mcp`,
    async close() {
      closing = true;
      clearInterval(sweep);
      await Promise.all([...sessions.values()].map(({ server }) => server.close()));
      const done = new Promise(resolve => httpServer.close(resolve));
      httpServer.closeAllConnections();
      await done;
    },
  };
}
