import { Postgres } from './bindings/postgres';
import {
  defineBindingMetadata,
  isWitIdentifier,
  rejectsPlaintextSecret,
  type WasmCloudBindingOptions,
} from './metadata';

export type { WasmCloudBindingOptions };

/**
 * Declares a named wasmCloud host-interface binding on a concrete class.
 * Class identity is the DI token; `name` is the WIT import and hostInterfaces name.
 */
export function WasmCloudBinding(name: string, options: WasmCloudBindingOptions = {}) {
  // biome-ignore lint/suspicious/noExplicitAny: class decorator constructor
  return <T extends { new (...args: any[]): object }>(ctor: T): T => {
    if (!isWitIdentifier(name)) {
      throw new Error(
        `WasmCloud binding name "${name}" must be a WIT identifier matching /^[a-z][a-z0-9-]*$/`,
      );
    }
    if (options.serviceName !== undefined) {
      if (
        typeof options.serviceName !== 'string' ||
        !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(options.serviceName) ||
        options.serviceName.length > 40
      )
        throw new Error('serviceName must be a DNS label of at most 40 characters');
      if (!(ctor.prototype instanceof Postgres))
        throw new Error('serviceName is currently supported only for Postgres');
      if (
        options.config !== undefined ||
        options.configFrom !== undefined ||
        options.secretFrom !== undefined
      )
        throw new Error('serviceName cannot be combined with manual connection configuration');
      if (name.length > 54 || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name))
        throw new Error(
          'Managed PostgreSQL binding names must be DNS labels of at most 54 characters',
        );
    }
    const secretProblem = rejectsPlaintextSecret(options.config);
    if (secretProblem !== undefined) {
      throw new Error(`WasmCloud binding "${name}": ${secretProblem}`);
    }
    defineBindingMetadata(ctor, { name, options });
    return ctor;
  };
}
