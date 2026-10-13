/**
 * Binance USDⓈ-M leverage brackets and the isolated liquidation price.
 *
 * Binance tiers every symbol by position notional: each bracket has a maximum
 * initial leverage, a maintenance margin rate (MMR) and a maintenance amount
 * (`cum`). The bigger the position, the lower the allowed leverage and the
 * higher the MMR. The live/demo desk reads the real table from
 * GET /fapi/v1/leverageBracket (signed); paper trading and replays use the
 * fallback below, an ESTIMATE in the shape of Binance's table — the UI labels
 * it as such.
 *
 * Isolated, one-way liquidation price (Binance's published formula with the
 * cross-margin terms at zero):
 *
 *   LP = (WB + cum − side·Q·EP) / (Q·MMR − side·Q)
 *
 *   WB = isolated margin, Q = position size, EP = entry price, side = +1 long / −1 short
 *   → long:  (Q·EP − WB − cum) / (Q·(1 − MMR))
 *   → short: (Q·EP + WB + cum) / (Q·(1 + MMR))
 */
import type { Side, TradingSymbol } from '../../shared/trading';

export interface LeverageBracket {
  bracket: number;
  initialLeverage: number;
  notionalFloor: number;
  notionalCap: number;
  maintMarginRatio: number;
  /** Maintenance amount (USDT) — the bracket's offset so tiers join continuously. */
  cum: number;
}

/** Number brackets and derive `cum` so maintenance margin is continuous across tiers. */
export function withCum(rows: Array<Pick<LeverageBracket, 'initialLeverage' | 'notionalFloor' | 'notionalCap' | 'maintMarginRatio'>>): LeverageBracket[] {
  const out: LeverageBracket[] = [];
  let cum = 0;
  rows.forEach((r, i) => {
    if (i > 0) cum += r.notionalFloor * (r.maintMarginRatio - rows[i - 1].maintMarginRatio);
    out.push({ ...r, bracket: i + 1, cum: Math.round(cum * 100) / 100 });
  });
  return out;
}

/** Estimated tiers (paper trading and replays only; demo/live read the real table). */
export const FALLBACK_BRACKETS: Record<TradingSymbol, LeverageBracket[]> = {
  BTCUSDT: withCum([
    { initialLeverage: 125, notionalFloor: 0, notionalCap: 50_000, maintMarginRatio: 0.004 },
    { initialLeverage: 100, notionalFloor: 50_000, notionalCap: 600_000, maintMarginRatio: 0.005 },
    { initialLeverage: 75, notionalFloor: 600_000, notionalCap: 3_000_000, maintMarginRatio: 0.0065 },
    { initialLeverage: 50, notionalFloor: 3_000_000, notionalCap: 12_000_000, maintMarginRatio: 0.01 },
    { initialLeverage: 25, notionalFloor: 12_000_000, notionalCap: 70_000_000, maintMarginRatio: 0.02 },
    { initialLeverage: 20, notionalFloor: 70_000_000, notionalCap: 100_000_000, maintMarginRatio: 0.025 },
    { initialLeverage: 10, notionalFloor: 100_000_000, notionalCap: 230_000_000, maintMarginRatio: 0.05 },
    { initialLeverage: 5, notionalFloor: 230_000_000, notionalCap: 480_000_000, maintMarginRatio: 0.1 },
    { initialLeverage: 2, notionalFloor: 480_000_000, notionalCap: 800_000_000, maintMarginRatio: 0.25 },
    { initialLeverage: 1, notionalFloor: 800_000_000, notionalCap: 1_500_000_000, maintMarginRatio: 0.5 }
  ]),
  ETHUSDT: withCum([
    { initialLeverage: 125, notionalFloor: 0, notionalCap: 50_000, maintMarginRatio: 0.004 },
    { initialLeverage: 100, notionalFloor: 50_000, notionalCap: 600_000, maintMarginRatio: 0.005 },
    { initialLeverage: 75, notionalFloor: 600_000, notionalCap: 3_000_000, maintMarginRatio: 0.0065 },
    { initialLeverage: 50, notionalFloor: 3_000_000, notionalCap: 12_000_000, maintMarginRatio: 0.01 },
    { initialLeverage: 25, notionalFloor: 12_000_000, notionalCap: 50_000_000, maintMarginRatio: 0.02 },
    { initialLeverage: 20, notionalFloor: 50_000_000, notionalCap: 65_000_000, maintMarginRatio: 0.025 },
    { initialLeverage: 10, notionalFloor: 65_000_000, notionalCap: 150_000_000, maintMarginRatio: 0.05 },
    { initialLeverage: 5, notionalFloor: 150_000_000, notionalCap: 320_000_000, maintMarginRatio: 0.1 },
    { initialLeverage: 2, notionalFloor: 320_000_000, notionalCap: 400_000_000, maintMarginRatio: 0.25 },
    { initialLeverage: 1, notionalFloor: 400_000_000, notionalCap: 800_000_000, maintMarginRatio: 0.5 }
  ])
};

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * GET /fapi/v1/leverageBracket answers an array of `{ symbol, brackets }`, or a
 * single object when one symbol was asked for. Both are accepted.
 */
export function parseLeverageBrackets(raw: unknown): Partial<Record<string, LeverageBracket[]>> {
  const rows = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  const out: Partial<Record<string, LeverageBracket[]>> = {};
  for (const r of rows as Array<Record<string, unknown>>) {
    const sym = typeof r?.symbol === 'string' ? r.symbol : null;
    const list = Array.isArray(r?.brackets) ? (r.brackets as Array<Record<string, unknown>>) : [];
    if (!sym || !list.length) continue;
    const brackets = list.map((b) => ({
      bracket: num(b.bracket),
      initialLeverage: num(b.initialLeverage),
      notionalFloor: num(b.notionalFloor),
      notionalCap: num(b.notionalCap),
      maintMarginRatio: num(b.maintMarginRatio),
      cum: num(b.cum)
    })).filter((b) => b.initialLeverage > 0 && b.notionalCap > 0).sort((a, b) => a.notionalFloor - b.notionalFloor);
    if (brackets.length) out[sym] = brackets;
  }
  return out;
}

/** The tier a position of this notional falls in (the last tier for anything bigger). */
export function bracketFor(brackets: readonly LeverageBracket[], notional: number): LeverageBracket {
  for (const b of brackets) if (notional < b.notionalCap) return b;
  return brackets[brackets.length - 1];
}

/** The largest notional Binance accepts at this leverage (0 if no tier allows it). */
export function maxNotionalAt(brackets: readonly LeverageBracket[], leverage: number): number {
  let cap = 0;
  for (const b of brackets) if (b.initialLeverage >= leverage) cap = Math.max(cap, b.notionalCap);
  return cap;
}

/** Isolated liquidation price. `margin` defaults to the initial margin EP·Q / leverage. */
export function liquidationPrice(opts: {
  side: Side;
  entryPrice: number;
  quantity: number;
  leverage: number;
  brackets: readonly LeverageBracket[];
  margin?: number;
}): { price: number; mmr: number; cum: number; margin: number } {
  const { side, entryPrice: ep, quantity: q } = opts;
  const notional = ep * q;
  const b = bracketFor(opts.brackets, notional);
  const margin = opts.margin ?? notional / Math.max(1, opts.leverage);
  const mmr = b.maintMarginRatio;
  const price = side === 'LONG'
    ? (q * ep - margin - b.cum) / (q * (1 - mmr))
    : (q * ep + margin + b.cum) / (q * (1 + mmr));
  return { price: Math.max(0, price), mmr, cum: b.cum, margin };
}

/**
 * The highest leverage at which the liquidation price stays at least
 * `buffer` stop-distances away from entry (so the stop always fires first).
 * Derived from the formula above with cum = 0; the short side is the tighter one.
 */
export function maxSafeLeverage(stopFrac: number, mmr: number, buffer = 1.25): number {
  if (!(stopFrac > 0)) return 1;
  return Math.max(1, Math.floor(1 / (mmr + buffer * stopFrac * (1 + mmr))));
}
