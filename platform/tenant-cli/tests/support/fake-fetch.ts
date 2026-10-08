/** A `fetch` double keyed by `METHOD /path`; records every call for assertions. */
export interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export function fakeFetch(
  routes: Record<string, (recorded: Recorded) => Response | Promise<Response>>,
) {
  const calls: Recorded[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const recorded: Recorded = {
      method: init?.method ?? 'GET',
      url,
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(recorded);
    const key = `${recorded.method} ${new URL(url).pathname}`;
    const route = routes[key];
    if (!route) return Response.json({ title: 'Not Found', status: 404 }, { status: 404 });
    return route(recorded);
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

export const sse = (frames: string) =>
  new Response(frames, { status: 200, headers: { 'content-type': 'text/event-stream' } });
