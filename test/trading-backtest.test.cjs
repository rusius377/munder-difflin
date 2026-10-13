'use strict';

/**
 * Trading desk — past-chart replays ("백테스트"). Pins:
 *   - Binance data-archive zips unpack (stored and deflated), and the kline,
 *     aggTrades and bookDepth CSVs parse (headers, µs timestamps, aggressor side);
 *   - the history store downloads once, caches past days only, falls back to
 *     REST for candles and reports days without a tape;
 *   - the tape index computes the same flow the live tracker does;
 *   - the replay runs the live scalper with no look-ahead, exits at stop /
 *     target with slippage and fees, keeps R and ROE consistent, exports
 *     signals and stops when cancelled;
 *   - experience buckets veto losing setups (exact, then coarse at 2×), a
 *     re-test of the same days replaces the old run, and the engine applies it;
 *   - backtest jobs run, save, learn and delete; the NautilusTrader path hands
 *     the engine the tape and the signals and reports its fills;
 *   - the NautilusTrader environment finds Python, installs into its own venv
 *     and relays job progress — with a fake process runner;
 *   - the Python runner's sizing and liquidation match risk.ts (when python3
 *     with pandas is available).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { makeFetch, makeKlines, rng } = require('./fixtures/trading-fixtures.cjs');

const { unzip, firstCsv } = loadTs('src/main/trading/zip.ts');
const hist = loadTs('src/main/trading/histData.ts');
const replay = loadTs('src/main/trading/replay.ts');
const exp = loadTs('src/main/trading/experience.ts');
const { FlowTracker } = loadTs('src/main/trading/orderFlow.ts');
const { BacktestRunner, rangeOf } = loadTs('src/main/trading/backtest.ts');
const nt = loadTs('src/main/trading/nautilus.ts');
const { sizeOrder } = loadTs('src/main/trading/risk.ts');
const { FALLBACK_FILTERS } = loadTs('src/main/trading/broker.ts');
const { FALLBACK_BRACKETS, bracketFor } = loadTs('src/main/trading/leverage.ts');
const { parseKlines } = loadTs('src/main/trading/binance.ts');
const { TradingEngine } = loadTs('src/main/trading/engine.ts');
const shared = loadTs('src/shared/trading.ts');

const DAY = 86_400_000;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'desk-bt-'));

// ─── a minimal zip writer (local headers + central directory + EOCD) ─────────

function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, deflate } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test('zip: stored and deflated entries unpack; firstCsv picks the CSV', () => {
  const csv = Buffer.from('a,b\n1,2\n'.repeat(200));
  const zip = makeZip([{ name: 'readme.txt', data: Buffer.from('hi') }, { name: 'X-1m-2026-10-01.csv', data: csv, deflate: true }]);
  const e = unzip(zip);
  assert.deepEqual(e.map((x) => x.name), ['readme.txt', 'X-1m-2026-10-01.csv']);
  assert.equal(e[0].data.toString(), 'hi');
  assert.ok(firstCsv(zip).equals(csv));
  assert.throws(() => unzip(Buffer.from('not a zip at all, definitely not')), /zip/);
});

test('zip: an archive written by Python zipfile unpacks too', (t) => {
  const dir = tmpDir();
  const out = path.join(dir, 'py.zip');
  const r = spawnSync('python3', ['-c', `import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED)\nz.writestr('BTCUSDT-aggTrades-2026-10-01.csv','1,2,3\\n'*1000)\nz.close()`, out], { encoding: 'utf8' });
  if (r.status !== 0) { t.skip('python3 not available'); return; }
  assert.equal(firstCsv(fs.readFileSync(out)).toString(), '1,2,3\n'.repeat(1000));
});

// ─── CSV parsers ─────────────────────────────────────────────────────────────

test('histData: kline CSV with header and µs timestamps', () => {
  const t0 = Date.UTC(2026, 9, 1);
  const csv = Buffer.from([
    'open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore',
    `${t0},64000,64100,63900,64050,10,${t0 + 59_999},640000,100,6,384000,0`,
    `${(t0 + 60_000) * 1000},64050,64200,64000,64150,12,${(t0 + 119_999) * 1000},770000,120,5,320000,0`
  ].join('\r\n'));
  const k = hist.parseKlineCsv(csv);
  assert.equal(k.length, 2);
  assert.equal(k[0].openTime, t0);
  assert.equal(k[1].openTime, t0 + 60_000, 'µs → ms');
  assert.equal(k[1].closeTime, t0 + 119_999);
  assert.equal(k[0].takerBuyBase, 6);
});

test('histData: aggTrades → one bar per second, aggressor from is_buyer_maker, big trades', () => {
  const t0 = Date.UTC(2026, 9, 1, 0, 0, 0);
  const rows = [
    'agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker',
    `1,64000,0.5,1,1,${t0 + 100},false`,   // buy 0.5
    `2,64010,2,2,3,${t0 + 400},true`,      // sell 2 (128k → big sell at 100k)
    `3,63990,0.1,4,4,${t0 + 999},True`,    // sell 0.1 (case-insensitive)
    `4,64020,1.6,5,5,${(t0 + 1500) * 1000},false` // µs; buy 1.6 (102k → big buy)
  ];
  const s = hist.aggTradesToSeconds(Buffer.from(rows.join('\n')), 100_000);
  assert.equal(s.length, 2);
  assert.deepEqual(
    { t: s[0].t, o: s[0].o, h: s[0].h, l: s[0].l, c: s[0].c, n: s[0].n, bigBuys: s[0].bigBuys, bigSells: s[0].bigSells },
    { t: t0, o: 64000, h: 64010, l: 63990, c: 63990, n: 3, bigBuys: 0, bigSells: 1 }
  );
  assert.ok(Math.abs(s[0].buy - 0.5) < 1e-9 && Math.abs(s[0].sell - 2.1) < 1e-9);
  assert.equal(s[1].t, t0 + 1000);
  assert.equal(s[1].bigBuys, 1);
});

test('histData: bookDepth keeps the ±1% band per snapshot', () => {
  const csv = Buffer.from([
    'timestamp,percentage,depth,notional',
    '2026-10-01 00:00:08,-5,900,1',
    '2026-10-01 00:00:08,-1,120,1',
    '2026-10-01 00:00:08,1,80,1',
    '2026-10-01 00:00:08,2,300,1',
    '2026-10-01 00:00:38,-1,100,1',
    '2026-10-01 00:00:38,1,100,1'
  ].join('\n'));
  const d = hist.parseBookDepthCsv(csv);
  assert.deepEqual(d, [
    { t: Date.UTC(2026, 9, 1, 0, 0, 8), bid: 120, ask: 80 },
    { t: Date.UTC(2026, 9, 1, 0, 0, 38), bid: 100, ask: 100 }
  ]);
});

test('histData: aggregateKlines buckets by open time', () => {
  const k = parseKlines(makeKlines({ n: 15, interval: '1m', endTime: Date.UTC(2026, 9, 1, 0, 15) }));
  const five = hist.aggregateKlines(k, 5);
  assert.equal(five.length, 3);
  assert.equal(five[0].openTime, Date.UTC(2026, 9, 1, 0, 0));
  assert.equal(five[0].high, Math.max(...k.slice(0, 5).map((x) => x.high)));
  assert.equal(five[2].close, k[14].close);
});

// ─── history store ───────────────────────────────────────────────────────────

function archiveFetch(files) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const body = files[url];
    if (!body) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) };
  };
  fn.calls = calls;
  return fn;
}

test('HistoryStore: downloads once, caches past days, REST fills missing candles, reports tape gaps', async () => {
  const dir = tmpDir();
  const d1 = '2026-10-01';
  const d2 = '2026-10-02';
  const t1 = Date.parse(`${d1}T00:00:00Z`);
  const klineCsv = (t) => Array.from({ length: 3 }, (_, i) => `${t + i * 60_000},1,2,0.5,1.5,10,${t + i * 60_000 + 59_999},15,5,4,6,0`).join('\n');
  const aggCsv = `1,64000,1,1,1,${t1 + 5},false\n2,64001,1,2,2,${t1 + 2005},true\n`;
  const files = {
    [hist.visionUrl('klines', 'BTCUSDT', d1)]: makeZip([{ name: `BTCUSDT-1m-${d1}.csv`, data: Buffer.from(klineCsv(t1)), deflate: true }]),
    [hist.visionUrl('aggTrades', 'BTCUSDT', d1)]: makeZip([{ name: `BTCUSDT-aggTrades-${d1}.csv`, data: Buffer.from(aggCsv), deflate: true }])
  };
  const fetchBin = archiveFetch(files);
  const restCalls = [];
  const rest = {
    klinesRange: async (symbol, interval, start, end) => {
      restCalls.push([symbol, interval, start, end]);
      return parseKlines(makeKlines({ n: 3, interval: '1m', endTime: start + 3 * 60_000 }));
    }
  };
  const store = new hist.HistoryStore(dir, fetchBin, rest, { now: () => Date.parse('2026-10-02T12:00:00Z') });
  const from = t1;
  const to = Date.parse(`${d2}T00:03:00Z`);
  const k = await store.klines1m('BTCUSDT', from, to);
  assert.equal(k.k.length, 6, '3 archive candles + 3 REST candles');
  assert.deepEqual(k.fromRest, [d2]);
  assert.equal(restCalls.length, 1);
  assert.ok(fs.existsSync(store.zipPath('klines', 'BTCUSDT', d1)), 'a past day is cached');
  assert.ok(!fs.existsSync(store.zipPath('klines', 'BTCUSDT', d2)), 'today is never cached');

  const s = await store.seconds('BTCUSDT', from, to, 100_000);
  assert.equal(s.s.length, 2);
  assert.deepEqual(s.missing, [d2]);
  const n = fetchBin.calls.length;
  const again = await store.seconds('BTCUSDT', from, to, 100_000);
  assert.deepEqual(again.s, s.s, 'the per-second cache reads back the same bars');
  assert.equal(fetchBin.calls.filter((u) => u.includes(`aggTrades-${d1}`)).length, 1, 'the tape downloads once');
  assert.ok(fetchBin.calls.length - n <= 1, 'only the still-missing day is retried');
});

// ─── tape index ↔ live tracker ───────────────────────────────────────────────

test('TapeIndex computes the live tracker\'s flow features from per-second bars', () => {
  const r = rng(3);
  const t0 = Date.UTC(2026, 9, 1, 0, 0);
  const trades = [];
  let px = 64000;
  let id = 1;
  for (let s = 0; s < 600; s++) {
    const k = Math.floor(r() * 4);
    for (let j = 0; j < k; j++) {
      px *= 1 + (r() - 0.5) * 0.0004;
      trades.push({ id: id++, t: t0 + s * 1000 + 100 + j * 200, price: +px.toFixed(1), qty: +(r() * (r() < 0.05 ? 4 : 0.5)).toFixed(3), buy: r() < 0.55 });
    }
  }
  const csv = trades.map((x) => `${x.id},${x.price},${x.qty},${x.id},${x.id},${x.t},${x.buy ? 'false' : 'true'}`).join('\n');
  const tape = new replay.TapeIndex(hist.aggTradesToSeconds(Buffer.from(csv), 100_000));
  for (const at of [t0 + 120_000, t0 + 333_000, t0 + 599_000]) {
    const tr = new FlowTracker('BTCUSDT', { bigTradeUsdt: 100_000 });
    for (const x of trades) if (x.t < at) tr.addTrade(x);
    const a = tr.features(at, 'live');
    const b = tape.features(at, null);
    for (const k of ['cvd1m', 'cvd5m', 'vol1m', 'buyShare1m', 'tradesPerSec', 'change1mPct']) {
      assert.ok(Math.abs((a[k] ?? 0) - (b[k] ?? 0)) < 1e-6, `${k} at ${at - t0}: ${a[k]} vs ${b[k]}`);
    }
    assert.equal(a.bigBuys, b.bigBuys);
    assert.equal(a.bigSells, b.bigSells);
    assert.equal(a.absorption, b.absorption);
    assert.equal(a.lastPrice, b.lastPrice);
  }
});

// ─── the scalping replay ─────────────────────────────────────────────────────

const END = Date.UTC(2026, 9, 10);
function synthetic({ days = 3, tapeHours = 12, seed = 11, start = 64000 } = {}) {
  const k1m = parseKlines(makeKlines({ n: days * 1440, start, drift: 0.00002, vol: 0.0012, interval: '1m', endTime: END, seed }));
  const r = rng(seed + 1);
  const seconds = [];
  for (const k of k1m.filter((x) => x.openTime >= END - tapeHours * 3_600_000)) {
    let p = k.open;
    for (let i = 0; i < 60; i++) {
      const target = i === 59 ? k.close : p + (r() - 0.5) * (k.high - k.low) * 0.3;
      const pxx = Math.min(k.high, Math.max(k.low, target));
      const vol = k.volume / 60;
      const share = 0.3 + r() * 0.4;
      seconds.push({ t: k.openTime + i * 1000, o: p, h: Math.max(p, pxx), l: Math.min(p, pxx), c: pxx, buy: vol * share, sell: vol * (1 - share), n: 20, bigBuys: r() < 0.01 ? 1 : 0, bigSells: r() < 0.01 ? 1 : 0 });
      p = pxx;
    }
  }
  return { k1m, seconds };
}

function replayReq(cfg, over = {}) {
  return { symbol: 'BTCUSDT', from: END - DAY, to: END, scalping: cfg.scalping, risk: cfg.risk, startEquity: 10_000, evalEverySec: 5, ...over };
}

test('replay: candle days trade the live scalper with stops, targets, fees and consistent R', async () => {
  const cfg = shared.defaultTradingConfig();
  const { k1m } = synthetic();
  const res = await replay.runScalpReplay(replayReq(cfg, { from: END - 2 * DAY }), { k1m });
  assert.equal(res.dataLevel, 'candles');
  assert.ok(res.trades.length >= 3, `trades: ${res.trades.length}`);
  const slip = cfg.risk.slippageBps / 10_000;
  const fee = cfg.risk.takerFeePct / 100;
  let equity = 10_000;
  for (const t of res.trades) {
    const long = t.side === 'LONG';
    assert.ok(t.leverage >= 1 && t.leverage <= cfg.scalping.leverage);
    assert.ok(long ? t.liquidationPrice < t.stopLoss : t.liquidationPrice > t.stopLoss, 'liquidation sits beyond the stop');
    if (t.exitReason === '손절') {
      assert.ok(Math.abs(t.exitPrice - t.stopLoss * (long ? 1 - slip : 1 + slip)) < 1e-6);
      assert.ok(Math.abs(t.pnlR + 1) < 0.03, `a full stop is about −1R (${t.pnlR})`);
    }
    if (t.exitReason === '익절') assert.ok(Math.abs(t.exitPrice - t.takeProfit * (long ? 1 - slip : 1 + slip)) < 1e-6);
    const gross = (long ? 1 : -1) * (t.exitPrice - t.entryPrice) * t.quantity;
    assert.ok(Math.abs(t.fees - (t.entryPrice + t.exitPrice) * t.quantity * fee) < 1e-6);
    assert.ok(Math.abs(t.pnl - (gross - t.fees)) < 1e-6);
    assert.ok(Math.abs(t.roe - (t.pnl / t.margin) * 100) < 1e-6);
    assert.ok(t.exitTime > t.entryTime);
    assert.ok(['with', 'flat', 'against'].includes(t.features.trendAligned));
    equity += t.pnl;
  }
  assert.ok(Math.abs(res.stats.endEquity - equity) < 1e-6);
  assert.ok(Math.abs(res.equity[res.equity.length - 1][1] - equity) < 1e-6);
  assert.equal(res.stats.trades, res.trades.length);
  assert.ok(res.notes.some((n) => /펀딩비/.test(n)));
});

test('replay: the tape drives second-by-second evaluation and break-even stops', async () => {
  const cfg = shared.defaultTradingConfig();
  const { k1m, seconds } = synthetic({ tapeHours: 24 });
  const res = await replay.runScalpReplay(replayReq(cfg), { k1m, seconds });
  assert.equal(res.dataLevel, 'tape');
  assert.ok(res.evaluations > 10_000, `${res.evaluations} evaluations at 5 s`);
  assert.ok(res.trades.length > 0);
  for (const t of res.trades) {
    assert.ok(['손절', '익절', '본전 손절', '시간 청산', '강한 반대 신호', '기간 종료', '강제 청산'].includes(t.exitReason) || t.exitReason.length > 0);
    // Exits on the tape happen at the end of a second.
    if (['손절', '익절', '본전 손절'].includes(t.exitReason)) assert.equal(t.exitTime % 1000, 999);
  }
});

test('replay: no look-ahead — rewriting the future does not change earlier trades', async () => {
  const cfg = shared.defaultTradingConfig();
  const a = synthetic({ tapeHours: 24, seed: 11 });
  const cut = END - 8 * 3_600_000;
  const other = synthetic({ tapeHours: 24, seed: 99, start: a.k1m.find((k) => k.openTime >= cut).open });
  // Same history up to `cut`, a different market afterwards.
  const shift = (arr, key) => arr.filter((x) => x[key] >= cut);
  const k1mB = [...a.k1m.filter((k) => k.openTime < cut), ...shift(other.k1m, 'openTime')];
  const secB = [...a.seconds.filter((s) => s.t < cut), ...shift(other.seconds, 't')];
  const ra = await replay.runScalpReplay(replayReq(cfg), { k1m: a.k1m, seconds: a.seconds });
  const rb = await replay.runScalpReplay(replayReq(cfg), { k1m: k1mB, seconds: secB });
  const before = (r) => r.trades.filter((t) => t.exitTime < cut - 60_000).map((t) => JSON.stringify(t));
  assert.ok(before(ra).length > 0, 'some trades closed before the cut');
  assert.deepEqual(before(rb), before(ra));
});

test('replay: signals export for an execution engine; progress can stop it', async () => {
  const cfg = shared.defaultTradingConfig();
  const { k1m, seconds } = synthetic();
  const res = await replay.runScalpReplay(replayReq(cfg, { collectSignals: true }), { k1m, seconds });
  assert.ok(res.signals.length > 0);
  const withEntry = res.signals.filter((s) => s.entry);
  assert.ok(withEntry.length >= res.trades.length);
  for (const s of withEntry) {
    assert.ok(s.entry.features && typeof s.entry.features.score === 'number');
    assert.ok(s.entry.side === 'LONG' ? s.entry.stopLoss < s.price : s.entry.stopLoss > s.price);
  }
  let calls = 0;
  const stopped = await replay.runScalpReplay(replayReq(cfg), { k1m, seconds }, { progress: () => ++calls >= 3 });
  assert.ok(stopped.notes.some((n) => /멈췄/.test(n)));
  assert.ok(stopped.evaluations < res.evaluations);
});

// ─── experience ──────────────────────────────────────────────────────────────

const feat = (o = {}) => ({ trendAligned: 'with', score: 80, atrPct: 0.1, flow: 'with', hourUtc: 3, ...o });
const trade = (pnlR, o = {}) => ({
  side: 'LONG', entryTime: 0, exitTime: 1, entryPrice: 1, exitPrice: 1, stopLoss: 1, takeProfit: 1, quantity: 1, leverage: 75,
  liquidationPrice: 0, margin: 1, pnl: pnlR, pnlR, roe: 0, fees: 0, exitReason: pnlR > 0 ? '익절' : '손절', features: feat(), ...o
});

test('experience: losing setups veto, coarse buckets need twice the samples, re-tests replace runs', () => {
  const dir = tmpDir();
  const store = new exp.ExperienceStore(dir, () => 1000);
  const losing = Array.from({ length: 12 }, (_, i) => trade(i < 4 ? 1.5 : -1));
  store.addRun('BTCUSDT', { id: 'a', from: 0, to: 10 * DAY, engine: 'builtin', trades: losing });
  const v = store.verdict('BTCUSDT', 'LONG', feat(), 10);
  assert.equal(v.block, true);
  assert.equal(v.n, 12);
  assert.match(v.note, /진입 안 함/);
  assert.ok(Math.abs(v.avgR - (4 * 1.5 - 8) / 12) < 1e-9);
  // Not enough samples: no veto.
  assert.equal(store.verdict('BTCUSDT', 'LONG', feat(), 20).block, false);
  // A different trend falls back to the coarse (side · volatility) bucket at 2×.
  const coarse = store.verdict('BTCUSDT', 'LONG', feat({ trendAligned: 'against' }), 6);
  assert.equal(coarse.block, true);
  assert.equal(coarse.key, 'LONG|*|*|s|*');
  assert.equal(store.verdict('BTCUSDT', 'LONG', feat({ trendAligned: 'against' }), 7).block, false, '12 < 2×7');
  // Other side / symbol: untouched.
  assert.equal(store.verdict('BTCUSDT', 'SHORT', feat(), 5).block, false);
  assert.equal(store.verdict('ETHUSDT', 'LONG', feat(), 5).block, false);

  // Re-testing a period that covers the old run replaces it.
  const later = new exp.ExperienceStore(dir, () => 1000 + 120_000);
  later.addRun('BTCUSDT', { id: 'b', from: 0, to: 20 * DAY, engine: 'nautilus', trades: Array.from({ length: 12 }, () => trade(0.8)) });
  const v2 = later.verdict('BTCUSDT', 'LONG', feat(), 10);
  assert.equal(v2.block, false);
  assert.equal(v2.n, 12);
  const view = later.view('BTCUSDT');
  assert.deepEqual(view.runs.map((r) => r.id), ['b']);
  assert.equal(view.trades, 12);
  assert.ok(view.buckets.some((b) => b.key === 'LONG|with|75-84|s|with' && b.n === 12));
  assert.ok(view.buckets.some((b) => b.key === 'LONG|*|*|s|*'), 'coarse buckets are shown too');
  later.removeRun('BTCUSDT', 'b');
  assert.equal(later.view('BTCUSDT').trades, 0);
  later.addRun('BTCUSDT', { id: 'c', from: 0, to: 1, engine: 'builtin', trades: [trade(1)] });
  later.clear('BTCUSDT');
  assert.equal(later.view('BTCUSDT').runs.length, 0);
});

test('engine: a losing experience record vetoes the live scalper\'s setup', async () => {
  const dir = tmpDir();
  const store = new exp.ExperienceStore(path.join(dir, 'experience'));
  const all = [];
  for (const side of ['LONG', 'SHORT']) for (const atrPct of [0.03, 0.08, 0.2, 0.5]) for (let i = 0; i < 12; i++) all.push(trade(-1, { side, features: feat({ atrPct }) }));
  store.addRun('BTCUSDT', { id: 'x', from: 0, to: DAY, engine: 'builtin', trades: all });
  const FLAT = { start: 64000, drift: 0.00005, vol: 0.0008 };
  const cfg = shared.normalizeTradingConfig({ mode: 'scalping', venue: 'paper', symbols: ['BTCUSDT'], scalping: { pollSeconds: 60, agentBias: false, orderFlow: false, experienceMinSamples: 5 } });
  const eng = new TradingEngine(cfg, {
    fetch: makeFetch({ klines: { '1m': FLAT, '3m': FLAT, '5m': FLAT, '15m': FLAT, '1h': FLAT, '4h': FLAT, '1d': FLAT } }),
    dataDir: dir, getSecret: () => undefined, createLlm: () => ({ label: 'x', complete: async () => '' }), emit: () => {}
  });
  await eng.start();
  try {
    let sc;
    for (let i = 0; i < 200 && !sc; i++) { sc = eng.getSnapshot().scalp.BTCUSDT; if (!sc) await new Promise((r) => setTimeout(r, 25)); }
    assert.ok(sc, 'the scalper evaluated');
    assert.match(sc.experience, /진입 안 함/);
    assert.equal(eng.getSnapshot().positions.length, 0);
  } finally {
    await eng.stop();
    eng.dispose();
  }
});

// ─── backtest jobs ───────────────────────────────────────────────────────────

function fakeHistory(data, dir) {
  return {
    async klines1m(symbol, from, to, progress) {
      progress?.('klines', 1, 1);
      return { k: data.k1m.filter((k) => k.openTime >= from && k.openTime < to), fromRest: [] };
    },
    async seconds(symbol, from, to) {
      const s = (data.seconds ?? []).filter((x) => x.t >= from && x.t < to);
      return { s, missing: s.length ? [] : hist.dayList(from, to - 1) };
    },
    async depth(symbol, from, to) { return { d: [], missing: hist.dayList(from, to - 1) }; },
    zipPath(kind, symbol, day) {
      const p = path.join(dir, 'zips', `${kind}-${day}.zip`);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      if (kind === 'aggTrades') fs.writeFileSync(p, 'zip');
      return p;
    }
  };
}

async function waitJob(runner, id) {
  for (let i = 0; i < 600; i++) {
    const j = runner.list().find((x) => x.id === id);
    if (j && ['done', 'error', 'cancelled'].includes(j.state)) return j;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('job did not finish');
}

test('backtest runner: a scalping job runs, saves, learns, and deleting it forgets the experience', async () => {
  const dir = tmpDir();
  const cfg = shared.defaultTradingConfig();
  const data = synthetic({ days: 3, tapeHours: 24 });
  const experience = new exp.ExperienceStore(path.join(dir, 'experience'));
  const pushes = [];
  const runner = new BacktestRunner({
    dataDir: dir, history: fakeHistory(data, dir), experience, nautilus: null, getConfig: () => cfg,
    emit: (jobs) => pushes.push(jobs), now: () => END + 3_600_000
  });
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  const job = runner.start({ mode: 'scalping', engine: 'builtin', symbol: 'BTCUSDT', fromDay: day(END - DAY), toDay: day(END - DAY), useTape: true, evalEverySec: 10, learn: true });
  assert.ok(['queued', 'loading'].includes(job.state));
  assert.equal(job.request.leverage, 75, 'scalping replays default to 75x');
  const done = await waitJob(runner, job.id);
  assert.equal(done.state, 'done', done.error);
  assert.ok(pushes.length > 3, 'progress is pushed');
  const r = runner.result(job.id);
  assert.equal(r.dataLevel, 'tape');
  assert.equal(r.learned, r.trades.length > 0);
  assert.equal(r.stats.trades, r.trades.length);
  assert.ok(r.notes.some((n) => /호가 깊이/.test(n)));
  const list = runner.results();
  assert.equal(list[0].id, job.id);
  assert.equal(list[0].tradeCount, r.trades.length);
  assert.equal(list[0].trades, undefined, 'the list carries no trade arrays');
  if (r.learned) assert.equal(experience.view('BTCUSDT').runs[0].id, job.id);
  runner.remove(job.id);
  assert.equal(runner.result(job.id), null);
  assert.equal(experience.view('BTCUSDT').runs.length, 0);
  assert.throws(() => rangeOf({ fromDay: day(END + 5 * DAY), toDay: day(END + 5 * DAY) }, END), /지난 데이터/);
});

test('backtest runner: the NautilusTrader path gets the tape and the signals, and reports its fills', async () => {
  const dir = tmpDir();
  const cfg = shared.defaultTradingConfig();
  const data = synthetic({ days: 3, tapeHours: 24 });
  let seen = null;
  const nautilus = {
    async status() { return { state: 'ready', version: '1.231.0', python: '3.12' }; },
    async runJob(jobDir, job, onProgress) {
      const signals = JSON.parse(fs.readFileSync(job.signalsPath, 'utf8'));
      seen = { jobDir, job, signals };
      onProgress(0.5, '노틸러스 실행 중');
      return {
        nautilusVersion: '1.231.0', ticks: 123456, notes: ['노틸러스 노트'],
        trades: [trade(1.2, { entryTime: END - 5 * 3_600_000, exitTime: END - 5 * 3_600_000 + 60_000, pnl: 12 }), trade(-1, { entryTime: END - 3_600_000, exitTime: END - 3_000_000, pnl: -10 })]
      };
    }
  };
  const runner = new BacktestRunner({
    dataDir: dir, history: fakeHistory(data, dir), experience: new exp.ExperienceStore(path.join(dir, 'experience')), nautilus,
    getConfig: () => cfg, emit: () => {}, now: () => END + 3_600_000
  });
  const day = new Date(END - DAY).toISOString().slice(0, 10);
  const job = runner.start({ mode: 'scalping', engine: 'nautilus', symbol: 'BTCUSDT', fromDay: day, toDay: day, learn: false });
  const done = await waitJob(runner, job.id);
  assert.equal(done.state, 'done', done.error);
  assert.ok(seen.signals.length > 0, 'the desk\'s signals reached the engine');
  assert.deepEqual(seen.job.tapeFiles.map((f) => path.basename(f)), [`aggTrades-${day}.zip`]);
  const p = seen.job.params;
  assert.equal(p.leverage, 75);
  const tier = bracketFor(FALLBACK_BRACKETS.BTCUSDT, 10_000 * (cfg.risk.maxNotionalPct / 100));
  assert.equal(p.mmr, tier.maintMarginRatio);
  assert.equal(p.stepSize, FALLBACK_FILTERS.BTCUSDT.marketStepSize);
  assert.ok(!fs.existsSync(seen.jobDir), 'the job folder is cleaned up');
  const r = runner.result(job.id);
  assert.equal(r.engine, 'nautilus');
  assert.equal(r.stats.trades, 2);
  assert.ok(Math.abs(r.stats.netPnl - 2) < 1e-9);
  assert.ok(r.notes.some((n) => n.startsWith('NautilusTrader 1.231.0 · 체결 123,456건')));
  assert.ok(r.notes.some((n) => /앱 내장 리플레이/.test(n)), 'the built-in replay of the same signals is shown for comparison');
  assert.equal(r.learned, false);
});

test('backtest runner: Nautilus without Python fails with a clear message; queued jobs cancel', async () => {
  const dir = tmpDir();
  const cfg = shared.defaultTradingConfig();
  const data = synthetic({ days: 2, tapeHours: 2 });
  let release;
  const gate = new Promise((r) => { release = r; });
  const history = fakeHistory(data, dir);
  const slow = { ...history, klines1m: async (...a) => { await gate; return history.klines1m(...a); } };
  const runner = new BacktestRunner({
    dataDir: dir, history: slow, experience: new exp.ExperienceStore(path.join(dir, 'experience')),
    nautilus: { status: async () => ({ state: 'missing-python' }), runJob: async () => { throw new Error('unreachable'); } },
    getConfig: () => cfg, emit: () => {}, now: () => END + 3_600_000
  });
  const day = new Date(END - DAY).toISOString().slice(0, 10);
  const a = runner.start({ mode: 'scalping', engine: 'nautilus', fromDay: day, toDay: day });
  const b = runner.start({ mode: 'scalping', engine: 'builtin', fromDay: day, toDay: day, useTape: false });
  runner.cancel(b.id);
  release();
  const ja = await waitJob(runner, a.id);
  assert.equal(ja.state, 'error');
  assert.match(ja.error, /Python 3\.12/);
  assert.equal(runner.list().find((x) => x.id === b.id).state, 'cancelled');
  assert.throws(() => runner.start({ mode: 'agents' }), /에이전트/, 'agents mode needs the engine');
});

test('backtest request: normalized and clamped', () => {
  const cfg = shared.defaultTradingConfig();
  const r = shared.normalizeBacktestRequest({ fromDay: '2026-09-30', toDay: '2026-08-01', leverage: 500, evalEverySec: 0, episodes: 99, engine: 'x', mode: 'agents' }, cfg);
  assert.equal(r.fromDay, '2026-08-01');
  assert.equal(r.toDay, '2026-08-31', 'at most 31 days');
  assert.equal(r.leverage, 125);
  assert.equal(r.evalEverySec, 1);
  assert.equal(r.episodes, 30);
  assert.equal(r.engine, 'builtin');
  assert.equal(r.mode, 'agents');
  assert.equal(shared.defaultBacktestRequest(cfg).leverage, 75);
  const tape = shared.normalizeBacktestRequest({ mode: 'scalping', useTape: true, fromDay: '2026-08-01', toDay: '2026-08-31' }, cfg);
  assert.equal(tape.toDay, '2026-08-07', 'the tape is held in memory: at most 7 days');
  const nautilus = shared.normalizeBacktestRequest({ mode: 'scalping', engine: 'nautilus', useTape: false, fromDay: '2026-08-01', toDay: '2026-08-31' }, cfg);
  assert.equal(nautilus.toDay, '2026-08-07');
  const candles = shared.normalizeBacktestRequest({ mode: 'scalping', useTape: false, fromDay: '2026-08-01', toDay: '2026-08-31' }, cfg);
  assert.equal(candles.toDay, '2026-08-31');
});

// ─── NautilusTrader environment (fake processes) ─────────────────────────────

function fakeRunner(handler) {
  const calls = [];
  const run = async (cmd, args, opts = {}) => {
    calls.push([cmd, ...args]);
    return handler(cmd, args, opts) ?? { code: 1, stdout: '', stderr: 'not found' };
  };
  run.calls = calls;
  return run;
}

test('NautilusEnv: finds a supported Python, installs into its own venv, reports ready', async () => {
  const dir = tmpDir();
  let installed = false;
  const run = fakeRunner((cmd, args, opts) => {
    if (args[args.length - 1] === '--version') {
      if (cmd === 'python3.13') return { code: 1, stdout: '', stderr: 'nope' };
      if (cmd === 'python3.12') return { code: 0, stdout: 'Python 3.12.7\n', stderr: '' };
      return { code: 0, stdout: 'Python 3.11.2', stderr: '' };
    }
    if (args.includes('venv')) {
      const py = nt.venvPython(args[args.length - 1], 'linux');
      fs.mkdirSync(path.dirname(py), { recursive: true });
      fs.writeFileSync(py, '');
      opts.onLine?.('created');
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args.includes('pip')) {
      if (args.some((a) => a.startsWith('nautilus_trader=='))) installed = true;
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === '-c') return installed ? { code: 0, stdout: '1.231.0\n3.12.7\n', stderr: '' } : { code: 1, stdout: '', stderr: 'ModuleNotFoundError' };
    return null;
  });
  const env = new nt.NautilusEnv(dir, '/scripts', run, 'linux');
  assert.deepEqual(await env.status(), { state: 'not-installed', python: '3.12' });
  const lines = [];
  const st = await env.install((l) => lines.push(l));
  assert.deepEqual(st, { state: 'ready', version: '1.231.0', python: '3.12.7' });
  assert.ok(run.calls.some((c) => c[0] === 'python3.12' && c.includes('venv')));
  assert.ok(run.calls.some((c) => c[0] === env.python && c.includes(`nautilus_trader==${nt.NAUTILUS_VERSION}`)), 'pip runs inside the venv');
  assert.ok(lines.some((l) => /3\.12/.test(l)));
  assert.equal(nt.parsePythonVersion('Python 3.14.0').ok, true);
  assert.equal(nt.parsePythonVersion('Python 3.15.0').ok, false);
  assert.deepEqual(nt.pythonCandidates('win32')[0], { cmd: 'py', args: ['-3.13'] });
  assert.equal(nt.venvPython('C:\\v', 'win32'), path.join('C:\\v', 'Scripts', 'python.exe'));
});

test('NautilusEnv: no Python → missing-python; a job relays progress and surfaces errors', async () => {
  const dir = tmpDir();
  const none = new nt.NautilusEnv(dir, '/scripts', fakeRunner(() => null), 'linux');
  assert.equal((await none.status()).state, 'missing-python');
  assert.equal((await none.install()).state, 'missing-python');

  const runJob = (result) => new nt.NautilusEnv(dir, '/scripts', fakeRunner((cmd, args, opts) => {
    const job = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    assert.equal(args[0], path.join('/scripts', 'desk_backtest.py'));
    opts.onLine('PROGRESS 0.250 체결 읽는 중');
    opts.onLine('some log line');
    if (result) fs.writeFileSync(job.out, JSON.stringify(result));
    return { code: result && !result.error ? 0 : 1, stdout: '', stderr: 'Traceback: boom' };
  }), 'linux');
  const prog = [];
  const out = await runJob({ trades: [], ticks: 5 }).runJob(path.join(dir, 'j1'), { symbol: 'BTCUSDT' }, (p, m) => prog.push([p, m]));
  assert.deepEqual(out, { trades: [], ticks: 5 });
  assert.deepEqual(prog, [[0.25, '체결 읽는 중']]);
  await assert.rejects(runJob({ error: 'ValueError: bad' }).runJob(path.join(dir, 'j2'), {}, () => {}), /노틸러스 오류: ValueError/);
  await assert.rejects(runJob(null).runJob(path.join(dir, 'j3'), {}, () => {}), /boom/);
});

// ─── the Python runner mirrors risk.ts ───────────────────────────────────────

test('desk_backtest.py: compiles; sizing, safe leverage and liquidation match risk.ts', (t) => {
  const script = path.join(__dirname, '..', 'resources', 'nautilus', 'desk_backtest.py');
  const compiled = spawnSync('python3', ['-m', 'py_compile', script], { encoding: 'utf8' });
  if (compiled.error) { t.skip('python3 not available'); return; }
  assert.equal(compiled.status, 0, compiled.stderr);

  const cfg = shared.defaultTradingConfig();
  const f = FALLBACK_FILTERS.BTCUSDT;
  const equity = 10_000;
  const tier = bracketFor(FALLBACK_BRACKETS.BTCUSDT, equity * (cfg.risk.maxNotionalPct / 100));
  const params = {
    leverage: 75, takerFeePct: cfg.risk.takerFeePct, slippageBps: cfg.risk.slippageBps, riskPerTradePct: cfg.risk.riskPerTradePct,
    maxNotionalPct: cfg.risk.maxNotionalPct, mmr: tier.maintMarginRatio, cum: tier.cum, stepSize: f.marketStepSize, minQty: f.marketMinQty, minNotional: f.minNotional
  };
  const cases = [
    ['LONG', 64000, 63920], ['SHORT', 64000, 64090], ['LONG', 64000, 63300], ['SHORT', 2500, 2530]
  ];
  const py = spawnSync('python3', ['-I', '-c', `
import json, sys
sys.path.insert(0, sys.argv[1])
import desk_backtest as d
p = json.loads(sys.argv[2]); out = []
for side, entry, stop in json.loads(sys.argv[3]):
    s = d.size_order(side, entry, stop, p, 10000.0, 10000.0)
    out.append(None if s is None else {**s, "liq": d.liquidation_price(side, entry, s["qty"], s["leverage"], p["mmr"], p["cum"])})
print(json.dumps(out))
`, path.dirname(script), JSON.stringify(params), JSON.stringify(cases)], { encoding: 'utf8' });
  assert.equal(py.status, 0, py.stderr);
  const got = JSON.parse(py.stdout);
  cases.forEach(([side, entry, stop], i) => {
    const sym = entry < 10_000 ? 'ETHUSDT' : 'BTCUSDT';
    if (sym === 'ETHUSDT') return; // params above are BTC's
    const v = sizeOrder({ side, entryType: 'MARKET', entryPrice: entry, stopLoss: stop, takeProfit: 0, leverage: 75, riskPct: cfg.risk.riskPerTradePct }, {
      symbol: sym, price: entry, equity, available: equity, filters: FALLBACK_FILTERS[sym], risk: { ...cfg.risk, maxLeverage: 125 },
      minRewardRisk: 0, defaultLeverage: 75, haltedReason: null, brackets: FALLBACK_BRACKETS[sym]
    });
    assert.ok(v.approved, v.reason);
    const g = got[i];
    assert.ok(g, `python sized case ${i}`);
    assert.ok(Math.abs(g.qty - v.plan.quantity) < 1e-9, `qty ${g.qty} vs ${v.plan.quantity}`);
    assert.equal(g.leverage, v.plan.leverage, `leverage case ${i}`);
    assert.ok(Math.abs(g.riskUsdt - v.plan.riskUsdt) < 1e-6);
    assert.ok(Math.abs(g.liq - v.plan.liquidationPrice) <= f.tickSize, `liq ${g.liq} vs ${v.plan.liquidationPrice}`);
  });
  assert.ok(got[2].leverage < 75, 'a wide stop lowers the leverage on both sides');
});

test('desk_backtest.py: aggTrades zips become a nanosecond UTC tape with the aggressor side', (t) => {
  const probe = spawnSync('python3', ['-c', 'import pandas'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) { t.skip('python3 with pandas not available'); return; }
  const dir = tmpDir();
  const t0 = Date.UTC(2026, 9, 1);
  const zipA = path.join(dir, 'a.zip');
  const zipB = path.join(dir, 'b.zip');
  fs.writeFileSync(zipA, makeZip([{ name: 'a.csv', deflate: true, data: Buffer.from(`agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker\n1,64000,0.5,1,1,${t0 + 5},false\n2,64001,0.2,2,2,${t0 + 9},true\n`) }]));
  fs.writeFileSync(zipB, makeZip([{ name: 'b.csv', data: Buffer.from(`3,64002,0.1,3,3,${(t0 + 1000) * 1000},False\n4,64003,0,4,4,${(t0 + 2000) * 1000},True\n`) }]));
  const script = path.join(__dirname, '..', 'resources', 'nautilus');
  const py = spawnSync('python3', ['-I', '-c', `
import json, sys
sys.path.insert(0, sys.argv[1])
import desk_backtest as d
f = d.agg_trades_frame([sys.argv[2], sys.argv[3]], int(sys.argv[4]), int(sys.argv[5]))
print(json.dumps({"dtype": str(f.index.dtype), "ns": [int(x) for x in f.index.asi8], "side": list(f["side"]), "id": list(f["trade_id"]), "qty": list(f["quantity"])}))
`, script, zipA, zipB, String(t0), String(t0 + DAY)], { encoding: 'utf8' });
  assert.equal(py.status, 0, py.stderr);
  const out = JSON.parse(py.stdout);
  assert.equal(out.dtype, 'datetime64[ns, UTC]');
  assert.deepEqual(out.ns, [(t0 + 5) * 1e6, (t0 + 9) * 1e6, (t0 + 1000) * 1e6]);
  assert.deepEqual(out.side, ['BUY', 'SELL', 'BUY']);
  assert.deepEqual(out.id, ['1', '2', '3']);
});
