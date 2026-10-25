// Claude Desktop runs this dependency-free stdio bridge with its bundled Node.
// The app's HTTP MCP server returns JSON responses and has no server requests.
const { createInterface } = require('node:readline');
const { url, token } = require('./connection.json');
let session, protocol, closing = false;
const headers = () => ({
  Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  ...(session ? { 'Mcp-Session-Id': session } : {}),
  ...(protocol ? { 'MCP-Protocol-Version': protocol } : {}),
});
let initialization, needsPresentation = false;
const send = message => fetch(url, {
  method: 'POST', headers: headers(), body: JSON.stringify(message),
  signal: AbortSignal.timeout(120000), redirect: 'error',
});
async function readResponse(response) {
  if (!response.ok) throw new Error(`App connection returned HTTP ${response.status}. Keep Welcome to My TED Talk running. If access is denied, reinstall its Claude extension to refresh the credentials.`);
  session = response.headers.get('mcp-session-id') || session;
  if (response.status === 202 || response.status === 204) return;
  return response.json();
}
async function reconnect() {
  session = undefined;
  protocol = undefined;
  needsPresentation = true;
  const result = await readResponse(await send({ ...initialization, id: 'wetmytt-reconnect' }));
  if (!result?.result?.protocolVersion || !session) throw new Error('Could not restore the app connection. Restart the Claude extension.');
  protocol = result.result.protocolVersion;
  await readResponse(await send({ jsonrpc: '2.0', method: 'notifications/initialized' }));
}
async function forward(line) {
  let message;
  try {
    message = JSON.parse(line);
    if (message.method === 'initialize') initialization = message;
    if (!session && initialization && message.method !== 'initialize') await reconnect();
    const isTool = message.method === 'tools/call';
    const selectsPresentation = isTool && message.params?.name === 'get_presentation';
    if (isTool && needsPresentation && !selectsPresentation) throw new Error('The app connection was restored. Call get_presentation to select the open presentation, then retry.');
    let response = await send(message);
    if (response.status === 404 && session && initialization && message.method !== 'initialize') {
      // A 404 means the request was rejected before execution. Never retry
      // connection failures or other statuses: an edit may already have run.
      await response.arrayBuffer();
      await reconnect();
      if (isTool && !selectsPresentation) throw new Error('The app connection was restored. Call get_presentation to select the open presentation, then retry.');
      response = await send(message);
    }
    const result = await readResponse(response);
    if (!result) return;
    if (message.method === 'initialize') protocol = result.result?.protocolVersion;
    if (selectsPresentation && result.result && !result.result.isError) needsPresentation = false;
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const detail = error.cause?.code ? `${error.message} (${error.cause.code})` : error.message;
    const text = `Welcome to My TED Talk connection failed: ${detail.replace(/\.+$/, '')}. Keep the app running, then call get_presentation and retry.`;
    console.error(text);
    if (message && Object.hasOwn(message, 'id')) {
      // Tool failures belong in CallToolResult so Claude can read and act on
      // them. JSON-RPC errors are displayed as a generic connector failure.
      const result = message.method === 'tools/call'
        ? { result: { isError: true, content: [{ type: 'text', text }] } }
        : { error: { code: -32603, message: text } };
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, ...result })}\n`);
    }
  }
}
let pending = Promise.resolve();
const input = createInterface({ input: process.stdin });
input.on('line', line => { if (line.trim()) pending = pending.then(() => forward(line)); });
async function close() {
  if (closing) return;
  closing = true;
  await pending;
  if (session) await fetch(url, { method: 'DELETE', headers: headers(), signal: AbortSignal.timeout(2000), redirect: 'error' }).catch(() => {});
  process.exit(0);
}
input.on('close', close);
process.on('SIGTERM', close);
process.on('SIGINT', close);
