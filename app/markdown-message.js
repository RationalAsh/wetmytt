import { createElement } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const components = {
  a: ({ href, children, title }) => createElement('a', {
    href: href || undefined, title, target: '_blank', rel: 'noopener',
  }, children),
  table: ({ children }) => createElement('div', { className: 'markdown-table', tabIndex: 0, role: 'region', 'aria-label': 'Table' },
    createElement('table', null, children)),
  img: ({ src, alt, title }) => src ? createElement('img', { src, alt, title, loading: 'lazy' }) : alt,
};

/** @param {{ children: string }} props */
export function MarkdownMessage({ children }) {
  return createElement('div', { className: 'markdown-body' },
    createElement(Markdown, { remarkPlugins: [remarkGfm], components }, children));
}
