'use strict';

/**
 * Trading desk — the deterministic half: indicators, Binance wire helpers,
 * model-output parsing, the risk engine, the paper broker and the scalper.
 * Everything that decides an order size or a stop is pinned here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { makeKlines, makeFetch, RSS } = require('./fixtures/trading-fixtures.cjs');

const ind = loadTs('src/main/trading/indicators.ts');
const bn = loadTs('src/main/trading/binance.ts');
const dec = loadTs('src/main/trading/decision.ts');
const risk = loadTs('src/main/trading/risk.ts');
const broker = loadTs('src/main/trading/broker.ts');
const scalper = loadTs('src/main/trading/scalper.ts');
const news = loadTs('src/main/trading/news.ts');
const shared = loadTs('src/shared/trading.ts');

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

// ─── indicators ──────────────────────────────────────────────────────────────

test('sma/ema warm up with nulls and match hand-computed values', () => {
  const v = [1, 2, 3, 4, 5, 6];
  assert.deepEqual(ind.sma(v, 3), [null, null, 2, 3, 4, 5]);
  const e = ind.ema(v, 3);
  assert.equal(e[1], null);
  near(e[2], 2);            // seeded with SMA(1,2,3)
  near(e[3], 3);            // 4*0.5 + 2*0.5
  near(e[5], 5);
});

test('rsi is 100 on a straight rise, 0 on a straight fall, ~50 flat-ish', () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  const down = Array.from({ length: 30 }, (_, i) => 100 - i);
  assert.equal(ind.lastValue(ind.rsi(up, 14)), 100);
  assert.equal(ind.lastValue(ind.rsi(down, 14)), 0);
  const zig = Array.from({ length: 40 }, (_, i) => 100 + (i % 2 ? 1 : -1));
  const r = ind.lastValue(ind.rsi(zig, 14));
  assert.ok(r > 40 && r < 60, `zigzag RSI ${r}`);
});

test('atr, bollinger and macd produce finite last values on real-shaped candles', () => {
  const k = bn.parseKlines(makeKlines({ n: 120 }));
  assert.equal(k.length, 120);
  assert.ok(ind.lastValue(ind.atr(k, 14)) > 0);
  const bb = ind.bollinger(k.map((c) => c.close), 20, 2);
  assert.ok(ind.lastValue(bb.upper) > ind.lastValue(bb.lower));
  const m = ind.macd(k.map((c) => c.close));
  near(ind.lastValue(m.hist), ind.lastValue(m.macd) - ind.lastValue(m.signal), 1e-9);
});

test('swingLevels returns supports below and resistances above the last close', () => {
  const k = bn.parseKlines(makeKlines({ n: 150, drift: 0, vol: 0.01, seed: 3 }));
  const px = k[k.length - 1].close;
  const lv = ind.swingLevels(k, 3, 3);
  for (const s of lv.supports) assert.ok(s < px);
  for (const r of lv.resistances) assert.ok(r > px);
});

// ─── binance wire helpers ────────────────────────────────────────────────────

test('roundToStep snaps without float noise', () => {
  assert.equal(bn.roundToStep(0.30000000000000004, 0.1, 'floor'), 0.3);
  assert.equal(bn.roundToStep(0.0156, 0.001, 'floor'), 0.015);
  assert.equal(bn.roundToStep(64123.27, 0.1), 64123.3);
  assert.equal(bn.fmtParam(0.015, 0.001), '0.015');
  assert.equal(bn.fmtParam(64123.27, 0.1), '64123.3');
  assert.equal(bn.stepDecimals(0.00001), 5);
});

test('signed requests carry key header, timestamp and a correct HMAC-SHA256 signature', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    if (url.includes('/fapi/v1/time')) return { ok: true, status: 200, text: async () => JSON.stringify({ serverTime: 1760000000000 }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ algoId: 1 }) };
  };
  const c = new bn.BinanceFuturesClient({ baseUrl: 'https://demo-fapi.binance.com', apiKey: 'k', apiSecret: 's', fetch: fetchImpl, now: () => 1760000000000 });
  await c.newAlgoOrder({ symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', quantity: '0.010', triggerPrice: '63000.0', reduceOnly: 'true' });
  const call = seen.find((s) => s.url.includes('/fapi/v1/algoOrder'));
  assert.ok(call, 'algo order endpoint used for STOP_MARKET');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['X-MBX-APIKEY'], 'k');
  const u = new URL(call.url);
  assert.equal(u.searchParams.get('algoType'), 'CONDITIONAL');
  assert.equal(u.searchParams.get('triggerPrice'), '63000.0');
  const sig = u.searchParams.get('signature');
  const unsigned = call.url.split('?')[1].replace(/&signature=[0-9a-f]+$/, '');
  const expect = require('node:crypto').createHmac('sha256', 's').update(unsigned).digest('hex');
  assert.equal(sig, expect);
  assert.ok(u.searchParams.get('timestamp'));
});

test('Binance errors surface code and a Korean hint for geo-blocks', async () => {
  const c = new bn.BinanceFuturesClient({ baseUrl: 'https://fapi.binance.com', fetch: async () => ({ ok: false, status: 451, text: async () => '{"code":0,"msg":"restricted location"}' }) });
  await assert.rejects(c.klines('BTCUSDT', '1m', 10), (e) => e.status === 451 && /지역/.test(e.message));
  const c2 = new bn.BinanceFuturesClient({ baseUrl: 'https://fapi.binance.com', apiKey: 'k', apiSecret: 's', fetch: async (url) => {
    if (url.includes('/time')) return { ok: true, status: 200, text: async () => '{"serverTime":1}' };
    return { ok: false, status: 400, text: async () => '{"code":-4046,"msg":"No need to change margin type."}' };
  } });
  await c2.setMarginType('BTCUSDT', 'ISOLATED'); // -4046 swallowed
});

test('exchange filters parse from exchangeInfo', async () => {
  const c = new bn.BinanceFuturesClient({ baseUrl: 'https://fapi.binance.com', fetch: makeFetch() });
  const f = await c.exchangeFilters(['BTCUSDT']);
  assert.equal(f.BTCUSDT.tickSize, 0.1);
  assert.equal(f.BTCUSDT.marketStepSize, 0.001);
  assert.equal(f.BTCUSDT.minNotional, 100);
  assert.equal(f.ETHUSDT, undefined);
});

// ─── news ────────────────────────────────────────────────────────────────────

test('RSS parsing decodes CDATA/entities and splits coin vs macro news', () => {
  const items = news.parseFeed(RSS, 'example.com');
  assert.equal(items.length, 5);
  assert.match(items[0].title, /^Bitcoin ETF inflows/);
  assert.equal(items[0].summary, 'Spot bitcoin ETFs saw strong inflows.');
  const { coin, macro } = news.classifyNews(items, 'BTCUSDT');
  assert.ok(coin.some((i) => /Bitcoin ETF/.test(i.title)));
  assert.ok(macro.some((i) => /Powell/.test(i.title)));
  assert.ok(!coin.concat(macro).some((i) => /NFT shoe/.test(i.title)));
});

// ─── decision parsing ────────────────────────────────────────────────────────

test('parseFinalDecision reads a fenced JSON block and coerces sloppy numbers', () => {
  const text = `**Rating**: Overweight\n\n요약: 롱 우위.\n\n\`\`\`json\n{"rating":"Overweight","action":"LONG","entryType":"MARKET","entryPrice":"64,000","stopLoss":"$62,800","takeProfit":66400,"leverage":"5","riskPct":"0.8%","confidence":72,"horizonHours":24,"summary":"추세 지속 가능성"}\n\`\`\``;
  const { decision, parsedJson } = dec.parseFinalDecision(text);
  assert.equal(parsedJson, true);
  assert.equal(decision.rating, 'Overweight');
  assert.equal(decision.action, 'LONG');
  assert.equal(decision.stopLoss, 62800);
  assert.equal(decision.entryPrice, 64000);
  assert.equal(decision.riskPct, 0.8);
  near(decision.confidence, 0.72);
  assert.equal(decision.summary, '추세 지속 가능성');
});

test('without JSON the first Rating line decides, and a quoted "not a Sell" does not override it', () => {
  const text = '**Rating**: Buy\n\n이것은 Sell이 아니다.\n**Rating**: Sell 이라고 쓰면 안 된다';
  assert.equal(dec.parseRating(text), 'Buy');
  const { decision, parsedJson } = dec.parseFinalDecision(text);
  assert.equal(parsedJson, false);
  assert.equal(decision.action, 'LONG');
  assert.equal(decision.stopLoss, null);
});

test('trader action, Korean rating aliases and bias JSON parse', () => {
  assert.equal(dec.parseTraderAction('...\nFINAL TRANSACTION PROPOSAL: **SHORT**'), 'SHORT');
  assert.equal(dec.parseTraderAction('- **Action**: 관망'), 'HOLD');
  assert.equal(dec.normalizeRating('비중 축소'), 'Underweight');
  const b = dec.parseBias('근거...\n```json\n{"bias":"long only","confidence":0.7,"note":"상승 추세"}\n```');
  assert.deepEqual(b, { bias: 'LONG_ONLY', confidence: 0.7, note: '상승 추세' });
  assert.equal(dec.parseBias('no json here'), null);
});

// ─── risk engine ─────────────────────────────────────────────────────────────

const RISK = shared.defaultTradingConfig().risk;
const FILTERS = broker.FALLBACK_FILTERS.BTCUSDT;
const ctx = (over = {}) => ({ symbol: 'BTCUSDT', price: 64000, equity: 10000, available: 10000, filters: FILTERS, risk: RISK, minRewardRisk: 1.5, defaultLeverage: 3, ...over });

test('position size comes from stop distance and the risk budget (fees included)', () => {
  const v = risk.sizeOrder({ side: 'LONG', entryType: 'MARKET', entryPrice: 64000, stopLoss: 63000, takeProfit: 66000, leverage: 5, riskPct: 1 }, ctx());
  assert.equal(v.approved, true, v.reason);
  // budget 100 USDT / (1000 + fees ≈ 63.5 + slippage ≈ 25.4) ≈ 0.0919 → floor to 0.091
  assert.equal(v.plan.quantity, 0.091);
  assert.ok(v.plan.riskUsdt <= 100 + 1e-9, `risk ${v.plan.riskUsdt}`);
  near(v.plan.rewardRisk, 2);
});

test('risk engine rejects wrong-side stops, thin R:R, and clamps leverage and risk', () => {
  assert.equal(risk.sizeOrder({ side: 'LONG', entryType: 'MARKET', entryPrice: 64000, stopLoss: 64500, takeProfit: 66000, leverage: 5, riskPct: 1 }, ctx()).approved, false);
  assert.equal(risk.sizeOrder({ side: 'SHORT', entryType: 'MARKET', entryPrice: 64000, stopLoss: 63000, takeProfit: 62000, leverage: 5, riskPct: 1 }, ctx()).approved, false);
  const thin = risk.sizeOrder({ side: 'LONG', entryType: 'MARKET', entryPrice: 64000, stopLoss: 63000, takeProfit: 64500, leverage: 5, riskPct: 1 }, ctx());
  assert.equal(thin.approved, false);
  assert.match(thin.reason, /손익비/);
  const v = risk.sizeOrder({ side: 'LONG', entryType: 'MARKET', entryPrice: 64000, stopLoss: 63000, takeProfit: 67000, leverage: 75, riskPct: 4 }, ctx());
  assert.equal(v.approved, true);
  assert.equal(v.plan.leverage, RISK.maxLeverage);
  assert.ok(v.adjustments.some((a) => /레버리지/.test(a)));
  assert.ok(v.adjustments.some((a) => /리스크/.test(a)));
});

test('leverage is lowered so isolated liquidation sits beyond the stop', () => {
  // 6% stop at 10x would liquidate (~10%) close to the stop: must come down.
  const v = risk.sizeOrder({ side: 'SHORT', entryType: 'MARKET', entryPrice: 64000, stopLoss: 67840, takeProfit: 56000, leverage: 10, riskPct: 1 }, ctx());
  assert.equal(v.approved, true, v.reason);
  assert.ok(v.plan.leverage <= 12 && v.plan.leverage * 0.06 * 1.25 < 1, `lev ${v.plan.leverage}`);
});

test('notional cap and minimum order size are enforced', () => {
  const tiny = risk.sizeOrder({ side: 'LONG', entryType: 'MARKET', entryPrice: 64000, stopLoss: 63000, takeProfit: 66000, leverage: 5, riskPct: 0.05 }, ctx({ equity: 100, available: 100 }));
  assert.equal(tiny.approved, false);
  const capped = risk.sizeOrder({ side: 'LONG', entryType: 'MARKET', entryPrice: 64000, stopLoss: 63900, takeProfit: 64300, leverage: 10, riskPct: 1 }, ctx({ minRewardRisk: 1 }));
  assert.equal(capped.approved, true, capped.reason);
  assert.ok(capped.plan.notional <= 10000 * RISK.maxNotionalPct / 100 + 1e-6);
});

test('halted day refuses entries; low confidence and missing stop are refused', () => {
  const v = risk.sizeOrder({ side: 'LONG', entryType: 'MARKET', entryPrice: 64000, stopLoss: 63000, takeProfit: 66000, leverage: 5, riskPct: 1 }, ctx({ haltedReason: '일일 손실 한도' }));
  assert.equal(v.approved, false);
  const d = { rating: 'Buy', action: 'LONG', entryType: 'MARKET', entryPrice: null, stopLoss: 63000, takeProfit: 66000, leverage: 3, riskPct: 1, confidence: 0.3, horizonHours: 12, summary: '' };
  assert.equal(risk.planFromDecision(d, ctx(), 0.55).approved, false);
  assert.equal(risk.planFromDecision({ ...d, confidence: 0.8, stopLoss: null }, ctx(), 0.55).approved, false);
  assert.equal(risk.planFromDecision({ ...d, confidence: 0.8 }, ctx(), 0.55).approved, true);
  // Price already through the stop → refuse a market entry.
  assert.equal(risk.planFromDecision({ ...d, confidence: 0.8 }, ctx({ price: 62900 }), 0.55).approved, false);
});

test('a LIMIT entry on the wrong side of price becomes MARKET; a good one stays LIMIT', () => {
  const d = { rating: 'Buy', action: 'LONG', entryType: 'LIMIT', entryPrice: 63500, stopLoss: 62800, takeProfit: 66000, leverage: 3, riskPct: 1, confidence: 0.8, horizonHours: 12, summary: '' };
  const good = risk.planFromDecision(d, ctx(), 0.55);
  assert.equal(good.plan.entryType, 'LIMIT');
  assert.equal(good.plan.entryPrice, 63500);
  const bad = risk.planFromDecision({ ...d, entryPrice: 64500 }, ctx(), 0.55);
  assert.equal(bad.plan.entryType, 'MARKET');
});

// ─── paper broker ────────────────────────────────────────────────────────────

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-paper-'));
  const file = path.join(dir, 'paper.json');
  return { file, load: () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined), save: (v) => fs.writeFileSync(file, JSON.stringify(v)) };
}

const plan = (over = {}) => ({ symbol: 'BTCUSDT', side: 'LONG', entryType: 'MARKET', entryPrice: 64000, stopLoss: 63000, takeProfit: 66000, leverage: 5, quantity: 0.1, notional: 6400, riskUsdt: 100, rewardRisk: 2, ...over });

test('paper broker: fees on open, stop beats target inside one bar, state persists', async () => {
  const store = tmpStore();
  let t = 1_000_000;
  const b = new broker.PaperBroker({ startBalance: 10000, takerFeePct: 0.05, slippageBps: 0, persist: store, now: () => t });
  await b.init(['BTCUSDT']);
  await b.open(plan(), 'agents');
  const a1 = await b.account();
  near(a1.walletBalance, 10000 - 6400 * 0.0005);
  await assert.rejects(b.open(plan(), 'agents'), /이미/);
  // Restart: a new broker reads the same position back.
  const b2 = new broker.PaperBroker({ startBalance: 10000, takerFeePct: 0.05, slippageBps: 0, persist: store, now: () => t });
  assert.equal((await b2.positions()).length, 1);
  t += 60_000;
  const closed = await b2.sync({ BTCUSDT: { last: 64500, mark: 64500, high: 66100, low: 62900 } });
  assert.equal(closed.length, 1);
  assert.equal(closed[0].exitReason, '손절');
  near(closed[0].pnl, (63000 - 64000) * 0.1 - 6400 * 0.0005 - 6300 * 0.0005, 1e-6);
  const a2 = await b2.account();
  near(a2.walletBalance, 10000 + closed[0].pnl, 1e-6);
});

test('paper broker: target fill, funding charge on a long, manual close', async () => {
  let t = 0;
  const b = new broker.PaperBroker({ startBalance: 10000, takerFeePct: 0, slippageBps: 0, now: () => t });
  await b.init(['BTCUSDT']);
  await b.open(plan(), 'scalping');
  await b.sync({ BTCUSDT: { last: 64000, mark: 64000, high: 64000, low: 64000, fundingRate: 0.0001, nextFundingTime: 1000 } });
  t = 2000; // crossed the funding time
  await b.sync({ BTCUSDT: { last: 64000, mark: 64000, high: 64000, low: 64000, fundingRate: 0.0001, nextFundingTime: 1000 + 8 * 3600e3 } });
  const funded = await b.account();
  near(funded.walletBalance, 10000 - 64000 * 0.1 * 0.0001);
  const closed = await b.sync({ BTCUSDT: { last: 66050, mark: 66050, high: 66100, low: 65000 } });
  assert.equal(closed[0].exitReason, '익절');
  near(closed[0].pnl, 2000 * 0.1 - 0.64, 1e-6);
  await b.open(plan({ side: 'SHORT', stopLoss: 65000, takeProfit: 62000 }), 'scalping');
  const m = await b.close('BTCUSDT', '수동 청산');
  assert.equal(m.exitReason, '수동 청산');
  assert.equal((await b.positions()).length, 0);
});

// ─── scalper ─────────────────────────────────────────────────────────────────

const SCALP = shared.defaultTradingConfig().scalping;

function scalpInputs({ drift, takerBias = 0.5, bidQty = 2 }) {
  const k = bn.parseKlines(makeKlines({ n: 150, drift, vol: 0.0012, interval: '1m', seed: 11, takerBias }));
  const trend = bn.parseKlines(makeKlines({ n: 150, drift: drift * 3, vol: 0.002, interval: '5m', seed: 5 }));
  const px = k[k.length - 1].close;
  const depth = { bids: Array.from({ length: 20 }, (_, i) => [px - 0.1 - i * 0.1, bidQty]), asks: Array.from({ length: 20 }, (_, i) => [px + 0.1 + i * 0.1, 2]) };
  return { k, trend, depth, premium: null };
}

test('scalper: an uptrend scores long above short and proposes an ATR stop/target', () => {
  const ev = scalper.evaluateScalp(scalpInputs({ drift: 0.0006, takerBias: 0.65, bidQty: 3 }), { ...SCALP, minScore: 50 });
  assert.equal(ev.trend, 'up');
  assert.ok(ev.longScore > ev.shortScore, `${ev.longScore} vs ${ev.shortScore}`);
  if (ev.entry) {
    assert.equal(ev.entry.side, 'LONG');
    near(ev.price - ev.entry.stopLoss, SCALP.slAtr * ev.atr, 1e-6);
    near(ev.entry.takeProfit - ev.price, SCALP.tpAtr * ev.atr, 1e-6);
  } else {
    assert.ok(ev.blocked, 'no entry must say why');
  }
});

test('scalper: a downtrend mirrors to short; the agent bias filter can block it', () => {
  const inp = scalpInputs({ drift: -0.0006, takerBias: 0.35, bidQty: 1 });
  const ev = scalper.evaluateScalp(inp, { ...SCALP, minScore: 50 });
  assert.equal(ev.trend, 'down');
  assert.ok(ev.shortScore > ev.longScore);
  const blocked = scalper.evaluateScalp(inp, { ...SCALP, minScore: 50 }, 'LONG_ONLY');
  assert.equal(blocked.entry, undefined);
  if (ev.entry) assert.match(blocked.blocked, /방향 필터/);
  assert.equal(scalper.biasAllows('NO_TRADE', 'LONG'), false);
  assert.equal(scalper.biasAllows(undefined, 'SHORT'), true);
});

test('scalper: volatility and spread filters block entries', () => {
  const inp = scalpInputs({ drift: 0.0006, takerBias: 0.65, bidQty: 3 });
  const dead = scalper.evaluateScalp(inp, { ...SCALP, minAtrPct: 5, maxAtrPct: 9 });
  assert.match(dead.blocked, /변동성 너무 낮음/);
  const wide = { ...inp, depth: { bids: [[100, 1]], asks: [[101, 1]] } };
  assert.match(scalper.evaluateScalp(wide, { ...SCALP, minScore: 40 }).blocked || '', /스프레드|점수|양방향/);
});

test('manageScalp: time stop, break-even move, strong opposite signal', () => {
  const pos = { symbol: 'BTCUSDT', side: 'LONG', quantity: 0.1, entryPrice: 64000, markPrice: 64000, leverage: 10, unrealizedPnl: 0, stopLoss: 63900, takeProfit: 64200, openedAt: 0, source: 'scalping' };
  const ev = { price: 64000, longScore: 50, shortScore: 20, trend: 'up', atr: 80, atrPct: 0.12, spreadBps: 0.1, reasons: [] };
  assert.equal(scalper.manageScalp(pos, ev, SCALP, SCALP.maxHoldMinutes * 60e3, 0.05).action, 'close');
  const be = scalper.manageScalp(pos, { ...ev, price: 64110 }, SCALP, 60e3, 0.05);
  assert.equal(be.action, 'moveStop');
  near(be.stopLoss, 64000 * (1 + 2 * 0.0005));
  assert.equal(scalper.manageScalp(pos, { ...ev, shortScore: 90 }, SCALP, 60e3, 0.05).action, 'close');
  assert.equal(scalper.manageScalp(pos, ev, SCALP, 60e3, 0.05).action, 'hold');
});

// ─── config ──────────────────────────────────────────────────────────────────

test('normalizeTradingConfig clamps numbers and refuses live without acknowledgement', () => {
  const c = shared.normalizeTradingConfig({ venue: 'live', risk: { maxLeverage: 500, riskPerTradePct: 50 }, symbols: ['BTCUSDT', 'DOGEUSDT'], llm: { quickModel: 'rm -rf /' } });
  assert.equal(c.venue, 'paper');
  assert.equal(c.risk.maxLeverage, 50);
  assert.equal(c.risk.riskPerTradePct, 5);
  assert.deepEqual(c.symbols, ['BTCUSDT']);
  assert.equal(c.llm.quickModel, 'sonnet');
  const live = shared.normalizeTradingConfig({ venue: 'live', liveAcknowledged: true });
  assert.equal(live.venue, 'live');
  const scalp = shared.normalizeTradingConfig({ risk: { maxLeverage: 5 }, scalping: { leverage: 20, emaFast: 30, emaSlow: 10 } });
  assert.equal(scalp.scalping.leverage, 5);
  assert.ok(scalp.scalping.emaSlow > scalp.scalping.emaFast);
});

// ─── automation & live-key safety ────────────────────────────────────────────

test('automation settings default to manual start, keep-awake and notifications on', () => {
  const d = shared.normalizeTradingConfig({});
  assert.deepEqual(d.automation, { autoStart: false, keepAwake: true, notify: true });
  const c = shared.normalizeTradingConfig({ automation: { autoStart: true, keepAwake: 'yes', notify: false } });
  assert.deepEqual(c.automation, { autoStart: true, keepAwake: true, notify: false });
});

test('assessLiveKey refuses withdraw-capable or futures-less keys and warns on missing IP allowlist', () => {
  const base = { ipRestrict: true, enableReading: true, enableFutures: true, enableWithdrawals: false, enableInternalTransfer: false, permitsUniversalTransfer: false };
  assert.deepEqual(shared.assessLiveKey(base), { ok: true, problems: [], warnings: [] });
  const w = shared.assessLiveKey({ ...base, enableWithdrawals: true });
  assert.equal(w.ok, false);
  assert.match(w.problems[0], /출금/);
  assert.equal(shared.assessLiveKey({ ...base, enableFutures: false }).ok, false);
  const ip = shared.assessLiveKey({ ...base, ipRestrict: false });
  assert.equal(ip.ok, true);
  assert.match(ip.warnings[0], /IP/);
});

test('liveKeyPermissions reads /sapi/v1/account/apiRestrictions on the spot host, signed', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.includes('/api/v3/time')) return { ok: true, status: 200, text: async () => '{"serverTime":1760000000000}' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ ipRestrict: true, enableReading: true, enableFutures: true, enableWithdrawals: false, enableInternalTransfer: true, permitsUniversalTransfer: false }) };
  };
  const p = await bn.liveKeyPermissions('k', 's', fetchImpl, () => 1760000000000);
  assert.equal(p.enableFutures, true);
  assert.equal(p.enableInternalTransfer, true);
  assert.ok(seen.some((u) => u.startsWith('https://api.binance.com/api/v3/time')), 'time synced on the spot host');
  const call = seen.find((u) => u.includes('/sapi/v1/account/apiRestrictions'));
  assert.ok(call.startsWith('https://api.binance.com/'));
  assert.match(call, /signature=[0-9a-f]{64}/);
});
