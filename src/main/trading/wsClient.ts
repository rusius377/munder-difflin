/**
 * A small RFC 6455 WebSocket client for the desk's market streams.
 *
 * Electron 32's main process runs Node 20, which has no WebSocket client, and
 * the desk only needs the read side of public market streams: connect, read
 * text frames, answer pings, close. That is ~200 lines, so it lives here
 * rather than as a new dependency.
 *
 *   - wss:// over TLS (Binance), ws:// over plain TCP (tests)
 *   - client frames are masked, server frames must not be
 *   - fragmented messages are reassembled; pings are answered with pongs
 *   - no extensions are offered, so the server never compresses
 */
import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 16 * 1024 * 1024;

export interface WsHandlers {
  onOpen?: () => void;
  onMessage?: (text: string) => void;
  onClose?: (code: number, reason: string) => void;
  onError?: (err: Error) => void;
}

export interface WsConnection {
  close(code?: number, reason?: string): void;
  send(text: string): void;
  readonly isOpen: boolean;
}

export type WsFactory = (url: string, handlers: WsHandlers) => WsConnection;

/** Build one client frame (always masked, as RFC 6455 requires of clients). */
export function encodeFrame(opcode: number, payload: Buffer, mask: Buffer = randomBytes(4)): Buffer {
  const len = payload.length;
  const head: number[] = [0x80 | opcode];
  if (len < 126) head.push(0x80 | len);
  else if (len < 65536) head.push(0x80 | 126, (len >> 8) & 0xff, len & 0xff);
  else {
    head.push(0x80 | 127);
    const big = Buffer.alloc(8);
    big.writeBigUInt64BE(BigInt(len));
    head.push(...big);
  }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([Buffer.from(head), mask, masked]);
}

export interface Frame { fin: boolean; opcode: number; payload: Buffer }

/**
 * Pull complete frames off the front of `buf`. Returns the frames and the
 * unconsumed rest. Throws on a protocol violation.
 */
export function decodeFrames(buf: Buffer): { frames: Frame[]; rest: Buffer } {
  const frames: Frame[] = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      const big = buf.readBigUInt64BE(p);
      if (big > BigInt(MAX_MESSAGE)) throw new Error('웹소켓 프레임이 너무 큽니다');
      len = Number(big);
      p += 8;
    }
    let mask: Buffer | null = null;
    if (masked) {
      if (buf.length - p < 4) break;
      mask = buf.subarray(p, p + 4);
      p += 4;
    }
    if (buf.length - p < len) break;
    let payload = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    frames.push({ fin, opcode, payload });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

export function acceptKey(key: string): string {
  return createHash('sha1').update(key + GUID).digest('base64');
}

/** Open a WebSocket. Errors and closes are reported through the handlers, never thrown. */
export const connectWebSocket: WsFactory = (url, handlers) => {
  const u = new URL(url);
  const secure = u.protocol === 'wss:';
  if (!secure && u.protocol !== 'ws:') throw new Error(`웹소켓 주소가 아닙니다: ${url}`);
  const port = Number(u.port || (secure ? 443 : 80));
  const key = randomBytes(16).toString('base64');
  let open = false;
  let closed = false;
  let handshake = Buffer.alloc(0);
  let buf = Buffer.alloc(0);
  let fragments: Buffer[] = [];
  let fragmentOpcode = 0;

  const socket: net.Socket = secure
    ? tls.connect({ host: u.hostname, port, servername: u.hostname })
    : net.connect({ host: u.hostname, port });

  const finish = (code: number, reason: string, err?: Error) => {
    if (closed) return;
    closed = true;
    open = false;
    if (err) handlers.onError?.(err);
    handlers.onClose?.(code, reason);
    socket.destroy();
  };

  const write = (opcode: number, payload: Buffer) => {
    if (!socket.destroyed) socket.write(encodeFrame(opcode, payload));
  };

  socket.setNoDelay(true);
  socket.once(secure ? 'secureConnect' : 'connect', () => {
    socket.write([
      `GET ${u.pathname || '/'}${u.search} HTTP/1.1`,
      `Host: ${u.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      'User-Agent: munder-difflin-trading-desk',
      '', ''
    ].join('\r\n'));
  });

  const onFrames = () => {
    let decoded;
    try { decoded = decodeFrames(buf); } catch (e) { finish(1002, 'protocol error', e as Error); return; }
    buf = Buffer.from(decoded.rest);
    for (const f of decoded.frames) {
      if (f.opcode === 0x9) { write(0xa, f.payload); continue; }
      if (f.opcode === 0xa) continue;
      if (f.opcode === 0x8) {
        const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
        const reason = f.payload.length > 2 ? f.payload.subarray(2).toString('utf8') : '';
        write(0x8, f.payload.subarray(0, 2));
        finish(code, reason);
        return;
      }
      if (f.opcode === 0x1 || f.opcode === 0x2) {
        if (f.fin) handlers.onMessage?.(f.payload.toString('utf8'));
        else { fragments = [f.payload]; fragmentOpcode = f.opcode; }
        continue;
      }
      if (f.opcode === 0x0) {
        if (!fragmentOpcode) { finish(1002, 'unexpected continuation'); return; }
        fragments.push(f.payload);
        const size = fragments.reduce((a, b) => a + b.length, 0);
        if (size > MAX_MESSAGE) { finish(1009, 'message too big'); return; }
        if (f.fin) {
          handlers.onMessage?.(Buffer.concat(fragments).toString('utf8'));
          fragments = [];
          fragmentOpcode = 0;
        }
      }
    }
  };

  socket.on('data', (chunk: Buffer) => {
    if (!open) {
      handshake = Buffer.concat([handshake, chunk]);
      const end = handshake.indexOf('\r\n\r\n');
      if (end < 0) {
        if (handshake.length > 16384) finish(1002, 'handshake too long');
        return;
      }
      const head = handshake.subarray(0, end).toString('latin1');
      const status = /^HTTP\/1\.1 (\d{3})/.exec(head)?.[1];
      const accept = /\r\nsec-websocket-accept:\s*(\S+)/i.exec(head)?.[1];
      if (status !== '101' || accept !== acceptKey(key)) {
        finish(1002, 'handshake failed', new Error(`웹소켓 연결 거부 (HTTP ${status ?? '?'})`));
        return;
      }
      open = true;
      buf = Buffer.from(handshake.subarray(end + 4));
      handlers.onOpen?.();
      if (buf.length) onFrames();
      return;
    }
    buf = Buffer.concat([buf, chunk]);
    onFrames();
  });
  socket.on('error', (e: Error) => finish(1006, e.message, e));
  socket.on('close', () => finish(1006, 'connection lost'));

  return {
    get isOpen() { return open && !closed; },
    send(text: string) { if (open) write(0x1, Buffer.from(text, 'utf8')); },
    close(code = 1000, reason = '') {
      if (closed) return;
      if (open) {
        const p = Buffer.alloc(2 + Buffer.byteLength(reason));
        p.writeUInt16BE(code, 0);
        p.write(reason, 2);
        write(0x8, p);
      }
      finish(code, reason);
    }
  };
};
