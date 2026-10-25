import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { agentDescription, agentLongDescription, projectUrl } from './agent-metadata.js';

export async function prepareClaudeExtension({ url, token, directory }) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/mcp' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !token) throw new Error('Invalid local agent connection.');
  const manifest = {
    manifest_version: '0.3', name: 'wetmytt', display_name: 'Welcome to My TED Talk', version: '0.1.2',
    icon: 'assets/icon.png',
    description: agentDescription, long_description: agentLongDescription,
    author: { name: 'Welcome to My TED Talk', url: projectUrl }, tools_generated: true,
    homepage: projectUrl, documentation: `${projectUrl}#readme`, support: `${projectUrl}/issues`,
    repository: { type: 'git', url: projectUrl },
    server: { type: 'node', entry_point: 'server/bridge.cjs', mcp_config: { command: 'node', args: ['${__dirname}/server/bridge.cjs'] } },
    compatibility: { runtimes: { node: '>=18.0.0' } },
  };
  const archive = zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    'assets/icon.png': new Uint8Array(await fs.readFile(new URL('./assets/icon.png', import.meta.url))),
    'server/bridge.cjs': new Uint8Array(await fs.readFile(new URL('./claude-bridge.cjs', import.meta.url))),
    'server/connection.json': strToU8(JSON.stringify({ url, token })),
  });
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'wetmytt.mcpb');
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, archive, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, filename);
  } finally { await fs.rm(temporary, { force: true }); }
  return { filename };
}

export async function connectClaude({ openPath, ...options }) {
  const { filename } = await prepareClaudeExtension(options);
  try {
    const error = await openPath(filename);
    if (error) throw new Error(error);
    return { opened: true, filename };
  } catch {
    return { opened: false, filename, error: 'The extension is ready, but Claude could not be opened. Install or open Claude Desktop, then install the extension from Settings → Extensions → Advanced settings.' };
  }
}
