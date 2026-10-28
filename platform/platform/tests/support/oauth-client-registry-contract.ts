import { beforeEach, describe, expect, it } from 'bun:test';
import {
  OAuthAdminError,
  OAuthClientConflict,
  OAuthClientNotFound,
  type OAuthClientRegistry,
  type OAuthClientSpec,
} from '../../src/tenancy/oauth-clients';

/** What the contract runs against. */
export interface OAuthClientRegistryTarget {
  registry: OAuthClientRegistry;
  /** An organization that exists on the target (#48 may require one); default `acme`. */
  organizationSlug?: string;
  /** Raw authenticated requests to the admin API, for cases the seam cannot express. */
  request?: (path: string, init: RequestInit) => Promise<Response>;
}

/**
 * The behavior every {@link OAuthClientRegistry} must show (#59). It runs against the fake admin
 * API by default. Every case uses fresh, random client ids, so it also runs against a persistent
 * identity server that keeps revoked ids; see `oauth-clients.test.ts` (`IDENTITY_ADMIN_URL`).
 * Cases marked `#48 provisional` follow `PROVISIONAL_48`.
 */
export function describeOAuthClientRegistryContract(
  name: string,
  setup: () => OAuthClientRegistryTarget | Promise<OAuthClientRegistryTarget>,
  options: { skip?: boolean } = {},
): void {
  describe.skipIf(Boolean(options.skip))(`OAuthClientRegistry contract: ${name}`, () => {
    let target: OAuthClientRegistryTarget;
    let registry: OAuthClientRegistry;
    let confidential: OAuthClientSpec;
    let publicClient: OAuthClientSpec;
    let missing: string;
    beforeEach(async () => {
      target = await setup();
      registry = target.registry;
      const prefix = `contract-${crypto.randomUUID().slice(0, 8)}`;
      missing = `${prefix}-missing`;
      confidential = {
        clientId: `${prefix}-console`,
        organizationSlug: target.organizationSlug ?? 'acme',
        redirectUris: ['https://acme.example.com/callback'],
        scopes: ['openid', 'profile'],
        audiences: ['https://acme.example.com'],
        public: false,
      };
      publicClient = {
        ...confidential,
        clientId: `${prefix}-cli`,
        redirectUris: ['http://127.0.0.1/callback'],
        public: true,
      };
    });

    it('creates a confidential client with a secret and reads it back', async () => {
      const created = await registry.create(confidential);
      expect(created.clientId).toBe(confidential.clientId);
      expect(created.clientSecret).toBeString();
      const record = await registry.get(confidential.clientId);
      expect(record).toMatchObject(confidential);
      expect(record?.revokedAt).toBeUndefined();
    });

    it('creates a public client without a secret (#48 provisional)', async () => {
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

    it('replays a keyed create with the same secret and refuses the key for another body', async () => {
      const key = `${confidential.clientId}-create`;
      const created = await registry.create(confidential, key);
      expect(await registry.create(confidential, key)).toEqual(created);
      const other = { ...confidential, scopes: ['openid'] };
      await expect(registry.create(other, key)).rejects.toBeInstanceOf(OAuthClientConflict);
    });

    it('rejects ids over 100 characters and organizations over 128', async () => {
      const longId = { ...confidential, clientId: `${confidential.clientId}-${'x'.repeat(100)}` };
      await expect(registry.create(longId)).rejects.toMatchObject({ status: 400 });
      const longSlug = { ...confidential, organizationSlug: 'o'.repeat(129) };
      await expect(registry.create(longSlug)).rejects.toBeInstanceOf(OAuthAdminError);
    });

    it('trims the client id', async () => {
      const padded = { ...confidential, clientId: `  ${confidential.clientId}  ` };
      expect((await registry.create(padded)).clientId).toBe(confidential.clientId);
    });

    it('reports an unknown client as undefined', async () => {
      expect(await registry.get(missing)).toBeUndefined();
    });

    it('rotates a confidential secret, deterministically per key and version', async () => {
      const created = await registry.create(confidential);
      const rotated = await registry.rotate(confidential.clientId, 'v2');
      expect(rotated.clientId).toBe(confidential.clientId);
      expect(rotated.clientSecret).toBeString();
      expect(rotated.clientSecret).not.toBe(created.clientSecret);
      const key = `${confidential.clientId}-rotate`;
      const keyed = await registry.rotate(confidential.clientId, 'v3', key);
      expect(await registry.rotate(confidential.clientId, 'v3', key)).toEqual(keyed);
      const next = await registry.rotate(confidential.clientId, 'v4', key);
      expect(next.clientSecret).not.toBe(keyed.clientSecret);
    });

    it('refuses to rotate unknown and revoked clients', async () => {
      await expect(registry.rotate(missing, 'v2')).rejects.toBeInstanceOf(OAuthClientNotFound);
      await registry.create(confidential);
      await registry.delete(confidential.clientId);
      await expect(registry.rotate(confidential.clientId, 'v2')).rejects.toBeInstanceOf(
        OAuthClientConflict,
      );
    });

    it('refuses to rotate a public client (#48 provisional)', async () => {
      await registry.create(publicClient);
      await expect(registry.rotate(publicClient.clientId, 'v2')).rejects.toBeInstanceOf(
        OAuthClientConflict,
      );
    });

    it('revokes idempotently and keeps the revoked id', async () => {
      await registry.create(confidential);
      await registry.delete(confidential.clientId);
      await registry.delete(confidential.clientId);
      await registry.delete(missing);
      expect((await registry.get(confidential.clientId))?.revokedAt).toBeString();
      await expect(registry.create(confidential)).rejects.toBeInstanceOf(OAuthClientConflict);
    });

    it('validates raw create bodies (HTTP targets)', async () => {
      const post = target.request;
      if (!post) return;
      const create = (body: Record<string, unknown>) =>
        post('/api/admin/oauth-clients', { method: 'POST', body: JSON.stringify(body) });
      const base = {
        clientId: confidential.clientId,
        organizationSlug: confidential.organizationSlug,
      };
      expect((await create({ ...base, browser: true })).status).toBe(400);
      expect((await create(base)).status).toBe(201);
      const read = await post(`/api/admin/oauth-clients/${base.clientId}`, { method: 'GET' });
      expect(await read.json()).toMatchObject({ redirect_uris: [], scopes: [], browser: false });
    });
  });
}
