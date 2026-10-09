/** A local HTTP server for tests: records every request and answers through one handler. */
export interface Recorded {
  method: string;
  /** Path with the query string. */
  path: string;
  pathname: string;
  headers: Headers;
  body: string;
}
export interface FakeServer {
  url: string;
  requests: Recorded[];
  stop(): void;
}

export type Handler = (request: Recorded, raw: Request) => Response | Promise<Response>;

export function serve(handler: Handler): FakeServer {
  const requests: Recorded[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const recorded: Recorded = {
        method: request.method,
        path: url.pathname + url.search,
        pathname: url.pathname,
        headers: request.headers,
        body: await request.text(),
      };
      requests.push(recorded);
      return handler(recorded, request);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
