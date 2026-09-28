export type GuestModules = Record<string, unknown>;

/** Well-known key the wasmCloud CLI plugin writes from generated `guests.js`. */
export const WASMCLOUD_GUESTS_GLOBAL = 'di-framework.wasmcloud.guests';

const GUESTS_KEY = Symbol.for(WASMCLOUD_GUESTS_GLOBAL);

let guests: GuestModules = {};

function installedGuests(): GuestModules {
  return (globalThis as Record<symbol, GuestModules | undefined>)[GUESTS_KEY] ?? guests;
}

export function setGuests(value: GuestModules): void {
  guests = value;
  (globalThis as Record<symbol, GuestModules>)[GUESTS_KEY] = value;
}

export function resetGuests(): void {
  guests = {};
  delete (globalThis as Record<symbol, GuestModules | undefined>)[GUESTS_KEY];
}

export function tryGetGuest<T>(name: string): T | undefined {
  return installedGuests()[name] as T | undefined;
}

export function requireGuest<T>(guest: T | undefined, name: string): T {
  if (guest === undefined) {
    throw new Error(
      `wasmCloud binding "${name}" has no guest implementation. In unit tests, pass a fake to the constructor or call setGuests().`,
    );
  }
  return guest;
}
