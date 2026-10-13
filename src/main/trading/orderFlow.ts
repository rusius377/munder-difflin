/**
 * Order flow ("호가·체결 흐름"): what the tape and the book say right now.
 *
 * Live, the desk subscribes to Binance's streams:
 *   wss://fstream.binance.com/market/stream?streams=<sym>@aggTrade/…      every aggressor fill
 *   wss://fstream.binance.com/public/stream?streams=<sym>@depth20@100ms/… top 20 levels, 10×/s
 * (Binance split the futures endpoints into /public and /market; the old
 * un-routed URL was retired in April 2026.) If the sockets are down, the
 * engine feeds the same tracker from REST (recent aggTrades + depth), so the
 * features never go blind — they just get coarser.
 *
 * Replays feed a tracker from historical aggTrades and bookDepth files, so the
 * scalper reads the same features in a backtest as it does live.
 */
import { connectWebSocket, type WsConnection, type WsFactory } from './wsClient';
import type { FlowView, TradingSymbol } from '../../shared/trading';

export interface FlowTrade {
  /** Binance aggregate trade id (dedupe across WS and REST). */
  id: number;
  t: number;
  price: number;
  qty: number;
  /** Aggressor was the buyer (Binance `m` = buyer is maker → false). */
  buy: boolean;
}

export interface BookLevels {
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
  at: number;
}

export interface FlowFeatures {
  source: 'live' | 'rest' | 'replay';
  /** Base-asset volume delta (aggressive buys − sells). */
  cvd1m: number;
  cvd5m: number;
  vol1m: number;
  /** Aggressive buy share of the last minute's volume, 0–1 (null with no trades). */
  buyShare1m: number | null;
  tradesPerSec: number;
  /** Trades at or above the big-trade size over the last 5 minutes. */
  bigBuys: number;
  bigSells: number;
  /** Bid size / ask size over the book levels read (≥1 = more bids). */
  bookImbalance: number | null;
  /** Unusually large resting orders near the price. */
  walls: Array<{ side: 'bid' | 'ask'; price: number; qty: number; distPct: number }>;
  spreadBps: number | null;
  /** Price change over the last minute, %. */
  change1mPct: number | null;
  /** Heavy aggression that does not move price: someone absorbs it. */
  absorption: 'buy' | 'sell' | null;
  lastPrice: number | null;
  updatedAt: number;
}

const WINDOW_MS = 5 * 60_000;

export class FlowTracker {
  private trades: FlowTrade[] = [];
  private lastId = -1;
  private book: BookLevels | null = null;
  /** Big trades for the UI (newest first). */
  private bigTape: FlowTrade[] = [];

  constructor(readonly symbol: TradingSymbol, private readonly opts: { bigTradeUsdt: number }) {}

  addTrade(tr: FlowTrade): void {
    if (tr.id <= this.lastId) return;
    this.lastId = tr.id;
    this.trades.push(tr);
    if (tr.price * tr.qty >= this.opts.bigTradeUsdt) {
      this.bigTape.unshift(tr);
      if (this.bigTape.length > 12) this.bigTape.length = 12;
    }
    // Prune lazily (amortised): drop everything older than the window.
    if (this.trades.length > 256 && this.trades[0].t < tr.t - WINDOW_MS) {
      const cut = this.trades.findIndex((x) => x.t >= tr.t - WINDOW_MS);
      this.trades.splice(0, cut < 0 ? this.trades.length : cut);
    }
  }

  setBook(b: BookLevels): void {
    this.book = b;
  }

  get lastTradeId(): number { return this.lastId; }
  get lastTradeAt(): number { return this.trades.length ? this.trades[this.trades.length - 1].t : 0; }

  features(nowLocal: number, source: FlowFeatures['source']): FlowFeatures {
    // Windows are measured on the exchange's clock: a PC clock running behind
    // would otherwise see the newest trades as "in the future".
    const now = Math.max(nowLocal, this.lastTradeAt);
    let cvd1m = 0, cvd5m = 0, vol1m = 0, buy1m = 0, recent = 0, bigBuys = 0, bigSells = 0;
    let first1m: number | null = null;
    let lastPrice: number | null = null;
    for (const tr of this.trades) {
      const age = now - tr.t;
      if (age > WINDOW_MS) continue;
      const signed = tr.buy ? tr.qty : -tr.qty;
      cvd5m += signed;
      if (tr.price * tr.qty >= this.opts.bigTradeUsdt) { if (tr.buy) bigBuys++; else bigSells++; }
      if (age <= 60_000) {
        if (first1m === null) first1m = tr.price;
        cvd1m += signed;
        vol1m += tr.qty;
        if (tr.buy) buy1m += tr.qty;
      }
      if (age <= 10_000) recent++;
      lastPrice = tr.price;
    }
    const change1mPct = first1m && lastPrice ? ((lastPrice - first1m) / first1m) * 100 : null;
    const buyShare1m = vol1m > 0 ? buy1m / vol1m : null;

    let bookImbalance: number | null = null;
    let spreadBps: number | null = null;
    const walls: FlowFeatures['walls'] = [];
    const b = this.book;
    if (b && b.bids.length && b.asks.length) {
      const bid = b.bids[0][0];
      const ask = b.asks[0][0];
      const mid = (bid + ask) / 2;
      spreadBps = mid > 0 ? ((ask - bid) / mid) * 10_000 : null;
      const bq = b.bids.reduce((a, l) => a + l[1], 0);
      const aq = b.asks.reduce((a, l) => a + l[1], 0);
      bookImbalance = aq > 0 ? bq / aq : null;
      // A wall: a level at least 4× the median level size of the visible book.
      const sizes = [...b.bids, ...b.asks].map((l) => l[1]).sort((x, y) => x - y);
      const median = sizes[Math.floor(sizes.length / 2)] ?? 0;
      if (median > 0) {
        for (const [side, levels] of [['bid', b.bids], ['ask', b.asks]] as const) {
          levels
            .filter((l) => l[1] >= median * 4)
            .sort((x, y) => y[1] - x[1])
            .slice(0, 2)
            .forEach(([price, qty]) => walls.push({ side, price, qty, distPct: (Math.abs(price - mid) / mid) * 100 }));
        }
      }
      if (lastPrice === null) lastPrice = mid;
    }

    // Absorption: one side hits hard (≥60% of a minute's volume, real size)
    // and price does not give way — the other side is soaking it up.
    let absorption: FlowFeatures['absorption'] = null;
    if (buyShare1m !== null && change1mPct !== null && vol1m > 0 && Math.abs(cvd1m) > 0.2 * vol1m) {
      if (buyShare1m <= 0.4 && change1mPct >= 0) absorption = 'buy';
      else if (buyShare1m >= 0.6 && change1mPct <= 0) absorption = 'sell';
    }

    return {
      source, cvd1m, cvd5m, vol1m, buyShare1m, tradesPerSec: recent / 10, bigBuys, bigSells,
      bookImbalance, walls, spreadBps, change1mPct, absorption, lastPrice, updatedAt: now
    };
  }

  view(nowLocal: number, source: FlowFeatures['source'], connected: boolean): FlowView {
    const f = this.features(nowLocal, source);
    const now = Math.max(nowLocal, this.lastTradeAt);
    return {
      ...f,
      connected,
      bigTrades: this.bigTape
        .filter((x) => now - x.t <= WINDOW_MS)
        .slice(0, 6)
        .map((x) => ({ t: x.t, price: x.price, qty: x.qty, buy: x.buy }))
    };
  }
}

// ─── parsing ─────────────────────────────────────────────────────────────────

const n = (v: unknown) => (typeof v === 'number' ? v : Number(v));

/** A combined-stream aggTrade event (`{stream, data}` or the bare payload). */
export function parseAggTrade(msg: unknown): { symbol: string; trade: FlowTrade } | null {
  const o = (msg && typeof msg === 'object' && 'data' in (msg as object) ? (msg as { data: unknown }).data : msg) as Record<string, unknown> | null;
  if (!o || o.e !== 'aggTrade' || typeof o.s !== 'string') return null;
  const trade = { id: n(o.a), t: n(o.T), price: n(o.p), qty: n(o.q), buy: o.m !== true };
  if (![trade.id, trade.t, trade.price, trade.qty].every(Number.isFinite)) return null;
  return { symbol: o.s, trade };
}

/** A partial-depth event (futures streams use `b`/`a`; REST uses `bids`/`asks`). */
export function parseDepth(msg: unknown, symbolHint?: string): { symbol: string; book: BookLevels } | null {
  const o = (msg && typeof msg === 'object' && 'data' in (msg as object) ? (msg as { data: unknown }).data : msg) as Record<string, unknown> | null;
  if (!o) return null;
  const rawB = (o.b ?? o.bids) as unknown;
  const rawA = (o.a ?? o.asks) as unknown;
  if (!Array.isArray(rawB) || !Array.isArray(rawA)) return null;
  const lv = (rows: unknown[]) => rows
    .map((r) => (Array.isArray(r) ? [n(r[0]), n(r[1])] as [number, number] : null))
    .filter((x): x is [number, number] => !!x && Number.isFinite(x[0]) && Number.isFinite(x[1]) && x[1] > 0);
  const symbol = typeof o.s === 'string' ? o.s : symbolHint;
  if (!symbol) return null;
  return { symbol, book: { bids: lv(rawB), asks: lv(rawA), at: n(o.E ?? o.T ?? Date.now()) } };
}

/** REST GET /fapi/v1/aggTrades rows. */
export function parseRestAggTrades(rows: unknown): FlowTrade[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((r: Record<string, unknown>) => ({ id: n(r.a), t: n(r.T), price: n(r.p), qty: n(r.q), buy: r.m !== true }))
    .filter((x) => [x.id, x.t, x.price, x.qty].every(Number.isFinite));
}

// ─── live feed ───────────────────────────────────────────────────────────────

export const BINANCE_WS = {
  market: 'wss://fstream.binance.com/market/stream?streams=',
  public: 'wss://fstream.binance.com/public/stream?streams='
} as const;

export function streamUrls(symbols: readonly TradingSymbol[]): { market: string; public: string } {
  const s = symbols.map((x) => x.toLowerCase());
  return {
    market: BINANCE_WS.market + s.map((x) => `${x}@aggTrade`).join('/'),
    public: BINANCE_WS.public + s.map((x) => `${x}@depth20@100ms`).join('/')
  };
}

/**
 * Two sockets (trades, book) for the desk's symbols. Reconnects with backoff
 * and rotates every 23 hours (Binance cuts connections at 24 hours).
 */
export class LiveFlowFeed {
  readonly trackers: Partial<Record<TradingSymbol, FlowTracker>> = {};
  private conns: { market?: WsConnection; public?: WsConnection } = {};
  private lastMsg: { market: number; public: number } = { market: 0, public: 0 };
  private retries: { market: number; public: number } = { market: 0, public: 0 };
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private stopped = true;

  constructor(
    private readonly symbols: readonly TradingSymbol[],
    private readonly opts: {
      bigTradeUsdt: number;
      factory?: WsFactory;
      now?: () => number;
      log?: (msg: string, level?: 'info' | 'warn') => void;
      urls?: { market: string; public: string };
    }
  ) {
    for (const s of symbols) this.trackers[s] = new FlowTracker(s, { bigTradeUsdt: opts.bigTradeUsdt });
  }

  private now(): number { return (this.opts.now ?? Date.now)(); }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open('market');
    this.open('public');
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.conns.market?.close(1000, 'desk stopped');
    this.conns.public?.close(1000, 'desk stopped');
    this.conns = {};
  }

  /** A stream counts as live when it delivered something in the last 15 s. */
  live(kind: 'market' | 'public'): boolean {
    return !!this.conns[kind]?.isOpen && this.now() - this.lastMsg[kind] < 15_000;
  }

  private open(kind: 'market' | 'public'): void {
    if (this.stopped) return;
    const url = (this.opts.urls ?? streamUrls(this.symbols))[kind];
    const factory = this.opts.factory ?? connectWebSocket;
    let conn: WsConnection;
    try {
      conn = factory(url, {
        onOpen: () => {
          this.retries[kind] = 0;
          this.opts.log?.(`실시간 ${kind === 'market' ? '체결' : '호가'} 스트림 연결`, 'info');
        },
        onMessage: (text) => this.onMessage(kind, text),
        onClose: (code, reason) => {
          if (this.conns[kind] === conn) delete this.conns[kind];
          if (this.stopped) return;
          const wait = Math.min(60_000, 1000 * 2 ** Math.min(6, this.retries[kind]++));
          this.opts.log?.(`실시간 ${kind === 'market' ? '체결' : '호가'} 스트림 끊김(${code}${reason ? ` ${reason}` : ''}) — ${Math.round(wait / 1000)}초 뒤 재연결, 그동안 REST로 보완`, 'warn');
          this.timers.push(setTimeout(() => this.open(kind), wait));
        }
      });
    } catch (e) {
      this.opts.log?.(`스트림 연결 실패: ${e instanceof Error ? e.message : e}`, 'warn');
      this.timers.push(setTimeout(() => this.open(kind), 30_000));
      return;
    }
    this.conns[kind] = conn;
    // Rotate before Binance's 24-hour cut.
    this.timers.push(setTimeout(() => { if (this.conns[kind] === conn) conn.close(1000, 'rotate'); }, 23 * 3_600_000));
  }

  private onMessage(kind: 'market' | 'public', text: string): void {
    let msg: unknown;
    try { msg = JSON.parse(text); } catch { return; }
    this.lastMsg[kind] = this.now();
    if (kind === 'market') {
      const a = parseAggTrade(msg);
      if (a) this.trackers[a.symbol as TradingSymbol]?.addTrade(a.trade);
    } else {
      const d = parseDepth(msg);
      if (d) this.trackers[d.symbol as TradingSymbol]?.setBook(d.book);
    }
  }
}
