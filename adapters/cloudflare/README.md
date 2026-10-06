# @di-framework/cloudflare

Cloudflare Workers connector for `@di-framework`. It classifies Worker bindings, reads wrangler declarations, and injects them through the DI container.

Worker bindings arrive on the request `env` object. Register factories at startup, then publish `env` from the handler before resolving services.

## Features

- **Runtime detection**: `CloudflareDetector` matches the Workers user agent and `CF_PAGES=1`.
- **Binding classification** for KV, D1, R2, Durable Object namespaces, Queues, service bindings, Workers AI, Hyperdrive, Vectorize, Analytics Engine, Images, Workflows, rate limits, browsers, pipelines, and plain vars.
- **Wrangler declarations** for kinds whose host objects look alike: assets, email, dispatch namespaces, Secrets Store, and mTLS certificates. Also `vars`.
- **DI integration**:
  - `@CloudflareBinding('BINDING_NAME')` for parameter and property injection
  - `@EnableCloudflareBindings()` for container-wide lazy factories
  - `setCloudflareBindings(env)` from the Worker handler
- **Local fallback**: `CLOUDFLARE_BINDINGS` JSON, or an object passed as `localFallback`, when no Worker env is published.
- **Custom classifiers** through `BindingClassifierRegistry`.

## Installation

```bash
bun add @di-framework/cloudflare
```

## Quick start

```typescript
import { Container } from '@di-framework/core/decorators';
import {
  CloudflareBinding,
  type D1BindingInfo,
  EnableCloudflareBindings,
  type KvBindingInfo,
  setCloudflareBindings,
} from '@di-framework/cloudflare';

@EnableCloudflareBindings()
@Container()
export class OrderService {
  @CloudflareBinding('ORDERS')
  db!: D1BindingInfo;

  @CloudflareBinding('SESSIONS')
  sessions!: KvBindingInfo;

  async cart(id: string) {
    return this.sessions.binding?.get(id);
  }
}

export default {
  async fetch(request: Request, env: Record<string, unknown>) {
    setCloudflareBindings(env);
    const orders = new OrderService();
    const cart = await orders.cart(new URL(request.url).pathname);
    return new Response(cart == null ? 'empty' : String(cart));
  },
};
```

Call `setCloudflareBindings(env)` before the first read of an injected property. Property getters keep the first value they resolve.

## Programmatic discovery

```typescript
import { CloudflareEnvironment } from '@di-framework/cloudflare';

const cf = new CloudflareEnvironment({ bindings: env });

const db = cf.getD1Binding('ORDERS');
const sessions = cf.getKvBinding('SESSIONS');
const bucket = cf.getR2Binding();
```

`getKvBinding()` without a name returns the first KV binding in name order. The same pattern exists for D1, R2, Durable Objects, queues, service bindings, AI, Hyperdrive, Vectorize, and Analytics Engine.

## Use with `@di-framework/ai`

`WorkersAiChatModel` and `WorkersAiEmbeddingModel` take the Workers AI binding. `VectorizeVectorStore` takes the Vectorize binding. A function reads the env published by `setCloudflareBindings`.

```typescript
import { configureAi, VectorizeVectorStore, WorkersAiChatModel, WorkersAiEmbeddingModel } from '@di-framework/ai';
import { getCloudflareBindings, setCloudflareBindings } from '@di-framework/cloudflare';

configureAi({
  chatModel: new WorkersAiChatModel({
    binding: () => getCloudflareBindings()?.AI,
    model: '@cf/meta/llama-3.1-8b-instruct',
  }),
});

export default {
  fetch(request: Request, env: Record<string, unknown>) {
    setCloudflareBindings(env);
    const embeddings = WorkersAiEmbeddingModel.of(() => env.AI);
    const store = new VectorizeVectorStore({
      index: () => env.VECTORS,
      embeddingModel: embeddings,
    });
    return new Response(String(store.name));
  },
};
```

`@CloudflareBinding('AI')` injects `{ binding }`, which both models accept directly.

String bindings are vars. Names listed in `secretNames` are secrets. `kindHints` forces a kind when the live object is ambiguous:

```typescript
new CloudflareEnvironment({
  bindings: env,
  secretNames: ['API_TOKEN'],
  kindHints: { ASSETS: 'assets', SECRETS: 'secrets-store' },
});
```

A parsed wrangler config (JSON, not JSONC) supplies those kinds too. `parseWranglerBindings(config)` reads `kv_namespaces`, `d1_databases`, `r2_buckets`, `durable_objects`, queue producers, `services`, `ai`, `hyperdrive`, `vectorize`, `analytics_engine_datasets`, `ratelimits`, `workflows`, `send_email`, `pipelines`, `dispatch_namespaces`, `secrets_store_secrets`, `mtls_certificates`, `browser`, `images`, `assets`, and `vars`.

Outside Workers, a JSON object in `CLOUDFLARE_BINDINGS` fills the same map. Set `localFallback: false` to require a published Worker env.

## Custom classifiers

```typescript
import {
  type CloudflareBindingClassifier,
  getDefaultRegistry,
  type CloudflareBindingInfo,
} from '@di-framework/cloudflare';

class FlagClassifier implements CloudflareBindingClassifier {
  readonly kind = 'unknown' as const;

  accept(_name: string, value: unknown): boolean {
    return typeof value === 'object' && value !== null && 'flag' in value;
  }

  create(name: string, value: unknown): CloudflareBindingInfo {
    return { name, kind: 'unknown', binding: value };
  }
}

getDefaultRegistry().register(new FlagClassifier());
```

The default priority is `high`, so the classifier runs before the built-ins. `{ priority: 'low' }` runs after them.

## License

Licensed under either [MIT](../../LICENSE-MIT) or [Apache-2.0](../../LICENSE-APACHE), at your option.
