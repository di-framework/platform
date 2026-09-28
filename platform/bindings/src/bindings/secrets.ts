import { requireGuest, tryGetGuest } from '../guests';
import { getBindingMetadata } from '../metadata';

export type SecretsGuest = {
  get(key: string): Promise<unknown>;
  reveal(secret: unknown): Promise<unknown>;
};

export class Secrets {
  readonly bindingName: string;
  protected readonly guest: SecretsGuest | undefined;

  constructor(guest?: SecretsGuest) {
    this.bindingName = getBindingMetadata(this.constructor)?.name ?? 'secrets';
    this.guest = guest ?? tryGetGuest<SecretsGuest>(this.bindingName);
  }

  get(key: string): Promise<unknown> {
    return requireGuest(this.guest, this.bindingName).get(key);
  }

  reveal(secret: unknown): Promise<unknown> {
    return requireGuest(this.guest, this.bindingName).reveal(secret);
  }
}
