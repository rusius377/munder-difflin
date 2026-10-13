/**
 * Scalping mode ("스캘핑 모드") — the fast loop.
 *
 * An LLM takes seconds to answer, a 1-minute candle does not wait, so the
 * per-tick decision here is deterministic: a 0–100 score for each side built
 * from trend alignment, momentum, a pullback/breakout trigger, RSI, order flow
 * and volume. The agents still steer it — the bias desk (see engine.ts) runs a
 * compressed TradingAgents pass every N minutes and can restrict the scalper
 * to longs, shorts, both, or nothing.
 *
 * Pure functions: everything is computed from the inputs, so the whole
 * strategy is unit-testable on synthetic candles.
 */
import {
  atr, avgVolume, bollinger, ema, lastValue, percentileRank, rsi, sessionVwap, takerBuyShare, valueAt, type Kline
} from './indicators';
import { depthImbalance, spreadBps, type ScalpInputs } from './marketData';
import { sizeOrder, type RiskContext } from './risk';
import { FALLBACK_BRACKETS, liquidationPrice } from './leverage';
import type { BiasDirection, PositionView, ScalpPlanView, ScalpingSettings, Side } from '../../shared/trading';

export interface ScalpEval {
  price: number;
  longScore: number;
  shortScore: number;
  trend: 'up' | 'down' | 'flat';
  atr: number;
  atrPct: number;
  spreadBps: number;
  reasons: string[];
  entry?: { side: Side; stopLoss: number; takeProfit: number; score: number };
  blocked?: string;
}

interface SideScore { score: number; reasons: string[] }

function trendOf(trendK: Kline[], period: number): 'up' | 'down' | 'flat' {
  const closes = trendK.map((c) => c.close);
  const e = ema(closes, period);
  const now = lastValue(e);
  const before = valueAt(e, 3);
  const px = closes[closes.length - 1];
  if (now === null || before === null || px === undefined) return 'flat';
  const slope = (now - before) / now;
  if (px > now && slope > 0.0002) return 'up';
  if (px < now && slope < -0.0002) return 'down';
  return 'flat';
}

const fmtQty = (v: number) => `${v >= 0 ? '+' : ''}${Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)}`;

/**
 * Order flow (15): from the live tape and book when the desk has them, else
 * from the candles' taker volume and a REST book snapshot.
 *   tape   — 1-minute aggression share and CVD (6), 5-minute CVD (3)
 *   size   — net big trades on our side (3)
 *   book   — visible bid/ask imbalance (3)
 *   bonus  — the other side's aggression being absorbed (+3)
 *   brake  — a wall between price and the target (−6)
 */
function flowScore(dir: 1 | -1, closed: Kline[], inputs: ScalpInputs, price: number, targetDist: number): SideScore {
  const reasons: string[] = [];
  let score = 0;
  const f = inputs.flow;
  if (f && f.vol1m > 0) {
    if (f.buyShare1m !== null && (dir === 1 ? f.buyShare1m >= 0.55 && f.cvd1m > 0 : f.buyShare1m <= 0.45 && f.cvd1m < 0)) {
      score += 6;
      reasons.push(`1분 체결 ${dir === 1 ? '매수' : '매도'} 우위 ${((dir === 1 ? f.buyShare1m : 1 - f.buyShare1m) * 100).toFixed(0)}% (CVD ${fmtQty(f.cvd1m)})`);
    }
    if (dir * f.cvd5m > 0) { score += 3; reasons.push(`5분 CVD ${fmtQty(f.cvd5m)}`); }
    const netBig = dir === 1 ? f.bigBuys - f.bigSells : f.bigSells - f.bigBuys;
    if (netBig >= 2) { score += 3; reasons.push(`대량 ${dir === 1 ? '매수' : '매도'} 체결 우위 ${netBig}건`); }
    if (f.absorption === (dir === 1 ? 'buy' : 'sell')) { score += 3; reasons.push(`${dir === 1 ? '매도' : '매수'} 공세 흡수`); }
  } else {
    const share = takerBuyShare(closed, 3);
    if (share !== null && (dir === 1 ? share > 0.55 : share < 0.45)) { score += 8; reasons.push(`테이커 ${dir === 1 ? '매수' : '매도'} 우위 ${(share * 100).toFixed(0)}%`); }
  }
  const imb = f?.bookImbalance ?? depthImbalance(inputs.depth, 20);
  if (imb !== null && imb !== undefined && (dir === 1 ? imb > 1.15 : imb < 0.87)) {
    score += f ? 3 : 7;
    reasons.push(`호가 ${dir === 1 ? '매수' : '매도'}잔량 우위 ${imb.toFixed(2)}`);
  }
  if (f && targetDist > 0) {
    const wall = f.walls.find((w) => w.side === (dir === 1 ? 'ask' : 'bid') && (dir === 1 ? w.price > price && w.price < price + targetDist : w.price < price && w.price > price - targetDist));
    if (wall) { score -= 6; reasons.push(`목표가 앞 ${dir === 1 ? '매도' : '매수'}벽 ${wall.price} (${wall.qty.toFixed(1)})`); }
  }
  return { score, reasons };
}

/** Score one side. `dir` = +1 for long, −1 for short; everything mirrors. */
function scoreSide(dir: 1 | -1, closed: Kline[], trend: 'up' | 'down' | 'flat', p: ScalpingSettings, inputs: ScalpInputs, price: number, atrV = 0): SideScore {
  const reasons: string[] = [];
  let score = 0;
  const closes = closed.map((c) => c.close);
  const eFast = ema(closes, p.emaFast);
  const eSlow = ema(closes, p.emaSlow);
  const fast = lastValue(eFast);
  const slow = lastValue(eSlow);
  const fastPrev = valueAt(eFast, 2);
  const vwap = lastValue(sessionVwap(closed));
  const want = dir === 1 ? 'up' : 'down';
  const above = (a: number, b: number) => (dir === 1 ? a > b : a < b);

  // 1. Trend alignment (25)
  if (trend === want) { score += 25; reasons.push(`상위 추세 ${dir === 1 ? '상승' : '하락'} 정렬`); }
  else if (trend === 'flat') { score += 10; reasons.push('상위 추세 횡보'); }

  // 2. Momentum (20)
  if (fast !== null && slow !== null && above(fast, slow)) {
    score += 12;
    reasons.push(`EMA${p.emaFast} ${dir === 1 ? '>' : '<'} EMA${p.emaSlow}`);
    if (fastPrev !== null && above(fast, fastPrev)) { score += 8; reasons.push('단기 EMA 기울기 동조'); }
  }

  // 3. Trigger (20): pullback to EMA-slow/VWAP and reclaim, or squeeze breakout.
  let trigger = false;
  if (fast !== null && slow !== null) {
    const recent = closed.slice(-5);
    const level = vwap !== null ? (dir === 1 ? Math.max(slow, vwap) : Math.min(slow, vwap)) : slow;
    const touched = recent.some((c) => (dir === 1 ? c.low <= level * 1.0005 : c.high >= level * 0.9995));
    if (touched && above(price, fast)) { score += 20; trigger = true; reasons.push('되돌림 후 EMA 회복(눌림목 진입)'); }
  }
  if (!trigger) {
    const bb = bollinger(closes, 20, 2);
    const widthPct = percentileRank(bb.width.slice(0, -3), 100);
    const band = dir === 1 ? lastValue(bb.upper) : lastValue(bb.lower);
    const avgV = avgVolume(closed, 20, 1);
    const lastV = closed[closed.length - 1]?.volume ?? 0;
    if (widthPct !== null && widthPct < 25 && band !== null && above(price, band) && avgV > 0 && lastV > avgV * 1.3) {
      score += 20; trigger = true; reasons.push('변동성 수축 후 밴드 돌파');
    } else if (fast !== null && above(price, fast)) {
      score += 8; reasons.push(`가격이 EMA${p.emaFast} ${dir === 1 ? '위' : '아래'}`);
    }
  }

  // 4. RSI (10, with an over-extension penalty)
  const r = lastValue(rsi(closes, p.rsiPeriod));
  const rPrev = valueAt(rsi(closes, p.rsiPeriod), 1);
  if (r !== null) {
    const x = dir === 1 ? r : 100 - r;
    if (x >= 45 && x <= 72 && rPrev !== null && (dir === 1 ? r > rPrev : r < rPrev)) { score += 10; reasons.push(`RSI${p.rsiPeriod} ${r.toFixed(0)} 모멘텀 동조`); }
    else if (x > 82) { score -= 10; reasons.push(`RSI${p.rsiPeriod} ${r.toFixed(0)} 과열`); }
  }

  // 5. Order flow (15)
  const flow = flowScore(dir, closed, inputs, price, p.tpAtr * atrV);
  score += flow.score;
  reasons.push(...flow.reasons);

  // 6. Volume confirmation (10)
  const lastBar = closed[closed.length - 1];
  const avgV = avgVolume(closed, 20, 1);
  if (lastBar && avgV > 0 && lastBar.volume > avgV * 1.3 && (dir === 1 ? lastBar.close > lastBar.open : lastBar.close < lastBar.open)) {
    score += 10; reasons.push(`거래량 ${(lastBar.volume / avgV).toFixed(1)}배 동반 ${dir === 1 ? '양봉' : '음봉'}`);
  }

  return { score: Math.max(0, Math.min(100, score)), reasons };
}

export function biasAllows(bias: BiasDirection | undefined, side: Side): boolean {
  if (!bias || bias === 'BOTH') return true;
  if (bias === 'NO_TRADE') return false;
  return bias === (side === 'LONG' ? 'LONG_ONLY' : 'SHORT_ONLY');
}

const BIAS_KO: Record<BiasDirection, string> = { LONG_ONLY: '롱만', SHORT_ONLY: '숏만', BOTH: '양방향', NO_TRADE: '진입 금지' };
export const biasKo = (b: BiasDirection) => BIAS_KO[b];

export function evaluateScalp(inputs: ScalpInputs, p: ScalpingSettings, bias?: BiasDirection): ScalpEval {
  const k = inputs.k;
  const closed = k.slice(0, -1);
  const price = k[k.length - 1]?.close ?? 0;
  const atrV = lastValue(atr(closed, p.atrPeriod)) ?? 0;
  const atrPct = price ? (atrV / price) * 100 : 0;
  const spr = spreadBps(inputs.depth) ?? inputs.flow?.spreadBps ?? 0;
  const trend = trendOf(inputs.trend, p.trendEma);
  const base: ScalpEval = { price, longScore: 0, shortScore: 0, trend, atr: atrV, atrPct, spreadBps: spr, reasons: [] };
  if (closed.length < Math.max(p.emaSlow, p.atrPeriod, 30) + 5 || !price || !atrV) {
    return { ...base, blocked: '캔들 데이터 부족' };
  }

  const L = scoreSide(1, closed, trend, p, inputs, price, atrV);
  const S = scoreSide(-1, closed, trend, p, inputs, price, atrV);
  const ev: ScalpEval = { ...base, longScore: L.score, shortScore: S.score };
  const top = L.score >= S.score ? { side: 'LONG' as Side, s: L, other: S.score } : { side: 'SHORT' as Side, s: S, other: L.score };
  ev.reasons = top.s.reasons;

  if (atrPct < p.minAtrPct) return { ...ev, blocked: `변동성 너무 낮음 (ATR ${atrPct.toFixed(3)}%)` };
  if (atrPct > p.maxAtrPct) return { ...ev, blocked: `변동성 과도 (ATR ${atrPct.toFixed(2)}%)` };
  if (spr > p.maxSpreadBps) return { ...ev, blocked: `스프레드 과다 (${spr.toFixed(2)}bp)` };
  if (top.s.score < p.minScore) return { ...ev, blocked: `점수 미달 (${top.s.score} < ${p.minScore})` };
  if (top.s.score - top.other < 10) return { ...ev, blocked: '양방향 점수 차이 부족' };
  if (!biasAllows(bias, top.side)) return { ...ev, blocked: `에이전트 방향 필터: ${biasKo(bias as BiasDirection)}` };

  const dir = top.side === 'LONG' ? 1 : -1;
  return {
    ...ev,
    entry: {
      side: top.side,
      stopLoss: price - dir * p.slAtr * atrV,
      takeProfit: price + dir * p.tpAtr * atrV,
      score: top.s.score
    }
  };
}

export type ScalpManage =
  | { action: 'hold' }
  | { action: 'close'; reason: string }
  | { action: 'moveStop'; stopLoss: number; reason: string };

/** What to do with an open scalp: time stop, break-even, or exit on a strong opposite signal. */
export function manageScalp(pos: PositionView, ev: ScalpEval, p: ScalpingSettings, now: number, takerFeePct: number): ScalpManage {
  if (now - pos.openedAt >= p.maxHoldMinutes * 60_000) return { action: 'close', reason: '시간 청산' };
  const opposite = pos.side === 'LONG' ? ev.shortScore : ev.longScore;
  if (opposite >= Math.min(100, p.minScore + 10)) return { action: 'close', reason: '강한 반대 신호' };
  const px = ev.price || pos.markPrice;
  if (p.breakevenAtR > 0 && pos.stopLoss !== null) {
    const dir = pos.side === 'LONG' ? 1 : -1;
    const riskDist = dir * (pos.entryPrice - pos.stopLoss);
    if (riskDist > 0) {
      const progressR = (dir * (px - pos.entryPrice)) / riskDist;
      if (progressR >= p.breakevenAtR) {
        // Break-even plus round-trip fees, so a stop-out here is truly flat.
        const be = pos.entryPrice * (1 + dir * 2 * (takerFeePct / 100));
        return { action: 'moveStop', stopLoss: be, reason: `+${progressR.toFixed(1)}R 도달, 손절을 본전으로 이동` };
      }
    }
  }
  return { action: 'hold' };
}

/**
 * The scalper's trade card at its leverage: the trade it would place right
 * now for the leading side (or is placing, when `ev.entry` is set), sized by
 * the real risk engine — same stop, same tier and liquidation guards, same
 * fees — so the card shows exactly what an entry would look like.
 */
export function scalpPlan(ev: ScalpEval, ctx: RiskContext, p: ScalpingSettings, bracketsEstimated: boolean): ScalpPlanView | undefined {
  if (!(ev.price > 0) || !(ev.atr > 0)) return undefined;
  const side: Side = ev.entry ? ev.entry.side : ev.longScore >= ev.shortScore ? 'LONG' : 'SHORT';
  const dir = side === 'LONG' ? 1 : -1;
  const entry = ev.price;
  const stopLoss = ev.entry?.stopLoss ?? entry - dir * p.slAtr * ev.atr;
  const takeProfit = ev.entry?.takeProfit ?? entry + dir * p.tpAtr * ev.atr;
  const v = sizeOrder(
    { side, entryType: 'MARKET', entryPrice: entry, stopLoss, takeProfit, leverage: p.leverage, riskPct: ctx.risk.riskPerTradePct },
    { ...ctx, minRewardRisk: 0 }
  );
  const fee = ctx.risk.takerFeePct / 100;
  const slip = ctx.risk.slippageBps / 10_000;
  const stopDist = Math.abs(entry - stopLoss);
  const targetDist = Math.abs(takeProfit - entry);
  const perUnitRisk = stopDist + (entry + stopLoss) * (fee + slip);
  const perUnitReward = targetDist - (entry + takeProfit) * (fee + slip);
  const brackets = ctx.brackets && ctx.brackets.length ? ctx.brackets : FALLBACK_BRACKETS[ctx.symbol];
  // A refused plan still shows its levels: size it as the risk budget would (no exchange filters).
  const quantity = v.plan?.quantity ?? Math.min(
    (ctx.equity * ctx.risk.riskPerTradePct) / 100 / perUnitRisk,
    (ctx.equity * ctx.risk.maxNotionalPct) / 100 / entry
  );
  const leverage = v.plan?.leverage ?? Math.min(p.leverage, ctx.risk.maxLeverage);
  const liq = liquidationPrice({ side, entryPrice: entry, quantity: Math.max(quantity, 1e-9), leverage, brackets });
  const notional = quantity * entry;
  const margin = notional / leverage;
  const riskUsdt = quantity * perUnitRisk;
  const rewardUsdt = quantity * perUnitReward;
  const notes: string[] = [];
  if (!ev.entry && ev.blocked) notes.push(ev.blocked);
  if (!v.approved) notes.push(v.reason);
  notes.push(...v.adjustments);
  return {
    side,
    ready: !!ev.entry && v.approved,
    score: ev.entry?.score ?? Math.max(ev.longScore, ev.shortScore),
    entryPrice: entry,
    stopLoss: v.plan?.stopLoss ?? stopLoss,
    takeProfit: v.plan?.takeProfit ?? takeProfit,
    stopPct: (stopDist / entry) * 100,
    targetPct: (targetDist / entry) * 100,
    rewardRisk: stopDist > 0 ? targetDist / stopDist : 0,
    rewardRiskNet: perUnitRisk > 0 ? perUnitReward / perUnitRisk : 0,
    requestedLeverage: p.leverage,
    leverage,
    liquidationPrice: v.plan?.liquidationPrice ?? liq.price,
    liquidationPct: (Math.abs(entry - liq.price) / entry) * 100,
    maintMarginRate: liq.mmr,
    quantity,
    notional,
    margin,
    riskUsdt,
    rewardUsdt,
    roeAtStop: margin > 0 ? (-riskUsdt / margin) * 100 : 0,
    roeAtTarget: margin > 0 ? (rewardUsdt / margin) * 100 : 0,
    feesUsdt: quantity * (entry + takeProfit) * fee,
    breakEvenPct: 2 * (fee + slip) * 100,
    bracketsEstimated,
    notes
  };
}
