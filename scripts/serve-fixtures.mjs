// Serves fixtures/ on http://127.0.0.1:4410 for manual audits:
//   node scripts/serve-fixtures.mjs
//   node dist/cli.js http://127.0.0.1:4410/broken/toolbar.html
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const port = Number(process.env.PORT ?? 4410);

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^([/\\])+/, '');
  const file = join(root, path);
  if (!file.startsWith(root)) return res.writeHead(403).end();
  try {
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file));
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`fixtures on http://127.0.0.1:${port}/`));
