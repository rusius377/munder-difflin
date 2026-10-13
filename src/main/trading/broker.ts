/**
 * Brokers: where an OrderPlan becomes a position.
 *
 *   PaperBroker   — local simulation on live prices: taker fees, slippage,
 *                   stop/target fills from candle highs/lows (stop wins when
 *                   both are inside one bar), funding settlements, isolated
 *                   liquidation. State survives restarts.
 *   BinanceBroker — Binance USDⓈ-M (demo or live). Market entry, then a
 *                   reduce-only STOP_MARKET and TAKE_PROFIT_MARKET through the
 *                   Algo Order API. If the stop cannot be placed the position is
 *                   closed at once — the desk never holds an unprotected position.
 */
import {
  BinanceFuturesClient, fmtParam, roundToStep, type SymbolFilters
} from './binance';
import { grossPnl } from './risk';
import {
  TRADING_SYMBOLS, type ExecutionVenue, type OrderPlan, type PositionView, type Side, type TradeView,
  type TradingMode, type TradingSymbol
} from '../../shared/trading';

export interface PriceTick {
  last: number;
  mark: number;
  /** Extremes traded since the previous sync (from the current 1m candle). */
  high: number;
  low: number;
  fundingRate?: number;
  nextFundingTime?: number;
}

export interface BrokerAccount {
  equity: number;
  walletBalance: number;
  available: number;
  unrealizedPnl: number;
}

export type PositionSource = TradingMode | 'manual';

export interface Persist {
  load(): unknown;
  save(value: unknown): void;
}

export interface Broker {
  readonly venue: ExecutionVenue;
  init(symbols: readonly TradingSymbol[]): Promise<void>;
  filters(symbol: TradingSymbol): SymbolFilters | null;
  account(): Promise<BrokerAccount>;
  positions(): Promise<PositionView[]>;
  /** Apply fresh prices; returns positions that closed since the last sync. */
  sync(prices: Partial<Record<TradingSymbol, PriceTick>>): Promise<TradeView[]>;
  open(plan: OrderPlan, source: PositionSource): Promise<PositionView>;
  close(symbol: TradingSymbol, reason: string): Promise<TradeView | null>;
  updateStops(symbol: TradingSymbol, stopLoss: number | null, takeProfit: number | null): Promise<void>;
}

let seq = 0;
export function tradeId(now: number): string {
  seq = (seq + 1) % 1000;
  return `${now.toString(36)}-${seq.toString(36)}`;
}

// ─── paper ───────────────────────────────────────────────────────────────────

interface PaperPosition {
  symbol: TradingSymbol;
  side: Side;
  quantity: number;
  entryPrice: number;
  leverage: number;
  margin: number;
  stopLoss: number | null;
  takeProfit: number | null;
  openedAt: number;
  source: PositionSource;
  fees: number;
  funding: number;
  nextFundingAt: number;
  markPrice: number;
}

interface PaperState {
  walletBalance: number;
  positions: PaperPosition[];
  startBalance: number;
}

/** Sensible defaults if exchangeInfo cannot be read (BTC/ETH USDⓈ-M values). */
export const FALLBACK_FILTERS: Record<TradingSymbol, SymbolFilters> = {
  BTCUSDT: { symbol: 'BTCUSDT', tickSize: 0.1, stepSize: 0.001, marketStepSize: 0.001, minQty: 0.001, marketMinQty: 0.001, marketMaxQty: 120, minNotional: 100 },
  ETHUSDT: { symbol: 'ETHUSDT', tickSize: 0.01, stepSize: 0.001, marketStepSize: 0.001, minQty: 0.001, marketMinQty: 0.001, marketMaxQty: 2000, minNotional: 20 }
};

export class PaperBroker implements Broker {
  readonly venue: ExecutionVenue = 'paper';
  private state: PaperState;
  private readonly filterMap: Partial<Record<TradingSymbol, SymbolFilters>> = {};

  constructor(
    private readonly opts: {
      startBalance: number;
      takerFeePct: number;
      slippageBps: number;
      persist?: Persist;
      now?: () => number;
      loadFilters?: (symbols: readonly TradingSymbol[]) => Promise<Record<string, SymbolFilters>>;
    }
  ) {
    const loaded = opts.persist?.load() as PaperState | undefined;
    this.state = loaded && typeof loaded.walletBalance === 'number' && Array.isArray(loaded.positions)
      ? loaded
      : { walletBalance: opts.startBalance, positions: [], startBalance: opts.startBalance };
  }

  private now(): number { return (this.opts.now ?? Date.now)(); }
  private save(): void { try { this.opts.persist?.save(this.state); } catch { /* best-effort */ } }

  /** Reset the simulated account (UI button). */
  reset(balance: number): void {
    this.state = { walletBalance: balance, positions: [], startBalance: balance };
    this.save();
  }

  async init(symbols: readonly TradingSymbol[]): Promise<void> {
    let loaded: Record<string, SymbolFilters> = {};
    try { loaded = this.opts.loadFilters ? await this.opts.loadFilters(symbols) : {}; } catch { /* fallback below */ }
    for (const s of symbols) this.filterMap[s] = loaded[s] ?? FALLBACK_FILTERS[s];
  }

  filters(symbol: TradingSymbol): SymbolFilters | null {
    return this.filterMap[symbol] ?? FALLBACK_FILTERS[symbol] ?? null;
  }

  private upnl(p: PaperPosition): number {
    return grossPnl(p.side, p.quantity, p.entryPrice, p.markPrice);
  }

  async account(): Promise<BrokerAccount> {
    const u = this.state.positions.reduce((a, p) => a + this.upnl(p), 0);
    const used = this.state.positions.reduce((a, p) => a + p.margin, 0);
    const equity = this.state.walletBalance + u;
    return { equity, walletBalance: this.state.walletBalance, available: Math.max(0, equity - used), unrealizedPnl: u };
  }

  async positions(): Promise<PositionView[]> {
    return this.state.positions.map((p) => ({
      symbol: p.symbol,
      side: p.side,
      quantity: p.quantity,
      entryPrice: p.entryPrice,
      markPrice: p.markPrice,
      leverage: p.leverage,
      unrealizedPnl: this.upnl(p),
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
      openedAt: p.openedAt,
      source: p.source
    }));
  }

  private fee(notional: number): number {
    return notional * (this.opts.takerFeePct / 100);
  }

  private slip(price: number, side: Side, opening: boolean): number {
    // Buying fills higher, selling lower. Opening a long buys; closing a long sells.
    const buy = (side === 'LONG') === opening;
    const s = this.opts.slippageBps / 10_000;
    return buy ? price * (1 + s) : price * (1 - s);
  }

  async open(plan: OrderPlan, source: PositionSource): Promise<PositionView> {
    if (this.state.positions.some((p) => p.symbol === plan.symbol)) throw new Error(`${plan.symbol} 포지션이 이미 있습니다`);
    const price = this.slip(plan.entryPrice, plan.side, true);
    const notional = price * plan.quantity;
    const margin = notional / plan.leverage;
    const acct = await this.account();
    const fee = this.fee(notional);
    if (margin + fee > acct.available) throw new Error(`증거금 부족: 필요 ${(margin + fee).toFixed(2)} / 가용 ${acct.available.toFixed(2)} USDT`);
    this.state.walletBalance -= fee;
    const now = this.now();
    const pos: PaperPosition = {
      symbol: plan.symbol,
      side: plan.side,
      quantity: plan.quantity,
      entryPrice: price,
      leverage: plan.leverage,
      margin,
      stopLoss: plan.stopLoss,
      takeProfit: plan.takeProfit,
      openedAt: now,
      source,
      fees: fee,
      funding: 0,
      nextFundingAt: 0,
      markPrice: price
    };
    this.state.positions.push(pos);
    this.save();
    return (await this.positions()).find((p) => p.symbol === plan.symbol)!;
  }

  private settle(p: PaperPosition, rawExit: number, reason: string, slipped = true): TradeView {
    const exit = slipped ? this.slip(rawExit, p.side, false) : rawExit;
    const exitFee = this.fee(exit * p.quantity);
    const gross = grossPnl(p.side, p.quantity, p.entryPrice, exit);
    // Entry fee and funding already moved the wallet when they happened.
    this.state.walletBalance += gross - exitFee;
    this.state.positions = this.state.positions.filter((x) => x !== p);
    this.save();
    return {
      id: tradeId(this.now()),
      symbol: p.symbol,
      side: p.side,
      source: p.source,
      quantity: p.quantity,
      entryPrice: p.entryPrice,
      exitPrice: exit,
      openedAt: p.openedAt,
      closedAt: this.now(),
      // Entry fee was already taken from the wallet at open; report the full round trip.
      pnl: gross - exitFee - p.fees - p.funding,
      fees: exitFee + p.fees + p.funding,
      exitReason: reason
    };
  }

  async sync(prices: Partial<Record<TradingSymbol, PriceTick>>): Promise<TradeView[]> {
    const closed: TradeView[] = [];
    const now = this.now();
    for (const p of [...this.state.positions]) {
      const t = prices[p.symbol];
      if (!t) continue;
      p.markPrice = t.mark || t.last;
      // Funding: settle once per crossed funding time.
      if (t.nextFundingTime) {
        if (!p.nextFundingAt) p.nextFundingAt = t.nextFundingTime;
        else if (now >= p.nextFundingAt && t.fundingRate !== undefined) {
          const pay = p.markPrice * p.quantity * t.fundingRate * (p.side === 'LONG' ? 1 : -1);
          p.funding += pay;
          this.state.walletBalance -= pay;
          p.nextFundingAt = t.nextFundingTime > p.nextFundingAt ? t.nextFundingTime : p.nextFundingAt + 8 * 3_600_000;
        }
      }
      const hi = Math.max(t.high, t.last);
      const lo = Math.min(t.low, t.last);
      const slHit = p.stopLoss !== null && (p.side === 'LONG' ? lo <= p.stopLoss : hi >= p.stopLoss);
      const tpHit = p.takeProfit !== null && (p.side === 'LONG' ? hi >= p.takeProfit : lo <= p.takeProfit);
      // Isolated liquidation (approx.): loss eats ~all of the margin.
      const liqLoss = -grossPnl(p.side, p.quantity, p.entryPrice, p.side === 'LONG' ? lo : hi);
      if (liqLoss >= p.margin * 0.95 && !slHit) {
        closed.push(this.settle(p, p.side === 'LONG' ? p.entryPrice - p.margin / p.quantity : p.entryPrice + p.margin / p.quantity, '강제 청산(모의)', false));
        continue;
      }
      if (slHit) closed.push(this.settle(p, p.stopLoss as number, '손절'));
      else if (tpHit) closed.push(this.settle(p, p.takeProfit as number, '익절'));
    }
    if (!closed.length) this.save();
    return closed;
  }

  async close(symbol: TradingSymbol, reason: string): Promise<TradeView | null> {
    const p = this.state.positions.find((x) => x.symbol === symbol);
    if (!p) return null;
    return this.settle(p, p.markPrice, reason);
  }

  async updateStops(symbol: TradingSymbol, stopLoss: number | null, takeProfit: number | null): Promise<void> {
    const p = this.state.positions.find((x) => x.symbol === symbol);
    if (!p) return;
    const tick = this.filters(symbol)?.tickSize ?? 0.01;
    if (stopLoss !== null) p.stopLoss = roundToStep(stopLoss, tick);
    if (takeProfit !== null) p.takeProfit = roundToStep(takeProfit, tick);
    this.save();
  }
}

// ─── binance (demo / live) ───────────────────────────────────────────────────

interface LiveMeta {
  symbol: TradingSymbol;
  side: Side;
  openedAt: number;
  source: PositionSource;
  leverage: number;
  stopLoss: number | null;
  takeProfit: number | null;
  entryPrice: number;
  quantity: number;
  /** Conditional orders this desk placed for the position (stop, target). */
  algoIds?: Array<number | string>;
}

/** Does an open conditional order CLOSE a position (as opposed to opening one)? */
export function isClosingAlgo(o: Record<string, unknown>): boolean {
  const flag = (v: unknown) => v === true || v === 'true';
  if (flag(o.reduceOnly) || flag(o.closePosition)) return true;
  const ps = String(o.positionSide ?? 'BOTH');
  return (ps === 'LONG' && o.side === 'SELL') || (ps === 'SHORT' && o.side === 'BUY');
}

export class BinanceBroker implements Broker {
  private filterMap: Record<string, SymbolFilters> = {};
  private hedge = false;
  private meta: Partial<Record<TradingSymbol, LiveMeta>> = {};

  constructor(
    readonly venue: ExecutionVenue,
    private readonly client: BinanceFuturesClient,
    private readonly opts: {
      marginType: 'ISOLATED' | 'CROSSED';
      defaultLeverage: number;
      persist?: Persist;
      now?: () => number;
      log?: (msg: string, level?: 'info' | 'warn' | 'error') => void;
      sleep?: (ms: number) => Promise<void>;
    }
  ) {
    const loaded = opts.persist?.load() as Partial<Record<TradingSymbol, LiveMeta>> | undefined;
    if (loaded && typeof loaded === 'object') this.meta = loaded;
  }

  private now(): number { return (this.opts.now ?? Date.now)(); }
  private save(): void { try { this.opts.persist?.save(this.meta); } catch { /* best-effort */ } }
  private log(msg: string, level: 'info' | 'warn' | 'error' = 'info'): void { this.opts.log?.(msg, level); }
  private sleep(ms: number): Promise<void> { return (this.opts.sleep ?? ((t) => new Promise((r) => setTimeout(r, t))))(ms); }

  async init(symbols: readonly TradingSymbol[]): Promise<void> {
    await this.client.syncTime();
    this.filterMap = await this.client.exchangeFilters(symbols);
    this.hedge = await this.client.isHedgeMode();
    if (this.hedge) this.log('계정이 헤지 모드입니다 — positionSide를 지정해 주문합니다', 'warn');
    for (const s of symbols) {
      try { await this.client.setMarginType(s, this.opts.marginType); } catch (e) {
        this.log(`${s} 마진 모드 설정 실패(포지션/주문이 남아 있으면 변경 불가): ${e instanceof Error ? e.message : e}`, 'warn');
      }
    }
  }

  filters(symbol: TradingSymbol): SymbolFilters | null {
    return this.filterMap[symbol] ?? FALLBACK_FILTERS[symbol] ?? null;
  }

  async account(): Promise<BrokerAccount> {
    const a = await this.client.account();
    return {
      equity: a.totalMarginBalance || a.totalWalletBalance + a.totalUnrealizedProfit,
      walletBalance: a.totalWalletBalance,
      available: a.availableBalance,
      unrealizedPnl: a.totalUnrealizedProfit
    };
  }

  async positions(): Promise<PositionView[]> {
    const rows = await this.client.positionRisk();
    const out: PositionView[] = [];
    for (const r of rows) {
      // Other symbols on the account still count toward equity, but they are
      // not the desk's to show or manage.
      if (!r.positionAmt || !(TRADING_SYMBOLS as readonly string[]).includes(r.symbol)) continue;
      const symbol = r.symbol as TradingSymbol;
      const side: Side = r.positionAmt > 0 ? 'LONG' : 'SHORT';
      const m = this.meta[symbol];
      const tracked = m && m.side === side;
      out.push({
        symbol,
        side,
        quantity: Math.abs(r.positionAmt),
        entryPrice: r.entryPrice,
        markPrice: r.markPrice,
        leverage: tracked ? m.leverage : this.opts.defaultLeverage,
        unrealizedPnl: r.unRealizedProfit,
        stopLoss: tracked ? m.stopLoss : null,
        takeProfit: tracked ? m.takeProfit : null,
        openedAt: tracked ? m.openedAt : r.updateTime,
        source: tracked ? m.source : 'manual'
      });
    }
    return out;
  }

  private sideParams(side: Side, closing: boolean): Record<string, string> {
    const orderSide = (side === 'LONG') !== closing ? 'BUY' : 'SELL';
    if (this.hedge) return { side: orderSide, positionSide: side };
    return closing ? { side: orderSide, reduceOnly: 'true' } : { side: orderSide };
  }

  /**
   * Reduce-only stop and target, triggered on the MARK price (wick-resistant).
   * priceProtect is deliberately left off: with it on, Binance may refuse to
   * trigger when last and mark diverge — exactly when a stop is needed.
   */
  private async placeStops(symbol: TradingSymbol, side: Side, qty: number, sl: number | null, tp: number | null): Promise<Array<number | string>> {
    const f = this.filters(symbol)!;
    const q = fmtParam(qty, f.stepSize);
    const ids: Array<number | string> = [];
    const idOf = (r: Record<string, unknown>) => {
      const id = r.algoId ?? r.clientAlgoId;
      if (typeof id === 'number' || typeof id === 'string') ids.push(id);
    };
    if (sl !== null) {
      idOf(await this.client.newAlgoOrder({
        symbol, type: 'STOP_MARKET', ...this.sideParams(side, true), quantity: q,
        triggerPrice: fmtParam(sl, f.tickSize), workingType: 'MARK_PRICE'
      }));
    }
    if (tp !== null) {
      try {
        idOf(await this.client.newAlgoOrder({
          symbol, type: 'TAKE_PROFIT_MARKET', ...this.sideParams(side, true), quantity: q,
          triggerPrice: fmtParam(tp, f.tickSize), workingType: 'MARK_PRICE'
        }));
      } catch (e) {
        // The stop is in place, so the position is protected; the target is a nicety.
        this.log(`${symbol} 익절 주문 실패(손절은 유지): ${e instanceof Error ? e.message : e}`, 'warn');
      }
    }
    return ids;
  }

  /** Cancel the conditional orders this desk placed for a position. */
  private async cancelOwn(symbol: TradingSymbol, m: LiveMeta | undefined): Promise<void> {
    for (const id of m?.algoIds ?? []) {
      try { await this.client.cancelAlgoOrder(symbol, id); } catch { /* already triggered or gone */ }
    }
    if (m) m.algoIds = [];
  }

  /**
   * With NO position on the symbol, any open closing-type conditional order is
   * stale — and dangerous, because it would act on the next position opened.
   * Cancel those; leave the user's own entry-type conditional orders alone.
   */
  private async sweepStale(symbol: TradingSymbol): Promise<void> {
    let open: Array<Record<string, unknown>> = [];
    try { open = await this.client.openAlgoOrders(symbol); } catch { return; }
    for (const o of open) {
      if (!isClosingAlgo(o) || o.algoId === undefined) continue;
      try { await this.client.cancelAlgoOrder(symbol, o.algoId as number); } catch { /* gone */ }
    }
  }

  async open(plan: OrderPlan, source: PositionSource): Promise<PositionView> {
    const { symbol, side } = plan;
    const f = this.filters(symbol)!;
    await this.sweepStale(symbol);
    await this.client.setLeverage(symbol, plan.leverage);
    const res = await this.client.newOrder({
      symbol, type: 'MARKET', ...this.sideParams(side, false),
      quantity: fmtParam(plan.quantity, f.marketStepSize), newOrderRespType: 'RESULT'
    });
    const filledQty = Number(res.executedQty ?? plan.quantity) || plan.quantity;
    const avg = Number(res.avgPrice ?? 0) || plan.entryPrice;
    // Re-anchor stop/target to the actual fill so slippage does not shrink the stop.
    const shift = avg - plan.entryPrice;
    const sl = roundToStep(plan.stopLoss + shift, f.tickSize);
    const tp = roundToStep(plan.takeProfit + shift, f.tickSize);
    let algoIds: Array<number | string> = [];
    try {
      algoIds = await this.placeStops(symbol, side, filledQty, sl, tp);
    } catch (e) {
      this.log(`${symbol} 손절 주문 실패 — 보호 없는 포지션을 두지 않기 위해 즉시 청산합니다: ${e instanceof Error ? e.message : e}`, 'error');
      try {
        await this.client.newOrder({ symbol, type: 'MARKET', ...this.sideParams(side, true), quantity: fmtParam(filledQty, f.marketStepSize) });
      } catch (e2) {
        this.log(`${symbol} 비상 청산도 실패했습니다. 바이낸스에서 직접 확인하세요: ${e2 instanceof Error ? e2.message : e2}`, 'error');
      }
      throw e;
    }
    this.meta[symbol] = { symbol, side, openedAt: this.now(), source, leverage: plan.leverage, stopLoss: sl, takeProfit: tp, entryPrice: avg, quantity: filledQty, algoIds };
    this.save();
    return {
      symbol, side, quantity: filledQty, entryPrice: avg, markPrice: avg, leverage: plan.leverage,
      unrealizedPnl: 0, stopLoss: sl, takeProfit: tp, openedAt: this.now(), source
    };
  }

  /** PnL of a position that just closed, from the account's own fills. */
  private async closedTrade(m: LiveMeta, reason: string, fallbackExit: number): Promise<TradeView> {
    let exit = fallbackExit;
    let pnl = grossPnl(m.side, m.quantity, m.entryPrice, exit);
    let fees = 0;
    try {
      await this.sleep(800);
      const fills = await this.client.userTrades(m.symbol, m.openedAt - 1000);
      const closeSide = m.side === 'LONG' ? 'SELL' : 'BUY';
      const closing = fills.filter((f) => f.side === closeSide);
      const q = closing.reduce((a, f) => a + f.qty, 0);
      if (q > 0) exit = closing.reduce((a, f) => a + f.price * f.qty, 0) / q;
      fees = fills.reduce((a, f) => a + f.commission, 0);
      const realized = fills.reduce((a, f) => a + f.realizedPnl, 0);
      pnl = (closing.length ? realized : grossPnl(m.side, m.quantity, m.entryPrice, exit)) - fees;
    } catch (e) {
      this.log(`${m.symbol} 체결 내역 조회 실패, 추정 손익을 사용합니다: ${e instanceof Error ? e.message : e}`, 'warn');
    }
    return {
      id: tradeId(this.now()), symbol: m.symbol, side: m.side, source: m.source, quantity: m.quantity,
      entryPrice: m.entryPrice, exitPrice: exit, openedAt: m.openedAt, closedAt: this.now(), pnl, fees, exitReason: reason
    };
  }

  async sync(prices: Partial<Record<TradingSymbol, PriceTick>>): Promise<TradeView[]> {
    const live = await this.positions();
    const closed: TradeView[] = [];
    for (const sym of Object.keys(this.meta) as TradingSymbol[]) {
      const m = this.meta[sym];
      if (!m) continue;
      const still = live.find((p) => p.symbol === sym && p.side === m.side);
      if (still) continue;
      // Gone: a stop or target fired on the exchange. Clear the leftover leg.
      await this.cancelOwn(sym, m);
      if (!live.some((p) => p.symbol === sym)) await this.sweepStale(sym);
      const t = prices[sym];
      const last = t?.last ?? m.entryPrice;
      const reason = m.stopLoss !== null && (m.side === 'LONG' ? last <= m.stopLoss * 1.002 : last >= m.stopLoss * 0.998)
        ? '손절'
        : m.takeProfit !== null && (m.side === 'LONG' ? last >= m.takeProfit * 0.998 : last <= m.takeProfit * 1.002)
          ? '익절'
          : '거래소에서 종료';
      closed.push(await this.closedTrade(m, reason, last));
      delete this.meta[sym];
      this.save();
    }
    return closed;
  }

  async close(symbol: TradingSymbol, reason: string): Promise<TradeView | null> {
    const pos = (await this.positions()).find((p) => p.symbol === symbol);
    await this.cancelOwn(symbol, this.meta[symbol]);
    if (!pos) { delete this.meta[symbol]; this.save(); await this.sweepStale(symbol); return null; }
    const f = this.filters(symbol)!;
    await this.client.newOrder({ symbol, type: 'MARKET', ...this.sideParams(pos.side, true), quantity: fmtParam(pos.quantity, f.marketStepSize) });
    await this.sweepStale(symbol);
    const m: LiveMeta = this.meta[symbol] ?? {
      symbol, side: pos.side, openedAt: pos.openedAt, source: pos.source, leverage: pos.leverage,
      stopLoss: null, takeProfit: null, entryPrice: pos.entryPrice, quantity: pos.quantity
    };
    const trade = await this.closedTrade(m, reason, pos.markPrice);
    delete this.meta[symbol];
    this.save();
    return trade;
  }

  async updateStops(symbol: TradingSymbol, stopLoss: number | null, takeProfit: number | null): Promise<void> {
    const m = this.meta[symbol];
    const pos = (await this.positions()).find((p) => p.symbol === symbol);
    if (!pos) return;
    const sl = stopLoss ?? m?.stopLoss ?? null;
    const tp = takeProfit ?? m?.takeProfit ?? null;
    await this.cancelOwn(symbol, m);
    try {
      const ids = await this.placeStops(symbol, pos.side, pos.quantity, sl, tp);
      if (m) { m.stopLoss = sl; m.takeProfit = tp; m.algoIds = ids; this.save(); }
    } catch (e) {
      // The old stop is already cancelled: put it back, or flatten.
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`${symbol} 손절 갱신 실패: ${msg}`, 'error');
      if (m && m.stopLoss !== null && m.stopLoss !== sl) {
        try {
          m.algoIds = await this.placeStops(symbol, pos.side, pos.quantity, m.stopLoss, m.takeProfit);
          this.save();
          throw new Error(`손절 갱신 실패 — 기존 손절(${m.stopLoss})을 다시 걸었습니다: ${msg}`);
        } catch (e2) {
          if (e2 instanceof Error && e2.message.startsWith('손절 갱신 실패')) throw e2;
        }
      }
      await this.close(symbol, '손절 주문 복구 실패로 청산');
      throw e;
    }
  }
}
