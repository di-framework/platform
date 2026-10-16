/**
 * Resolves a bearer credential presented to the tenant controller into a principal: either an
 * identity-server access token (checked through UserInfo) or a tenant API key. Both must map to
 * a platform User with an active membership of this tenant; the User CR is the revocation point.
 */
import { ApiKeyError, type KeyStore, looksLikeKey, resolveApiKey } from './keys.ts';
import type { KubeClient } from './kube.ts';
import {
  type IdentityClaims,
  ORGANIZATION_ROLES_CLAIM,
  type ProviderMetadata,
  sha256,
  userinfo,
} from './oidc.ts';
import { TtlCache } from './ttl-cache.ts';

export class AuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Principal {
  user: string;
  account: string;
  role: 'developer' | 'viewer';
  via: 'identity' | 'api-key';
  /** identity-server subject for identity logins, API key id otherwise. */
  credentialId: string;
}

const USER_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
/** How long UserInfo claims for an accepted token are reused, capped by the token's `exp`. */
export const CLAIMS_TTL_MS = 60_000;
/** Accepted tokens whose claims are held at once; least recently used are evicted first. */
export const CLAIMS_CACHE_SIZE = 1024;
/** How long a token UserInfo refused stays refused without asking again. */
export const REJECTED_TTL_MS = 5_000;
/**
 * Refused tokens remembered at once. Kept apart from accepted claims so a flood of junk tokens
 * can only evict other junk, never the claims of signed-in users.
 */
export const REJECTED_CACHE_SIZE = 256;
const MEMBERSHIP_TTL_MS = 15_000;

export interface IdentityResolverOptions {
  /** Clock in epoch milliseconds; tests inject a fake one. */
  now?: () => number;
  claimsCacheSize?: number;
  rejectedCacheSize?: number;
}

export class IdentityResolver {
  private readonly now: () => number;
  private readonly claimsCache: TtlCache<IdentityClaims>;
  private readonly rejectedCache: TtlCache<true>;
  private readonly membershipCache = new Map<string, { role: Principal['role']; until: number }>();
  private provider: ProviderMetadata | null;

  constructor(
    private readonly kube: KubeClient,
    provider: ProviderMetadata | null,
    readonly tenant: string,
    private readonly keys: KeyStore,
    options: IdentityResolverOptions = {},
  ) {
    this.provider = provider;
    this.now = options.now ?? Date.now;
    this.claimsCache = new TtlCache(options.claimsCacheSize ?? CLAIMS_CACHE_SIZE, this.now);
    this.rejectedCache = new TtlCache(options.rejectedCacheSize ?? REJECTED_CACHE_SIZE, this.now);
  }

  /** Set the provider after discovery completes. */
  setProvider(provider: ProviderMetadata): void {
    this.provider = provider;
  }

  /** The platform's view: the tenant is live and the User CR holds an active membership. */
  async membership(user: string): Promise<Principal['role']> {
    const cached = this.membershipCache.get(user);
    if (cached && cached.until > this.now()) return cached.role;
    const tenant = await this.kube.getTenant(this.tenant);
    if (!tenant) throw new AuthError(404, `account ${this.tenant} does not exist`);
    if (tenant.spec.suspended) throw new AuthError(403, `account ${this.tenant} is suspended`);
    const resource = await this.kube.getUser(user);
    if (!resource || resource.spec.suspended)
      throw new AuthError(403, `${user} has no active platform user`);
    const found = resource.spec.memberships.find((m) => m.tenant === this.tenant);
    if (!found) throw new AuthError(403, `${user} is not a member of ${this.tenant}`);
    this.membershipCache.set(user, { role: found.role, until: this.now() + MEMBERSHIP_TTL_MS });
    return found.role;
  }

  private async claimsFor(accessToken: string): Promise<IdentityClaims | undefined> {
    if (!this.provider) throw new AuthError(503, 'issuer discovery is not yet complete');
    const id = Buffer.from(await sha256(accessToken)).toString('hex');
    const cached = this.claimsCache.get(id);
    if (cached) return cached;
    if (this.rejectedCache.get(id)) return undefined;
    const claims = await userinfo(this.provider, accessToken);
    const now = this.now();
    if (!claims) {
      this.rejectedCache.set(id, true, now + REJECTED_TTL_MS);
      return undefined;
    }
    // Never outlive the token: claims are dropped at its `exp` when UserInfo reports one.
    const expiresAt = typeof claims.exp === 'number' ? claims.exp * 1000 : Number.POSITIVE_INFINITY;
    if (expiresAt <= now) return undefined;
    this.claimsCache.set(id, claims, Math.min(now + CLAIMS_TTL_MS, expiresAt));
    return claims;
  }

  async resolve(authorization: string | null): Promise<Principal> {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (!token) throw new AuthError(401, 'a bearer token is required');
    if (looksLikeKey(token)) {
      try {
        const key = await resolveApiKey(this.keys, token);
        const role = await this.membership(key.user);
        return { user: key.user, account: this.tenant, role, via: 'api-key', credentialId: key.id };
      } catch (error) {
        if (error instanceof ApiKeyError) throw new AuthError(401, error.message);
        throw error;
      }
    }
    const claims = await this.claimsFor(token);
    if (!claims) throw new AuthError(401, 'the access token is invalid or has expired');
    const user = claims.preferred_username;
    if (!user || !USER_NAME.test(user))
      throw new AuthError(403, 'the signed-in user has no usable login');
    const organizations = claims[ORGANIZATION_ROLES_CLAIM] ?? [];
    if (!organizations.some((o) => o.slug === this.tenant))
      throw new AuthError(403, `${user} is not a member of organization ${this.tenant}`);
    const role = await this.membership(user);
    return { user, account: this.tenant, role, via: 'identity', credentialId: claims.sub };
  }

  /** Drop cached state for a user, for example after a key is revoked. */
  forget(user: string): void {
    this.membershipCache.delete(user);
  }
}
