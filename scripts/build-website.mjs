import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const repository = 'https://github.com/RationalAsh/wetmytt';

export function renderWebsite(template, release, siteUrl = 'https://rationalash.github.io/wetmytt/') {
  if (release.draft !== false || release.prerelease !== false || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) {
    throw new Error('Website downloads require a published stable release');
  }
  const version = release.tag_name.slice(1);
  const releaseUrl = `${repository}/releases/tag/${release.tag_name}`;
  if (release.html_url !== releaseUrl) throw new Error('Unexpected release URL');
  const base = new URL(siteUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('Invalid site URL');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const values = { VERSION: release.tag_name, RELEASE_URL: releaseUrl, SITE_URL: base.href, IMAGE_URL: new URL('assets/workspace.jpg', base).href };
  for (const [key, arch] of [['ARM64_URL', 'arm64'], ['X64_URL', 'x64']]) {
    const name = `wetmytt-${version}-mac-${arch}.dmg`;
    const assets = release.assets?.filter(asset => asset.name === name) ?? [];
    const expectedUrl = `${repository}/releases/download/${release.tag_name}/${name}`;
    if (assets.length !== 1 || assets[0].state !== 'uploaded' || assets[0].browser_download_url !== expectedUrl) {
      throw new Error(`Missing or invalid published ${arch} DMG`);
    }
    values[key] = expectedUrl;
  }
  const escape = value => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`Unknown website placeholder: ${key}`);
    return escape(values[key]);
  });
}

async function main() {
  const { values } = parseArgs({ options: { 'release-json': { type: 'string' } } });
  let release;
  if (values['release-json']) {
    release = JSON.parse(await fs.readFile(values['release-json'], 'utf8'));
  } else {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'wetmytt-website' };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const response = await fetch('https://api.github.com/repos/RationalAsh/wetmytt/releases/latest', { headers, signal: AbortSignal.timeout(30_000), redirect: 'error' });
    if (!response.ok) throw new Error(`Latest release lookup failed: HTTP ${response.status}`);
    release = await response.json();
  }
  const template = await fs.readFile(path.join(root, 'website/index.html'), 'utf8');
  const html = renderWebsite(template, release, process.env.PAGES_BASE_URL);
  const output = path.join(root, 'dist/website');
  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(path.join(output, 'assets'), { recursive: true });
  await fs.writeFile(path.join(output, 'index.html'), html);
  await fs.copyFile(path.join(root, 'website/styles.css'), path.join(output, 'styles.css'));
  await fs.cp(path.join(root, 'website/assets'), path.join(output, 'assets'), { recursive: true });
  await fs.copyFile(path.join(root, 'docs/screenshots/workspace.jpg'), path.join(output, 'assets/workspace.jpg'));
  await fs.copyFile(path.join(root, 'electron/assets/icon.svg'), path.join(output, 'assets/icon.svg'));
  await fs.writeFile(path.join(output, '.nojekyll'), '');
  console.log(`Built dist/website with ${release.tag_name} downloads`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
