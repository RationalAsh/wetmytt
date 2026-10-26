import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { runTool, presentationTools } from './tools.js';
import { agentLongDescription } from './agent-metadata.js';
import { presentationGuidance } from './presentation-guidance.js';

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

function presentationServer(getDeck, binding, screenshotSlide, sessionSignal, listRecentPresentations, openPresentation, createPresentation) {
  const server = new McpServer({ name: 'wetmytt', version: '0.1.0' }, {
    instructions: `${agentLongDescription}\n\nCall get_presentation before working to select and identify the open presentation, use list_recent_presentations and open_presentation to choose one, or use create_presentation to create and select a new one. If the presentation changes outside this session, call get_presentation again before making further edits; no reconnect is needed.`,
  });
  const currentRoot = (bound) => {
    const current = getDeck();
    if (current.generation !== bound.generation || current.root !== bound.root) throw new Error('The open presentation changed. Call get_presentation to select the current presentation, then retry.');
    if (!bound.root) throw new Error('Open a presentation in the app, then call get_presentation.');
    return bound.root;
  };
  const tool = (name, description, inputSchema, callback) => server.registerTool(name, { description, inputSchema }, async (args, extra) => {
    try { return await callback(args, AbortSignal.any([sessionSignal, extra.signal])); }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
  const selectPresentation = () => {
    const current = getDeck();
    if (current.generation !== binding.deck.generation || current.root !== binding.deck.root) {
      binding.controller.abort(new Error('The open presentation changed. Call get_presentation, then retry.'));
      binding.deck = { ...current };
      binding.controller = new AbortController();
    }
    return { content: [{ type: 'text', text: JSON.stringify({ root: current.root ?? null, name: current.root ? path.basename(current.root) : null, current: true }) }, { type: 'text', text: presentationGuidance }] };
  };
  tool('get_presentation', 'Select and identify the currently open presentation for subsequent tool calls. Returns authoring guidance; read AGENTS.md if present before editing. Call again after opening or switching presentations.', {}, selectPresentation);
  tool('list_recent_presentations', 'List up to ten recently opened presentations, newest first, with absolute folder paths. Works even when no presentation is open; entries may have moved or become unavailable.', {}, async () => {
    const current = getDeck();
    const folders = await listRecentPresentations();
    return { content: [{ type: 'text', text: JSON.stringify(folders.map(root => ({ root, name: path.basename(root), current: root === current.root }))) }] };
  });
  tool('open_presentation', 'Open an existing presentation folder in the app and select it for subsequent tools in this session. Accepts an absolute folder path from recent presentations or the user. Switches the visible presentation and cancels pending operations on the previous one.', {
    path: z.string().min(1).refine(value => path.isAbsolute(value), 'Expected an absolute presentation folder path.'),
  }, async ({ path: folder }, signal) => {
    signal.throwIfAborted();
    await openPresentation(folder, signal);
    return selectPresentation();
  });
  tool('create_presentation', 'Create a new presentation from the app’s starter template at the specified absolute folder path, open it in the app, and select it for subsequent tools in this session. Works with no presentation open. The parent directory must exist and the destination must not exist, even as an empty folder. Includes local Git history and authoring guidance. Switches the visible presentation and cancels pending operations on the previous one.', {
    path: z.string().min(1).refine(value => path.isAbsolute(value), 'Expected an absolute presentation folder path.'),
  }, async ({ path: folder }, signal) => {
    signal.throwIfAborted();
    await createPresentation(folder, signal);
    return selectPresentation();
  });
  const presentationTool = (name, description, schema, callback) => tool(name, description, schema, async (args, sessionSignal) => {
    // Capture this binding for the whole call. Selecting another presentation
    // must never redirect a queued or in-flight operation into its folder.
    const bound = binding.deck;
    const root = currentRoot(bound);
    const signal = AbortSignal.any([sessionSignal, binding.controller.signal]);
    signal.throwIfAborted();
    const result = await callback(root, args, signal);
    signal.throwIfAborted();
    currentRoot(bound);
    return result;
  });
  for (const { name, description, schema } of presentationTools) {
    presentationTool(name, description, schema.shape, async (root, args, signal) => ({
      content: [{ type: 'text', text: await runTool(root, name, args, signal) }],
    }));
  }
  presentationTool('screenshot_slide', 'Get a 1280×720 PNG of a slide without changing the visible preview. Slide numbers start at 1.', {
    slide: z.number().int().min(1),
  }, async (root, { slide }) => {
    const png = await screenshotSlide(root, slide);
    return { content: [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }] };
  });
  return server;
}

export async function startMcpServer({ getDeck, screenshotSlide, listRecentPresentations = () => [], openPresentation = async () => { throw new Error('Opening presentations is unavailable.'); }, createPresentation = async () => { throw new Error('Creating presentations is unavailable.'); }, token, port = MCP_PORT }) {
  if (!token) throw new Error('MCP requires an access token.');
  const sessions = new Map();
  const controllers = new Set();
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
      const controller = new AbortController();
      controllers.add(controller);
      const binding = { deck: { ...getDeck() }, controller: new AbortController() };
      const server = presentationServer(getDeck, binding, screenshotSlide, controller.signal, listRecentPresentations, openPresentation, createPresentation);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(), enableJsonResponse: true,
        onsessioninitialized: id => sessions.set(id, { transport, server, binding, controller, lastActive: Date.now() }),
      });
      await server.connect(transport);
      // Preserve the SDK's cleanup callback installed by connect().
      const onclose = transport.onclose;
      transport.onclose = () => { controller.abort(); controllers.delete(controller); sessions.delete(transport.sessionId); onclose?.(); };
      try { await transport.handleRequest(req, res, body); }
      finally { if (!transport.sessionId) { controller.abort(); controllers.delete(controller); await server.close(); } }
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
    cancelStaleSessions() {
      const current = getDeck();
      for (const { binding } of sessions.values()) {
        if (binding.deck.root !== current.root || binding.deck.generation !== current.generation) binding.controller.abort(new Error('The open presentation changed. Call get_presentation, then retry.'));
      }
    },
    async close() {
      closing = true;
      for (const controller of controllers) controller.abort();
      clearInterval(sweep);
      await Promise.all([...sessions.values()].map(({ server }) => server.close()));
      const done = new Promise(resolve => httpServer.close(resolve));
      httpServer.closeAllConnections();
      await done;
    },
  };
}
