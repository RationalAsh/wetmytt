import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startMcpServer } from '../../electron/mcp.js';
import { screenshotSlide } from '../../electron/screenshot.js';

const [root, directory] = process.argv.slice(2);
app.setPath('userData', directory);
app.setPath('sessionData', directory);
app.dock?.hide();
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const service = await startMcpServer({ port: 0, token: 'test-token', getDeck: () => ({ root, generation: 1 }), screenshotSlide });
  await fs.writeFile(path.join(directory, 'connection.json'), JSON.stringify({ url: service.url }));
  process.on('SIGTERM', () => service.close().finally(() => app.exit()));
}).catch(error => { console.error(error); app.exit(1); });
