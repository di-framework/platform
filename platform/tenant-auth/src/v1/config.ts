import { notImplemented, type V1Module } from './context.ts';

/** `/v1/secrets` and `/v1/vars` (platform#53). */
export const config: V1Module = {
  secrets: notImplemented('secrets'),
  setSecret: notImplemented('setSecret'),
  updateSecret: notImplemented('updateSecret'),
  unsetSecret: notImplemented('unsetSecret'),
  vars: notImplemented('vars'),
  setVar: notImplemented('setVar'),
  updateVar: notImplemented('updateVar'),
  unsetVar: notImplemented('unsetVar'),
};
