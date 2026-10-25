export const providers = {
  openrouter: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', hint: 'Use a model ID from OpenRouter that supports tools.' },
  openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', hint: 'Use an OpenAI model that supports function calling.' },
  claude: { name: 'Claude', baseUrl: 'https://api.anthropic.com/v1', hint: 'Use a Claude API model ID with tool use.' },
  ollama: { name: 'Ollama', baseUrl: 'http://localhost:11434/v1', hint: 'Start Ollama and pull a model that supports tools.' },
};

export function inferProvider(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname;
    if (host === 'openrouter.ai') return 'openrouter';
    if (host === 'api.anthropic.com') return 'claude';
    if (['localhost', '127.0.0.1', '[::1]'].includes(host)) return 'ollama';
  } catch {}
  return 'openai';
}

export function normalizeSettings(value, previous = {}, { requireKey = true } = {}) {
  const provider = value.provider ?? inferProvider(value.baseUrl);
  if (!Object.hasOwn(providers, provider)) throw new Error('Choose a supported AI provider.');
  let endpoint;
  try { endpoint = new URL(value.baseUrl); } catch { throw new Error('Enter a valid API base URL.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && local)) throw new Error('Use HTTPS, or HTTP for a local Ollama server.');
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('The base URL cannot contain credentials, query parameters, or a fragment.');
  if (/\/(chat\/completions|messages|responses)\/?$/.test(endpoint.pathname)) throw new Error('Enter the API base URL, without /chat/completions, /messages, or /responses.');
  const baseUrl = endpoint.href.replace(/\/+$/, '');
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  if (!model) throw new Error('Enter a model ID that supports tool calling.');
  const sameConnection = provider === (previous.provider ?? inferProvider(previous.baseUrl)) && baseUrl === previous.baseUrl?.replace(/\/+$/, '');
  const apiKey = value.apiKey === undefined ? (sameConnection ? previous.apiKey || '' : '') : value.apiKey;
  if (typeof apiKey !== 'string' || /[\r\n]/.test(apiKey)) throw new Error('Enter a valid API key.');
  if (requireKey && !apiKey.trim() && !(provider === 'ollama' && local)) throw new Error(`Enter an API key for ${providers[provider].name}.`);
  return { provider, baseUrl, model, apiKey: apiKey.trim() };
}

// Fallback windows for when a provider does not publish the selected model's limit.
// Live lookups override these. Versions are the documented context window, not the output cap.
const contextWindows = [
  [/^gpt-4\.1(?:-mini|-nano)?(?:-\d{4}-\d{2}-\d{2})?$/, 1_047_576],
  [/^gpt-5(?:-(?:mini|nano|chat))?(?:-\d{4}-\d{2}-\d{2})?$/, 400_000],
  [/^gpt-4o(?:-mini)?(?:-\d{4}-\d{2}-\d{2})?$/, 128_000],
  [/^chatgpt-4o/, 128_000],
  [/^gpt-4-turbo/, 128_000],
  [/^gpt-4-32k/, 32_768],
  [/^gpt-4(?:-\d{4})?$/, 8_192],
  [/^gpt-3\.5-turbo/, 16_385],
  [/^o4-mini/, 200_000],
  [/^o3(?:-mini)?(?:-\d{4}-\d{2}-\d{2})?$/, 200_000],
  [/^o1-mini/, 128_000],
  [/^o1-preview/, 128_000],
  [/^o1(?:-\d{4}-\d{2}-\d{2})?$/, 200_000],
];

function claudeWindow(model) {
  const modern = model.match(/^claude-(?:fable|mythos|opus|sonnet|haiku)-(\d+)(?:[.-](\d{1,2}))?(?:-\d{8})?(?:$|[^0-9])/);
  if (modern) {
    const major = Number(modern[1]);
    const minor = modern[2] == null ? 0 : Number(modern[2]);
    // Claude Opus/Sonnet/Haiku 4.6 and the 5+ lines use a 1M window. Earlier Claude models use 200k.
    return major > 4 || (major === 4 && minor >= 6) ? 1_000_000 : 200_000;
  }
  return model.startsWith('claude-') ? 200_000 : null;
}

export function knownContextWindow(provider, model) {
  const bare = String(model || '').trim().toLowerCase().split('/').pop();
  if (!bare) return null;
  if (provider === 'claude') return claudeWindow(bare);
  if (provider === 'openai') return contextWindows.find(([pattern]) => pattern.test(bare))?.[1] ?? null;
  if (provider === 'openrouter') return contextWindows.find(([pattern]) => pattern.test(bare))?.[1] ?? claudeWindow(bare);
  return null;
}

function wholeTokens(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100_000_000) return null;
  return Math.round(value);
}

export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const inputTokens = wholeTokens(usage.inputTokens);
  const outputTokens = wholeTokens(usage.outputTokens);
  if (inputTokens == null || outputTokens == null) return null;
  return { inputTokens, outputTokens };
}

export function conversationTokens(requests) {
  if (!Array.isArray(requests)) return 0;
  for (let index = requests.length - 1; index >= 0; index--) {
    const usage = normalizeUsage(requests[index]?.usage);
    if (usage) return usage.inputTokens + usage.outputTokens;
  }
  return 0;
}
