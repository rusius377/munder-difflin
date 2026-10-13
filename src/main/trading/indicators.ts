/**
 * Technical indicators — pure functions over plain arrays.
 *
 * Every series function returns an array the same length as its input, with
 * `null` where the indicator is not yet defined (warm-up). Callers read the
 * last element with `last()`. No dependency on any charting/TA package so the
 * main bundle stays small and every number is unit-testable.
 */

export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteVolume: number;
  trades: number;
  takerBuyBase: number;
  takerBuyQuote: number;
}

export type Series = (number | null)[];

export function last<T>(arr: readonly T[]): T | undefined {
  return arr.length ? arr[arr.length - 1] : undefined;
}

/** The last non-null value of a series. */
export function lastValue(s: Series): number | null {
  for (let i = s.length - 1; i >= 0; i--) {
    const v = s[i];
    if (v !== null && Number.isFinite(v)) return v;
  }
  return null;
}

/** Value `back` bars before the last (0 = last). */
export function valueAt(s: Series, back: number): number | null {
  const idx = s.length - 1 - back;
  if (idx < 0) return null;
  const v = s[idx];
  return v !== null && Number.isFinite(v) ? v : null;
}

export function sma(values: readonly number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** EMA seeded with the SMA of the first `period` values. */
export function ema(values: readonly number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI. */
export function rsi(closes: readonly number[], period = 14): Series {
  const out: Series = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(ch, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-ch, 0)) / period;
    out[i] = avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export interface MacdSeries { macd: Series; signal: Series; hist: Series }

export function macd(closes: readonly number[], fast = 12, slow = 26, signalPeriod = 9): MacdSeries {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const line: Series = closes.map((_, i) => (ef[i] !== null && es[i] !== null ? (ef[i] as number) - (es[i] as number) : null));
  // Signal = EMA of the defined part of the MACD line.
  const firstIdx = line.findIndex((v) => v !== null);
  const signal: Series = new Array(closes.length).fill(null);
  if (firstIdx >= 0) {
    const defined = line.slice(firstIdx) as number[];
    const sig = ema(defined, signalPeriod);
    for (let i = 0; i < sig.length; i++) signal[firstIdx + i] = sig[i];
  }
  const hist: Series = line.map((v, i) => (v !== null && signal[i] !== null ? v - (signal[i] as number) : null));
  return { macd: line, signal, hist };
}

export interface BollingerSeries { mid: Series; upper: Series; lower: Series; width: Series }

/** Bollinger bands; `width` = (upper − lower) / mid, the squeeze measure. */
export function bollinger(closes: readonly number[], period = 20, mult = 2): BollingerSeries {
  const mid = sma(closes, period);
  const upper: Series = new Array(closes.length).fill(null);
  const lower: Series = new Array(closes.length).fill(null);
  const width: Series = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const m = mid[i] as number;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (closes[j] - m) ** 2;
    const sd = Math.sqrt(v / period);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
    width[i] = m !== 0 ? (2 * mult * sd) / m : null;
  }
  return { mid, upper, lower, width };
}

export function trueRange(k: readonly Kline[]): number[] {
  return k.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const pc = k[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
}

/** Wilder's ATR. */
export function atr(k: readonly Kline[], period = 14): Series {
  const tr = trueRange(k);
  const out: Series = new Array(k.length).fill(null);
  if (k.length < period) return out;
  let prev = 0;
  for (let i = 0; i < period; i++) prev += tr[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < k.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** Volume-weighted moving average. */
export function vwma(k: readonly Kline[], period = 20): Series {
  const out: Series = new Array(k.length).fill(null);
  for (let i = period - 1; i < k.length; i++) {
    let pv = 0;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) { pv += k[j].close * k[j].volume; v += k[j].volume; }
    out[i] = v > 0 ? pv / v : null;
  }
  return out;
}

/**
 * Session VWAP, reset at each UTC day boundary — the level intraday desks
 * actually watch on crypto perps.
 */
export function sessionVwap(k: readonly Kline[]): Series {
  const out: Series = new Array(k.length).fill(null);
  let day = -1;
  let pv = 0;
  let v = 0;
  for (let i = 0; i < k.length; i++) {
    const d = Math.floor(k[i].openTime / 86_400_000);
    if (d !== day) { day = d; pv = 0; v = 0; }
    const typical = (k[i].high + k[i].low + k[i].close) / 3;
    pv += typical * k[i].volume;
    v += k[i].volume;
    out[i] = v > 0 ? pv / v : null;
  }
  return out;
}

/** Percentile rank (0–100) of the last value within the last `lookback` defined values. */
export function percentileRank(s: Series, lookback: number): number | null {
  const vals = s.filter((v): v is number => v !== null && Number.isFinite(v)).slice(-lookback);
  if (vals.length < 5) return null;
  const x = vals[vals.length - 1];
  const below = vals.filter((v) => v < x).length;
  return (below / (vals.length - 1)) * 100;
}

export interface SwingLevels { supports: number[]; resistances: number[] }

/**
 * Recent pivot highs/lows (a bar whose high/low is the extreme of `wing` bars
 * either side). Returns up to `max` of each, nearest-first relative to the last close.
 */
export function swingLevels(k: readonly Kline[], wing = 3, max = 3): SwingLevels {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = wing; i < k.length - wing; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - wing; j <= i + wing; j++) {
      if (j === i) continue;
      if (k[j].high >= k[i].high) isHigh = false;
      if (k[j].low <= k[i].low) isLow = false;
    }
    if (isHigh) highs.push(k[i].high);
    if (isLow) lows.push(k[i].low);
  }
  const px = last(k)?.close ?? 0;
  const resistances = highs.filter((h) => h > px).sort((a, b) => a - b).slice(0, max);
  const supports = lows.filter((l) => l < px).sort((a, b) => b - a).slice(0, max);
  return { supports, resistances };
}

/** Simple % change between two values. */
export function pct(from: number, to: number): number {
  return from !== 0 ? ((to - from) / from) * 100 : 0;
}

/** Share of taker-buy volume over the last `n` bars (0–1). 0.5 = balanced flow. */
export function takerBuyShare(k: readonly Kline[], n: number): number | null {
  const s = k.slice(-n);
  const vol = s.reduce((a, c) => a + c.volume, 0);
  if (vol <= 0) return null;
  return s.reduce((a, c) => a + c.takerBuyBase, 0) / vol;
}

/** Average volume of `n` bars ending `skip` bars before the last. */
export function avgVolume(k: readonly Kline[], n: number, skip = 1): number {
  const end = k.length - skip;
  const s = k.slice(Math.max(0, end - n), end);
  return s.length ? s.reduce((a, c) => a + c.volume, 0) / s.length : 0;
}

/** Round to a sensible number of significant decimals for prompts/UI. */
export function fmtPrice(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '-';
  const abs = Math.abs(v);
  const dp = abs >= 1000 ? 1 : abs >= 100 ? 2 : abs >= 1 ? 3 : 5;
  return v.toFixed(dp);
}

export function fmtNum(v: number | null | undefined, dp = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '-';
  return v.toFixed(dp);
}
