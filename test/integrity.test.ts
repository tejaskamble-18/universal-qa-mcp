import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '..', 'src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe('test integrity', () => {
  it('the engine never reads the fixtures\' test-oracle markers', () => {
    const leaks = files(SRC).filter((f) => /data-defect|fixtures[\\/](broken|clean)/.test(readFileSync(f, 'utf8')));
    expect(leaks).toEqual([]);
  });
});
