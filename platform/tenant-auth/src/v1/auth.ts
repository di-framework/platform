import { notImplemented, type V1Module } from './context.ts';

/**
 * `/v1/auth/*`. The controller answers these itself (`authInfo` before authentication, and
 * `logout` without a request body), so these stubs are only reached if that changes.
 */
export const auth: V1Module = {
  authInfo: notImplemented('authInfo'),
  whoami: notImplemented('whoami'),
  logout: notImplemented('logout'),
};
