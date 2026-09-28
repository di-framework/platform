import { requireGuest, tryGetGuest } from '../guests';
import { getBindingMetadata } from '../metadata';

export type MessagingGuest = {
  publish(message: unknown): Promise<unknown>;
  request(subject: string, body: AsyncIterable<Uint8Array>, timeoutMs?: number): Promise<unknown>;
};

export class Messaging {
  readonly bindingName: string;
  protected readonly guest: MessagingGuest | undefined;

  constructor(guest?: MessagingGuest) {
    this.bindingName = getBindingMetadata(this.constructor)?.name ?? 'messaging';
    this.guest = guest ?? tryGetGuest<MessagingGuest>(this.bindingName);
  }

  publish(message: unknown): Promise<unknown> {
    return requireGuest(this.guest, this.bindingName).publish(message);
  }

  request(subject: string, body: AsyncIterable<Uint8Array>, timeoutMs?: number): Promise<unknown> {
    return requireGuest(this.guest, this.bindingName).request(subject, body, timeoutMs);
  }
}
