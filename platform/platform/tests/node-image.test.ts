import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NODE_IMAGE } from '../src/node-image';
import { STORAGE_MODE_IMAGE } from '../src/tenancy/workload-storage';

describe('NODE_IMAGE', () => {
  it('is the Node image the operator Dockerfile builds on, pinned by digest', () => {
    const dockerfile = readFileSync(join(import.meta.dir, '../../operator/Dockerfile'), 'utf8');
    const bases = [...dockerfile.matchAll(/^FROM (node:\S+)/gm)].map((m) => m[1]);
    expect(bases.length).toBeGreaterThan(0);
    for (const base of bases) expect(base).toBe(NODE_IMAGE);
    expect(NODE_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(STORAGE_MODE_IMAGE).toBe(NODE_IMAGE);
  });
});
