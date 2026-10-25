import { load } from 'cheerio';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent } from 'undici';

const cache = new Map();
const clean = text => text.replace(/\s+/g, ' ').trim();

// Dedicated web tools may retrieve public HTTP resources, never local services.
async function publicAddresses(host) {
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some(({ address }) => {
    if (address.includes(':')) return !/^2[0-9a-f]{3}:/i.test(address) || /^2001:(?:0:|db8:)/i.test(address) || /^2002:/i.test(address);
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
  })) throw new Error('Local and private network URLs are not supported.');
  return addresses;
}

export async function publicURL(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use a public HTTP or HTTPS URL without credentials.');
  await publicAddresses(url.hostname.replace(/^\[|\]$/g, ''));
  return url;
}

// Validate the actual addresses passed to the socket as well as the URL. This
// closes the DNS rebinding gap between a preflight lookup and connection.
const publicAgent = new Agent({ connect: { lookup(hostname, options, callback) {
  publicAddresses(hostname).then(addresses => {
    const matching = options.family ? addresses.filter(entry => entry.family === options.family) : addresses;
    if (!matching.length) return callback(new Error('No public address for the requested address family.'));
    callback(null, options.all ? matching : matching[0].address, matching[0].family);
  }, callback);
} } });

export async function requestBytes(value, { signal, limit = 2_000_000, accept = 'text/html, text/plain;q=0.9' } = {}) {
  const deadline = AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]);
  let url = await publicURL(value);
  for (let redirects = 0; redirects <= 5; redirects++) {
    deadline.throwIfAborted();
    const response = await fetch(url, { dispatcher: publicAgent, redirect: 'manual', signal: deadline, headers: { Accept: accept, 'User-Agent': 'wetmytt/0.2 (presentation research)' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      if (!response.headers.get('location')) throw new Error('Redirect has no destination.');
      url = await publicURL(new URL(response.headers.get('location'), url).href);
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Web request returned HTTP ${response.status}.`); }
    const chunks = [];
    let size = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { value: chunk, done } = await reader.read();
          if (done) break;
          size += chunk.length;
          if (size > limit) throw new Error(`Response exceeds ${limit} bytes.`);
          chunks.push(Buffer.from(chunk));
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    return { bytes: Buffer.concat(chunks), url: url.href, contentType: response.headers.get('content-type') || '' };
  }
  throw new Error('Too many redirects.');
}

export function parseSearch(html, count = 5) {
  const $ = load(html);
  if ($('#challenge-form, #anomaly-form, .anomaly-modal').length || /bots use DuckDuckGo too|please complete the following challenge/i.test($.text())) throw new Error('DuckDuckGo blocked automated search. Try again later or provide a source URL to fetch_url.');
  const results = [];
  $('.result').each((_, element) => {
    const link = $(element).find('.result__a').first();
    let href = link.attr('href');
    if (!href) return;
    try {
      const target = new URL(href, 'https://duckduckgo.com');
      href = target.searchParams.get('uddg') || target.href;
      const url = new URL(href);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || results.some(result => result.url === url.href)) return;
      results.push({ title: clean(link.text()), url: url.href, snippet: clean($(element).find('.result__snippet').text()) });
    } catch { /* Ignore malformed result links. */ }
  });
  if (!results.length && !$('.no-results, .result--no-result').length && !/No results found/i.test($.text())) throw new Error('DuckDuckGo returned an unrecognized search page. Try again later or use fetch_url with a known URL.');
  return results.slice(0, count);
}

export async function searchWeb({ query, count = 5 }, signal, request = requestBytes) {
  signal?.throwIfAborted();
  const key = JSON.stringify([query, count]);
  const saved = cache.get(key);
  if (saved && Date.now() - saved.time < 60000) return saved.result;
  const url = new URL('https://html.duckduckgo.com/html/');
  url.searchParams.set('q', query);
  const response = await request(url.href, { signal });
  const result = { query, provider: 'DuckDuckGo', results: parseSearch(response.bytes.toString('utf8'), count) };
  if (cache.size >= 50) cache.delete(cache.keys().next().value);
  cache.set(key, { time: Date.now(), result });
  return result;
}

export async function fetchURL({ url }, signal, request = requestBytes) {
  const response = await request(url, { signal });
  const source = response.bytes.toString('utf8');
  if (!/text\/|application\/(json|xml|xhtml\+xml)/i.test(response.contentType)) throw new Error('URL is not a readable text page. Use download_asset for binary files.');
  if (!/html/i.test(response.contentType)) return { url: response.url, text: source.slice(0, 40000), truncated: source.length > 40000 };
  const $ = load(source);
  const title = clean($('title').text());
  $('script, style, noscript, nav, footer, header, iframe, form, svg').remove();
  $('br').replaceWith('\n');
  $('p, div, section, article, li, h1, h2, h3, h4, tr').append('\n');
  const article = $('main, article').first();
  const text = (article.length ? article : $('body')).text().replace(/[\t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { url: response.url, title, text: text.slice(0, 40000), truncated: text.length > 40000 };
}
