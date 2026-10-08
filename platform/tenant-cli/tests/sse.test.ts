import { expect, test } from 'bun:test';
import { events, type SseEvent } from '../src/client/sse.ts';

function stream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks: string[]): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const event of events(stream(chunks))) out.push(event);
  return out;
}

test('frames split across chunks, comments, ids, and multi-line data', async () => {
  expect(
    await collect([
      ': keep-alive\n',
      'event: log\nid: 1\ndata: {"a":',
      '1}\n\n',
      'data: first\r\ndata: second\r\n\r\n',
      'event: end\n\n',
    ]),
  ).toEqual([
    { event: 'log', id: '1', data: '{"a":1}' },
    { data: 'first\nsecond' },
    { event: 'end', data: '' },
  ]);
});

test('a final event without a trailing blank line is still delivered', async () => {
  expect(await collect(['data: tail'])).toEqual([{ data: 'tail' }]);
  expect(await collect(['data:no-space\r'])).toEqual([{ data: 'no-space' }]);
  expect(await collect(['data'])).toEqual([{ data: '' }]);
  expect(await collect(['\n\n'])).toEqual([]);
  expect(await collect(['retry: 100\n\n'])).toEqual([]);
});
