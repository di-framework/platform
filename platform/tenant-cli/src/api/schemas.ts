/**
 * Component schemas of the tenant controller API (`/v1`). Every endpoint's request and response
 * references one of these; `scripts/generate-openapi.ts` publishes them under
 * `components.schemas` so the document is self-contained and `openapi-typescript` can type it.
 */

const string = { type: 'string' } as const;
const dateTime = { type: 'string', format: 'date-time' } as const;
const integer = { type: 'integer', format: 'int32' } as const;

/** The environment every workload command is scoped to. */
export const Environment = { type: 'string', enum: ['prod', 'staging'] } as const;

export const schemas = {
  Empty: { type: 'object' },

  Problem: {
    type: 'object',
    description: 'RFC 9457 problem details; every error response uses it.',
    properties: {
      type: string,
      title: string,
      status: integer,
      detail: string,
    },
    required: ['title', 'status'],
  },

  AuthInfo: {
    type: 'object',
    description:
      'What a CLI needs before it holds a credential: the account this controller serves and the identity server to log in with.',
    properties: {
      account: string,
      issuer: { type: 'string', format: 'uri' },
      clientId: string,
    },
    required: ['account', 'issuer', 'clientId'],
  },

  Principal: {
    type: 'object',
    properties: {
      user: string,
      account: string,
      role: { type: 'string', enum: ['developer', 'viewer'] },
      via: { type: 'string', enum: ['identity', 'api-key'] },
      credentialId: string,
    },
    required: ['user', 'account', 'role', 'via'],
  },

  ComponentReference: {
    type: 'object',
    description: 'The built component the controller pulls from the platform registry.',
    properties: {
      reference: { type: 'string', description: 'OCI reference the component was pushed as.' },
      digest: { type: 'string', description: 'sha256 digest of the pushed artifact.' },
    },
    required: ['reference', 'digest'],
  },

  Binding: {
    type: 'object',
    description: 'One `@WasmCloudBinding` of the component, rendered by the CLI.',
    properties: {
      name: string,
      capability: string,
      serviceName: { type: 'string', description: 'Backing service the binding attaches to.' },
      config: { type: 'object', additionalProperties: string },
    },
    required: ['name', 'capability'],
  },

  DeployBundle: {
    type: 'object',
    description:
      'Everything the CLI renders client-side. The controller validates it at the boundary and never receives a kubeconfig or a namespace.',
    properties: {
      env: Environment,
      service: { type: 'string', description: 'Service the deployment belongs to.' },
      component: { $ref: '#/components/schemas/ComponentReference' },
      workload: {
        type: 'object',
        description:
          'The rendered WorkloadDeployment template, without namespace or host selector.',
        additionalProperties: true,
      },
      bindings: { type: 'array', items: { $ref: '#/components/schemas/Binding' } },
      secrets: {
        type: 'array',
        description: 'Names of tenant secrets the workload references; values never travel.',
        items: string,
      },
    },
    required: ['env', 'service', 'component', 'workload', 'bindings', 'secrets'],
  },

  RegistryInfo: {
    type: 'object',
    description:
      "Where a tenant pushes and pulls images: the tenant's own OCI registry. Log in with an identity-server access token or API key as the Basic password.",
    properties: {
      url: { type: 'string', format: 'uri', description:
          "Origin of the tenant's OCI registry: scheme + host[:port], no path. Clients use its host[:port] for login and in image references; an http: origin means plain HTTP.",
      },
      repositoryPrefix: {
        type: 'string',
        description: 'Namespace inside the tenant registry, when there is one.',
      },
      auth: {
        type: 'string',
        enum: ['basic-identity'],
        description:
          'Basic auth whose password is an identity-server access token or dik_ API key.',
      },
      username: {
        type: 'string',
        description: 'A fixed hint for the Basic username; the registry ignores it.',
      },
    },
    required: ['url', 'auth', 'username'],
  },

  DeployChange: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['create', 'update', 'unchanged', 'delete'] },
      resource: string,
      name: string,
      detail: string,
    },
    required: ['kind', 'resource', 'name'],
  },

  DeployPlan: {
    type: 'object',
    description: 'What applying the bundle would change.',
    properties: {
      env: Environment,
      service: string,
      changes: { type: 'array', items: { $ref: '#/components/schemas/DeployChange' } },
    },
    required: ['env', 'service', 'changes'],
  },

  Deployment: {
    type: 'object',
    properties: {
      id: string,
      service: string,
      env: Environment,
      status: { type: 'string', enum: ['pending', 'rolling', 'ready', 'failed', 'rolled-back'] },
      component: { $ref: '#/components/schemas/ComponentReference' },
      createdAt: dateTime,
      readyAt: dateTime,
    },
    required: ['id', 'service', 'env', 'status', 'component', 'createdAt'],
  },

  DeploymentList: {
    type: 'object',
    properties: {
      items: { type: 'array', items: { $ref: '#/components/schemas/Deployment' } },
    },
    required: ['items'],
  },

  DeploymentStats: {
    type: 'object',
    properties: {
      env: Environment,
      services: integer,
      deployments: integer,
      ready: integer,
      failed: integer,
      lastDeployedAt: dateTime,
    },
    required: ['env', 'services', 'deployments', 'ready', 'failed'],
  },

  RollbackRequest: {
    type: 'object',
    properties: {
      env: Environment,
      service: string,
      to: {
        type: 'string',
        description: 'Deployment id to roll back to; the previous one when absent.',
      },
    },
    required: ['env', 'service'],
  },

  CreateServiceRequest: {
    type: 'object',
    description:
      'Type-specific fields follow the type: `port` and `route` for http, `schedule` for cron, `command` for worker.',
    properties: {
      env: Environment,
      type: { type: 'string', enum: ['http', 'cron', 'worker'] },
      name: string,
      port: integer,
      route: { type: 'string', description: 'Public route pattern for an http service.' },
      schedule: { type: 'string', description: 'Cron expression for a cron service.' },
      command: { type: 'array', items: string, description: 'Entry command of a worker service.' },
    },
    required: ['env', 'type', 'name'],
  },

  Service: {
    type: 'object',
    properties: {
      name: string,
      env: Environment,
      type: { type: 'string', enum: ['http', 'cron', 'worker'] },
      route: string,
      port: integer,
      schedule: string,
      command: { type: 'array', items: string },
      createdAt: dateTime,
    },
    required: ['name', 'env', 'type', 'createdAt'],
  },

  LogEvent: {
    type: 'object',
    description:
      'One line of a service log. Streamed as `text/event-stream`: each SSE `data:` field is one LogEvent as JSON; the `event:` field is `log`, or `end` when the stream closes.',
    properties: {
      timestamp: dateTime,
      deployment: string,
      instance: string,
      level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] },
      message: string,
    },
    required: ['timestamp', 'deployment', 'message'],
  },

  ConfigEntry: {
    type: 'object',
    description: 'A secret lists its name only; a var also carries its value.',
    properties: {
      name: string,
      value: string,
      updatedAt: dateTime,
    },
    required: ['name', 'updatedAt'],
  },

  ConfigList: {
    type: 'object',
    properties: {
      env: Environment,
      items: { type: 'array', items: { $ref: '#/components/schemas/ConfigEntry' } },
    },
    required: ['env', 'items'],
  },

  SecretEntry: {
    type: 'object',
    description: 'A secret lists its name and update time only; its value never travels on read.',
    properties: {
      name: string,
      updatedAt: dateTime,
    },
    required: ['name', 'updatedAt'],
    additionalProperties: false,
  },

  SecretList: {
    type: 'object',
    properties: {
      env: Environment,
      items: { type: 'array', items: { $ref: '#/components/schemas/SecretEntry' } },
    },
    required: ['env', 'items'],
  },

  ConfigValue: {
    type: 'object',
    properties: {
      value: string,
    },
    required: ['value'],
  },

  ProxyRequest: {
    type: 'object',
    properties: {
      env: Environment,
      port: {
        ...integer,
        description: 'Service port to tunnel to; the service default when absent.',
      },
    },
    required: ['env'],
  },

  ProxySession: {
    type: 'object',
    description:
      'A short-lived tunnel to one service. The CLI connects to `url` with the same bearer; the tunnel transport is WebSocket and is described outside this document.',
    properties: {
      url: { type: 'string', format: 'uri' },
      port: integer,
      expiresAt: dateTime,
    },
    required: ['url', 'port', 'expiresAt'],
  },
} as const;
