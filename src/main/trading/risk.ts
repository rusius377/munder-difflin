/**
 * Risk engine — the code that stands between a model's opinion and an order.
 *
 * Nothing here trusts the model: a decision is re-checked against the live
 * price, the configured limits and the exchange's lot rules, then either turned
 * into a fully specified OrderPlan or rejected with a Korean reason. Position
 * size always comes from the STOP distance and the risk budget, never from a
 * number the model typed.
 */
import { roundToStep, type SymbolFilters } from './binance';
import type { FinalDecision, OrderPlan, RiskSettings, RiskVerdict, Side, TradingSymbol } from '../../shared/trading';
import { fmtPrice } from './indicators';

export interface RiskContext {
  symbol: TradingSymbol;
  /** Current reference price (last or mark). */
  price: number;
  equity: number;
  available: number;
  filters: SymbolFilters | null;
  risk: RiskSettings;
  minRewardRisk: number;
  defaultLeverage: number;
  /** Set when the day is halted (daily loss / losing streak): new entries refused. */
  haltedReason?: string | null;
}

export interface SizeRequest {
  side: Side;
  entryType: 'MARKET' | 'LIMIT';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  leverage: number;
  riskPct: number;
}

/** Stop narrower than this fraction of price is noise, not a stop. */
const MIN_STOP_FRAC = 0.0008;
/** Stop wider than this is not a futures trade the desk should size. */
const MAX_STOP_FRAC = 0.15;
/** Keep the (isolated) liquidation price this much further away than the stop, in units of the stop distance. */
const LIQ_BUFFER = 1.25;

export function sizeOrder(req: SizeRequest, ctx: RiskContext, adjustments: string[] = []): RiskVerdict {
  const { side } = req;
  const r = ctx.risk;
  if (ctx.haltedReason) return { approved: false, reason: `신규 진입 중단 상태: ${ctx.haltedReason}`, adjustments };
  if (!(ctx.equity > 0)) return { approved: false, reason: '계좌 자본을 확인할 수 없습니다', adjustments };

  const entry = req.entryPrice;
  const sl = req.stopLoss;
  let tp = req.takeProfit;
  if (!(entry > 0) || !(sl > 0)) return { approved: false, reason: '진입가 또는 손절가가 없습니다', adjustments };

  if (side === 'LONG' && sl >= entry) return { approved: false, reason: `롱인데 손절가(${fmtPrice(sl)})가 진입가(${fmtPrice(entry)}) 이상입니다`, adjustments };
  if (side === 'SHORT' && sl <= entry) return { approved: false, reason: `숏인데 손절가(${fmtPrice(sl)})가 진입가(${fmtPrice(entry)}) 이하입니다`, adjustments };

  const stopDist = Math.abs(entry - sl);
  const stopFrac = stopDist / entry;
  if (stopFrac < MIN_STOP_FRAC) return { approved: false, reason: `손절폭이 너무 좁습니다 (${(stopFrac * 100).toFixed(3)}%)`, adjustments };
  if (stopFrac > MAX_STOP_FRAC) return { approved: false, reason: `손절폭이 너무 넓습니다 (${(stopFrac * 100).toFixed(1)}%)`, adjustments };

  if (!(tp > 0) || (side === 'LONG' ? tp <= entry : tp >= entry)) {
    const rr = Math.max(ctx.minRewardRisk, 1);
    tp = side === 'LONG' ? entry + stopDist * rr : entry - stopDist * rr;
    adjustments.push(`목표가가 없거나 방향이 맞지 않아 손익비 ${rr}:1 기준으로 ${fmtPrice(tp)}에 설정`);
  }
  const rewardRisk = Math.abs(tp - entry) / stopDist;
  if (rewardRisk + 1e-9 < ctx.minRewardRisk) {
    return { approved: false, reason: `손익비 ${rewardRisk.toFixed(2)}:1 이 최소 기준 ${ctx.minRewardRisk}:1 보다 낮습니다`, adjustments };
  }

  // Leverage: clamp to the ceiling, then lower it until an isolated liquidation
  // sits safely beyond the stop (a stop past liquidation is no stop at all).
  let leverage = Math.round(req.leverage > 0 ? req.leverage : ctx.defaultLeverage);
  if (leverage > r.maxLeverage) {
    adjustments.push(`레버리지 ${leverage}배 → 상한 ${r.maxLeverage}배로 조정`);
    leverage = r.maxLeverage;
  }
  leverage = Math.max(1, leverage);
  const liqSafeMax = Math.max(1, Math.floor(1 / (stopFrac * LIQ_BUFFER) * 0.9));
  if (leverage > liqSafeMax) {
    adjustments.push(`손절이 청산가보다 먼저 닿도록 레버리지 ${leverage}배 → ${liqSafeMax}배로 하향`);
    leverage = liqSafeMax;
  }

  let riskPct = req.riskPct > 0 ? req.riskPct : r.riskPerTradePct;
  if (riskPct > r.riskPerTradePct) {
    adjustments.push(`리스크 ${riskPct}% → 상한 ${r.riskPerTradePct}%로 조정`);
    riskPct = r.riskPerTradePct;
  }

  const fee = r.takerFeePct / 100;
  const slip = r.slippageBps / 10_000;
  // Loss per unit if the stop fills: distance + round-trip taker fees + slippage on both legs.
  const perUnitLoss = stopDist + entry * fee + sl * fee + (entry + sl) * slip;
  const budget = ctx.equity * (riskPct / 100);
  let qty = budget / perUnitLoss;

  const notionalCap = ctx.equity * (r.maxNotionalPct / 100);
  if (qty * entry > notionalCap) {
    qty = notionalCap / entry;
    adjustments.push(`포지션 규모를 자본의 ${r.maxNotionalPct}% 명목가 상한으로 축소`);
  }
  const marginCap = Math.max(0, ctx.available) * leverage * 0.95;
  if (qty * entry > marginCap) {
    qty = marginCap / entry;
    adjustments.push('가용 증거금에 맞춰 규모 축소');
  }

  const f = ctx.filters;
  const step = f ? (req.entryType === 'MARKET' ? f.marketStepSize : f.stepSize) : 0.001;
  qty = roundToStep(qty, step, 'floor');
  const minQty = f ? (req.entryType === 'MARKET' ? f.marketMinQty : f.minQty) : 0;
  if (f && req.entryType === 'MARKET' && qty > f.marketMaxQty) qty = roundToStep(f.marketMaxQty, step, 'floor');
  if (!(qty > 0) || qty < minQty) {
    return { approved: false, reason: `계산된 수량(${qty})이 최소 주문 단위보다 작습니다 — 자본·리스크 비율을 확인하세요`, adjustments };
  }
  const notional = qty * entry;
  if (f && notional < f.minNotional) {
    return { approved: false, reason: `주문 명목가 ${notional.toFixed(2)} USDT가 최소 ${f.minNotional} USDT보다 작습니다`, adjustments };
  }

  const tick = f?.tickSize ?? 0.1;
  const plan: OrderPlan = {
    symbol: ctx.symbol,
    side,
    entryType: req.entryType,
    entryPrice: roundToStep(entry, tick),
    stopLoss: roundToStep(sl, tick),
    takeProfit: roundToStep(tp, tick),
    leverage,
    quantity: qty,
    notional,
    riskUsdt: qty * perUnitLoss,
    rewardRisk
  };
  return {
    approved: true,
    reason: `${side === 'LONG' ? '롱' : '숏'} ${qty} @ ${fmtPrice(plan.entryPrice)} · 손절 ${fmtPrice(plan.stopLoss)} · 익절 ${fmtPrice(plan.takeProfit)} · ${leverage}배 · 최대손실 ${plan.riskUsdt.toFixed(2)} USDT · 손익비 ${rewardRisk.toFixed(2)}`,
    plan,
    adjustments
  };
}

/**
 * Turn the portfolio manager's decision into an entry plan. Only called for
 * LONG/SHORT actions that would OPEN a position (HOLD/CLOSE and same-side
 * holds are handled by the engine before this).
 */
export function planFromDecision(d: FinalDecision, ctx: RiskContext, minConfidence: number): RiskVerdict {
  const adjustments: string[] = [];
  if (d.action !== 'LONG' && d.action !== 'SHORT') return { approved: false, reason: '진입 결정이 아닙니다', adjustments };
  if (d.confidence < minConfidence) {
    return { approved: false, reason: `확신도 ${d.confidence.toFixed(2)} 가 최소 기준 ${minConfidence} 보다 낮아 진입하지 않습니다`, adjustments };
  }
  if (!d.stopLoss) return { approved: false, reason: '손절가가 없는 진입은 거부합니다', adjustments };
  const side: Side = d.action;
  const px = ctx.price;
  let entryType: 'MARKET' | 'LIMIT' = d.entryType;
  let entry = px;
  if (entryType === 'LIMIT' && d.entryPrice) {
    const better = side === 'LONG' ? d.entryPrice < px : d.entryPrice > px;
    const near = Math.abs(d.entryPrice - px) / px < 0.001;
    if (!better || near) {
      entryType = 'MARKET';
      adjustments.push('지정가가 현재가와 같거나 불리한 쪽이라 시장가로 진입');
    } else {
      entry = d.entryPrice;
    }
  } else {
    entryType = 'MARKET';
  }
  // For a market entry the stop must still be on the right side of the CURRENT price.
  if (entryType === 'MARKET') {
    if (side === 'LONG' && d.stopLoss >= px) return { approved: false, reason: `현재가 ${fmtPrice(px)}가 이미 손절가 ${fmtPrice(d.stopLoss)} 이하입니다`, adjustments };
    if (side === 'SHORT' && d.stopLoss <= px) return { approved: false, reason: `현재가 ${fmtPrice(px)}가 이미 손절가 ${fmtPrice(d.stopLoss)} 이상입니다`, adjustments };
  }
  return sizeOrder({
    side,
    entryType,
    entryPrice: entry,
    stopLoss: d.stopLoss,
    takeProfit: d.takeProfit ?? 0,
    leverage: d.leverage ?? ctx.defaultLeverage,
    riskPct: d.riskPct ?? ctx.risk.riskPerTradePct
  }, ctx, adjustments);
}

/** Realised PnL of a closed position (fees not included). */
export function grossPnl(side: Side, qty: number, entry: number, exit: number): number {
  return side === 'LONG' ? (exit - entry) * qty : (entry - exit) * qty;
}
