// Copies the in-page scripts (plain JS, evaluated inside the browser) next to
// the compiled code so `dist/` has the same relative layout as `src/`.
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fromDir = join(root, 'src', 'inpage');
const toDir = join(root, 'dist', 'inpage');
mkdirSync(toDir, { recursive: true });
for (const name of readdirSync(fromDir).filter((n) => n.endsWith('.js'))) {
  copyFileSync(join(fromDir, name), join(toDir, name));
  console.log(`copied src/inpage/${name} -> dist/inpage/${name}`);
}
