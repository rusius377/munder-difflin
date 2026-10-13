/**
 * Binance USDⓈ-M futures REST client — the subset the trading desk needs.
 *
 * Endpoints follow the official docs (developers.binance.com, Oct 2026):
 *   - live REST  https://fapi.binance.com
 *   - demo REST  https://demo-fapi.binance.com   (Binance's futures demo/testnet)
 *   - conditional orders (STOP_MARKET / TAKE_PROFIT_MARKET) go through the Algo
 *     Order API (`POST /fapi/v1/algoOrder`, `algoType=CONDITIONAL`,
 *     `triggerPrice`). Since the Dec-2025 migration the classic `/fapi/v1/order`
 *     rejects those types with -4120, so this client never sends them there.
 *
 * Signed requests use HMAC-SHA256 over the query string, with a server-time
 * offset so a drifting local clock does not trip -1021.
 *
 * `fetch` is injectable for tests; production uses the global fetch of the
 * Electron main process.
 */
import { createHmac } from 'node:crypto';
import type { Kline } from './indicators';
import type { ApiKeyPermissions } from '../../shared/trading';

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<FetchResponseLike>;

export const BINANCE_REST = {
  live: 'https://fapi.binance.com',
  demo: 'https://demo-fapi.binance.com',
  /** Spot/wallet host — only used to read a live key's permissions. */
  spot: 'https://api.binance.com'
} as const;

export class BinanceError extends Error {
  constructor(message: string, readonly status: number, readonly code?: number) {
    super(message);
    this.name = 'BinanceError';
  }
}

export interface SymbolFilters {
  symbol: string;
  tickSize: number;
  stepSize: number;
  marketStepSize: number;
  minQty: number;
  marketMinQty: number;
  marketMaxQty: number;
  minNotional: number;
}

export interface PremiumIndex {
  symbol: string;
  markPrice: number;
  indexPrice: number;
  lastFundingRate: number;
  nextFundingTime: number;
  time: number;
}

export interface Ticker24h {
  symbol: string;
  lastPrice: number;
  priceChangePercent: number;
  highPrice: number;
  lowPrice: number;
  quoteVolume: number;
}

export interface Depth {
  bids: [number, number][];
  asks: [number, number][];
}

export interface RatioPoint { timestamp: number; value: number; longShare?: number; shortShare?: number }
export interface OiPoint { timestamp: number; openInterest: number; openInterestValue: number }
export interface FundingPoint { fundingTime: number; fundingRate: number }

export interface PositionRisk {
  symbol: string;
  positionSide: string;
  positionAmt: number;
  entryPrice: number;
  markPrice: number;
  unRealizedProfit: number;
  liquidationPrice: number;
  notional: number;
  updateTime: number;
}

export interface AccountSummary {
  totalWalletBalance: number;
  totalUnrealizedProfit: number;
  totalMarginBalance: number;
  availableBalance: number;
}

export interface IncomeRow { symbol: string; incomeType: string; income: number; time: number; tradeId?: string }

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

/** Decimal places implied by a step like 0.001 → 3 (works for 1e-8 too). */
export function stepDecimals(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 8;
  const s = step.toFixed(12).replace(/0+$/, '');
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

/** Snap a value onto a step grid without float noise. */
export function roundToStep(value: number, step: number, mode: 'floor' | 'round' | 'ceil' = 'round'): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return value;
  const dp = stepDecimals(step);
  const units = value / step;
  // Tiny epsilon so 0.3/0.1 = 2.9999999 floors to 3, not 2.
  const eps = 1e-9;
  const n = mode === 'floor' ? Math.floor(units + eps) : mode === 'ceil' ? Math.ceil(units - eps) : Math.round(units);
  return Number((n * step).toFixed(dp));
}

/** Format for a Binance parameter: fixed decimals, no exponent. */
export function fmtParam(value: number, step: number): string {
  return roundToStep(value, step, 'round').toFixed(stepDecimals(step));
}

export function parseSymbolFilters(raw: unknown): SymbolFilters | null {
  const s = raw as { symbol?: string; filters?: Array<Record<string, unknown>> };
  if (!s || typeof s.symbol !== 'string' || !Array.isArray(s.filters)) return null;
  const f = (type: string) => s.filters!.find((x) => x.filterType === type) ?? {};
  const price = f('PRICE_FILTER');
  const lot = f('LOT_SIZE');
  const mlot = f('MARKET_LOT_SIZE');
  const notional = f('MIN_NOTIONAL');
  return {
    symbol: s.symbol,
    tickSize: num(price.tickSize) || 0.1,
    stepSize: num(lot.stepSize) || 0.001,
    marketStepSize: num(mlot.stepSize) || num(lot.stepSize) || 0.001,
    minQty: num(lot.minQty),
    marketMinQty: num(mlot.minQty) || num(lot.minQty),
    marketMaxQty: num(mlot.maxQty) || Number.MAX_SAFE_INTEGER,
    minNotional: num(notional.notional) || 5
  };
}

export function parseKlines(rows: unknown): Kline[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((r: unknown[]) => ({
    openTime: num(r[0]),
    open: num(r[1]),
    high: num(r[2]),
    low: num(r[3]),
    close: num(r[4]),
    volume: num(r[5]),
    closeTime: num(r[6]),
    quoteVolume: num(r[7]),
    trades: num(r[8]),
    takerBuyBase: num(r[9]),
    takerBuyQuote: num(r[10])
  }));
}

export interface BinanceClientOptions {
  baseUrl: string;
  apiKey?: string;
  apiSecret?: string;
  fetch?: FetchLike;
  recvWindow?: number;
  timeoutMs?: number;
  now?: () => number;
  /** Server-time endpoint on this host (futures: /fapi/v1/time, spot: /api/v3/time). */
  timePath?: string;
}

type Params = Record<string, string | number | boolean | undefined>;

export class BinanceFuturesClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly apiSecret?: string;
  private readonly fetchImpl: FetchLike;
  private readonly recvWindow: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly timePath: string;
  private timeOffset = 0;
  private timeSyncedAt = 0;

  constructor(opts: BinanceClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.apiSecret = opts.apiSecret;
    this.fetchImpl = opts.fetch ?? ((globalThis as unknown as { fetch: FetchLike }).fetch);
    this.recvWindow = opts.recvWindow ?? 5000;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.now = opts.now ?? Date.now;
    this.timePath = opts.timePath ?? '/fapi/v1/time';
  }

  get hasCredentials(): boolean {
    return !!(this.apiKey && this.apiSecret);
  }

  static query(params: Params): string {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      usp.append(k, String(v));
    }
    return usp.toString();
  }

  sign(query: string): string {
    if (!this.apiSecret) throw new BinanceError('API secret이 설정되지 않았습니다', 0);
    return createHmac('sha256', this.apiSecret).update(query).digest('hex');
  }

  private async request<T>(method: string, path: string, params: Params, signed: boolean): Promise<T> {
    let query: string;
    const headers: Record<string, string> = {};
    if (signed) {
      if (!this.hasCredentials) throw new BinanceError('바이낸스 API 키가 설정되지 않았습니다', 0);
      if (this.now() - this.timeSyncedAt > 30 * 60_000) await this.syncTime();
      query = BinanceFuturesClient.query({
        ...params,
        recvWindow: this.recvWindow,
        timestamp: Math.round(this.now() + this.timeOffset)
      });
      query += `&signature=${this.sign(query)}`;
      headers['X-MBX-APIKEY'] = this.apiKey as string;
    } else {
      query = BinanceFuturesClient.query(params);
      if (this.apiKey) headers['X-MBX-APIKEY'] = this.apiKey;
    }
    const url = `${this.baseUrl}${path}${query ? `?${query}` : ''}`;
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), this.timeoutMs) : null;
    let res: FetchResponseLike;
    try {
      res = await this.fetchImpl(url, { method, headers, signal: ctl?.signal });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new BinanceError(`바이낸스 연결 실패 (${path}): ${msg}`, 0);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const text = await res.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!res.ok) {
      const b = body as { code?: number; msg?: string } | null;
      let msg = b && typeof b === 'object' && b.msg ? b.msg : `HTTP ${res.status}`;
      if (res.status === 451) msg += ' — 이 지역(IP)에서는 바이낸스 선물 API를 쓸 수 없습니다';
      if (res.status === 418 || res.status === 429) msg += ' — 요청 한도 초과, 잠시 후 다시 시도합니다';
      throw new BinanceError(`${path}: ${msg}`, res.status, b && typeof b === 'object' ? b.code : undefined);
    }
    return body as T;
  }

  publicGet<T>(path: string, params: Params = {}): Promise<T> {
    return this.request<T>('GET', path, params, false);
  }

  signedRequest<T>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Params = {}): Promise<T> {
    return this.request<T>(method, path, params, true);
  }

  async syncTime(): Promise<void> {
    const t0 = this.now();
    const r = await this.publicGet<{ serverTime: number }>(this.timePath);
    const t1 = this.now();
    this.timeOffset = num(r.serverTime) - (t0 + t1) / 2;
    this.timeSyncedAt = t1;
  }

  // ─── market data (public) ────────────────────────────────────────────────

  async klines(symbol: string, interval: string, limit = 200): Promise<Kline[]> {
    return parseKlines(await this.publicGet('/fapi/v1/klines', { symbol, interval, limit }));
  }

  /** Candles opening at or after `startTime` (ms) — used to look up a past price. */
  async klinesFrom(symbol: string, interval: string, startTime: number, limit = 1): Promise<Kline[]> {
    return parseKlines(await this.publicGet('/fapi/v1/klines', { symbol, interval, startTime: Math.floor(startTime), limit }));
  }

  /** Candles between two times (ms), at most `limit` (Binance max 1500) — replays page through this. */
  async klinesRange(symbol: string, interval: string, startTime: number, endTime: number, limit = 1500): Promise<Kline[]> {
    return parseKlines(await this.publicGet('/fapi/v1/klines', { symbol, interval, startTime: Math.floor(startTime), endTime: Math.floor(endTime), limit }));
  }

  /** GET /fapi/v1/aggTrades (weight 20): the latest aggregate trades, raw rows. */
  aggTradesRaw(symbol: string, limit = 500, fromId?: number): Promise<unknown> {
    return this.publicGet('/fapi/v1/aggTrades', fromId !== undefined ? { symbol, limit, fromId } : { symbol, limit });
  }

  async premiumIndex(symbol: string): Promise<PremiumIndex> {
    const r = await this.publicGet<Record<string, unknown>>('/fapi/v1/premiumIndex', { symbol });
    return {
      symbol,
      markPrice: num(r.markPrice),
      indexPrice: num(r.indexPrice),
      lastFundingRate: num(r.lastFundingRate),
      nextFundingTime: num(r.nextFundingTime),
      time: num(r.time)
    };
  }

  /** `endTime` (ms): history up to that moment (replays). */
  async fundingRateHistory(symbol: string, limit = 30, endTime?: number): Promise<FundingPoint[]> {
    const r = await this.publicGet<Array<Record<string, unknown>>>('/fapi/v1/fundingRate', endTime ? { symbol, limit, endTime: Math.floor(endTime) } : { symbol, limit });
    return (Array.isArray(r) ? r : []).map((x) => ({ fundingTime: num(x.fundingTime), fundingRate: num(x.fundingRate) }));
  }

  async openInterest(symbol: string): Promise<number> {
    const r = await this.publicGet<Record<string, unknown>>('/fapi/v1/openInterest', { symbol });
    return num(r.openInterest);
  }

  /** Binance keeps only the last 30 days of this series. */
  async openInterestHist(symbol: string, period = '1h', limit = 48, endTime?: number): Promise<OiPoint[]> {
    const r = await this.publicGet<Array<Record<string, unknown>>>('/futures/data/openInterestHist', endTime ? { symbol, period, limit, endTime: Math.floor(endTime) } : { symbol, period, limit });
    return (Array.isArray(r) ? r : []).map((x) => ({
      timestamp: num(x.timestamp),
      openInterest: num(x.sumOpenInterest),
      openInterestValue: num(x.sumOpenInterestValue)
    }));
  }

  private async ratio(path: string, symbol: string, period: string, limit: number, endTime?: number): Promise<RatioPoint[]> {
    const r = await this.publicGet<Array<Record<string, unknown>>>(path, endTime ? { symbol, period, limit, endTime: Math.floor(endTime) } : { symbol, period, limit });
    return (Array.isArray(r) ? r : []).map((x) => ({
      timestamp: num(x.timestamp),
      value: num(x.longShortRatio ?? x.buySellRatio),
      longShare: x.longAccount !== undefined ? num(x.longAccount) : x.longPosition !== undefined ? num(x.longPosition) : undefined,
      shortShare: x.shortAccount !== undefined ? num(x.shortAccount) : x.shortPosition !== undefined ? num(x.shortPosition) : undefined
    }));
  }

  globalLongShortAccountRatio(symbol: string, period = '1h', limit = 48, endTime?: number): Promise<RatioPoint[]> {
    return this.ratio('/futures/data/globalLongShortAccountRatio', symbol, period, limit, endTime);
  }

  topLongShortPositionRatio(symbol: string, period = '1h', limit = 48, endTime?: number): Promise<RatioPoint[]> {
    return this.ratio('/futures/data/topLongShortPositionRatio', symbol, period, limit, endTime);
  }

  takerBuySellRatio(symbol: string, period = '1h', limit = 48, endTime?: number): Promise<RatioPoint[]> {
    return this.ratio('/futures/data/takerlongshortRatio', symbol, period, limit, endTime);
  }

  async ticker24h(symbol: string): Promise<Ticker24h> {
    const r = await this.publicGet<Record<string, unknown>>('/fapi/v1/ticker/24hr', { symbol });
    return {
      symbol,
      lastPrice: num(r.lastPrice),
      priceChangePercent: num(r.priceChangePercent),
      highPrice: num(r.highPrice),
      lowPrice: num(r.lowPrice),
      quoteVolume: num(r.quoteVolume)
    };
  }

  async depth(symbol: string, limit = 20): Promise<Depth> {
    const r = await this.publicGet<{ bids?: [string, string][]; asks?: [string, string][] }>('/fapi/v1/depth', { symbol, limit });
    return {
      bids: (r.bids ?? []).map(([p, q]) => [num(p), num(q)] as [number, number]),
      asks: (r.asks ?? []).map(([p, q]) => [num(p), num(q)] as [number, number])
    };
  }

  async exchangeFilters(symbols: readonly string[]): Promise<Record<string, SymbolFilters>> {
    const r = await this.publicGet<{ symbols?: unknown[] }>('/fapi/v1/exchangeInfo');
    const out: Record<string, SymbolFilters> = {};
    for (const raw of r.symbols ?? []) {
      const f = parseSymbolFilters(raw);
      if (f && symbols.includes(f.symbol)) out[f.symbol] = f;
    }
    return out;
  }

  // ─── account & trading (signed) ──────────────────────────────────────────

  async account(): Promise<AccountSummary> {
    const r = await this.signedRequest<Record<string, unknown>>('GET', '/fapi/v3/account');
    return {
      totalWalletBalance: num(r.totalWalletBalance),
      totalUnrealizedProfit: num(r.totalUnrealizedProfit),
      totalMarginBalance: num(r.totalMarginBalance),
      availableBalance: num(r.availableBalance)
    };
  }

  async positionRisk(symbol?: string): Promise<PositionRisk[]> {
    const r = await this.signedRequest<Array<Record<string, unknown>>>('GET', '/fapi/v3/positionRisk', { symbol });
    return (Array.isArray(r) ? r : []).map((x) => ({
      symbol: String(x.symbol),
      positionSide: String(x.positionSide ?? 'BOTH'),
      positionAmt: num(x.positionAmt),
      entryPrice: num(x.entryPrice),
      markPrice: num(x.markPrice),
      unRealizedProfit: num(x.unRealizedProfit),
      liquidationPrice: num(x.liquidationPrice),
      notional: num(x.notional),
      updateTime: num(x.updateTime)
    }));
  }

  /** true = Hedge Mode (dual side), false = One-way. */
  async isHedgeMode(): Promise<boolean> {
    const r = await this.signedRequest<{ dualSidePosition?: boolean | string }>('GET', '/fapi/v1/positionSide/dual');
    return r.dualSidePosition === true || r.dualSidePosition === 'true';
  }

  /** GET /fapi/v1/leverageBracket (signed, weight 1): the symbol's notional tiers. */
  leverageBrackets(symbol?: string): Promise<unknown> {
    return this.signedRequest('GET', '/fapi/v1/leverageBracket', symbol ? { symbol } : {});
  }

  setLeverage(symbol: string, leverage: number): Promise<unknown> {
    return this.signedRequest('POST', '/fapi/v1/leverage', { symbol, leverage: Math.round(leverage) });
  }

  async setMarginType(symbol: string, marginType: 'ISOLATED' | 'CROSSED'): Promise<void> {
    try {
      await this.signedRequest('POST', '/fapi/v1/marginType', { symbol, marginType });
    } catch (e) {
      // -4046: "No need to change margin type." — already set, not an error.
      if (e instanceof BinanceError && e.code === -4046) return;
      throw e;
    }
  }

  newOrder(params: Params): Promise<Record<string, unknown>> {
    return this.signedRequest('POST', '/fapi/v1/order', params);
  }

  /** Conditional order through the Algo Order API (STOP_MARKET / TAKE_PROFIT_MARKET …). */
  newAlgoOrder(params: Params): Promise<Record<string, unknown>> {
    return this.signedRequest('POST', '/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', ...params });
  }

  async openAlgoOrders(symbol: string): Promise<Array<Record<string, unknown>>> {
    const r = await this.signedRequest<unknown>('GET', '/fapi/v1/openAlgoOrders', { symbol });
    if (Array.isArray(r)) return r as Array<Record<string, unknown>>;
    const o = r as { orders?: unknown };
    return Array.isArray(o?.orders) ? (o.orders as Array<Record<string, unknown>>) : [];
  }

  cancelAlgoOrder(symbol: string, algoId: number | string): Promise<unknown> {
    return this.signedRequest('DELETE', '/fapi/v1/algoOrder', { symbol, algoId });
  }

  /** Cancel every open conditional (algo) order on a symbol, one by one if the bulk call is refused. */
  async cancelAllAlgoOrders(symbol: string): Promise<void> {
    try {
      await this.signedRequest('DELETE', '/fapi/v1/algoOpenOrders', { symbol });
      return;
    } catch { /* fall through to per-order cancel */ }
    const open = await this.openAlgoOrders(symbol);
    for (const o of open) {
      const id = o.algoId;
      if (id !== undefined) {
        try { await this.cancelAlgoOrder(symbol, id as number); } catch { /* already gone */ }
      }
    }
  }

  async cancelAllOpenOrders(symbol: string): Promise<void> {
    try { await this.signedRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol }); } catch { /* none open */ }
  }

  async userTrades(symbol: string, startTime: number): Promise<Array<{ price: number; qty: number; side: string; realizedPnl: number; commission: number; time: number }>> {
    const r = await this.signedRequest<Array<Record<string, unknown>>>('GET', '/fapi/v1/userTrades', { symbol, startTime, limit: 500 });
    return (Array.isArray(r) ? r : []).map((x) => ({
      price: num(x.price),
      qty: num(x.qty),
      side: String(x.side),
      realizedPnl: num(x.realizedPnl),
      commission: num(x.commission),
      time: num(x.time)
    }));
  }

  async income(symbol: string, startTime: number, incomeType?: string): Promise<IncomeRow[]> {
    const r = await this.signedRequest<Array<Record<string, unknown>>>('GET', '/fapi/v1/income', {
      symbol, startTime, incomeType, limit: 1000
    });
    return (Array.isArray(r) ? r : []).map((x) => ({
      symbol: String(x.symbol),
      incomeType: String(x.incomeType),
      income: num(x.income),
      time: num(x.time),
      tradeId: x.tradeId !== undefined ? String(x.tradeId) : undefined
    }));
  }

  /** A key's permissions. Call on a client built for BINANCE_REST.spot with timePath '/api/v3/time'. */
  async apiRestrictions(): Promise<ApiKeyPermissions> {
    const r = await this.signedRequest<Record<string, unknown>>('GET', '/sapi/v1/account/apiRestrictions');
    const b = (k: string) => r[k] === true || r[k] === 'true';
    return {
      ipRestrict: b('ipRestrict'),
      enableReading: b('enableReading'),
      enableFutures: b('enableFutures'),
      enableWithdrawals: b('enableWithdrawals'),
      enableInternalTransfer: b('enableInternalTransfer'),
      permitsUniversalTransfer: b('permitsUniversalTransfer')
    };
  }
}

/** Read a LIVE key's permissions from the spot host. */
export function liveKeyPermissions(apiKey: string, apiSecret: string, fetchImpl: FetchLike, now?: () => number): Promise<ApiKeyPermissions> {
  return new BinanceFuturesClient({ baseUrl: BINANCE_REST.spot, apiKey, apiSecret, fetch: fetchImpl, now, timePath: '/api/v3/time' }).apiRestrictions();
}
