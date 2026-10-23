import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const validId = id => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id);

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
  if (value.version !== 1 || value.id !== id || typeof value.title !== 'string' || typeof value.updatedAt !== 'string' || !Array.isArray(value.messages) || !Array.isArray(value.requests) || value.messages.some(m => !m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string')) throw new Error('Invalid conversation file.');
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

export async function runConversation({ root, id, text, settings, signal, onActivity, chat }) {
  if (typeof text !== 'string' || !text.trim() || text.length > 50000) throw new Error('Enter a message of up to 50,000 characters.');
  const now = new Date().toISOString();
  const conversation = id ? await loadChat(root, id) : { version: 1, id: randomUUID(), title: text.trim().replace(/\s+/g, ' ').slice(0, 80), createdAt: now, updatedAt: now, messages: [], requests: [] };
  const request = { id: randomUUID(), provider: settings.provider, model: settings.model, baseUrl: settings.baseUrl, startedAt: now, status: 'running' };
  conversation.messages.push({ role: 'user', content: text.trim(), createdAt: now, requestId: request.id });
  conversation.requests.push(request);
  conversation.updatedAt = now;
  // Persist the prompt before contacting the provider, including on failure or Stop.
  await saveChat(root, conversation);
  let failure;
  try {
    const content = await chat({ root, settings, history: conversation.messages.slice(-100).map(({ role, content }) => ({ role, content })), signal, onActivity });
    signal.throwIfAborted();
    conversation.messages.push({ role: 'assistant', content, createdAt: new Date().toISOString(), requestId: request.id });
    request.status = 'completed';
  } catch (error) {
    request.status = signal.aborted ? 'cancelled' : 'failed';
    // Provider errors can contain sensitive endpoint details; keep them out of logs.
    failure = signal.aborted ? 'Generation stopped.' : error.message;
  } finally {
    request.finishedAt = new Date().toISOString();
    conversation.updatedAt = request.finishedAt;
    await saveChat(root, conversation);
  }
  return { conversation, error: failure };
}
