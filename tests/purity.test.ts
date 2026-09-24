import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('sim core purity (§0.7, §17)', () => {
  const files = walk('src/sim').filter((f) => f.endsWith('.ts'));
  it.each(files)('%s has no forbidden randomness, wall clock, DOM or renderer imports', (f) => {
    const src = readFileSync(f, 'utf8');
    expect(src).not.toMatch(/Math\.random/);
    expect(src).not.toMatch(/Date\.now|new Date\(/);
    expect(src).not.toMatch(/from ['"](three|node:)/);
    expect(src).not.toMatch(/\b(window|document)\./);
  });
});
