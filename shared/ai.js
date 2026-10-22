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
