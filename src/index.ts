#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer, defaultDeps } from './server.js';

const deps = defaultDeps();
const handle = serveStdio(() => createServer(deps), {
  onerror: (err) => deps.log(`transport error: ${err.message}`),
});

async function shutdown(): Promise<void> {
  await deps.browsers.close();
  await handle.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.stdin.on('end', () => void deps.browsers.close());
deps.log(`ready; artifacts in ${deps.artifactsRoot}`);
