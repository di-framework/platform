import { requireGuest, tryGetGuest } from '../guests';
import { getBindingMetadata } from '../metadata';

export type ConfigGuest = {
  get(key: string): Promise<string | undefined> | string | undefined;
  getAll(): Promise<Array<[string, string]>> | Array<[string, string]>;
};

export class Config {
  readonly bindingName: string;
  protected readonly guest: ConfigGuest | undefined;

  constructor(guest?: ConfigGuest) {
    this.bindingName = getBindingMetadata(this.constructor)?.name ?? 'config';
    this.guest = guest ?? tryGetGuest<ConfigGuest>(this.bindingName);
  }

  get(key: string): Promise<string | undefined> | string | undefined {
    return requireGuest(this.guest, this.bindingName).get(key);
  }

  getAll(): Promise<Array<[string, string]>> | Array<[string, string]> {
    return requireGuest(this.guest, this.bindingName).getAll();
  }
}
