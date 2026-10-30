import { knownContextWindow, providers } from '../shared/ai.js';

export class ImageInputError extends Error {}

const hasImages = messages => messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url' || part.type === 'image'));

function checkAborted(signal) {
  if (signal.aborted) throw new Error(signal.reason?.name === 'TimeoutError'
    ? 'The AI request timed out. Try a smaller request or a faster model.' : 'AI request stopped.');
}

async function fetchCompletion(settings, body, signal) {
  const name = providers[settings.provider].name;
  // Retry only this model request, before any returned tools are executed.
  const attempts = settings.provider === 'openrouter' ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    checkAborted(signal);
    let response;
    try {
      response = await fetch(`${settings.baseUrl}/${settings.provider === 'claude' ? 'messages' : 'chat/completions'}`, {
        method: 'POST', signal, redirect: 'error',
        headers: { 'Content-Type': 'application/json', ...(settings.provider === 'claude' ? { 'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01' } : settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}) },
        body: JSON.stringify(body),
      });
    } catch {
      checkAborted(signal);
      if (attempt + 1 < attempts) continue;
      throw new Error(`Could not reach ${name}. Check the base URL${settings.provider === 'ollama' ? ' and that Ollama is running' : ' and your internet connection'}.`);
    }
    if (!response.ok) {
      const advice = {
        400: 'Check the model ID and that the model supports tool calling.',
        401: 'Check your API key.', 403: 'Your key does not have access to this model.',
        404: 'Check the API base URL and model ID.', 402: 'Check your provider credits.',
        408: 'The provider timed out. Try a smaller request or a faster model.',
        429: 'Rate limit or quota reached. Check your usage and try again later.',
      }[response.status] || 'The provider is unavailable. Try again later.';
      await response.body?.cancel().catch(() => {});
      // Routers can return 404 when no endpoint accepts image input. Retrying
      // without images also leaves genuine model/URL errors actionable.
      if ([400, 404, 413, 415, 422].includes(response.status) && hasImages(body.messages)) throw new ImageInputError(`${name} rejected image input. Use a model with image support.`);
      if ([502, 503, 504].includes(response.status) && attempt + 1 < attempts) continue;
      throw new Error(`${name} returned ${response.status}. ${advice}`);
    }
    let text;
    try { text = await response.text(); }
    catch {
      checkAborted(signal);
      if (attempt + 1 < attempts) continue;
      throw new Error(`${name}'s response was interrupted while downloading. Try again.`);
    }
    checkAborted(signal);
    try { return JSON.parse(text); }
    catch {
      if (attempt + 1 < attempts) continue;
      throw new Error(`${name} returned invalid JSON (an empty, incomplete, or non-JSON response). Try again; if this persists, check provider status and the API base URL.`);
    }
  }
}

// Keep provider wire formats here; the agent works with one tool-call format.
export async function requestMessage(settings, messages, tools, signal) {
  // File-editing sessions can need several model calls; each gets its own deadline.
  signal = AbortSignal.any([signal, AbortSignal.timeout(180000)]);
  const claude = settings.provider === 'claude';
  const body = claude ? {
    model: settings.model, max_tokens: 8192, system: messages[0].content,
    messages: messages.slice(1).map(message => {
      if (message.role === 'tool') return { role: 'user', content: [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content }] };
      if (message.tool_calls?.length) return { role: 'assistant', content: [
        ...(message.content ? [{ type: 'text', text: message.content }] : []),
        ...message.tool_calls.map(call => ({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) })),
      ] };
      return { role: message.role, content: Array.isArray(message.content) ? message.content.map(part => {
        if (part.type !== 'image_url') return part;
        const [, media_type, data] = /^data:([^;]+);base64,(.+)$/.exec(part.image_url.url);
        return { type: 'image', source: { type: 'base64', media_type, data } };
      }) : message.content };
    }),
    tools: tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })),
  } : {
    model: settings.model, messages, tools: tools.map(fn => ({ type: 'function', function: fn })),
    ...(settings.provider === 'openrouter' ? { provider: { require_parameters: true } } : {}),
  };
  const data = await fetchCompletion(settings, body, signal);
  if (!data || typeof data !== 'object') throw new Error('The provider returned an unsupported response. Check the API base URL.');
  if (data.error) throw new Error('The provider could not complete the request. Check model access, tool support, and provider usage.');
  let message;
  if (claude) {
    if (!Array.isArray(data.content) || data.content.some(block => !block || typeof block.type !== 'string' || (block.type === 'text' && typeof block.text !== 'string') || (block.type === 'tool_use' && (!block.input || typeof block.input !== 'object' || Array.isArray(block.input))))) throw new Error('Claude returned an unsupported response.');
    if (data.stop_reason === 'max_tokens') throw new Error('Claude reached its output limit. Try a smaller edit.');
    message = { role: 'assistant', content: data.content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
      tool_calls: data.content.filter(block => block.type === 'tool_use').map(block => ({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } })) };
  } else {
    const choice = data.choices?.[0];
    if (choice?.error || choice?.finish_reason === 'error') throw new Error('The provider failed while generating the response. Try again or choose another model.');
    if (choice?.finish_reason === 'length') throw new Error('The model reached its output limit. Try a smaller edit.');
    message = choice?.message;
  }
  if (!message || (message.content != null && typeof message.content !== 'string') || (message.tool_calls != null && !Array.isArray(message.tool_calls))) throw new Error('The provider returned an unsupported message format. Choose a model with tool calling.');
  if (message.tool_calls?.some(call => !call || typeof call.id !== 'string' || !call.id || typeof call.function?.name !== 'string' || typeof call.function?.arguments !== 'string')) throw new Error('The model returned malformed tool calls. Try another model with tool calling.');
  if (!message.content && !message.tool_calls?.length) throw new Error(message.refusal || 'The model returned an empty response. Try another prompt or model.');
  return { role: 'assistant', content: message.content ?? null, ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}), usage: readUsage(settings.provider, data) };
}

function countedTokens(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100_000_000) return null;
  return Math.round(value);
}

// Claude reports cache reads and writes separately from input_tokens.
// OpenAI-style cached tokens are already included in prompt_tokens.
export function readUsage(provider, data) {
  const usage = data?.usage;
  if (!usage || typeof usage !== 'object') return null;
  if (provider === 'claude') {
    const input = countedTokens(usage.input_tokens);
    const output = countedTokens(usage.output_tokens);
    if (input == null || output == null) return null;
    return { inputTokens: input + (countedTokens(usage.cache_creation_input_tokens) ?? 0) + (countedTokens(usage.cache_read_input_tokens) ?? 0), outputTokens: output };
  }
  const input = countedTokens(usage.prompt_tokens);
  const output = countedTokens(usage.completion_tokens);
  if (input != null && output != null) return { inputTokens: input, outputTokens: output };
  const total = countedTokens(usage.total_tokens);
  return total == null ? null : { inputTokens: total, outputTokens: 0 };
}

function positiveTokens(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 20_000_000) return null;
  return value;
}

const limitCache = new Map();

async function readJSON(url, options) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(8000), ...options });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  try { return await response.json(); }
  catch { return null; }
}

function namesMatch(running, requested) {
  const loaded = String(running || '').trim().toLowerCase();
  const wanted = String(requested || '').trim().toLowerCase();
  if (!loaded || !wanted) return false;
  return loaded === wanted || (!wanted.includes(':') && loaded.startsWith(`${wanted}:`)) || (!loaded.includes(':') && wanted.startsWith(`${loaded}:`));
}

function modelContextLength(info) {
  if (!info || typeof info !== 'object') return null;
  const lengths = Object.entries(info).filter(([key]) => key.endsWith('.context_length')).map(([, value]) => positiveTokens(value)).filter(Boolean);
  return lengths.length ? Math.max(...lengths) : null;
}

function ollamaOrigin(settings) {
  return { origin: new URL(settings.baseUrl).origin, headers: { ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}) } };
}

async function ollamaRunningLimit(settings) {
  const { origin, headers } = ollamaOrigin(settings);
  const running = await readJSON(`${origin}/api/ps`, { headers });
  const loaded = Array.isArray(running?.models) ? running.models.find(model => namesMatch(model?.name || model?.model, settings.model)) : null;
  return positiveTokens(loaded?.context_length);
}

async function ollamaConfiguredLimit(settings) {
  const { origin, headers } = ollamaOrigin(settings);
  const shown = await readJSON(`${origin}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ model: settings.model }) });
  const parameters = typeof shown?.parameters === 'string' ? shown.parameters : '';
  const configured = parameters.match(/(?:^|[\r\n])\s*num_ctx\s+(\d+)\b/);
  return (configured && positiveTokens(Number(configured[1]))) || modelContextLength(shown?.model_info);
}

async function liveLimit(settings) {
  if (settings.provider === 'claude') {
    if (!settings.apiKey) return null;
    const data = await readJSON(`${settings.baseUrl}/models/${encodeURIComponent(settings.model)}`, { headers: { 'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01' } });
    return positiveTokens(data?.max_input_tokens);
  }
  if (settings.provider === 'openrouter') {
    const data = await readJSON(`${settings.baseUrl}/models`, { headers: { ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}) } });
    let found = null;
    for (const model of Array.isArray(data?.data) ? data.data : []) {
      const limit = positiveTokens(model?.context_length) ?? positiveTokens(model?.top_provider?.context_length);
      if (!limit || typeof model?.id !== 'string') continue;
      if (model.id === settings.model) found = limit;
      limitCache.set(`openrouter\0${settings.baseUrl}\0${model.id}`, { value: limit, expires: Date.now() + 600_000 });
    }
    return found;
  }
  if (settings.provider === 'ollama') return ollamaConfiguredLimit(settings);
  return null;
}

export async function contextLimit(settings) {
  if (!settings?.model) return null;
  const key = `${settings.provider}\0${settings.baseUrl}\0${settings.model}`;
  let reachable = true;
  // A loaded Ollama model reports the context it is actually using, which can differ from the Modelfile.
  if (settings.provider === 'ollama') {
    try {
      const running = await ollamaRunningLimit(settings);
      if (running) return running;
    } catch { reachable = false; }
  }
  const cached = limitCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  let value = null;
  if (reachable) {
    try { value = await liveLimit(settings); }
    catch { value = null; }
  }
  if (!value) value = knownContextWindow(settings.provider, settings.model);
  limitCache.set(key, { value: value ?? null, expires: Date.now() + (value ? 600_000 : 30_000) });
  return value ?? null;
}
