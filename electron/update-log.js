import fs from 'node:fs/promises';
import path from 'node:path';
import { inspect } from 'node:util';

// Keep two bounded files. Only updater diagnostics go here, never app/chat data.
export function createUpdateLog(filename, { maxBytes = 1024 * 1024, context = {} } = {}) {
  let pending = Promise.resolve(), writeError;
  const redact = value => String(value)
    .replace(/https?:\/\/[^\s"'<>]+/g, raw => {
      try { const url = new URL(raw); return `${url.origin}${url.pathname}`; }
      catch { return '[URL]'; }
    })
    .replace(/((?:authorization|token|password|cookie)["']?\s*[:=]\s*)[^\r\n]+/gi, '$1[redacted]');
  const logger = {};
  for (const level of ['info', 'warn', 'error', 'debug']) {
    logger[level] = (...values) => {
      const line = JSON.stringify({ time: new Date().toISOString(), level, ...context,
        message: redact(values.map(value => value instanceof Error ? `${value.stack || value.message}\ncode=${value.code || ''}` : typeof value === 'string' ? value : inspect(value)).join(' ')).slice(0, 16000) }) + '\n';
      pending = pending.then(async () => {
        await fs.mkdir(path.dirname(filename), { recursive: true });
        const size = await fs.stat(filename).then(stat => stat.size).catch(error => { if (error.code === 'ENOENT') return 0; throw error; });
        if (size + Buffer.byteLength(line) > maxBytes) await fs.rename(filename, `${filename}.1`);
        await fs.appendFile(filename, line, { mode: 0o600 });
        writeError = undefined;
      }).catch(error => { writeError = error; console.warn('Could not write update log:', error.message); });
    };
  }
  return { logger, flush: async () => { await pending; if (writeError) throw writeError; } };
}
