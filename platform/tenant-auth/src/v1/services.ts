import { notImplemented, type V1Module } from './context.ts';

/** `/v1/services` creation and the service HTTP proxy (platform#56). */
export const services: V1Module = {
  createService: notImplemented('createService'),
  proxy: notImplemented('proxy'),
};
