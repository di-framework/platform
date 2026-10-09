import {
  CreateServiceRequest,
  Empty,
  LogEvent,
  ProxyRequest,
  ProxySession,
  Service,
} from './api.schemas.ts';
import { env, manifest, operation, queryParameter } from './manifest.ts';

const schema = { module: './api.schemas.ts' };

export default manifest(
  'services',
  '/v1',
  {
    Empty: { schema: Empty, ...schema },
    CreateServiceRequest: { schema: CreateServiceRequest, ...schema },
    Service: { schema: Service, ...schema },
    LogEvent: { schema: LogEvent, ...schema },
    ProxyRequest: { schema: ProxyRequest, ...schema },
    ProxySession: { schema: ProxySession, ...schema },
  },
  [
    operation(
      'createService',
      {
        method: 'POST',
        path: '/services',
        successStatus: 201,
        summary: 'Create a service',
        description:
          'Creates an http, cron, or worker service in the environment. Type-specific fields follow the type.',
      },
      'CreateServiceRequest',
      'Service',
    ),
    operation(
      'logs',
      {
        method: 'GET',
        path: '/services/:service/logs',
        successStatus: 200,
        summary: 'Read or follow service logs',
        description:
          'Server-sent events (`text/event-stream`). Each `log` event carries one LogEvent as JSON; an `end` event closes the stream. With `follow` the stream stays open until the client disconnects.',
        parameters: [
          env,
          queryParameter('deployment', { type: 'string' }),
          queryParameter('follow', { type: 'boolean', default: false }),
          queryParameter('since', {
            type: 'string',
            description: 'Duration such as 10m or 1h, or an RFC 3339 timestamp.',
          }),
          queryParameter('tail', { type: 'integer', format: 'int32', default: 100 }),
        ],
      },
      'Empty',
      'LogEvent',
    ),
    operation(
      'proxy',
      {
        method: 'POST',
        path: '/services/:service/proxy',
        successStatus: 201,
        summary: 'Open a tunnel to a service',
        description:
          'Issues a short-lived tunnel session to one port of the service. The session URL takes the same bearer.',
      },
      'ProxyRequest',
      'ProxySession',
    ),
  ],
);
