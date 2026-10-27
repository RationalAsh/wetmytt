import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { renderWebsite } from '../scripts/build-website.mjs';

const template = await fs.readFile(new URL('../website/index.html', import.meta.url), 'utf8');
const repository = 'https://github.com/RationalAsh/wetmytt';
const release = version => ({
  tag_name: `v${version}`, draft: false, prerelease: false,
  html_url: `${repository}/releases/tag/v${version}`,
  assets: ['arm64', 'x64'].map(arch => ({
    name: `wetmytt-${version}-mac-${arch}.dmg`, state: 'uploaded',
    browser_download_url: `${repository}/releases/download/v${version}/wetmytt-${version}-mac-${arch}.dmg`,
  })),
});

test('website downloads follow the published version without source edits', () => {
  for (const version of ['0.3.2', '1.12.0']) {
    const html = renderWebsite(template, release(version));
    for (const arch of ['arm64', 'x64']) assert(html.includes(`href="${repository}/releases/download/v${version}/wetmytt-${version}-mac-${arch}.dmg"`));
    assert(!html.includes('{{'));
    assert(html.includes(`href="${repository}/releases/tag/v${version}"`));
  }
});

test('missing, duplicate, unfinished, or redirected installers stop the build', () => {
  const invalid = release('0.3.2');
  invalid.assets.pop();
  assert.throws(() => renderWebsite(template, invalid), /x64 DMG/);
  for (const mutate of [
    data => data.assets.push(data.assets[0]),
    data => { data.assets[0].state = 'new'; },
    data => { data.assets[0].browser_download_url = 'https://example.com/installer.dmg'; },
  ]) {
    const data = release('0.3.2');
    mutate(data);
    assert.throws(() => renderWebsite(template, data), /arm64 DMG/);
  }
});

test('drafts and prereleases cannot become landing page downloads', () => {
  for (const overrides of [{ draft: true }, { prerelease: true }, { tag_name: 'v1.0.0-beta.1' }]) {
    assert.throws(() => renderWebsite(template, { ...release('0.3.2'), ...overrides }), /stable release/);
  }
});

test('project paths and custom domains get correct escaped metadata', () => {
  const html = renderWebsite(template, release('0.3.2'), 'https://example.com/a&b');
  assert(html.includes('href="https://example.com/a&amp;b/"'));
  assert(html.includes('content="https://example.com/a&amp;b/assets/workspace.jpg"'));
  assert(html.includes('href="styles.css"'));
  assert(html.includes('src="assets/workspace.jpg"'));
  assert.throws(() => renderWebsite(template, release('0.3.2'), 'javascript:alert(1)'), /site URL/);
  assert.throws(() => renderWebsite('{{UNKNOWN}}', release('0.3.2')), /Unknown website placeholder/);
});
