import { describe, expect, it } from 'bun:test';
import { isWitIdentifier, rejectsPlaintextSecret } from '../src/metadata.ts';

describe('binding metadata helpers', () => {
  it('accepts WIT identifiers and rejects secret-shaped config', () => {
    expect(isWitIdentifier('cache')).toBe(true);
    expect(isWitIdentifier('1cache')).toBe(false);
    expect(rejectsPlaintextSecret(undefined)).toBeUndefined();
    expect(rejectsPlaintextSecret({ backend: 'in-memory' })).toBeUndefined();
    expect(rejectsPlaintextSecret({ token: 'abc' })).toContain('secretFrom');
    expect(rejectsPlaintextSecret({ note: 'password=secret' })).toContain('secretFrom');
  });
});
