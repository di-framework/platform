/** One server-sent event, as the `text/event-stream` format frames it. */
export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

/**
 * Parses a `text/event-stream` body into events. Comment lines (`:`) are skipped, `data:` lines
 * of one event join with newlines, and a blank line dispatches. The hand-written part of the
 * client: OpenAPI describes the streaming operations but not their framing.
 */
export async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  let pending: { event?: string; id?: string; data: string[] } = { data: [] };
  const flush = (): SseEvent | undefined => {
    if (pending.data.length === 0 && pending.event === undefined) return undefined;
    const done: SseEvent = { data: pending.data.join('\n') };
    if (pending.event !== undefined) done.event = pending.event;
    if (pending.id !== undefined) done.id = pending.id;
    pending = { data: [] };
    return done;
  };
  const take = (line: string): SseEvent | undefined => {
    if (line === '') return flush();
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') pending.event = value;
    else if (field === 'data') pending.data.push(value);
    else if (field === 'id') pending.id = value;
    return undefined;
  };
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      const event = take(line);
      if (event) yield event;
      newline = buffer.indexOf('\n');
    }
  }
  const tail = take(buffer.replace(/\r$/, ''));
  if (tail) yield tail;
  const last = flush();
  if (last) yield last;
}
