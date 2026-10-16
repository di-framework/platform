/**
 * Test fixtures for code that talks to the tenant controller contract, published as
 * `@di-framework/tenant-cli/testing`. Kept apart from `./client` so test code never ships in the
 * client entry, and type-only against it so it adds no runtime dependency.
 */
export { deployBundle } from './deploy-bundle';
