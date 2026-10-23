import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownMessage } from '../app/markdown-message.js';

const render = text => renderToStaticMarkup(createElement(MarkdownMessage, null, text));

test('agent replies render common Markdown and GitHub formatting', () => {
  const html = render('# Plan\n\n**Bold** and _italic_ with ~~removed~~ and `inline_code`.\n\n- First\n  - Nested\n\n1. Step one\n2. Step two\n\n> A quote\n\n---\n\n```js\nconst x = "<tag>";\n```\n\n| Slide | Status |\n| --- | --- |\n| Opening | Ready |\n\n- [x] Done\n- [ ] Next\n\n[Reference](https://example.com)');
  for (const tag of ['h1', 'strong', 'em', 'del', 'code', 'ul', 'ol', 'blockquote', 'hr', 'pre', 'table', 'th', 'td']) {
    assert.match(html, new RegExp(`<${tag}(?: |/?>)`));
  }
  assert.match(html, /<ul>\s*<li>First\s*<ul>/);
  assert.match(html, /const x = &quot;&lt;tag&gt;&quot;;/);
  assert.match(html, /class="markdown-table" tabindex="0" role="region"/);
  assert.match(html, /type="checkbox"[^>]*checked=""/);
  assert.match(html, /href="https:\/\/example.com"[^>]*target="_blank"[^>]*rel="noopener"/);
});

test('agent text cannot inject HTML or executable links', () => {
  const html = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[Bad](javascript:alert%281%29)\n\n![Bad image](javascript:alert%281%29)');
  assert.doesNotMatch(html, /<script|<img[^>]*onerror=/);
  assert.doesNotMatch(html, /(?:href|src)="javascript:/);
  assert.match(html, /&lt;script&gt;/);
});

test('plain text, literal underscores, and unfinished code fences remain readable', () => {
  assert.match(render('Keep slide_title and file_name.md.'), /Keep slide_title and file_name.md\./);
  assert.match(render('```html\n<div>Work in progress'), /<pre><code class="language-html">&lt;div&gt;Work in progress/);
});
