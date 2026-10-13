'use strict';

/**
 * Trading desk — 75x scalping: Binance leverage tiers, the isolated
 * liquidation price, the risk engine's tier/liquidation guards and the
 * scalper's trade card. Pins:
 *   - tiers join continuously (cum) and parse from both response shapes;
 *   - the liquidation price satisfies equity == maintenance margin exactly;
 *   - 75x is kept when the stop is tight and lowered when the stop is wide,
 *     the tier is too small, or the notional is too big for the leverage;
 *   - paper positions liquidate at that price when it comes before the stop;
 *   - the plan card's numbers agree with the risk engine and with each other;
 *   - v1 configs migrate to 75x scalping while agents keep their old ceiling.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const lev = loadTs('src/main/trading/leverage.ts');
const risk = loadTs('src/main/trading/risk.ts');
const broker = loadTs('src/main/trading/broker.ts');
const scalper = loadTs('src/main/trading/scalper.ts');
const shared = loadTs('src/shared/trading.ts');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b}`);

test('tiers: cum keeps maintenance margin continuous; both response shapes parse', () => {
  for (const sym of ['BTCUSDT', 'ETHUSDT']) {
    const b = lev.FALLBACK_BRACKETS[sym];
    for (let i = 1; i < b.length; i++) {
      const n = b[i].notionalFloor;
      near(n * b[i - 1].maintMarginRatio - b[i - 1].cum, n * b[i].maintMarginRatio - b[i].cum, 1e-6, `${sym} tier ${i + 1}`);
    }
    assert.ok(lev.maxNotionalAt(b, 75) > 0, `${sym} allows 75x`);
  }
  const raw = [{ symbol: 'BTCUSDT', notionalCoef: 1, brackets: [
    { bracket: 2, initialLeverage: 100, notionalCap: 600000, notionalFloor: 50000, maintMarginRatio: 0.005, cum: 50 },
    { bracket: 1, initialLeverage: 125, notionalCap: 50000, notionalFloor: 0, maintMarginRatio: 0.004, cum: 0 }
  ] }];
  const arr = lev.parseLeverageBrackets(raw);
  assert.deepEqual(arr.BTCUSDT.map((x) => x.initialLeverage), [125, 100], 'sorted by floor');
  assert.deepEqual(lev.parseLeverageBrackets(raw[0]).BTCUSDT, arr.BTCUSDT, 'single-symbol object form');
  assert.deepEqual(lev.parseLeverageBrackets({ code: -2015, msg: 'Invalid API-key' }), {});
  assert.equal(lev.bracketFor(arr.BTCUSDT, 49_999).initialLeverage, 125);
  assert.equal(lev.bracketFor(arr.BTCUSDT, 50_000).initialLeverage, 100);
  assert.equal(lev.bracketFor(arr.BTCUSDT, 9e9).initialLeverage, 100, 'beyond the table → last tier');
});

test('isolated liquidation price: equity equals maintenance margin there', () => {
  const b = lev.FALLBACK_BRACKETS.BTCUSDT;
  for (const [side, q, L] of [['LONG', 0.1, 75], ['SHORT', 0.1, 75], ['LONG', 20, 20], ['SHORT', 20, 10]]) {
    const ep = 64000;
    const r = lev.liquidationPrice({ side, entryPrice: ep, quantity: q, leverage: L, brackets: b });
    const dir = side === 'LONG' ? 1 : -1;
    const equity = r.margin + dir * q * (r.price - ep);
    const maint = q * r.price * r.mmr - r.cum;
    near(equity, maint, 1e-6, `${side} ${q}@${L}x`);
    assert.ok(side === 'LONG' ? r.price < ep : r.price > ep);
  }
  // 75x long, first tier: ~0.94% below entry.
  const long75 = lev.liquidationPrice({ side: 'LONG', entryPrice: 64000, quantity: 0.1, leverage: 75, brackets: b });
  near(long75.price, (64000 * (1 - 1 / 75)) / (1 - 0.004), 1e-6);
  near((64000 - long75.price) / 64000 * 100, 0.94, 0.01);
});

test('maxSafeLeverage keeps liquidation 1.25 stop-distances out', () => {
  assert.ok(lev.maxSafeLeverage(0.002, 0.004) >= 75, 'a 0.2% scalp stop allows 75x');
  assert.equal(lev.maxSafeLeverage(0.01, 0.004), 60, 'a 1% stop does not');
  for (const stop of [0.001, 0.003, 0.008, 0.02]) {
    const L = lev.maxSafeLeverage(stop, 0.004);
    const liq = lev.liquidationPrice({ side: 'SHORT', entryPrice: 100, quantity: 1, leverage: L, brackets: [{ bracket: 1, initialLeverage: 125, notionalFloor: 0, notionalCap: 1e9, maintMarginRatio: 0.004, cum: 0 }] });
    assert.ok((liq.price - 100) / 100 >= 1.25 * stop - 1e-12, `stop ${stop} → ${L}x`);
  }
});

const RISK = { ...shared.defaultTradingConfig().risk };
const FILTERS = broker.FALLBACK_FILTERS.BTCUSDT;
const ctx = (over = {}) => ({ symbol: 'BTCUSDT', price: 64000, equity: 10000, available: 10000, filters: FILTERS, risk: RISK, minRewardRisk: 0, defaultLeverage: 3, ...over });

test('risk engine keeps 75x on a tight scalp stop and reports liquidation and margin', () => {
  const v = risk.sizeOrder({ side: 'LONG', entryType: 'MARKET', entryPrice: 64000, stopLoss: 63900, takeProfit: 64150, leverage: 75, riskPct: 1 }, ctx());
  assert.equal(v.approved, true, v.reason);
  assert.equal(v.plan.leverage, 75);
  assert.ok(v.plan.liquidationPrice < v.plan.stopLoss, 'stop fires before liquidation');
  near(v.plan.margin, v.plan.notional / 75, 1e-6);
  assert.equal(v.plan.maintMarginRate, 0.004);
  assert.match(v.reason, /청산가/);
});

test('risk engine lowers 75x for a wide stop, a big notional, or a tier that does not allow it', () => {
  const wide = risk.sizeOrder({ side: 'SHORT', entryType: 'MARKET', entryPrice: 64000, stopLoss: 64700, takeProfit: 62600, leverage: 75, riskPct: 1 }, ctx());
  assert.equal(wide.approved, true, wide.reason);
  assert.ok(wide.plan.leverage < 75 && wide.adjustments.some((a) => /청산가보다 먼저/.test(a)));
  assert.ok(wide.plan.liquidationPrice > wide.plan.stopLoss);
  // A huge account: notional lands in a tier capped below the request.
  const big = risk.sizeOrder({ side: 'LONG', entryType: 'MARKET', entryPrice: 64000, stopLoss: 63900, takeProfit: 64150, leverage: 100, riskPct: 1 },
    ctx({ equity: 2_000_000, available: 2_000_000, risk: { ...RISK, maxLeverage: 125 } }));
  assert.equal(big.approved, true, big.reason);
  assert.ok(big.plan.leverage <= 75, `lev ${big.plan.leverage}`);
  assert.ok(big.plan.notional <= lev.maxNotionalAt(lev.FALLBACK_BRACKETS.BTCUSDT, big.plan.leverage) + 1e-6);
  assert.ok(big.adjustments.some((a) => /거래소/.test(a)));
  // Exchange tiers from the account override the estimate.
  const tight = [{ bracket: 1, initialLeverage: 50, notionalFloor: 0, notionalCap: 1e9, maintMarginRatio: 0.01, cum: 0 }];
  const t = risk.sizeOrder({ side: 'LONG', entryType: 'MARKET', entryPrice: 64000, stopLoss: 63900, takeProfit: 64150, leverage: 75, riskPct: 1 }, ctx({ brackets: tight }));
  assert.equal(t.plan.leverage, 50);
  assert.equal(t.plan.maintMarginRate, 0.01);
});

test('paper broker liquidates at the tier price when it comes before the stop', async () => {
  const pb = new broker.PaperBroker({ startBalance: 10000, takerFeePct: 0.05, slippageBps: 0 });
  await pb.init(['BTCUSDT']);
  // A stop placed beyond liquidation (the risk engine would never do this).
  await pb.open({ symbol: 'BTCUSDT', side: 'LONG', entryType: 'MARKET', entryPrice: 64000, stopLoss: 60000, takeProfit: 70000, leverage: 75, quantity: 0.1, notional: 6400, riskUsdt: 0, rewardRisk: 1 }, 'scalping');
  const [pos] = await pb.positions();
  near(pos.liquidationPrice, (64000 * (1 - 1 / 75)) / (1 - 0.004), 1e-6);
  near(pos.margin, 6400 / 75, 1e-9);
  const closed = await pb.sync({ BTCUSDT: { last: 63300, mark: 63300, high: 64000, low: 63300 } });
  assert.equal(closed.length, 1);
  assert.equal(closed[0].exitReason, '강제 청산(모의)');
  near(closed[0].exitPrice, pos.liquidationPrice, 1e-6);
  // Loss ≈ margin − maintenance margin (+ fees).
  near(-closed[0].pnl, 6400 / 75 - 0.1 * pos.liquidationPrice * 0.004 + closed[0].fees, 0.01);
  // A stop closer than liquidation wins.
  await pb.open({ symbol: 'BTCUSDT', side: 'SHORT', entryType: 'MARKET', entryPrice: 64000, stopLoss: 64100, takeProfit: 63000, leverage: 75, quantity: 0.1, notional: 6400, riskUsdt: 0, rewardRisk: 1 }, 'scalping');
  const c2 = await pb.sync({ BTCUSDT: { last: 65000, mark: 65000, high: 65000, low: 64000 } });
  assert.equal(c2[0].exitReason, '손절');
});

test('scalp plan card at 75x: levels, liquidation, margin, ROE and net R:R agree', () => {
  const p = { ...shared.defaultTradingConfig().scalping };
  assert.equal(p.leverage, 75);
  const ev = { price: 64000, longScore: 72, shortScore: 30, trend: 'up', atr: 80, atrPct: 0.125, spreadBps: 0.2, reasons: [],
    entry: { side: 'LONG', stopLoss: 64000 - 1.2 * 80, takeProfit: 64000 + 1.8 * 80, score: 72 } };
  const plan = scalper.scalpPlan(ev, ctx(), p, true);
  assert.equal(plan.ready, true);
  assert.equal(plan.side, 'LONG');
  assert.equal(plan.leverage, 75);
  near(plan.rewardRisk, 1.5, 1e-9);
  assert.ok(plan.rewardRiskNet < plan.rewardRisk, 'fees eat into a 1.5R scalp');
  assert.ok(plan.liquidationPrice < plan.stopLoss && plan.liquidationPct > plan.stopPct);
  near(plan.margin, plan.notional / 75, 1e-6);
  near(plan.roeAtStop, (-plan.riskUsdt / plan.margin) * 100, 1e-9);
  near(plan.roeAtTarget, (plan.rewardUsdt / plan.margin) * 100, 1e-9);
  // At 75x a 0.15% stop is −11.25% of margin before costs; round-trip taker
  // fees + slippage (0.14%) add another −10.5%. On a 1-minute scalp the costs
  // are as big as the stop — the card's net R:R says so.
  near(plan.roeAtStop, -(0.15 + 0.14) * 75, 0.05, 'ROE at stop');
  near(plan.rewardRiskNet, (0.225 - 0.14) / (0.15 + 0.14), 0.002, 'net R:R');
  near(plan.breakEvenPct, 2 * (0.05 / 100 + 2 / 10000) * 100, 1e-9);
  assert.equal(plan.bracketsEstimated, true);
  // No entry signal: the card shows the leading side's would-be trade and why it is waiting.
  const waiting = scalper.scalpPlan({ ...ev, entry: undefined, longScore: 20, shortScore: 50, blocked: '점수 미달 (50 < 65)' }, ctx(), p, false);
  assert.equal(waiting.ready, false);
  assert.equal(waiting.side, 'SHORT');
  assert.ok(waiting.stopLoss > waiting.entryPrice && waiting.liquidationPrice > waiting.stopLoss);
  assert.match(waiting.notes[0], /점수 미달/);
  // A halted day still shows the levels, with the reason.
  const halted = scalper.scalpPlan(ev, ctx({ haltedReason: '일일 손실 한도' }), p, true);
  assert.equal(halted.ready, false);
  assert.ok(halted.quantity > 0 && halted.notes.some((n) => /일일 손실 한도/.test(n)));
});

test('v1 configs move scalping to 75x; agents keep their ceiling; v2 values are kept', () => {
  const v1 = shared.normalizeTradingConfig({ version: 1, risk: { maxLeverage: 10 }, scalping: { leverage: 10 }, agents: { defaultLeverage: 3 } });
  assert.equal(v1.version, 2);
  assert.equal(v1.scalping.leverage, 75);
  assert.equal(v1.risk.maxLeverage, 75);
  assert.equal(v1.agents.maxLeverage, 10);
  assert.equal(v1.agents.defaultLeverage, 3);
  const v2 = shared.normalizeTradingConfig({ version: 2, risk: { maxLeverage: 100 }, scalping: { leverage: 20 }, agents: { maxLeverage: 15, defaultLeverage: 40 } });
  assert.equal(v2.scalping.leverage, 20);
  assert.equal(v2.agents.maxLeverage, 15);
  assert.equal(v2.agents.defaultLeverage, 15, 'default ≤ agent ceiling');
  const fresh = shared.normalizeTradingConfig({});
  assert.equal(fresh.scalping.leverage, 75);
  assert.equal(fresh.agents.maxLeverage, 10);
  assert.equal(shared.normalizeTradingConfig({ scalping: { leverage: 500 }, risk: { maxLeverage: 500 } }).scalping.leverage, 125);
});
