import { providers } from '../shared/ai.js';

// Keep provider wire formats here; the agent works with one tool-call format.
export async function requestMessage(settings, messages, tools, signal) {
  const claude = settings.provider === 'claude';
  const body = claude ? {
    model: settings.model, max_tokens: 8192, system: messages[0].content,
    messages: messages.slice(1).map(message => {
      if (message.role === 'tool') return { role: 'user', content: [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content }] };
      if (message.tool_calls?.length) return { role: 'assistant', content: [
        ...(message.content ? [{ type: 'text', text: message.content }] : []),
        ...message.tool_calls.map(call => ({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) })),
      ] };
      return { role: message.role, content: message.content };
    }),
    tools: tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })),
  } : {
    model: settings.model, messages, tools: tools.map(fn => ({ type: 'function', function: fn })),
    ...(settings.provider === 'openrouter' ? { provider: { require_parameters: true } } : {}),
  };
  let response;
  try {
    response = await fetch(`${settings.baseUrl}/${claude ? 'messages' : 'chat/completions'}`, {
      method: 'POST', signal, redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(claude ? { 'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01' } : settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}) },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (signal.aborted) throw new Error(signal.reason?.name === 'TimeoutError' ? 'The AI request timed out. Try a smaller request or a faster model.' : 'AI request stopped.');
    throw new Error(`Could not reach ${providers[settings.provider].name}. Check the base URL${settings.provider === 'ollama' ? ' and that Ollama is running' : ' and your internet connection'}.`);
  }
  if (!response.ok) {
    const advice = {
      400: 'Check the model ID and that the model supports tool calling.',
      401: 'Check your API key.', 403: 'Your key does not have access to this model.',
      404: 'Check the API base URL and model ID.', 402: 'Check your provider credits.',
      429: 'Rate limit or quota reached. Check your usage and try again later.',
    }[response.status] || 'The provider is unavailable. Try again later.';
    throw new Error(`${providers[settings.provider].name} returned ${response.status}. ${advice}`);
  }
  let data;
  try { data = await response.json(); } catch { throw new Error('The provider returned invalid JSON. Check the API base URL.'); }
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
    if (choice?.finish_reason === 'length') throw new Error('The model reached its output limit. Try a smaller edit.');
    message = choice?.message;
  }
  if (!message || (message.content != null && typeof message.content !== 'string') || (message.tool_calls != null && !Array.isArray(message.tool_calls))) throw new Error('The provider returned an unsupported message format. Choose a model with tool calling.');
  if (message.tool_calls?.some(call => !call || typeof call.id !== 'string' || !call.id || typeof call.function?.name !== 'string' || typeof call.function?.arguments !== 'string')) throw new Error('The model returned malformed tool calls. Try another model with tool calling.');
  if (!message.content && !message.tool_calls?.length) throw new Error(message.refusal || 'The model returned an empty response. Try another prompt or model.');
  return { role: 'assistant', content: message.content ?? null, ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) };
}
