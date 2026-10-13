/**
 * Historical market data for replays ("과거 차트 리테스트").
 *
 * Source: Binance's public data archive, USDⓈ-M daily files
 *   https://data.binance.vision/data/futures/um/daily/
 *     klines/<SYM>/1m/<SYM>-1m-<day>.zip          1-minute candles (with taker buy volume)
 *     aggTrades/<SYM>/<SYM>-aggTrades-<day>.zip     every aggressor fill (the tape)
 *     bookDepth/<SYM>/<SYM>-bookDepth-<day>.zip     book depth within ±1…5% of mid, every ~30 s
 * (The best-bid/ask "bookTicker" archive stopped being published, so the book
 * side of a replay is the ±1% depth, not the top levels.) Files appear about a
 * day late; missing candles are filled from the REST API, missing tape or book
 * days simply replay on candles.
 *
 * Zips are cached under <userData>/trading/history/, and the tape is reduced
 * to one record per second (OHLC, aggressive buy/sell volume, trade count,
 * big trades) — the replay's clock — and cached gzipped.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { firstCsv } from './zip';
import type { Kline } from './indicators';
import type { BinanceFuturesClient } from './binance';
import type { TradingSymbol } from '../../shared/trading';

export const BINANCE_VISION_UM_DAILY = 'https://data.binance.vision/data/futures/um/daily';

export type BinaryFetch = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

/** One second of the tape. */
export interface SecondBar {
  /** Second start (ms). */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Aggressive buy / sell volume (base asset). */
  buy: number;
  sell: number;
  /** Aggregate trades in the second. */
  n: number;
  bigBuys: number;
  bigSells: number;
}

/** Book depth within ±1% of mid (base asset), at a moment. */
export interface DepthSnap { t: number; bid: number; ask: number }

export type HistKind = 'klines' | 'aggTrades' | 'bookDepth';

const DAY_MS = 86_400_000;

/** UTC days (YYYY-MM-DD) covering [fromMs, toMs]. */
export function dayList(fromMs: number, toMs: number): string[] {
  const out: string[] = [];
  for (let d = Math.floor(fromMs / DAY_MS) * DAY_MS; d <= toMs; d += DAY_MS) out.push(new Date(d).toISOString().slice(0, 10));
  return out;
}

export function visionUrl(kind: HistKind, symbol: string, day: string): string {
  if (kind === 'klines') return `${BINANCE_VISION_UM_DAILY}/klines/${symbol}/1m/${symbol}-1m-${day}.zip`;
  return `${BINANCE_VISION_UM_DAILY}/${kind}/${symbol}/${symbol}-${kind}-${day}.zip`;
}

/** Lines of a CSV buffer without materialising one giant string. */
export function* csvLines(buf: Buffer): Generator<string> {
  let start = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i === buf.length || buf[i] === 0x0a) {
      let end = i;
      if (end > start && buf[end - 1] === 0x0d) end--;
      if (end > start) yield buf.toString('latin1', start, end);
      start = i + 1;
    }
  }
}

const isNum = (s: string) => s !== '' && Number.isFinite(Number(s));
/** Archive timestamps are ms; a few newer files use µs. */
const ms = (v: number) => (v > 1e14 ? Math.floor(v / 1000) : v);

export function parseKlineCsv(buf: Buffer): Kline[] {
  const out: Kline[] = [];
  for (const line of csvLines(buf)) {
    const f = line.split(',');
    if (!isNum(f[0])) continue; // header
    out.push({
      openTime: ms(Number(f[0])), open: Number(f[1]), high: Number(f[2]), low: Number(f[3]), close: Number(f[4]),
      volume: Number(f[5]), closeTime: ms(Number(f[6])), quoteVolume: Number(f[7]), trades: Number(f[8]),
      takerBuyBase: Number(f[9]), takerBuyQuote: Number(f[10])
    });
  }
  return out;
}

/**
 * aggTrades CSV (agg_trade_id, price, quantity, first_trade_id, last_trade_id,
 * transact_time, is_buyer_maker) → one SecondBar per second that traded.
 */
export function aggTradesToSeconds(buf: Buffer, bigTradeUsdt: number): SecondBar[] {
  const out: SecondBar[] = [];
  let cur: SecondBar | null = null;
  for (const line of csvLines(buf)) {
    const f = line.split(',');
    if (!isNum(f[0])) continue;
    const price = Number(f[1]);
    const qty = Number(f[2]);
    const t = ms(Number(f[5]));
    const buy = f[6].trim().toLowerCase() !== 'true';
    const sec = t - (t % 1000);
    if (!cur || cur.t !== sec) {
      if (cur) out.push(cur);
      cur = { t: sec, o: price, h: price, l: price, c: price, buy: 0, sell: 0, n: 0, bigBuys: 0, bigSells: 0 };
    }
    if (price > cur.h) cur.h = price;
    if (price < cur.l) cur.l = price;
    cur.c = price;
    cur.n++;
    if (buy) cur.buy += qty; else cur.sell += qty;
    if (price * qty >= bigTradeUsdt) { if (buy) cur.bigBuys++; else cur.bigSells++; }
  }
  if (cur) out.push(cur);
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** bookDepth CSV (timestamp, percentage, depth, notional) → ±1% bid/ask depth per snapshot. */
export function parseBookDepthCsv(buf: Buffer): DepthSnap[] {
  const groups = new Map<string, Array<[number, number]>>();
  for (const line of csvLines(buf)) {
    const f = line.split(',');
    if (f.length < 3 || !isNum(f[1])) continue;
    const list = groups.get(f[0]) ?? [];
    list.push([Number(f[1]), Number(f[2])]);
    groups.set(f[0], list);
  }
  const out: DepthSnap[] = [];
  for (const [ts, rows] of groups) {
    const t = isNum(ts) ? ms(Number(ts)) : Date.parse(`${ts.replace(' ', 'T')}Z`);
    if (!Number.isFinite(t)) continue;
    const pick = (sign: 1 | -1) => {
      const side = rows.filter(([p]) => Math.sign(p) === sign).sort((a, b) => Math.abs(Math.abs(a[0]) - 1) - Math.abs(Math.abs(b[0]) - 1));
      return side[0]?.[1] ?? 0;
    };
    const bid = pick(-1);
    const ask = pick(1);
    if (bid > 0 && ask > 0) out.push({ t, bid, ask });
  }
  return out.sort((a, b) => a.t - b.t);
}

export interface HistoryProgress { (phase: string, done: number, total: number): void }

export class HistoryStore {
  constructor(
    private readonly root: string,
    private readonly fetchBin: BinaryFetch,
    private readonly rest: Pick<BinanceFuturesClient, 'klinesRange'> | null,
    private readonly opts: { now?: () => number } = {}
  ) {}

  private file(...parts: string[]): string {
    const p = path.join(this.root, ...parts);
    mkdirSync(path.dirname(p), { recursive: true });
    return p;
  }

  /** Where a day's archive zip is cached (it exists once `csv` has downloaded it). */
  zipPath(kind: HistKind, symbol: TradingSymbol, day: string): string {
    return this.file(symbol, kind, `${day}.zip`);
  }

  /** The day's CSV (downloaded once, cached as the original zip). Null when Binance has no file (yet). */
  async csv(kind: HistKind, symbol: TradingSymbol, day: string): Promise<Buffer | null> {
    const zipPath = this.file(symbol, kind, `${day}.zip`);
    if (existsSync(zipPath)) return firstCsv(readFileSync(zipPath));
    const res = await this.fetchBin(visionUrl(kind, symbol, day));
    if (res.status === 404 || res.status === 403) return null;
    if (!res.ok) throw new Error(`과거 데이터 다운로드 실패 (${kind} ${day}, HTTP ${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    const csv = firstCsv(buf);
    // Today's file never exists; don't cache partial days.
    if (day < new Date((this.opts.now ?? Date.now)()).toISOString().slice(0, 10)) writeFileSync(zipPath, buf);
    return csv;
  }

  /** 1-minute candles over [from, to); archive days first, REST for the rest. */
  async klines1m(symbol: TradingSymbol, fromMs: number, toMs: number, progress?: HistoryProgress): Promise<{ k: Kline[]; fromRest: string[] }> {
    const days = dayList(fromMs, toMs - 1);
    const all: Kline[] = [];
    const fromRest: string[] = [];
    for (const [i, day] of days.entries()) {
      progress?.('klines', i, days.length);
      let rows: Kline[] | null = null;
      try { const csv = await this.csv('klines', symbol, day); rows = csv ? parseKlineCsv(csv) : null; } catch { rows = null; }
      if (!rows && this.rest) {
        rows = [];
        const d0 = Date.parse(`${day}T00:00:00Z`);
        for (let s = d0; s < d0 + DAY_MS; s += 1500 * 60_000) {
          const page = await this.rest.klinesRange(symbol, '1m', s, Math.min(d0 + DAY_MS, s + 1500 * 60_000) - 1, 1500);
          rows.push(...page);
          if (page.length < 1500) break;
        }
        fromRest.push(day);
      }
      if (rows) all.push(...rows);
    }
    progress?.('klines', days.length, days.length);
    const dedup = new Map<number, Kline>();
    for (const k of all) if (k.openTime >= fromMs && k.openTime < toMs) dedup.set(k.openTime, k);
    return { k: [...dedup.values()].sort((a, b) => a.openTime - b.openTime), fromRest };
  }

  /** The tape, one record per second, over [from, to). Days without an archive file are listed in `missing`. */
  async seconds(symbol: TradingSymbol, fromMs: number, toMs: number, bigTradeUsdt: number, progress?: HistoryProgress): Promise<{ s: SecondBar[]; missing: string[] }> {
    const days = dayList(fromMs, toMs - 1);
    const out: SecondBar[] = [];
    const missing: string[] = [];
    for (const [i, day] of days.entries()) {
      progress?.('aggTrades', i, days.length);
      const cache = this.file(symbol, 'seconds', `${day}-b${Math.round(bigTradeUsdt)}.json.gz`);
      let rows: SecondBar[] | null = null;
      if (existsSync(cache)) {
        try {
          rows = (JSON.parse(gunzipSync(readFileSync(cache)).toString('utf8')) as number[][])
            .map(([t, o, h, l, c, buy, sell, n, bigBuys, bigSells]) => ({ t, o, h, l, c, buy, sell, n, bigBuys, bigSells }));
        } catch { rows = null; }
      }
      if (!rows) {
        const csv = await this.csv('aggTrades', symbol, day).catch(() => null);
        if (!csv) { missing.push(day); continue; }
        rows = aggTradesToSeconds(csv, bigTradeUsdt);
        if (day < new Date((this.opts.now ?? Date.now)()).toISOString().slice(0, 10)) {
          try {
            writeFileSync(cache, gzipSync(JSON.stringify(rows.map((r) => [r.t, r.o, r.h, r.l, r.c, +r.buy.toFixed(6), +r.sell.toFixed(6), r.n, r.bigBuys, r.bigSells]))));
          } catch { /* cache is optional */ }
        }
      }
      for (const r of rows) if (r.t >= fromMs && r.t < toMs) out.push(r);
    }
    progress?.('aggTrades', days.length, days.length);
    return { s: out, missing };
  }

  /** ±1% book depth snapshots over [from, to). */
  async depth(symbol: TradingSymbol, fromMs: number, toMs: number, progress?: HistoryProgress): Promise<{ d: DepthSnap[]; missing: string[] }> {
    const days = dayList(fromMs, toMs - 1);
    const out: DepthSnap[] = [];
    const missing: string[] = [];
    for (const [i, day] of days.entries()) {
      progress?.('bookDepth', i, days.length);
      const csv = await this.csv('bookDepth', symbol, day).catch(() => null);
      if (!csv) { missing.push(day); continue; }
      for (const r of parseBookDepthCsv(csv)) if (r.t >= fromMs && r.t < toMs) out.push(r);
    }
    progress?.('bookDepth', days.length, days.length);
    return { d: out, missing };
  }
}

/** Candles of a coarser timeframe built from 1-minute ones (bucketed by open time). */
export function aggregateKlines(k1m: readonly Kline[], minutes: number): Kline[] {
  if (minutes <= 1) return [...k1m];
  const step = minutes * 60_000;
  const out: Kline[] = [];
  let cur: Kline | null = null;
  for (const k of k1m) {
    const open = k.openTime - (k.openTime % step);
    if (!cur || cur.openTime !== open) {
      if (cur) out.push(cur);
      cur = { ...k, openTime: open, closeTime: open + step - 1 };
      continue;
    }
    cur.high = Math.max(cur.high, k.high);
    cur.low = Math.min(cur.low, k.low);
    cur.close = k.close;
    cur.volume += k.volume;
    cur.quoteVolume += k.quoteVolume;
    cur.trades += k.trades;
    cur.takerBuyBase += k.takerBuyBase;
    cur.takerBuyQuote += k.takerBuyQuote;
  }
  if (cur) out.push(cur);
  return out;
}

export const TF_MINUTES: Record<string, number> = { '1m': 1, '3m': 3, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440 };
