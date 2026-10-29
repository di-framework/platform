import { connect as tcp } from 'node:net';
import { type TLSSocket, connect as tls } from 'node:tls';

/**
 * A minimal NATS client for the scheduler broker test (#541 §8.2): the text protocol over TLS,
 * upgraded after the server's INFO as nats-server 2.12 expects without `handshake_first`. It
 * records every message, `-ERR` and the close, so a test can assert the broker's exact response.
 */
export interface Credentials {
  ca: string;
  cert: string;
  key: string;
}
export interface Message {
  subject: string;
  sid: string;
  reply?: string;
  payload: string;
}

const WAIT_MS = 5_000;

export class NatsClient {
  readonly messages: Message[] = [];
  readonly errors: string[] = [];
  closed = false;
  closeReason = '';
  private buffer = '';
  private readonly pongs: (() => void)[] = [];
  private nextSid = 1;

  private constructor(private readonly socket: TLSSocket) {}

  /**
   * Connects with `credentials` and waits for the first PONG. Resolves with the client, or with
   * the reason the broker refused it: an `-ERR`, or a TLS failure or close during the handshake.
   */
  static connect(
    port: number,
    credentials: Credentials,
  ): Promise<{ client: NatsClient } | { refused: string }> {
    return new Promise((resolve) => {
      const plain = tcp(port, '127.0.0.1');
      let settled = false;
      const done = (value: { client: NatsClient } | { refused: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        plain.destroy();
        done({ refused: 'timeout' });
      }, WAIT_MS);
      plain.on('error', (error) => done({ refused: `tcp: ${error.message}` }));
      let info = '';
      const onInfo = (chunk: Buffer) => {
        info += chunk.toString('utf8');
        if (!info.includes('\r\n')) return;
        plain.off('data', onInfo);
        const socket = tls({
          socket: plain,
          servername: 'nats',
          ca: credentials.ca,
          cert: credentials.cert,
          key: credentials.key,
        });
        const client = new NatsClient(socket);
        socket.on('error', (error) => {
          client.closed = true;
          client.closeReason ||= error.message;
          done({ refused: `tls: ${error.message}` });
        });
        socket.on('close', () => {
          client.closed = true;
          done({ refused: client.errors[0] ?? `closed: ${client.closeReason || 'by server'}` });
        });
        socket.on('data', (data: Buffer) => client.receive(data.toString('utf8')));
        socket.on('secureConnect', () => {
          socket.write(
            `CONNECT ${JSON.stringify({ verbose: false, pedantic: false, tls_required: true, protocol: 1, name: 'broker-test' })}\r\nPING\r\n`,
          );
          client.pongs.push(() => done({ client }));
        });
        client.onError = (error) => done({ refused: error });
      };
      plain.on('data', onInfo);
    });
  }

  private onError?: (error: string) => void;

  private receive(text: string): void {
    this.buffer += text;
    for (;;) {
      const end = this.buffer.indexOf('\r\n');
      if (end < 0) return;
      const line = this.buffer.slice(0, end);
      if (line.startsWith('MSG ')) {
        const [, subject, sid, ...rest] = line.split(' ');
        const size = Number(rest.pop());
        if (this.buffer.length < end + 2 + size + 2) return;
        const payload = this.buffer.slice(end + 2, end + 2 + size);
        this.buffer = this.buffer.slice(end + 2 + size + 2);
        this.messages.push({
          subject: subject as string,
          sid: sid as string,
          reply: rest[0],
          payload,
        });
        continue;
      }
      this.buffer = this.buffer.slice(end + 2);
      if (line === 'PING') this.socket.write('PONG\r\n');
      else if (line === 'PONG') this.pongs.shift()?.();
      else if (line.startsWith('-ERR')) {
        const error = line.slice(5).replace(/^'|'$/g, '');
        this.errors.push(error);
        this.onError?.(error);
      }
    }
  }

  /** Subscribes to `subject`; returns its sid. */
  sub(subject: string): string {
    const sid = String(this.nextSid++);
    this.socket.write(`SUB ${subject} ${sid}\r\n`);
    return sid;
  }
  pub(subject: string, payload = '', reply?: string): void {
    const head = [subject, reply, Buffer.byteLength(payload)].filter((part) => part !== undefined);
    this.socket.write(`PUB ${head.join(' ')}\r\n${payload}\r\n`);
  }
  /** Round-trips a PING, so everything sent before it has been processed. False when closed. */
  flush(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), WAIT_MS);
      this.pongs.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
      this.socket.write('PING\r\n');
    });
  }
  /** Messages received on `subject`. */
  on(subject: string): Message[] {
    return this.messages.filter((m) => m.subject === subject);
  }
  close(): void {
    this.socket.destroy();
  }
}
