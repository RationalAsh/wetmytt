import { app, BrowserWindow, clipboard, dialog } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Server } from 'node:net';
import { MCP_PORT } from '../../electron/mcp.js';

const [directory] = process.argv.slice(2);
app.setPath('userData', path.join(directory, 'profile'));
app.setPath('sessionData', path.join(directory, 'profile'));
app.whenReady().then(async () => {
  const first = path.join(directory, 'Chat deck'), second = path.join(directory, 'Other deck');
  await fs.cp(path.resolve('templates/starter'), first, { recursive: true });
  await fs.cp(path.resolve('templates/starter'), second, { recursive: true });
  const legacyId = '11111111-1111-1111-1111-111111111111';
  await fs.mkdir(path.join(first, '.wetmytt/chats'), { recursive: true });
  await fs.writeFile(path.join(first, '.wetmytt/chats', `${legacyId}.json`), JSON.stringify({
    version: 1, id: legacyId, title: 'Legacy conversation', updatedAt: '2026-01-01T00:00:00.000Z', requests: [],
    messages: [{ role: 'user', content: 'Old question' }, { role: 'assistant', content: 'Old answer' }],
  }));
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [first] });
  dialog.showErrorBox = (title, message) => { throw new Error(`${title}: ${message}`); };
  const listen = Server.prototype.listen;
  Server.prototype.listen = function (port, ...args) { return listen.call(this, port === MCP_PORT ? 0 : port, ...args); };
  const originalFetch = globalThis.fetch;
  let held = false;
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith('http://localhost:11434/v1')) return originalFetch(url, options);
    if (!String(url).endsWith('/chat/completions')) return Response.json({ data: [] });
    const body = JSON.parse(options.body);
    const prompt = body.messages.findLast(message => message.role === 'user').content;
    if (prompt === 'Switch project' || (prompt === 'Stop after edit' && body.messages.at(-1).role === 'tool')) {
      held = true;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    }
    const tools = prompt === 'Stop after edit'
      ? [{ id: 'write', function: { name: 'write_file', arguments: JSON.stringify({ path: 'note.txt', content: 'Saved before Stop' }) } }]
      : [{ id: 'read', function: { name: 'read_file', arguments: JSON.stringify({ path: 'index.html' }) } },
        { id: 'missing', function: { name: 'read_file', arguments: JSON.stringify({ path: 'missing.txt' }) } }];
    return Response.json({ choices: [{ message: body.messages.at(-1).role === 'tool'
      ? { content: '**Finished** inspecting your deck.' }
      : { content: 'I will check the presentation.', tool_calls: tools } }], usage: { prompt_tokens: 120, completion_tokens: 20 } });
  };
  const waitFor = async predicate => {
    const deadline = Date.now() + 15000;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`Chat UI did not reach expected state: ${predicate}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  try {
    await import('../../electron/main.js');
    let window;
    await waitFor(() => { window = BrowserWindow.getAllWindows().find(item => item.isVisible()); return window; });
    const errors = [];
    window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
    const js = source => window.webContents.executeJavaScript(source, true);
    await waitFor(() => js(`Boolean(window.wetmytt && document.querySelector('.assistant-thread'))`));
    await js(`window.wetmytt.open()`);
    await waitFor(() => js(`document.querySelector('.chat-messages').textContent.includes('Old answer')`));
    await js(`window.wetmytt.saveSettings({ provider: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'chat-test', apiKey: '' })`);
    // Reload to exercise startup settings and legacy history restoration together.
    window.webContents.reload();
    await waitFor(() => js(`document.querySelector('.model-select')?.textContent.includes('chat-test') && document.querySelector('.chat-messages').textContent.includes('Old answer')`));
    const click = label => js(`document.querySelector('[aria-label=${JSON.stringify(label)}]').click()`);
    const input = text => js(`(() => { const e = document.querySelector('.composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(e, ${JSON.stringify(text)}); e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    const send = async text => { await input(text); await click('Send message'); };
    await send('Inspect the deck');
    await waitFor(() => js(`document.querySelector('.chat-messages').textContent.includes('Finished') && !document.querySelector('[aria-label="Stop generation"]')`));
    assert.equal(await js(`document.querySelector('.message.assistant .markdown-body strong')?.textContent`), 'Finished');
    assert.equal(await js(`Array.from(document.querySelectorAll('.message.user')).filter(e => e.textContent.includes('Inspect the deck')).length`), 1);
    window.focus();
    await js(`Array.from(document.querySelectorAll('.message.assistant')).find(e => e.querySelector('.markdown-body strong')).querySelector('[aria-label="Copy response"]').click()`);
    await waitFor(async () => (await clipboard.readText()).includes('Finished'));
    assert.equal(await js(`navigator.permissions.query({ name: 'clipboard-read' }).then(p => p.state)`), 'denied');
    const preview = window.webContents.mainFrame.frames.find(frame => frame.url.includes('index.html'));
    assert.ok(preview);
    assert.equal(await preview.executeJavaScript(`navigator.permissions.query({ name: 'clipboard-write' }).then(p => p.state)`), 'denied');
    assert.equal(await js(`document.querySelector('.tool-group').open`), false);
    await js(`document.querySelector('.tool-group > summary').click()`);
    assert.equal(await js(`document.querySelectorAll('.tool-call').length`), 2);
    assert.equal(await js(`document.querySelector('.tool-call').open`), false);
    await js(`document.querySelector('.tool-call > summary').click()`);
    assert.equal(await js(`document.querySelector('.tool-call').open`), true);
    assert.ok(await js(`document.querySelector('.tool-call pre').textContent.includes('index.html')`));
    assert.equal(await js(`document.querySelector('.tool-failed .tool-status').textContent`), 'Failed');
    window.setSize(900, 620);
    assert.equal(await js(`document.querySelector('.assistant-thread').scrollWidth <= document.querySelector('.assistant-thread').clientWidth`), true);
    window.setSize(1440, 940);
    const saved = await js(`window.wetmytt.loadChat(${JSON.stringify(first)}, ${JSON.stringify(legacyId)})`);
    assert.equal(saved.messages[3].tools[1].status, 'failed');
    assert.equal(saved.messages[0].content, 'Old question');
    await click('New conversation');
    await waitFor(() => js(`Boolean(document.querySelector('.chat-intro'))`));
    await js(`(() => { const e = document.querySelector('[aria-label="Saved conversations"]'); e.value = ${JSON.stringify(legacyId)}; e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(() => js(`document.querySelectorAll('.tool-call').length === 2`));
    assert.equal(await js(`document.querySelector('.tool-failed .tool-status').textContent`), 'Failed');
    // Enter submits through assistant-ui's composer; Shift+Enter stays multiline.
    await input('Stop after edit');
    await js(`document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }))`);
    assert.equal(await js(`Boolean(document.querySelector('[aria-label="Stop generation"]'))`), false);
    await js(`document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
    await waitFor(() => held);
    await click('Stop generation');
    await waitFor(() => js(`!document.querySelector('[aria-label="Stop generation"]')`));
    assert.equal(await fs.readFile(path.join(first, 'note.txt'), 'utf8'), 'Saved before Stop');
    const stopped = await js(`window.wetmytt.loadChat(${JSON.stringify(first)}, ${JSON.stringify(legacyId)})`);
    assert.equal(stopped.requests.at(-1).status, 'cancelled');
    assert.equal(stopped.messages.at(-1).tools[0].status, 'completed');
    if (process.env.WETMYTT_CHAT_SCREENSHOT) await fs.writeFile(process.env.WETMYTT_CHAT_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
    held = false;
    await send('Switch project');
    await waitFor(() => held);
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [second] });
    await js(`window.wetmytt.open()`);
    await waitFor(() => js(`document.querySelector('h1').textContent === 'Other deck' && Boolean(document.querySelector('.chat-intro'))`));
    assert.ok(!(await js(`document.querySelector('.chat-messages').textContent`)).includes('Old answer'));
    assert.deepEqual(await js(`window.wetmytt.chats(${JSON.stringify(second)})`), []);
    assert.deepEqual(errors, []);
    console.log('Chat integration passed: legacy history, composer, tool groups, tool errors, restored activity, Stop, and project isolation.');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
