import { beforeEach, describe, expect, it } from 'bun:test';
import {
  OAuthClientConflict,
  OAuthClientNotFound,
  type OAuthClientRegistry,
  type OAuthClientSpec,
} from '../../src/tenancy/oauth-clients';

/**
 * The behavior every {@link OAuthClientRegistry} must show (#59). It runs against the fake admin
 * API now; once di-framework/identity-server#48 is released (G05) the same suite runs against the
 * real identity server.
 */
export function describeOAuthClientRegistryContract(
  name: string,
  setup: () => OAuthClientRegistry | Promise<OAuthClientRegistry>,
): void {
  describe(`OAuthClientRegistry contract: ${name}`, () => {
    let registry: OAuthClientRegistry;
    beforeEach(async () => {
      registry = await setup();
    });

    const confidential: OAuthClientSpec = {
      clientId: 'tenant-acme-0a1b2c3d-console',
      organizationSlug: 'acme',
      redirectUris: ['https://acme.example.com/callback'],
      scopes: ['openid', 'profile'],
      audiences: ['https://acme.example.com'],
      public: false,
    };
    const publicClient: OAuthClientSpec = {
      ...confidential,
      clientId: 'tenant-acme-0a1b2c3d-cli',
      redirectUris: ['http://127.0.0.1/callback'],
      public: true,
    };

    it('creates a confidential client with a secret and reads it back', async () => {
      const created = await registry.create(confidential);
      expect(created.clientId).toBe(confidential.clientId);
      expect(created.clientSecret).toBeString();
      const record = await registry.get(confidential.clientId);
      expect(record).toMatchObject(confidential);
      expect(record?.revokedAt).toBeUndefined();
    });

    it('creates a public client without a secret', async () => {
      expect(await registry.create(publicClient)).toEqual({ clientId: publicClient.clientId });
      expect(await registry.get(publicClient.clientId)).toMatchObject({
        public: true,
        audiences: publicClient.audiences,
      });
    });

    it('refuses to create an id that exists', async () => {
      await registry.create(confidential);
      await expect(registry.create(confidential)).rejects.toBeInstanceOf(OAuthClientConflict);
    });

    it('reports an unknown client as undefined', async () => {
      expect(await registry.get('missing')).toBeUndefined();
    });

    it('rotates a confidential secret', async () => {
      const created = await registry.create(confidential);
      const rotated = await registry.rotate(confidential.clientId, 'v2');
      expect(rotated.clientId).toBe(confidential.clientId);
      expect(rotated.clientSecret).toBeString();
      expect(rotated.clientSecret).not.toBe(created.clientSecret);
    });

    it('refuses to rotate unknown, public and revoked clients', async () => {
      await expect(registry.rotate('missing', 'v2')).rejects.toBeInstanceOf(OAuthClientNotFound);
      await registry.create(publicClient);
      await expect(registry.rotate(publicClient.clientId, 'v2')).rejects.toBeInstanceOf(
        OAuthClientConflict,
      );
      await registry.create(confidential);
      await registry.delete(confidential.clientId);
      await expect(registry.rotate(confidential.clientId, 'v2')).rejects.toBeInstanceOf(
        OAuthClientConflict,
      );
    });

    it('revokes idempotently and keeps the revoked id', async () => {
      await registry.create(confidential);
      await registry.delete(confidential.clientId);
      await registry.delete(confidential.clientId);
      await registry.delete('missing');
      expect((await registry.get(confidential.clientId))?.revokedAt).toBeString();
      await expect(registry.create(confidential)).rejects.toBeInstanceOf(OAuthClientConflict);
    });
  });
}
