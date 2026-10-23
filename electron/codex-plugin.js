import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const pluginName = 'wetmytt';
const sourcePath = './.agents/plugins/wetmytt';
const iconPath = new URL('./assets/icon.svg', import.meta.url);

async function atomicWrite(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, value, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, filename);
  } finally { await fs.rm(temporary, { force: true }); }
}
const json = value => `${JSON.stringify(value, null, 2)}\n`;

// A personal marketplace resolves source paths from the user's home directory.
// Keep this installation private: its MCP configuration contains a local token.
export async function prepareCodexPlugin({ url, token, homeDirectory = os.homedir() }) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/mcp' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !token) throw new Error('Invalid local agent connection.');
  const marketplaceDirectory = path.join(homeDirectory, '.agents', 'plugins');
  const marketplacePath = path.join(marketplaceDirectory, 'marketplace.json');
  const pluginDirectory = path.join(marketplaceDirectory, pluginName);
  await fs.mkdir(marketplaceDirectory, { recursive: true });
  let lock;
  try { lock = await fs.open(`${marketplacePath}.lock`, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Your personal plugin marketplace is being updated. Try again when that update finishes.');
    throw error;
  }
  try {
    let marketplace;
    try { marketplace = JSON.parse(await fs.readFile(marketplacePath, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Could not read your personal plugin marketplace. Fix its JSON before connecting; it has not been replaced.');
      marketplace = { name: 'wetmytt-local', interface: { displayName: 'My Local Plugins' }, plugins: [] };
    }
    if (!marketplace || typeof marketplace.name !== 'string' || !marketplace.name.trim() || !Array.isArray(marketplace.plugins)) throw new Error('Your personal plugin marketplace has an unsupported format. It has not been replaced.');
    const previous = marketplace.plugins.find(entry => entry?.name === pluginName);
    if (previous && previous.source !== sourcePath && (previous.source?.source !== 'local' || previous.source?.path !== sourcePath)) throw new Error('Another plugin named wetmytt already exists in your personal marketplace. Rename that entry before connecting.');
    // Do not replace a folder belonging to a separately installed plugin.
    const ownerFile = path.join(pluginDirectory, '.wetmytt-generated');
    try {
      const entries = await fs.readdir(pluginDirectory);
      if (entries.length && (await fs.readFile(ownerFile, 'utf8').catch(() => '')) !== '1\n') throw new Error('The local wetmytt plugin folder already contains other files. Move it before connecting.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.mkdir(path.join(pluginDirectory, '.codex-plugin'), { recursive: true, mode: 0o700 });
    await fs.chmod(pluginDirectory, 0o700);
    await fs.mkdir(path.join(pluginDirectory, 'assets'), { recursive: true });
    const manifest = {
      name: pluginName, version: '0.1.0', description: 'Read, edit, and capture slides in the presentation open in Welcome to My TED Talk.',
      mcpServers: './.mcp.json', requires_local_executor: true,
      interface: {
        displayName: 'Welcome to My TED Talk', shortDescription: 'Work with your open presentation',
        longDescription: 'Read and edit presentation files and capture slide screenshots through the running desktop app. Open a presentation before starting a Codex session. Reconnect after switching presentations.',
        developerName: 'Welcome to My TED Talk', category: 'Productivity', capabilities: ['Read', 'Write'],
        defaultPrompt: ['Review the open presentation and suggest improvements.'],
        brandColor: '#5b38b8', composerIcon: './assets/icon.svg', logo: './assets/icon.svg',
      },
    };
    await atomicWrite(ownerFile, '1\n');
    await atomicWrite(path.join(pluginDirectory, '.codex-plugin', 'plugin.json'), json(manifest));
    await atomicWrite(path.join(pluginDirectory, '.mcp.json'), json({ mcpServers: { wetmytt: { url, http_headers: { Authorization: `Bearer ${token}` } } } }));
    await atomicWrite(path.join(pluginDirectory, 'assets', 'icon.svg'), await fs.readFile(iconPath));
    const entry = { ...previous, name: pluginName, source: { source: 'local', path: sourcePath }, category: 'Productivity', policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', ...previous?.policy } };
    marketplace.plugins = previous ? marketplace.plugins.map(item => item === previous ? entry : item) : [...marketplace.plugins, entry];
    await atomicWrite(marketplacePath, json(marketplace));
    return { marketplacePath, pluginDirectory, link: `codex://plugins/${pluginName}?marketplacePath=${encodeURIComponent(marketplacePath)}` };
  } finally {
    await lock.close();
    await fs.rm(`${marketplacePath}.lock`, { force: true });
  }
}

export async function connectCodex({ openExternal, ...options }) {
  const result = await prepareCodexPlugin(options);
  try { await openExternal(result.link); return { opened: true }; }
  catch { return { opened: false, error: 'The plugin is ready, but Codex could not be opened. Install or open Codex Desktop, then try again.' }; }
}
