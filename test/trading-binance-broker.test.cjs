'use strict';

/**
 * BinanceBroker against a small in-memory USDⓈ-M exchange. Pins the order
 * flow that real money depends on:
 *   - entry is a MARKET order on /fapi/v1/order;
 *   - stop and target are reduce-only conditional orders on /fapi/v1/algoOrder
 *     (never STOP_MARKET on /fapi/v1/order, which Binance now rejects with -4120);
 *   - a stop that cannot be placed flattens the position immediately;
 *   - a position closed on the exchange is detected, its leftover leg cancelled
 *     and its PnL read from the account's fills;
 *   - hedge-mode accounts get positionSide instead of reduceOnly.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { EXCHANGE_INFO } = require('./fixtures/trading-fixtures.cjs');

const bn = loadTs('src/main/trading/binance.ts');
const { BinanceBroker } = loadTs('src/main/trading/broker.ts');

function fakeExchange({ hedge = false, failAlgo = null } = {}) {
  const ex = { orders: [], algo: [], position: 0, entry: 0, mark: 64000, cancelled: 0, fills: [], nextId: 0 };
  const ok = (b) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) });
  const bad = (code, msg) => ({ ok: false, status: 400, text: async () => JSON.stringify({ code, msg }) });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const q = Object.fromEntries(u.searchParams);
    const m = (init.method || 'GET').toUpperCase();
    const key = `${m} ${u.pathname}`;
    switch (key) {
      case 'GET /fapi/v1/time': return ok({ serverTime: Date.now() });
      case 'GET /fapi/v1/exchangeInfo': return ok(EXCHANGE_INFO);
      case 'GET /fapi/v1/positionSide/dual': return ok({ dualSidePosition: hedge });
      case 'POST /fapi/v1/marginType': return bad(-4046, 'No need to change margin type.');
      case 'POST /fapi/v1/leverage': return ok({ leverage: Number(q.leverage), symbol: q.symbol });
      case 'POST /fapi/v1/order': {
        if (/STOP|TAKE_PROFIT/.test(q.type)) return bad(-4120, 'Order type not supported for this endpoint. Please use the Algo Order API endpoints instead.');
        ex.orders.push(q);
        const qty = Number(q.quantity);
        const signed = q.side === 'BUY' ? qty : -qty;
        if (ex.position === 0) ex.entry = ex.mark;
        ex.fills.push({ price: String(ex.mark), qty: q.quantity, side: q.side, realizedPnl: ex.position !== 0 ? String((ex.mark - ex.entry) * Math.sign(ex.position) * qty) : '0', commission: String(ex.mark * qty * 0.0005), time: Date.now() });
        ex.position = Number((ex.position + signed).toFixed(6));
        return ok({ orderId: ex.orders.length, executedQty: q.quantity, avgPrice: String(ex.mark), status: 'FILLED' });
      }
      case 'POST /fapi/v1/algoOrder': {
        if (failAlgo && failAlgo(q)) return bad(-2021, 'Order would immediately trigger.');
        ex.nextId = (ex.nextId || 0) + 1;
        ex.algo.push({ ...q, algoId: ex.nextId });
        return ok({ algoId: ex.nextId, algoStatus: 'NEW' });
      }
      case 'DELETE /fapi/v1/algoOpenOrders': ex.cancelled += ex.algo.length; ex.algo = []; return ok({ code: 200, msg: 'ok' });
      case 'DELETE /fapi/v1/algoOrder': {
        const before = ex.algo.length;
        ex.algo = ex.algo.filter((o) => String(o.algoId) !== String(q.algoId));
        if (ex.algo.length === before) return bad(-2011, 'Unknown order sent.');
        ex.cancelled += 1;
        return ok({ algoId: Number(q.algoId), code: '200' });
      }
      case 'GET /fapi/v1/openAlgoOrders': return ok(ex.algo);
      case 'GET /fapi/v3/positionRisk': return ok(ex.position ? [{ symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: String(ex.position), entryPrice: String(ex.entry), markPrice: String(ex.mark), unRealizedProfit: String((ex.mark - ex.entry) * ex.position), liquidationPrice: '0', notional: String(ex.mark * ex.position), updateTime: Date.now() }] : []);
      case 'GET /fapi/v3/account': return ok({ totalWalletBalance: '1000', totalUnrealizedProfit: '0', totalMarginBalance: '1000', availableBalance: '900' });
      case 'GET /fapi/v1/userTrades': return ok(ex.fills);
      default: return { ok: false, status: 404, text: async () => JSON.stringify({ code: -1, msg: `unmocked ${key}` }) };
    }
  };
  return { ex, fetchImpl };
}

const plan = { symbol: 'BTCUSDT', side: 'LONG', entryType: 'MARKET', entryPrice: 64000, stopLoss: 63000, takeProfit: 66000, leverage: 5, quantity: 0.015, notional: 960, riskUsdt: 15, rewardRisk: 2 };

function makeBroker(fx, logs = []) {
  const client = new bn.BinanceFuturesClient({ baseUrl: 'https://demo-fapi.binance.com', apiKey: 'k', apiSecret: 's', fetch: fx.fetchImpl });
  return new BinanceBroker('demo', client, { marginType: 'ISOLATED', defaultLeverage: 3, log: (m, l) => logs.push([l, m]), sleep: async () => {} });
}

test('open = MARKET entry + reduce-only STOP_MARKET and TAKE_PROFIT_MARKET via the Algo API', async () => {
  const fx = fakeExchange();
  const b = makeBroker(fx);
  await b.init(['BTCUSDT']);
  const pos = await b.open(plan, 'agents');
  assert.equal(fx.ex.orders.length, 1);
  assert.equal(fx.ex.orders[0].type, 'MARKET');
  assert.equal(fx.ex.orders[0].side, 'BUY');
  assert.equal(fx.ex.orders[0].quantity, '0.015');
  assert.equal(fx.ex.algo.length, 2);
  const [sl, tp] = fx.ex.algo;
  assert.equal(sl.type, 'STOP_MARKET');
  assert.equal(sl.algoType, 'CONDITIONAL');
  assert.equal(sl.side, 'SELL');
  assert.equal(sl.reduceOnly, 'true');
  assert.equal(sl.triggerPrice, '63000.0');
  assert.equal(sl.workingType, 'MARK_PRICE');
  assert.equal(tp.type, 'TAKE_PROFIT_MARKET');
  assert.equal(tp.triggerPrice, '66000.0');
  assert.equal(pos.stopLoss, 63000);
  const listed = await b.positions();
  assert.equal(listed[0].source, 'agents');
  assert.equal(listed[0].stopLoss, 63000);
});

test('stop placement failure flattens the position at once', async () => {
  const fx = fakeExchange({ failAlgo: (q) => q.type === 'STOP_MARKET' });
  const logs = [];
  const b = makeBroker(fx, logs);
  await b.init(['BTCUSDT']);
  await assert.rejects(b.open(plan, 'scalping'));
  assert.equal(fx.ex.position, 0, 'no unprotected position left');
  assert.equal(fx.ex.orders.length, 2);
  assert.equal(fx.ex.orders[1].side, 'SELL');
  assert.equal(fx.ex.orders[1].reduceOnly, 'true');
  assert.ok(logs.some(([l, m]) => l === 'error' && /즉시 청산/.test(m)));
});

test('a stop that fired on the exchange is detected and booked from fills', async () => {
  const fx = fakeExchange();
  const b = makeBroker(fx);
  await b.init(['BTCUSDT']);
  await b.open(plan, 'agents');
  // Exchange-side stop fill.
  fx.ex.mark = 63000;
  fx.ex.fills.push({ price: '63000', qty: '0.015', side: 'SELL', realizedPnl: '-15', commission: '0.4725', time: Date.now() });
  fx.ex.position = 0;
  fx.ex.algo = fx.ex.algo.filter((o) => o.type !== 'STOP_MARKET');
  const closed = await b.sync({ BTCUSDT: { last: 63000, mark: 63000, high: 64000, low: 62990 } });
  assert.equal(closed.length, 1);
  assert.equal(closed[0].exitReason, '손절');
  assert.equal(closed[0].exitPrice, 63000);
  assert.ok(closed[0].pnl < -15, `pnl ${closed[0].pnl} includes fees`);
  assert.equal(fx.ex.algo.length, 0, 'leftover take-profit cancelled');
  assert.equal((await b.sync({})).length, 0, 'booked once');
});

test('updateStops replaces both legs; close is reduce-only and clears algo orders', async () => {
  const fx = fakeExchange();
  const b = makeBroker(fx);
  await b.init(['BTCUSDT']);
  await b.open(plan, 'scalping');
  await b.updateStops('BTCUSDT', 64064, null);
  assert.equal(fx.ex.algo.length, 2);
  assert.equal(fx.ex.algo[0].triggerPrice, '64064.0');
  assert.equal(fx.ex.algo[1].triggerPrice, '66000.0');
  const t = await b.close('BTCUSDT', '수동 청산');
  assert.equal(t.exitReason, '수동 청산');
  assert.equal(fx.ex.position, 0);
  assert.equal(fx.ex.algo.length, 0);
});

test('hedge-mode accounts use positionSide instead of reduceOnly', async () => {
  const fx = fakeExchange({ hedge: true });
  const b = makeBroker(fx);
  await b.init(['BTCUSDT']);
  await b.open({ ...plan, side: 'SHORT', stopLoss: 65000, takeProfit: 62000 }, 'agents');
  assert.equal(fx.ex.orders[0].positionSide, 'SHORT');
  assert.equal(fx.ex.orders[0].side, 'SELL');
  assert.equal(fx.ex.algo[0].positionSide, 'SHORT');
  assert.equal(fx.ex.algo[0].side, 'BUY');
  assert.equal(fx.ex.algo[0].reduceOnly, undefined);
});

test('opening sweeps stale closing-type conditional orders but leaves the user\'s entry orders alone', async () => {
  const fx = fakeExchange();
  // Leftovers from a previous position (no position now) and a user's own stop-entry order.
  fx.ex.algo.push({ symbol: 'BTCUSDT', type: 'STOP_MARKET', side: 'SELL', reduceOnly: 'true', algoId: 901 });
  fx.ex.algo.push({ symbol: 'BTCUSDT', type: 'STOP_MARKET', side: 'BUY', reduceOnly: 'false', algoId: 902 });
  const b = makeBroker(fx);
  await b.init(['BTCUSDT']);
  await b.open(plan, 'agents');
  const ids = fx.ex.algo.map((o) => o.algoId);
  assert.ok(!ids.includes(901), 'stale reduce-only stop removed');
  assert.ok(ids.includes(902), 'user entry order kept');
  await b.close('BTCUSDT', '수동 청산');
  assert.deepEqual(fx.ex.algo.map((o) => o.algoId), [902], 'only the desk\'s own legs were cancelled');
});

test('isClosingAlgo recognises reduce-only, closePosition and hedge-mode closing legs', () => {
  const { isClosingAlgo } = loadTs('src/main/trading/broker.ts');
  assert.equal(isClosingAlgo({ reduceOnly: true }), true);
  assert.equal(isClosingAlgo({ closePosition: 'true' }), true);
  assert.equal(isClosingAlgo({ positionSide: 'LONG', side: 'SELL' }), true);
  assert.equal(isClosingAlgo({ positionSide: 'SHORT', side: 'BUY' }), true);
  assert.equal(isClosingAlgo({ positionSide: 'LONG', side: 'BUY' }), false);
  assert.equal(isClosingAlgo({ positionSide: 'BOTH', side: 'BUY', reduceOnly: 'false' }), false);
});
