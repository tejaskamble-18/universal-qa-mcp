import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export const FIXTURES_DIR = resolve(import.meta.dirname, '..', '..', 'fixtures');

/** Static server for fixtures/, bound to loopback on a random port. */
export async function startFixtureServer(root = FIXTURES_DIR): Promise<{ url: (path: string) => string; close: () => Promise<void> }> {
  const server: Server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^([/\\])+/, '');
    const file = join(root, path);
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: (p: string) => `http://127.0.0.1:${port}/${p.replace(/^\//, '')}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
