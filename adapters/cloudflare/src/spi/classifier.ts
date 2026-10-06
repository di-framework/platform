import type { CloudflareBindingInfo, CloudflareBindingKind } from '../types';

/**
 * Converts one Worker `env` entry into a typed binding descriptor.
 * The first classifier whose `accept` returns true wins.
 */
export interface CloudflareBindingClassifier<
  T extends CloudflareBindingInfo = CloudflareBindingInfo,
> {
  readonly kind: CloudflareBindingKind;
  accept(name: string, value: unknown): boolean;
  create(name: string, value: unknown): T;
}
