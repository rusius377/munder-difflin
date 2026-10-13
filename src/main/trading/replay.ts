/**
 * Scalping replay ("과거 차트 리테스트") — the live scalper, run over history.
 *
 * Nothing here re-implements the strategy: every decision comes from the same
 * evaluateScalp / manageScalp / sizeOrder the live desk calls, fed with the
 * market as it was at that moment:
 *
 *   clock      every `evalEverySec` seconds on days with the tape (aggTrades),
 *              every minute on days with candles only
 *   candles    closed entry/trend bars + the bar forming at that moment
 *   flow       1- and 5-minute CVD, aggression share, trade rate, big trades
 *              and absorption from the tape; ±1% depth imbalance from bookDepth
 *   fills      market entry at the price then, plus slippage and taker fee;
 *              stop, target and liquidation checked second by second on the
 *              tape (minute by minute on candles — stop first when a bar
 *              touches both); exits pay slippage and fee
 *   rules      cooldown, trades per hour, daily loss limit and losing streak
 *              exactly as live; break-even move, time stop and opposite-signal
 *              exit through manageScalp
 *
 * Funding is not charged (scalps rarely cross a funding time); the result says so.
 */
import { evaluateScalp, manageScalp, type ScalpEval } from './scalper';
import { sizeOrder, grossPnl, type RiskContext } from './risk';
import { FALLBACK_FILTERS } from './broker';
import { FALLBACK_BRACKETS } from './leverage';
import { aggregateKlines, TF_MINUTES, type DepthSnap, type SecondBar } from './histData';
import type { FlowFeatures } from './orderFlow';
import type { Kline } from './indicators';
import type {
  BacktestStats, BacktestTrade, PositionView, RiskSettings, ScalpingSettings, Side, TradeFeatures, TradingSymbol
} from '../../shared/trading';

export type { BacktestStats, BacktestTrade, TradeFeatures };

export interface ReplayRequest {
  symbol: TradingSymbol;
  from: number;
  to: number;
  scalping: ScalpingSettings;
  risk: RiskSettings;
  startEquity: number;
  /** Seconds between evaluations on tape days (≥ 1). */
  evalEverySec: number;
  /** Keep the evaluation stream (for an external execution engine). */
  collectSignals?: boolean;
}

export interface ReplayData {
  /** 1-minute candles, including warm-up history before `from`. */
  k1m: Kline[];
  seconds?: SecondBar[];
  depth?: DepthSnap[];
}

/** One evaluation, for an engine that executes the desk's signals itself. */
export interface ReplaySignal {
  t: number;
  price: number;
  longScore: number;
  shortScore: number;
  atr: number;
  entry?: { side: Side; stopLoss: number; takeProfit: number; score: number; features: TradeFeatures };
}

export interface ReplayResult {
  symbol: TradingSymbol;
  from: number;
  to: number;
  dataLevel: 'tape' | 'candles' | 'mixed';
  trades: BacktestTrade[];
  /** [time, equity] after each trade, plus the start. */
  equity: Array<[number, number]>;
  stats: BacktestStats;
  notes: string[];
  signals?: ReplaySignal[];
  evaluations: number;
}

interface OpenPos {
  side: Side;
  entryTime: number;
  entryPrice: number;
  quantity: number;
  leverage: number;
  stopLoss: number;
  takeProfit: number;
  liquidationPrice: number;
  margin: number;
  riskUsdt: number;
  fees: number;
  features: TradeFeatures;
}

/** Last index with `key(i) <= t` in a sorted array (−1 if none). */
function lastAtOrBefore<T>(arr: readonly T[], t: number, key: (x: T) => number): number {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]) <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/**
 * Prefix sums over the tape, so any window's flow is O(log n).
 */
export class TapeIndex {
  private readonly cBuy: Float64Array;
  private readonly cSell: Float64Array;
  private readonly cN: Float64Array;
  private readonly cBigB: Float64Array;
  private readonly cBigS: Float64Array;

  constructor(readonly s: readonly SecondBar[]) {
    const n = s.length;
    this.cBuy = new Float64Array(n + 1);
    this.cSell = new Float64Array(n + 1);
    this.cN = new Float64Array(n + 1);
    this.cBigB = new Float64Array(n + 1);
    this.cBigS = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      this.cBuy[i + 1] = this.cBuy[i] + s[i].buy;
      this.cSell[i + 1] = this.cSell[i] + s[i].sell;
      this.cN[i + 1] = this.cN[i] + s[i].n;
      this.cBigB[i + 1] = this.cBigB[i] + s[i].bigBuys;
      this.cBigS[i + 1] = this.cBigS[i] + s[i].bigSells;
    }
  }

  /** Index range [a, b) of seconds that STARTED in [t0, t1). */
  private range(t0: number, t1: number): [number, number] {
    return [lastAtOrBefore(this.s, t0 - 1, (x) => x.t) + 1, lastAtOrBefore(this.s, t1 - 1, (x) => x.t) + 1];
  }

  covers(t: number): boolean {
    return this.s.length > 0 && t >= this.s[0].t && t <= this.s[this.s.length - 1].t + 60_000;
  }

  /** Last traded price before t. */
  priceAt(t: number): number | null {
    const i = lastAtOrBefore(this.s, t - 1000, (x) => x.t);
    return i >= 0 ? this.s[i].c : null;
  }

  /** Seconds strictly inside (t0, t1] as bars to walk a position through. */
  between(t0: number, t1: number): readonly SecondBar[] {
    const [a, b] = this.range(t0, t1);
    return this.s.slice(a, b);
  }

  /** Same features the live tracker computes, from per-second records. */
  features(t: number, imbalance: number | null): FlowFeatures {
    const sum = (c: Float64Array, a: number, b: number) => c[b] - c[a];
    const [a1, b1] = this.range(t - 60_000, t);
    const [a5, b5] = this.range(t - 300_000, t);
    const [a10, b10] = this.range(t - 10_000, t);
    const buy1 = sum(this.cBuy, a1, b1);
    const sell1 = sum(this.cSell, a1, b1);
    const vol1m = buy1 + sell1;
    const cvd1m = buy1 - sell1;
    const cvd5m = sum(this.cBuy, a5, b5) - sum(this.cSell, a5, b5);
    const buyShare1m = vol1m > 0 ? buy1 / vol1m : null;
    const first = a1 < b1 ? this.s[a1].o : null;
    const last = b1 > 0 ? this.s[b1 - 1].c : null;
    const change1mPct = first && last && a1 < b1 ? ((last - first) / first) * 100 : null;
    let absorption: FlowFeatures['absorption'] = null;
    if (buyShare1m !== null && change1mPct !== null && vol1m > 0 && Math.abs(cvd1m) > 0.2 * vol1m) {
      if (buyShare1m <= 0.4 && change1mPct >= 0) absorption = 'buy';
      else if (buyShare1m >= 0.6 && change1mPct <= 0) absorption = 'sell';
    }
    return {
      source: 'replay', cvd1m, cvd5m, vol1m, buyShare1m,
      tradesPerSec: sum(this.cN, a10, b10) / 10,
      bigBuys: sum(this.cBigB, a5, b5), bigSells: sum(this.cBigS, a5, b5),
      bookImbalance: imbalance, walls: [], spreadBps: null, change1mPct, absorption, lastPrice: last, updatedAt: t
    };
  }
}

const RANGE_STEP = 60_000;

/** The bar of `tfMin` minutes containing t: closed 1m candles inside it, then the price now. */
function formingBar(k1m: readonly Kline[], tfMin: number, t: number, price: number, tape: TapeIndex | null): Kline {
  const step = tfMin * 60_000;
  const open = t - (t % step);
  const minuteOpen = t - (t % RANGE_STEP);
  const i0 = lastAtOrBefore(k1m, open - 1, (x) => x.openTime) + 1;
  const i1 = lastAtOrBefore(k1m, minuteOpen - 1, (x) => x.openTime) + 1;
  const bar: Kline = { openTime: open, open: price, high: price, low: price, close: price, volume: 0, closeTime: open + step - 1, quoteVolume: 0, trades: 0, takerBuyBase: 0, takerBuyQuote: 0 };
  let first = true;
  for (let i = i0; i < i1; i++) {
    const k = k1m[i];
    if (first) { bar.open = k.open; bar.high = k.high; bar.low = k.low; first = false; }
    bar.high = Math.max(bar.high, k.high);
    bar.low = Math.min(bar.low, k.low);
    bar.volume += k.volume;
    bar.quoteVolume += k.quoteVolume;
    bar.trades += k.trades;
    bar.takerBuyBase += k.takerBuyBase;
    bar.takerBuyQuote += k.takerBuyQuote;
  }
  // The current minute so far, from the tape.
  if (tape) {
    for (const s of tape.between(minuteOpen - 1, t)) {
      if (first) { bar.open = s.o; bar.high = s.h; bar.low = s.l; first = false; }
      bar.high = Math.max(bar.high, s.h);
      bar.low = Math.min(bar.low, s.l);
      bar.volume += s.buy + s.sell;
      bar.takerBuyBase += s.buy;
      bar.trades += s.n;
    }
  }
  bar.high = Math.max(bar.high, price);
  bar.low = Math.min(bar.low, price);
  bar.close = price;
  return bar;
}

export function featuresAt(ev: ScalpEval, side: Side, flow: FlowFeatures | null | undefined, t: number): TradeFeatures {
  const want = side === 'LONG' ? 'up' : 'down';
  const dir = side === 'LONG' ? 1 : -1;
  let f: TradeFeatures['flow'] = 'none';
  if (flow && flow.vol1m > 0 && flow.buyShare1m !== null) {
    const aligned = dir * flow.cvd1m > 0 && (dir === 1 ? flow.buyShare1m >= 0.55 : flow.buyShare1m <= 0.45);
    const opposed = dir * flow.cvd1m < 0 && (dir === 1 ? flow.buyShare1m <= 0.45 : flow.buyShare1m >= 0.55);
    f = aligned ? 'with' : opposed ? 'against' : 'neutral';
  }
  return {
    trendAligned: ev.trend === want ? 'with' : ev.trend === 'flat' ? 'flat' : 'against',
    score: ev.entry?.score ?? (side === 'LONG' ? ev.longScore : ev.shortScore),
    atrPct: ev.atrPct,
    flow: f,
    hourUtc: new Date(t).getUTCHours()
  };
}

export function computeStats(trades: readonly BacktestTrade[], startEquity: number, equity: ReadonlyArray<[number, number]>): BacktestStats {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
  const netPnl = grossProfit - grossLoss;
  let peak = startEquity, maxDd = 0;
  for (const [, e] of equity) {
    peak = Math.max(peak, e);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - e) / peak);
  }
  const byExit: Record<string, number> = {};
  for (const t of trades) byExit[t.exitReason] = (byExit[t.exitReason] ?? 0) + 1;
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? wins.length / trades.length : null,
    netPnl,
    returnPct: startEquity > 0 ? (netPnl / startEquity) * 100 : 0,
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : null,
    avgR: trades.length ? trades.reduce((a, t) => a + t.pnlR, 0) / trades.length : null,
    maxDrawdownPct: maxDd * 100,
    avgHoldMin: trades.length ? trades.reduce((a, t) => a + (t.exitTime - t.entryTime), 0) / trades.length / 60_000 : null,
    fees: trades.reduce((a, t) => a + t.fees, 0),
    liquidations: trades.filter((t) => t.exitReason === '강제 청산').length,
    longs: trades.filter((t) => t.side === 'LONG').length,
    shorts: trades.filter((t) => t.side === 'SHORT').length,
    byExit,
    endEquity: startEquity + netPnl
  };
}

export interface ReplayControl {
  /** Called every ~2% of the range; return true to stop early. */
  progress?: (pct: number, trades: number) => boolean | void;
  /** Yield to the event loop now and then (keeps the app responsive). */
  yieldEvery?: number;
}

export async function runScalpReplay(req: ReplayRequest, data: ReplayData, ctl: ReplayControl = {}): Promise<ReplayResult> {
  const p = req.scalping;
  const r = req.risk;
  const entryMin = TF_MINUTES[p.timeframe] ?? 1;
  const trendMin = TF_MINUTES[p.trendTimeframe] ?? 5;
  const k1m = data.k1m;
  if (!k1m.length) throw new Error('리플레이할 캔들이 없습니다');
  const entryBars = aggregateKlines(k1m, entryMin);
  const trendBars = aggregateKlines(k1m, trendMin);
  const tape = data.seconds && data.seconds.length ? new TapeIndex(data.seconds) : null;
  const depth = data.depth ?? [];
  const fee = r.takerFeePct / 100;
  const slip = r.slippageBps / 10_000;
  const notes: string[] = ['펀딩비는 반영하지 않았습니다 (스캘핑은 보유 시간이 짧음)'];
  if (!depth.length) notes.push('호가 깊이 자료가 없어 호가 불균형 점수는 빠졌습니다');

  let wallet = req.startEquity;
  let pos: OpenPos | null = null;
  const trades: BacktestTrade[] = [];
  const equity: Array<[number, number]> = [[req.from, wallet]];
  const signals: ReplaySignal[] = [];
  let lastExit = -Infinity;
  const entryTimes: number[] = [];
  let dayKey = '';
  let dayStart = wallet;
  let streak = 0;
  let tapeEvals = 0;
  let candleEvals = 0;

  const kPrice = (t: number) => {
    const i = lastAtOrBefore(k1m, t - RANGE_STEP, (x) => x.openTime);
    return i >= 0 ? k1m[i].close : null;
  };
  const priceAt = (t: number) => (tape?.covers(t) ? tape.priceAt(t) : null) ?? kPrice(t);
  const exitFill = (side: Side, px: number) => (side === 'LONG' ? px * (1 - slip) : px * (1 + slip));

  const close = (t: number, rawPx: number, reason: string, slipped = true) => {
    if (!pos) return;
    const px = slipped ? exitFill(pos.side, rawPx) : rawPx;
    const exitFee = px * pos.quantity * fee;
    const gross = grossPnl(pos.side, pos.quantity, pos.entryPrice, px);
    const pnl = gross - exitFee - pos.fees;
    wallet += gross - exitFee; // the entry fee left the wallet at entry
    trades.push({
      side: pos.side, entryTime: pos.entryTime, exitTime: t, entryPrice: pos.entryPrice, exitPrice: px,
      stopLoss: pos.stopLoss, takeProfit: pos.takeProfit, quantity: pos.quantity, leverage: pos.leverage,
      liquidationPrice: pos.liquidationPrice, margin: pos.margin, pnl, pnlR: pos.riskUsdt > 0 ? pnl / pos.riskUsdt : 0,
      roe: pos.margin > 0 ? (pnl / pos.margin) * 100 : 0, fees: exitFee + pos.fees, exitReason: reason, features: pos.features
    });
    equity.push([t, wallet]);
    lastExit = t;
    streak = pnl > 0 ? 0 : streak + 1;
    pos = null;
  };

  /** Walk the open position through (t0, t1]: liquidation, stop, target. */
  const walk = (t0: number, t1: number) => {
    if (!pos) return;
    const bars: Array<{ t: number; h: number; l: number }> = tape?.covers(t1)
      ? tape.between(t0, t1).map((s) => ({ t: s.t + 999, h: s.h, l: s.l }))
      : k1m.slice(lastAtOrBefore(k1m, t0 - 1, (x) => x.openTime) + 1, lastAtOrBefore(k1m, t1 - RANGE_STEP, (x) => x.openTime) + 1)
        .map((k) => ({ t: k.closeTime, h: k.high, l: k.low }));
    for (const b of bars) {
      if (!pos) return;
      const long = pos.side === 'LONG';
      const slHit = long ? b.l <= pos.stopLoss : b.h >= pos.stopLoss;
      const tpHit = long ? b.h >= pos.takeProfit : b.l <= pos.takeProfit;
      const liqHit = long ? b.l <= pos.liquidationPrice : b.h >= pos.liquidationPrice;
      if (liqHit && (!slHit || (long ? pos.liquidationPrice >= pos.stopLoss : pos.liquidationPrice <= pos.stopLoss))) {
        close(b.t, pos.liquidationPrice, '강제 청산', false);
      } else if (slHit) {
        close(b.t, pos.stopLoss, Math.abs(pos.stopLoss - pos.entryPrice) / pos.entryPrice < 0.0015 && (long ? pos.stopLoss >= pos.entryPrice : pos.stopLoss <= pos.entryPrice) ? '본전 손절' : '손절');
      } else if (tpHit) {
        close(b.t, pos.takeProfit, '익절');
      }
    }
  };

  const total = req.to - req.from;
  let lastPct = -1;
  let t = req.from - (req.from % 1000);
  let iter = 0;
  const yieldEvery = ctl.yieldEvery ?? 2000;

  while (t < req.to) {
    const onTape = !!tape?.covers(t) && tape.priceAt(t) !== null;
    if (onTape) tapeEvals++; else candleEvals++;
    const price = priceAt(t);
    if (price) {
      // Day rollover (UTC): new day, new loss budget.
      const dk = new Date(t).toISOString().slice(0, 10);
      if (dk !== dayKey) { dayKey = dk; dayStart = wallet; streak = 0; }

      const ci = lastAtOrBefore(entryBars, t - entryMin * 60_000, (x) => x.openTime) + 1;
      const ti = lastAtOrBefore(trendBars, t - trendMin * 60_000, (x) => x.openTime) + 1;
      const k = entryBars.slice(Math.max(0, ci - 149), ci);
      k.push(formingBar(k1m, entryMin, t, price, onTape ? tape : null));
      const trend = trendBars.slice(Math.max(0, ti - 149), ti);
      trend.push(formingBar(k1m, trendMin, t, price, onTape ? tape : null));
      const di = lastAtOrBefore(depth, t, (x) => x.t);
      const imbalance = di >= 0 && t - depth[di].t < 120_000 ? depth[di].bid / depth[di].ask : null;
      const flow = onTape && tape ? tape.features(t, imbalance) : null;
      const ev = evaluateScalp({ k, trend, depth: null, premium: null, flow }, p);

      if (req.collectSignals && (ev.entry || Math.max(ev.longScore, ev.shortScore) >= p.minScore + 10)) {
        signals.push({
          t, price, longScore: ev.longScore, shortScore: ev.shortScore, atr: ev.atr,
          ...(ev.entry ? { entry: { ...ev.entry, features: featuresAt(ev, ev.entry.side, flow, t) } } : {})
        });
      }

      if (pos) {
        const view: PositionView = {
          symbol: req.symbol, side: pos.side, quantity: pos.quantity, entryPrice: pos.entryPrice, markPrice: price, leverage: pos.leverage,
          unrealizedPnl: grossPnl(pos.side, pos.quantity, pos.entryPrice, price), stopLoss: pos.stopLoss, takeProfit: pos.takeProfit,
          openedAt: pos.entryTime, source: 'scalping'
        };
        const m = manageScalp(view, ev, p, t, r.takerFeePct);
        if (m.action === 'close') close(t, price, m.reason);
        else if (m.action === 'moveStop') {
          const better = pos.side === 'LONG' ? m.stopLoss > pos.stopLoss : m.stopLoss < pos.stopLoss;
          const safe = pos.side === 'LONG' ? m.stopLoss < price : m.stopLoss > price;
          if (better && safe) pos.stopLoss = m.stopLoss;
        }
      } else if (ev.entry) {
        const eq = wallet;
        const dayLossPct = dayStart > 0 ? ((eq - dayStart) / dayStart) * 100 : 0;
        const halted = dayLossPct <= -r.dailyLossLimitPct ? '일일 손실 한도' : streak >= r.maxConsecutiveLosses ? '연속 손실' : null;
        const recent = entryTimes.filter((x) => t - x < 3_600_000);
        if (!halted && t - lastExit >= p.cooldownMinutes * 60_000 && recent.length < p.maxTradesPerHour) {
          const ctx: RiskContext = {
            symbol: req.symbol, price, equity: eq, available: eq, filters: FALLBACK_FILTERS[req.symbol], risk: r,
            minRewardRisk: 0, defaultLeverage: p.leverage, haltedReason: null, brackets: FALLBACK_BRACKETS[req.symbol]
          };
          const v = sizeOrder({ side: ev.entry.side, entryType: 'MARKET', entryPrice: price, stopLoss: ev.entry.stopLoss, takeProfit: ev.entry.takeProfit, leverage: p.leverage, riskPct: r.riskPerTradePct }, ctx);
          if (v.approved && v.plan) {
            const fill = ev.entry.side === 'LONG' ? price * (1 + slip) : price * (1 - slip);
            const entryFee = fill * v.plan.quantity * fee;
            wallet -= entryFee;
            pos = {
              side: ev.entry.side, entryTime: t, entryPrice: fill, quantity: v.plan.quantity, leverage: v.plan.leverage,
              stopLoss: v.plan.stopLoss, takeProfit: v.plan.takeProfit, liquidationPrice: v.plan.liquidationPrice ?? 0,
              margin: v.plan.margin ?? (fill * v.plan.quantity) / v.plan.leverage, riskUsdt: v.plan.riskUsdt, fees: entryFee,
              features: featuresAt(ev, ev.entry.side, flow, t)
            };
            entryTimes.push(t);
          }
        }
      }
    }

    const step = onTape ? Math.max(1, req.evalEverySec) * 1000 : RANGE_STEP;
    const next = Math.min(req.to, onTape ? t + step : t - (t % RANGE_STEP) + RANGE_STEP);
    walk(t, next);
    t = next;

    const pct = Math.floor(((t - req.from) / total) * 50);
    if (pct !== lastPct) {
      lastPct = pct;
      if (ctl.progress?.((t - req.from) / total, trades.length) === true) { notes.push('사용자가 중간에 멈췄습니다'); break; }
    }
    if (++iter % yieldEvery === 0) await new Promise<void>((res) => setImmediate(res));
  }
  if (pos) close(Math.min(t, req.to), priceAt(Math.min(t, req.to)) ?? (pos as OpenPos).entryPrice, '기간 종료');

  const evals = tapeEvals + candleEvals;
  const dataLevel = tapeEvals >= evals * 0.98 ? 'tape' : tapeEvals ? 'mixed' : 'candles';
  return {
    symbol: req.symbol, from: req.from, to: req.to, dataLevel, trades, equity,
    stats: computeStats(trades, req.startEquity, equity), notes,
    evaluations: tapeEvals + candleEvals,
    ...(req.collectSignals ? { signals } : {})
  };
}
