import { requireGuest, tryGetGuest } from '../guests';
import { getBindingMetadata } from '../metadata';

export type PostgresGuest = {
  query(query: string, params: readonly unknown[]): Promise<unknown>;
  queryBatch(query: string): Promise<unknown>;
};

export class Postgres {
  readonly bindingName: string;
  protected readonly guest: PostgresGuest | undefined;

  constructor(guest?: PostgresGuest) {
    this.bindingName = getBindingMetadata(this.constructor)?.name ?? 'postgres';
    this.guest = guest ?? tryGetGuest<PostgresGuest>(this.bindingName);
  }

  query(query: string, params: readonly unknown[] = []): Promise<unknown> {
    return requireGuest(this.guest, this.bindingName).query(query, params);
  }

  queryBatch(query: string): Promise<unknown> {
    return requireGuest(this.guest, this.bindingName).queryBatch(query);
  }
}
