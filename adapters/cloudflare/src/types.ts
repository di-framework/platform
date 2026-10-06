/**
 * Binding kinds recognized by duck-typing or a wrangler config declaration.
 * Ambiguous host objects (secrets store, email, assets) stay `unknown` until
 * a wrangler declaration or `kindHints` entry names them.
 */
export const CLOUDFLARE_BINDING_KINDS = [
  'kv',
  'd1',
  'r2',
  'durable-object',
  'queue',
  'service',
  'assets',
  'ai',
  'hyperdrive',
  'vectorize',
  'analytics',
  'ratelimit',
  'workflow',
  'images',
  'browser',
  'pipeline',
  'email',
  'dispatch-namespace',
  'secrets-store',
  'mtls',
  'var',
  'secret',
  'unknown',
] as const;

export type CloudflareBindingKind = (typeof CLOUDFLARE_BINDING_KINDS)[number];

export interface CloudflareBindingInfo<T = unknown> {
  readonly name: string;
  readonly kind: CloudflareBindingKind;
  /** Live Workers binding. Absent when only a wrangler declaration was available. */
  readonly binding?: T;
  /** Fields copied from the wrangler declaration, when one matched this name. */
  readonly config?: Readonly<Record<string, unknown>>;
}

export interface KvNamespaceBinding {
  get(key: string, typeOrOptions?: unknown): Promise<unknown>;
  put(key: string, value: unknown, options?: unknown): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  list(options?: unknown): Promise<unknown>;
}

export interface KvBindingInfo extends CloudflareBindingInfo<KvNamespaceBinding> {
  readonly kind: 'kv';
}

export interface D1PreparedStatementBinding {
  bind(...values: unknown[]): D1PreparedStatementBinding;
  first<T = unknown>(column?: string): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: readonly T[] }>;
  run(): Promise<unknown>;
  raw<T = unknown>(): Promise<T[]>;
}

export interface D1DatabaseBinding {
  prepare(query: string): D1PreparedStatementBinding;
  batch<T = unknown>(statements: readonly D1PreparedStatementBinding[]): Promise<T[]>;
  exec(query: string): Promise<unknown>;
}

export interface D1BindingInfo extends CloudflareBindingInfo<D1DatabaseBinding> {
  readonly kind: 'd1';
}

export interface R2BucketBinding {
  head(key: string): Promise<unknown>;
  get(key: string, options?: unknown): Promise<unknown>;
  put(key: string, value: unknown, options?: unknown): Promise<unknown>;
  delete(keys: string | readonly string[]): Promise<unknown>;
  list(options?: unknown): Promise<unknown>;
}

export interface R2BindingInfo extends CloudflareBindingInfo<R2BucketBinding> {
  readonly kind: 'r2';
}

export interface DurableObjectNamespaceBinding {
  get(id: unknown): unknown;
  idFromName(name: string): unknown;
  idFromString(id: string): unknown;
  newUniqueId(options?: unknown): unknown;
}

export interface DurableObjectBindingInfo
  extends CloudflareBindingInfo<DurableObjectNamespaceBinding> {
  readonly kind: 'durable-object';
}

export interface QueueBinding {
  send(message: unknown, options?: unknown): Promise<unknown>;
  sendBatch(messages: readonly unknown[], options?: unknown): Promise<unknown>;
}

export interface QueueBindingInfo extends CloudflareBindingInfo<QueueBinding> {
  readonly kind: 'queue';
}

export interface FetcherBinding {
  fetch(input: unknown, init?: unknown): Promise<unknown>;
}

export interface ServiceBindingInfo extends CloudflareBindingInfo<FetcherBinding> {
  readonly kind: 'service';
}

export interface AiBinding {
  run(model: string, inputs: unknown, options?: unknown): Promise<unknown>;
}

export interface AiBindingInfo extends CloudflareBindingInfo<AiBinding> {
  readonly kind: 'ai';
}

export interface HyperdriveBinding {
  readonly connectionString: string;
  readonly host?: string;
  readonly port?: number;
  readonly user?: string;
  readonly password?: string;
  readonly database?: string;
}

export interface HyperdriveBindingInfo extends CloudflareBindingInfo<HyperdriveBinding> {
  readonly kind: 'hyperdrive';
  readonly connectionString: string;
}

export interface VectorizeBinding {
  query(vector: unknown, options?: unknown): Promise<unknown>;
  upsert(vectors: readonly unknown[]): Promise<unknown>;
}

export interface VectorizeBindingInfo extends CloudflareBindingInfo<VectorizeBinding> {
  readonly kind: 'vectorize';
}

export interface AnalyticsBinding {
  writeDataPoint(event: unknown): void;
}

export interface AnalyticsBindingInfo extends CloudflareBindingInfo<AnalyticsBinding> {
  readonly kind: 'analytics';
}

export interface BindingFilter {
  readonly name?: string | RegExp;
  readonly kind?: CloudflareBindingKind;
  readonly predicate?: (binding: CloudflareBindingInfo) => boolean;
}

export interface CloudflareBindingOptions {
  /** Worker `env` object. When omitted, the adapter reads `setCloudflareBindings`. */
  readonly bindings?: Readonly<Record<string, unknown>>;
  /** Parsed wrangler config object, or a JSON string of one. */
  readonly config?: unknown;
  /** Environment dictionary used for `CLOUDFLARE_BINDINGS` and `fallbackEnv`. */
  readonly env?: Record<string, string | undefined>;
  /** String bindings whose names are Worker secrets rather than `[vars]`. */
  readonly secretNames?: readonly string[];
  /** Explicit kinds for host objects whose shape is ambiguous. */
  readonly kindHints?: Readonly<Record<string, CloudflareBindingKind>>;
  /**
   * Local stand-in used when no Worker env was published.
   * `true` (default) reads `CLOUDFLARE_BINDINGS` JSON. An object is used as the env.
   */
  readonly localFallback?: boolean | Readonly<Record<string, unknown>>;
  /** Environment variable key or keys used when the named binding is absent. */
  readonly fallbackEnv?: string | readonly string[];
  /** When false, a missing binding resolves to `undefined` instead of throwing. Defaults to required. */
  readonly required?: boolean;
  /** Returned as-is when the binding is missing and `required` is not true. */
  readonly defaultValue?: unknown;
  readonly container?: unknown;
  readonly registry?: unknown;
}

export interface EnableCloudflareBindingsOptions extends CloudflareBindingOptions {}

export interface WranglerBindingDeclaration {
  readonly name: string;
  readonly kind: CloudflareBindingKind;
  readonly config: Readonly<Record<string, unknown>>;
}
