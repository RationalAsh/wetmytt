// Assemble complete messages before allowing any tool to execute. Text previews
// are transient; a broken stream must never become a successful answer or edit.
export async function readResponseStream(response, signal, onText) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', text = '', finished = false, done = false, usage, lastPreview = 0;
  const calls = new Map();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const event = payload => {
    if (payload === '[DONE]') { done = true; return; }
    const data = JSON.parse(payload);
    if (data.error) throw new Error('The provider failed while generating the response. Try again or choose another model.');
    if (data.usage) usage = data.usage;
    const choice = data.choices?.find(choice => choice.index === 0 || choice.index === undefined);
    if (!choice) return;
    if (choice.error || choice.finish_reason === 'error') throw new Error('The provider failed while generating the response. Try again or choose another model.');
    if (choice.finish_reason === 'length') throw new Error('The model reached its output limit. Try a smaller edit.');
    if (choice.finish_reason === 'content_filter') throw new Error('The provider filtered the response. Try another prompt.');
    if (choice.finish_reason) finished = true;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string') text += delta.content;
    for (const part of delta.tool_calls || []) {
      if (!Number.isSafeInteger(part.index) || part.index < 0) throw new Error('The model returned malformed tool calls.');
      const call = calls.get(part.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
      const { index, id, function: fn, ...metadata } = part;
      Object.assign(call, metadata);
      if (id) call.id += id;
      if (fn?.name) call.function.name += fn.name;
      if (fn?.arguments) call.function.arguments += fn.arguments;
      calls.set(part.index, call);
    }
    if (text && Date.now() - lastPreview >= 50) { onText(text); lastPreview = Date.now(); }
  };
  const frame = value => {
    const payload = value.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (payload) event(payload);
  };
  try {
    signal.throwIfAborted();
    while (!done) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done }).replace(/\r\n/g, '\n');
      // Normalize again after concatenation in case CRLF was split across reads.
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        frame(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2);
      }
      if (chunk.done) { if (buffer.trim()) frame(buffer); break; }
    }
    if (!done || !finished) throw new Error('The provider response was interrupted. Try again.');
    if (text) onText(text);
    return { choices: [{ message: { role: 'assistant', content: text || null, tool_calls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call) } }], usage };
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
