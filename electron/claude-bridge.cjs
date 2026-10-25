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
async function forward(line) {
  let message;
  try {
    message = JSON.parse(line);
    const response = await fetch(url, {
      method: 'POST', headers: headers(), body: JSON.stringify(message),
      signal: AbortSignal.timeout(120000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`App connection returned HTTP ${response.status}. Keep Welcome to My TED Talk running and reconnect if the connection has expired.`);
    session = response.headers.get('mcp-session-id') || session;
    if (response.status === 202 || response.status === 204) return;
    const result = await response.json();
    if (message.method === 'initialize') protocol = result.result?.protocolVersion;
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    if (message && Object.hasOwn(message, 'id')) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message } })}\n`);
    } else console.error('Welcome to My TED Talk connection failed:', error.message);
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
