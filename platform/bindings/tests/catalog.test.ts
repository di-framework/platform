import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BINDING_CATALOG,
  BINDING_KINDS,
  Blobstore,
  Config,
  isBindingKind,
  KeyValue,
  Messaging,
  OutgoingHttp,
  Postgres,
  Secrets,
} from '../src/index.ts';

const CLASSES = {
  Postgres,
  KeyValue,
  Blobstore,
  Messaging,
  Config,
  Secrets,
  OutgoingHttp,
} as const;

describe('BINDING_CATALOG', () => {
  it('covers every exported binding class and kind', () => {
    expect(Object.keys(BINDING_CATALOG).sort()).toEqual([...BINDING_KINDS].sort());
    for (const kind of BINDING_KINDS) {
      expect(isBindingKind(kind)).toBe(true);
      expect(CLASSES[kind]).toBeFunction();
      const entry = BINDING_CATALOG[kind];
      expect(entry.kind).toBe(kind);
      expect(entry.package).toMatch(/^(wasi|wasmcloud):/);
      expect(entry.interfaces).toContain(entry.primaryInterface);
      expect(entry.witDep.length).toBeGreaterThan(0);
    }
    expect(isBindingKind('Database')).toBe(false);
  });

  it('keeps package versions independent of component-model 0.3', () => {
    expect(BINDING_CATALOG.Postgres.version).toBe('0.2.0');
    expect(BINDING_CATALOG.KeyValue.version).toBe('0.2.0');
    expect(BINDING_CATALOG.Messaging.version).toBe('0.3.0');
    expect(BINDING_CATALOG.OutgoingHttp.version).toBe('0.3.0');
  });

  it('ships a JSON catalog matching the TypeScript source', () => {
    const json = JSON.parse(
      readFileSync(join(import.meta.dir, '..', 'catalog.json'), 'utf8'),
    ) as typeof BINDING_CATALOG;
    expect(json).toEqual(BINDING_CATALOG);
  });
});
