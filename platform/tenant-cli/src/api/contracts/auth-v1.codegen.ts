import { AuthInfo, Empty, Principal } from './api.schemas.ts';
import { manifest, operation } from './manifest.ts';

const schema = { module: './api.schemas.ts' };

export default manifest(
  'auth',
  '/v1',
  {
    Empty: { schema: Empty, ...schema },
    AuthInfo: { schema: AuthInfo, ...schema },
    Principal: { schema: Principal, ...schema },
  },
  [
    operation(
      'authInfo',
      {
        method: 'GET',
        path: '/auth/info',
        successStatus: 200,
        summary: 'Describe how to log in',
        description:
          'The account this controller serves and the identity server to obtain a credential from. The only unauthenticated operation.',
      },
      'Empty',
      'AuthInfo',
    ),
    operation(
      'whoami',
      {
        method: 'GET',
        path: '/auth/whoami',
        successStatus: 200,
        summary: 'Resolve the caller',
        description: 'The user, role, and credential the bearer token stands for in this account.',
      },
      'Empty',
      'Principal',
    ),
    operation(
      'logout',
      {
        method: 'POST',
        path: '/auth/logout',
        successStatus: 204,
        summary: 'Revoke the credential',
        description:
          'Revokes the bearer token at the identity server (or the API key) so it stops working everywhere.',
      },
      'Empty',
      'Empty',
    ),
  ],
);
