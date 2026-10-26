import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeUsage } from '../shared/ai.js';

const validId = id => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id);
const toolStatuses = ['pending', 'running', 'completed', 'failed', 'cancelled'];
const validTool = tool => tool && typeof tool.id === 'string' && typeof tool.name === 'string' && typeof tool.argsText === 'string' && toolStatuses.includes(tool.status) && (tool.result === undefined || typeof tool.result === 'string');
function validMessage(message) {
  if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') return false;
  if (message.id !== undefined && typeof message.id !== 'string') return false;
  if (message.requestId !== undefined && typeof message.requestId !== 'string') return false;
  if (message.createdAt !== undefined && (typeof message.createdAt !== 'string' || !Number.isFinite(Date.parse(message.createdAt)))) return false;
  if (message.activity !== undefined && (message.activity !== true || message.role !== 'assistant')) return false;
  return message.tools === undefined || (message.activity === true && Array.isArray(message.tools) && message.tools.every(validTool));
}
// Keep expanded tool details useful without allowing large reads to overwhelm
// the local conversation file. Full results still go to the model unchanged.
const toolDetail = text => text.length > 24000 ? text.slice(0, 24000) + '\n[Display truncated to 24,000 characters.]' : text;

async function directory(root, create = false) {
  let folder = await fs.realpath(root);
  for (const name of ['.wetmytt', 'chats']) {
    folder = path.join(folder, name);
    if (create) await fs.mkdir(folder, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await fs.lstat(folder);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Chat storage must be a directory inside the project.');
  }
  return folder;
}

export async function loadChat(root, id) {
  if (!validId(id)) throw new Error('Invalid conversation ID.');
  const file = path.join(await directory(root), `${id}.json`);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20_000_000) throw new Error('Invalid or oversized conversation file.');
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
  if (value.version !== 1 || value.id !== id || typeof value.title !== 'string' || typeof value.updatedAt !== 'string' || !Array.isArray(value.messages) || !Array.isArray(value.requests) || !value.messages.every(validMessage)) throw new Error('Invalid conversation file.');
  return value;
}

export async function listChats(root) {
  let folder;
  try { folder = await directory(root); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const chats = [];
  for (const name of await fs.readdir(folder)) {
    if (!name.endsWith('.json') || !validId(name.slice(0, -5))) continue;
    try {
      const { id, title, updatedAt, requests } = await loadChat(root, name.slice(0, -5));
      const last = requests.at(-1);
      chats.push({ id, title, updatedAt, provider: last?.provider, model: last?.model });
    } catch (error) {
      // One damaged log must not hide the rest of the project's history.
      console.warn(`Could not load chat ${name}: ${error.message}`);
    }
  }
  return chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function saveChat(root, conversation) {
  const folder = await directory(root, true);
  const temporary = path.join(folder, `.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify(conversation, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, path.join(folder, `${conversation.id}.json`));
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

export async function runConversation({ root, id, text, settings, signal, onActivity, onConversation = () => {}, chat }) {
  if (typeof text !== 'string' || !text.trim() || text.length > 50000) throw new Error('Enter a message of up to 50,000 characters.');
  const now = new Date().toISOString();
  const conversation = id ? await loadChat(root, id) : { version: 1, id: randomUUID(), title: text.trim().replace(/\s+/g, ' ').slice(0, 80), createdAt: now, updatedAt: now, messages: [], requests: [] };
  const request = { id: randomUUID(), provider: settings.provider, model: settings.model, baseUrl: settings.baseUrl, startedAt: now, status: 'running' };
  conversation.messages.push({ id: randomUUID(), role: 'user', content: text.trim(), createdAt: now, requestId: request.id });
  conversation.requests.push(request);
  conversation.updatedAt = now;
  // Persist the prompt before contacting the provider, including on failure or Stop.
  await saveChat(root, conversation);
  onConversation(conversation);
  // Preserve the existing model context: tool activity is a display transcript,
  // not an extra assistant answer or a replay of tool executions.
  const history = conversation.messages.filter(message => !message.activity).slice(-100).map(({ role, content }) => ({ role, content }));
  const onEvent = async event => {
    if (event.type === 'assistant') {
      conversation.messages.push({ id: randomUUID(), role: 'assistant', activity: true, content: event.content, tools: event.tools.map(tool => ({ ...tool, argsText: toolDetail(tool.argsText) })), createdAt: new Date().toISOString(), requestId: request.id });
    } else if (event.type === 'tool') {
      const tool = conversation.messages.at(-1)?.tools?.find(tool => tool.id === event.id);
      if (!tool) throw new Error('Tool activity has no matching call.');
      tool.status = event.status;
      if (event.result !== undefined) tool.result = toolDetail(event.result);
    }
    await saveChat(root, conversation);
    onConversation(conversation);
  };
  let failure;
  try {
    const result = await chat({ root, settings, history, signal, onActivity, onEvent });
    const content = typeof result === 'string' ? result : result?.content;
    const usage = typeof result === 'string' ? null : normalizeUsage(result?.usage);
    signal.throwIfAborted();
    if (usage) request.usage = usage;
    conversation.messages.push({ id: randomUUID(), role: 'assistant', content, createdAt: new Date().toISOString(), requestId: request.id });
    request.status = 'completed';
  } catch (error) {
    request.status = signal.aborted ? 'cancelled' : 'failed';
    // Provider errors can contain sensitive endpoint details; keep them out of logs.
    failure = signal.aborted ? 'Generation stopped.' : error.message;
  } finally {
    for (const message of conversation.messages) {
      if (message.requestId !== request.id) continue;
      for (const tool of message.tools || []) {
        if (['pending', 'running'].includes(tool.status)) tool.status = signal.aborted ? 'cancelled' : 'failed';
      }
    }
    request.finishedAt = new Date().toISOString();
    conversation.updatedAt = request.finishedAt;
    await saveChat(root, conversation);
    onConversation(conversation);
  }
  return { conversation, error: failure };
}
