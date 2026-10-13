'use strict';

/**
 * Trading desk — live order flow. Pins:
 *   - the WebSocket client speaks RFC 6455 (handshake accept key, masked
 *     client frames, 7/16/64-bit lengths, ping → pong, fragmentation, close)
 *     against a real local socket server;
 *   - Binance aggTrade / depth payloads parse in combined-stream form;
 *   - the tracker's CVD, aggression share, big trades, imbalance, walls and
 *     absorption are right, dedupe trades by id, and survive a slow PC clock;
 *   - the feed opens Binance's routed endpoints (/market, /public), marks the
 *     streams live, and reconnects with backoff;
 *   - the scalper scores the tape and brakes for a wall in front of the target;
 *   - the engine publishes live flow to the snapshot.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { makeFetch, makeKlines } = require('./fixtures/trading-fixtures.cjs');

const ws = loadTs('src/main/trading/wsClient.ts');
const of = loadTs('src/main/trading/orderFlow.ts');
const scalper = loadTs('src/main/trading/scalper.ts');
const { parseKlines } = loadTs('src/main/trading/binance.ts');
const shared = loadTs('src/shared/trading.ts');
const { TradingEngine } = loadTs('src/main/trading/engine.ts');

// ─── websocket client ────────────────────────────────────────────────────────

/** Server → client frame (unmasked). */
function serverFrame(opcode, payload, fin = true) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([(fin ? 0x80 : 0) | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = (fin ? 0x80 : 0) | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = (fin ? 0x80 : 0) | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

test('frames: masked client frames round-trip at every length encoding; partial input waits', () => {
  for (const n of [0, 5, 125, 126, 65535, 70000]) {
    const payload = crypto.randomBytes(n);
    const f = ws.encodeFrame(0x1, payload);
    assert.equal(f[1] & 0x80, 0x80, 'client frames are masked');
    const { frames, rest } = ws.decodeFrames(f);
    assert.equal(frames.length, 1);
    assert.equal(rest.length, 0);
    assert.ok(frames[0].payload.equals(payload), `len ${n}`);
  }
  const two = Buffer.concat([serverFrame(1, Buffer.from('a')), serverFrame(1, Buffer.from('bc'))]);
  const cut = two.subarray(0, two.length - 1);
  const r = ws.decodeFrames(cut);
  assert.equal(r.frames.length, 1);
  assert.equal(r.rest.length, 3, 'the incomplete second frame is kept');
  assert.equal(ws.acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=', 'RFC 6455 example');
});

test('client: handshake, text, ping→pong, fragments, a 70 kB message and a clean close against a real socket', async () => {
  const received = [];
  let pongPayload = null;
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let upgraded = false;
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.subarray(0, end).toString();
        const key = /Sec-WebSocket-Key: (\S+)/i.exec(head)[1];
        assert.match(head, /^GET \/market\/stream\?streams=btcusdt@aggTrade HTTP\/1\.1/);
        sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${ws.acceptKey(key)}\r\n\r\n`);
        buf = buf.subarray(end + 4);
        upgraded = true;
        sock.write(Buffer.concat([
          serverFrame(1, Buffer.from('{"hello":1}')),
          serverFrame(9, Buffer.from('ping!')),
          serverFrame(1, Buffer.from('frag-'), false),
          serverFrame(0, Buffer.from('mented'), true),
          serverFrame(1, Buffer.alloc(70000, 0x61))
        ]));
        return;
      }
      const { frames, rest } = ws.decodeFrames(buf);
      buf = Buffer.from(rest);
      for (const f of frames) {
        if (f.opcode === 0xa) {
          pongPayload = f.payload.toString();
          const close = Buffer.alloc(2); close.writeUInt16BE(1000);
          sock.write(serverFrame(8, Buffer.concat([close, Buffer.from('bye')])));
        }
        if (f.opcode === 0x8) sock.end();
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const closed = await new Promise((resolve) => {
    let opened = false;
    ws.connectWebSocket(`ws://127.0.0.1:${port}/market/stream?streams=btcusdt@aggTrade`, {
      onOpen: () => { opened = true; },
      onMessage: (t) => received.push(t),
      onClose: (code, reason) => resolve({ code, reason, opened })
    });
  });
  server.close();
  assert.equal(closed.opened, true);
  assert.equal(closed.code, 1000);
  assert.equal(closed.reason, 'bye');
  assert.equal(pongPayload, 'ping!', 'pings are answered with the same payload');
  assert.deepEqual(received.slice(0, 2), ['{"hello":1}', 'frag-mented']);
  assert.equal(received[2].length, 70000);
});

test('client: a server that does not upgrade is reported, not thrown', async () => {
  const server = net.createServer((sock) => sock.on('data', () => sock.end('HTTP/1.1 403 Forbidden\r\n\r\n')));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const res = await new Promise((resolve) => {
    const errors = [];
    ws.connectWebSocket(`ws://127.0.0.1:${server.address().port}/x`, {
      onError: (e) => errors.push(e.message),
      onClose: (code) => resolve({ code, errors })
    });
  });
  server.close();
  assert.equal(res.code, 1002);
  assert.match(res.errors[0], /403/);
});

// ─── parsing & features ──────────────────────────────────────────────────────

test('Binance combined-stream payloads parse; REST rows too', () => {
  const a = of.parseAggTrade({ stream: 'btcusdt@aggTrade', data: { e: 'aggTrade', E: 1, s: 'BTCUSDT', a: 77, p: '64000.10', q: '0.250', f: 1, l: 2, T: 1700000000000, m: true } });
  assert.deepEqual(a, { symbol: 'BTCUSDT', trade: { id: 77, t: 1700000000000, price: 64000.1, qty: 0.25, buy: false } });
  assert.equal(of.parseAggTrade({ data: { e: 'depthUpdate' } }), null);
  const d = of.parseDepth({ stream: 'btcusdt@depth20@100ms', data: { e: 'depthUpdate', E: 5, T: 4, s: 'BTCUSDT', U: 1, u: 2, pu: 0, b: [['64000.0', '1.5'], ['63999.9', '0']], a: [['64000.1', '2.0']] } });
  assert.equal(d.symbol, 'BTCUSDT');
  assert.deepEqual(d.book.bids, [[64000, 1.5]], 'zero-size levels are dropped');
  assert.deepEqual(d.book.asks, [[64000.1, 2]]);
  assert.deepEqual(of.parseRestAggTrades([{ a: 1, p: '1', q: '2', T: 3, m: false }]), [{ id: 1, t: 3, price: 1, qty: 2, buy: true }]);
  const u = of.streamUrls(['BTCUSDT', 'ETHUSDT']);
  assert.equal(u.market, 'wss://fstream.binance.com/market/stream?streams=btcusdt@aggTrade/ethusdt@aggTrade');
  assert.equal(u.public, 'wss://fstream.binance.com/public/stream?streams=btcusdt@depth20@100ms/ethusdt@depth20@100ms');
});

test('tracker: CVD, aggression share, big trades, imbalance, walls, absorption; dedupe and clock skew', () => {
  const t0 = 1_700_000_000_000;
  const tr = new of.FlowTracker('BTCUSDT', { bigTradeUsdt: 100_000 });
  let id = 0;
  const add = (dt, price, qty, buy) => tr.addTrade({ id: ++id, t: t0 + dt, price, qty, buy });
  add(-6 * 60_000, 63000, 50, true); // outside 5 minutes
  add(-4 * 60_000, 64000, 2, false); // 128k sell — big, inside 5m, outside 1m
  add(-30_000, 64000, 1.5, true); // 96k — not big
  add(-20_000, 64010, 1, false);
  add(-5_000, 64020, 2, true); // 128k buy — big
  tr.addTrade({ id: 3, t: t0, price: 1, qty: 999, buy: true }); // replayed id → ignored
  tr.setBook({ bids: [[64019, 1], [64018, 1], [64017, 9]], asks: [[64021, 1], [64022, 1], [64030, 1.2]], at: t0 });
  const f = tr.features(t0, 'live');
  assert.equal(f.cvd1m, 2.5);
  assert.equal(f.cvd5m, 0.5);
  assert.equal(f.vol1m, 4.5);
  near(f.buyShare1m, 3.5 / 4.5);
  assert.equal(f.bigBuys, 1);
  assert.equal(f.bigSells, 1);
  near(f.bookImbalance, 11 / 3.2);
  assert.deepEqual(f.walls.map((w) => [w.side, w.price]), [['bid', 64017]]);
  near(f.spreadBps, (2 / 64020) * 10_000);
  assert.equal(f.lastPrice, 64020);
  // A PC clock 30 s behind the exchange still sees the last minute.
  assert.equal(tr.features(t0 - 30_000, 'live').cvd1m, 2.5);
  // Heavy selling that does not push price down is being absorbed by buyers.
  const ab = new of.FlowTracker('BTCUSDT', { bigTradeUsdt: 1e9 });
  ab.addTrade({ id: 1, t: t0 - 50_000, price: 64000, qty: 1, buy: true });
  ab.addTrade({ id: 2, t: t0 - 40_000, price: 64000, qty: 8, buy: false });
  ab.addTrade({ id: 3, t: t0 - 1_000, price: 64005, qty: 1, buy: false });
  assert.equal(ab.features(t0, 'live').absorption, 'buy');
  const v = tr.view(t0, 'live', true);
  assert.equal(v.connected, true);
  assert.deepEqual(v.bigTrades.map((b) => b.buy), [true, false], 'newest big trade first');
});

function near(a, b, tol = 1e-9) { assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`); }

test('feed: routed endpoints, live state, reconnect with backoff', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const opened = [];
  const conns = [];
  const factory = (url, h) => {
    opened.push(url);
    const c = { isOpen: true, h, close(code = 1000, reason = '') { this.isOpen = false; h.onClose(code, reason); }, send() {} };
    conns.push(c);
    h.onOpen();
    return c;
  };
  let now = 1_700_000_000_000;
  const feed = new of.LiveFlowFeed(['BTCUSDT'], { bigTradeUsdt: 1e5, factory, now: () => now });
  feed.start();
  assert.deepEqual(opened, [
    'wss://fstream.binance.com/market/stream?streams=btcusdt@aggTrade',
    'wss://fstream.binance.com/public/stream?streams=btcusdt@depth20@100ms'
  ]);
  assert.equal(feed.live('market'), false, 'open but silent is not live');
  conns[0].h.onMessage(JSON.stringify({ stream: 'btcusdt@aggTrade', data: { e: 'aggTrade', s: 'BTCUSDT', a: 1, p: '64000', q: '1', T: now, m: false } }));
  conns[1].h.onMessage(JSON.stringify({ data: { e: 'depthUpdate', s: 'BTCUSDT', E: now, b: [['63999', '2']], a: [['64001', '1']] } }));
  assert.equal(feed.live('market'), true);
  assert.equal(feed.live('public'), true);
  assert.equal(feed.trackers.BTCUSDT.features(now, 'live').cvd1m, 1);
  // The server drops the trade stream: reconnect after 1 s, then 2 s.
  conns[0].isOpen = false;
  conns[0].h.onClose(1006, 'gone');
  assert.equal(feed.live('market'), false);
  t.mock.timers.tick(999);
  assert.equal(opened.length, 2);
  t.mock.timers.tick(1);
  assert.equal(opened.length, 3);
  feed.stop();
  t.mock.timers.tick(120_000);
  assert.equal(opened.length, 3, 'no reconnects after stop');
});

// ─── scoring ─────────────────────────────────────────────────────────────────

const P = { ...shared.defaultTradingConfig().scalping };
function inputsWith(flow) {
  const k = parseKlines(makeKlines({ n: 150, start: 64000, drift: 0.0002, vol: 0.0006, interval: '1m', seed: 3 }));
  const trend = parseKlines(makeKlines({ n: 150, start: 63000, drift: 0.0004, vol: 0.001, interval: '5m', seed: 4 }));
  return { k, trend, depth: { bids: [[63999.9, 3]], asks: [[64000, 3]] }, premium: null, flow };
}
const FLOW = (over = {}) => ({ source: 'live', cvd1m: 12, cvd5m: 30, vol1m: 20, buyShare1m: 0.8, tradesPerSec: 40, bigBuys: 4, bigSells: 0,
  bookImbalance: 1.6, walls: [], spreadBps: 0.02, change1mPct: 0.05, absorption: 'buy', lastPrice: null, updatedAt: 0, ...over });

test('scalper scores the live tape and brakes for a wall in front of the target', () => {
  const base = scalper.evaluateScalp(inputsWith(null), P);
  const withTape = scalper.evaluateScalp(inputsWith(FLOW()), P);
  assert.ok(withTape.longScore > base.longScore - 15, 'flow replaces the candle proxy');
  const reasons = scalper.evaluateScalp(inputsWith(FLOW()), P);
  const L = reasons.longScore >= reasons.shortScore ? reasons.reasons : [];
  assert.ok(L.some((r) => /1분 체결 매수 우위 80%/.test(r)), L.join(' | '));
  assert.ok(L.some((r) => /대량 매수 체결 우위 4건/.test(r)));
  assert.ok(L.some((r) => /매도 공세 흡수/.test(r)));
  const price = withTape.price;
  const wall = scalper.evaluateScalp(inputsWith(FLOW({ walls: [{ side: 'ask', price: price + withTape.atr * 0.5, qty: 120, distPct: 0.05 }] })), P);
  assert.equal(wall.longScore, withTape.longScore - 6);
  assert.ok(wall.reasons.some((r) => /목표가 앞 매도벽/.test(r)) || wall.shortScore > wall.longScore);
  // Bearish tape mirrors.
  const bear = scalper.evaluateScalp(inputsWith(FLOW({ cvd1m: -12, cvd5m: -30, buyShare1m: 0.2, bigBuys: 0, bigSells: 4, bookImbalance: 0.5, absorption: 'sell' })), P);
  assert.ok(bear.shortScore - base.shortScore >= 10, `${bear.shortScore} vs ${base.shortScore}`);
});

// ─── engine ──────────────────────────────────────────────────────────────────

test('engine (scalping): live streams feed the score and the snapshot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-flow-'));
  const factory = (url, h) => {
    const c = { isOpen: true, close(code = 1000) { this.isOpen = false; h.onClose(code, ''); }, send() {} };
    h.onOpen();
    const now = Date.now();
    if (url.includes('/market/')) {
      for (let i = 0; i < 20; i++) h.onMessage(JSON.stringify({ data: { e: 'aggTrade', s: 'BTCUSDT', a: i + 1, p: '64000', q: i % 4 ? '0.5' : '2', T: now - 20_000 + i * 500, m: i % 4 === 0 } }));
    } else {
      h.onMessage(JSON.stringify({ data: { e: 'depthUpdate', s: 'BTCUSDT', E: now, b: [['63999.9', '4']], a: [['64000.0', '1']] } }));
    }
    return c;
  };
  const FLAT = { start: 64000, drift: 0.00005, vol: 0.0008 };
  const cfg = shared.normalizeTradingConfig({ mode: 'scalping', venue: 'paper', symbols: ['BTCUSDT'], scalping: { pollSeconds: 60, agentBias: false } });
  const eng = new TradingEngine(cfg, {
    fetch: makeFetch({ klines: { '1m': FLAT, '3m': FLAT, '5m': FLAT, '15m': FLAT, '1h': FLAT, '4h': FLAT, '1d': FLAT } }),
    dataDir: dir, getSecret: () => undefined, createLlm: () => ({ label: 'x', complete: async () => '' }), emit: () => {}, wsFactory: factory
  });
  await eng.start();
  try {
    const flow = await (async () => {
      for (let i = 0; i < 200; i++) {
        const f = eng.getSnapshot().flow.BTCUSDT;
        if (f) return f;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('no flow');
    })();
    assert.equal(flow.source, 'live');
    assert.equal(flow.connected, true);
    assert.ok(flow.vol1m > 0);
    assert.equal(flow.bookImbalance, 4);
    const plan = eng.getSnapshot().scalp.BTCUSDT.plan;
    assert.ok(plan && plan.requestedLeverage === 75, 'the 75x card rides along');
  } finally {
    await eng.stop();
    eng.dispose();
  }
});
