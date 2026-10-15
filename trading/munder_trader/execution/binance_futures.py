"""Binance USDⓈ-M futures broker (testnet or live).

Order mapping for an :class:`OrderPlan`:

* ``POST /fapi/v1/marginType`` ISOLATED and ``POST /fapi/v1/leverage`` per symbol
  (leverage chosen by the sizer, never above the configured cap),
* market tranche → ``MARKET``; scale-in tranches → ``LIMIT GTC``,
* protective stop → ``STOP_MARKET`` with ``closePosition=true`` on mark price
  (so it survives partial take-profits without resizing),
* TP1 → ``TAKE_PROFIT_MARKET`` ``reduceOnly`` for the partial quantity,
* TP2 → ``TAKE_PROFIT_MARKET`` ``closePosition=true``.

Every poll reconciles with ``positionRisk`` / ``openOrders`` so the engine
state matches the exchange even after a restart, and realised P&L of closed
positions is read from ``userTrades`` (``realizedPnl`` − ``commission``).

The broker is *one-way* position mode only; it switches the account to one-way
at start when it finds hedge mode and no open positions.
"""

from __future__ import annotations

import logging
import time
import uuid
from typing import Any

from ..data.binance_rest import BinanceAPIError, BinanceFuturesREST
from ..learn.feedback import ClosedTrade
from ..strategy.plan import AccountState, OrderPlan, Position, TakeProfit
from ..symbols import SymbolFilters
from ..util import now_ms
from .base import Broker, BrokerEvent

log = logging.getLogger(__name__)


def load_filters(rest: BinanceFuturesREST, symbols: list[str], *, with_brackets: bool = True) -> dict[str, SymbolFilters]:
    info = rest.exchange_info()
    wanted = {s.upper() for s in symbols}
    out: dict[str, SymbolFilters] = {}
    for row in info.get("symbols", []):
        if row.get("symbol") in wanted:
            out[row["symbol"]] = SymbolFilters.from_exchange_info(row)
    missing = wanted - set(out)
    for m in missing:
        log.warning("symbol %s not found in exchangeInfo (delisted or not yet listed?) — using defaults", m)
        out[m] = SymbolFilters(m)
    if with_brackets and rest.has_keys:
        try:
            rows = rest.leverage_bracket()
            for row in rows if isinstance(rows, list) else [rows]:
                sym = row.get("symbol")
                if sym in out:
                    out[sym].apply_brackets(row.get("brackets", []))
        except BinanceAPIError as exc:
            log.warning("leverage brackets unavailable (%s); using exchangeInfo defaults", exc)
    return out


class BinanceFuturesBroker(Broker):
    name = "binance"

    def __init__(self, rest: BinanceFuturesREST, symbols: list[str], *, isolated: bool = True,
                 taker_fee: float = 0.0005, maker_fee: float = 0.0002, client_prefix: str = "mt") -> None:
        if not rest.has_keys:
            raise RuntimeError("Binance API key/secret are required for the futures broker")
        self.rest = rest
        self.symbols = [s.upper() for s in symbols]
        self.isolated = isolated
        self.taker_fee = taker_fee
        self.maker_fee = maker_fee
        self.prefix = client_prefix
        self._filters: dict[str, SymbolFilters] = {}
        self.positions: dict[str, Position] = {}
        self.decisions: dict[str, dict] = {}
        self.plans: dict[str, dict] = {}
        self.stop_orders: dict[str, int] = {}
        self.events: list[BrokerEvent] = []
        self.closed: list[ClosedTrade] = []
        self._lev_cache: dict[str, int] = {}
        self._margin_cache: dict[str, bool] = {}
        self._last_reconcile = 0.0
        self._equity_peak = 0.0
        self._consecutive_losses = 0
        self._daily_pnl = 0.0
        self.name = "binance-testnet" if "testnet" in rest.base_url else "binance-live"
        self._prepare()

    # ------------------------------------------------------------------ setup
    def _prepare(self) -> None:
        self.rest.sync_time()
        self._filters = load_filters(self.rest, self.symbols)
        try:
            mode = self.rest.position_mode()
            if mode.get("dualSidePosition") in (True, "true"):
                if not [p for p in self.rest.position_risk() if abs(float(p.get("positionAmt", 0))) > 0]:
                    self.rest.set_position_mode(False)
                    log.info("switched account to one-way position mode")
                else:
                    log.warning("account is in hedge mode with open positions; the broker expects one-way mode")
        except BinanceAPIError as exc:
            log.warning("could not verify position mode: %s", exc)
        self.reconcile(force=True)

    def filters(self, symbol: str) -> SymbolFilters:
        return self._filters.get(symbol.upper()) or SymbolFilters(symbol.upper())

    def _client_id(self, tag: str) -> str:
        return f"{self.prefix}_{tag}_{uuid.uuid4().hex[:10]}"[:36]

    # ------------------------------------------------------------------ account
    def account(self) -> AccountState:
        acct = self.rest.account()
        equity = float(acct.get("totalMarginBalance", acct.get("totalWalletBalance", 0.0)))
        available = float(acct.get("availableBalance", 0.0))
        used = float(acct.get("totalInitialMargin", acct.get("totalPositionInitialMargin", 0.0)))
        self._equity_peak = max(self._equity_peak, equity)
        return AccountState(equity=equity, available=available, used_margin=used, positions=dict(self.positions),
                            daily_pnl=self._daily_pnl, peak_equity=self._equity_peak, consecutive_losses=self._consecutive_losses)

    def mark_price(self, symbol: str) -> float | None:
        try:
            return float(self.rest.premium_index(symbol)["markPrice"])
        except Exception:
            return None

    # ------------------------------------------------------------------ orders
    def _ensure_leverage(self, symbol: str, leverage: int) -> int:
        if self._margin_cache.get(symbol) is None:
            try:
                self.rest.change_margin_type(symbol, self.isolated)
            except BinanceAPIError as exc:
                log.warning("margin type change failed for %s: %s", symbol, exc)
            self._margin_cache[symbol] = True
        if self._lev_cache.get(symbol) != leverage:
            resp = self.rest.change_leverage(symbol, leverage)
            leverage = int(resp.get("leverage", leverage))
            self._lev_cache[symbol] = leverage
        return leverage

    def place_plan(self, plan: OrderPlan, *, decision: dict[str, Any] | None = None) -> Position | None:
        sym = plan.symbol
        f = self.filters(sym)
        if sym in self.positions:
            self._event("reject", sym, "position already open")
            return None
        side = "BUY" if plan.direction > 0 else "SELL"
        close_side = "SELL" if plan.direction > 0 else "BUY"
        try:
            lev = self._ensure_leverage(sym, plan.leverage)
            market = [t for t in plan.tranches if t.kind == "market"]
            limits = [t for t in plan.tranches if t.kind == "limit"]
            qty0 = f.round_qty(sum(t.qty for t in market) or plan.total_qty)
            if qty0 < f.min_qty:
                self._event("reject", sym, f"qty {qty0} below minQty")
                return None
            resp = self.rest.new_order(symbol=sym, side=side, type="MARKET", quantity=qty0,
                                       newClientOrderId=self._client_id("entry"), newOrderRespType="RESULT")
            fill = float(resp.get("avgPrice") or 0.0) or float(resp.get("price") or 0.0)
            if fill <= 0:
                fill = self.mark_price(sym) or plan.entry_ref
            filled_qty = float(resp.get("executedQty") or qty0)
            shift = fill - plan.entry_ref
            stop = f.round_price(plan.stop + shift)
            tps = [TakeProfit(f.round_price(tp.price + shift), tp.fraction, tp.note) for tp in plan.take_profits]
            # protective stop first
            so = self.rest.new_order(symbol=sym, side=close_side, type="STOP_MARKET", stopPrice=stop, closePosition="true",
                                     workingType="MARK_PRICE", priceProtect="TRUE", newClientOrderId=self._client_id("stop"))
            self.stop_orders[sym] = int(so.get("orderId", 0))
            total_qty = filled_qty + sum(t.qty for t in limits)
            for i, tp in enumerate(tps):
                is_last = i == len(tps) - 1
                if is_last:
                    self.rest.new_order(symbol=sym, side=close_side, type="TAKE_PROFIT_MARKET", stopPrice=tp.price, closePosition="true",
                                        workingType="CONTRACT_PRICE", newClientOrderId=self._client_id("tp2"))
                else:
                    q = f.round_qty(total_qty * tp.fraction)
                    if q >= f.min_qty:
                        self.rest.new_order(symbol=sym, side=close_side, type="TAKE_PROFIT_MARKET", stopPrice=tp.price, quantity=q,
                                            reduceOnly="true", workingType="CONTRACT_PRICE", newClientOrderId=self._client_id("tp1"))
            for t in limits:
                q = f.round_qty(t.qty)
                if q >= f.min_qty:
                    self.rest.new_order(symbol=sym, side=side, type="LIMIT", timeInForce="GTC", price=f.round_price(t.price),
                                        quantity=q, newClientOrderId=self._client_id("scale"))
        except BinanceAPIError as exc:
            log.error("order placement failed for %s: %s", sym, exc)
            self._event("reject", sym, f"binance error {exc.code}: {exc.msg}")
            try:
                self.rest.cancel_all(sym)
            except Exception:
                pass
            return None
        pos = Position(symbol=sym, side=plan.side, qty=filled_qty, entry_price=fill, leverage=lev, margin=filled_qty * fill / lev,
                       stop=stop, take_profits=tps, mode=plan.mode, opened_ts=now_ms(), trail_atr=plan.trail_atr, atr=plan.atr,
                       time_stop_bars=plan.time_stop_bars, breakeven_after_r=plan.breakeven_after_r, initial_risk=abs(fill - stop),
                       original_qty=filled_qty, plan_id=str(uuid.uuid4())[:8], liquidation_price=plan.liquidation_est,
                       tags={"setup": plan.setup, "regime": plan.regime, "conviction": plan.conviction, "mfe_r": 0.0, "mae_r": 0.0,
                             "hold_bias": (decision or {}).get("hold_bias", "balanced")})
        self.positions[sym] = pos
        self.decisions[sym] = decision or {}
        self.plans[sym] = plan.to_dict()
        self._event("fill", sym, f"{plan.side} {filled_qty:g} @ {fill:.6g} lev {lev}x stop {stop:.6g}", {"position": pos.to_dict()})
        return pos

    def update_stop(self, symbol: str, new_stop: float, reason: str = "") -> bool:
        pos = self.positions.get(symbol)
        if not pos:
            return False
        f = self.filters(symbol)
        new_stop = f.round_price(new_stop)
        d = pos.direction
        if (d > 0 and new_stop <= pos.stop) or (d < 0 and new_stop >= pos.stop):
            return False
        close_side = "SELL" if d > 0 else "BUY"
        try:
            so = self.rest.new_order(symbol=symbol, side=close_side, type="STOP_MARKET", stopPrice=new_stop, closePosition="true",
                                     workingType="MARK_PRICE", priceProtect="TRUE", newClientOrderId=self._client_id("stop"))
            old = self.stop_orders.get(symbol)
            if old:
                try:
                    self.rest.cancel_order(symbol, order_id=old)
                except BinanceAPIError as exc:
                    if exc.code != -2011:  # unknown order (already gone)
                        raise
            self.stop_orders[symbol] = int(so.get("orderId", 0))
        except BinanceAPIError as exc:
            log.error("stop update failed for %s: %s", symbol, exc)
            return False
        pos.stop = new_stop
        pos.tags["be"] = True
        self._event("info", symbol, f"stop → {new_stop:.6g} ({reason})")
        return True

    def close_position(self, symbol: str, fraction: float = 1.0, reason: str = "") -> bool:
        pos = self.positions.get(symbol)
        if not pos:
            return False
        f = self.filters(symbol)
        close_side = "SELL" if pos.direction > 0 else "BUY"
        qty = f.round_qty(pos.qty if fraction >= 0.999 else pos.qty * fraction)
        try:
            if fraction >= 0.999:
                self.rest.cancel_all(symbol)
            self.rest.new_order(symbol=symbol, side=close_side, type="MARKET", quantity=qty, reduceOnly="true",
                                newClientOrderId=self._client_id("close"))
        except BinanceAPIError as exc:
            log.error("close failed for %s: %s", symbol, exc)
            return False
        pos.tags["close_reason"] = reason
        self._event("info", symbol, f"close {fraction:.0%} ({reason})")
        return True

    def add_to_position(self, symbol: str, qty: float, reason: str = "") -> bool:
        pos = self.positions.get(symbol)
        if not pos or qty <= 0:
            return False
        f = self.filters(symbol)
        qty = f.round_qty(qty)
        if qty < f.min_qty:
            return False
        side = "BUY" if pos.direction > 0 else "SELL"
        try:
            resp = self.rest.new_order(symbol=symbol, side=side, type="MARKET", quantity=qty,
                                       newClientOrderId=self._client_id("pyr"), newOrderRespType="RESULT")
        except BinanceAPIError as exc:
            log.error("pyramid order failed for %s: %s", symbol, exc)
            return False
        fill = float(resp.get("avgPrice") or 0.0) or (self.mark_price(symbol) or pos.entry_price)
        filled = float(resp.get("executedQty") or qty)
        new_qty = pos.qty + filled
        pos.entry_price = (pos.entry_price * pos.qty + fill * filled) / new_qty
        pos.qty = new_qty
        pos.original_qty += filled
        pos.margin = pos.qty * pos.entry_price / pos.leverage
        pos.tags["pyramided"] = pos.tags.get("pyramided", 0) + 1
        self._event("fill", symbol, f"pyramid +{filled:g} @ {fill:.6g} ({reason})")
        return True

    # ------------------------------------------------------------------ reconciliation
    def reconcile(self, force: bool = False) -> None:
        if not force and time.time() - self._last_reconcile < 5.0:
            return
        self._last_reconcile = time.time()
        rows = self.rest.position_risk()
        live: dict[str, dict] = {}
        for r in rows:
            amt = float(r.get("positionAmt", 0) or 0)
            if abs(amt) > 0 and r.get("symbol") in self.symbols:
                live[r["symbol"]] = r
        # positions that vanished on the exchange → closed
        for sym in list(self.positions):
            if sym not in live:
                self._on_closed(sym)
        # positions on the exchange we do not know (restart / manual) → adopt
        for sym, r in live.items():
            amt = float(r["positionAmt"])
            if sym not in self.positions:
                entry = float(r.get("entryPrice", 0) or 0)
                lev = int(float(r.get("leverage", 1) or 1))
                liq = float(r.get("liquidationPrice", 0) or 0) or None
                side = "LONG" if amt > 0 else "SHORT"
                stop = entry * (1 - 0.02 if amt > 0 else 1 + 0.02)
                pos = Position(symbol=sym, side=side, qty=abs(amt), entry_price=entry, leverage=lev,
                               margin=float(r.get("isolatedMargin", 0) or abs(amt) * entry / lev), stop=stop, take_profits=[],
                               mode="swing", opened_ts=int(r.get("updateTime", now_ms())), initial_risk=abs(entry - stop),
                               original_qty=abs(amt), liquidation_price=liq, tags={"adopted": True, "mfe_r": 0.0, "mae_r": 0.0})
                self.positions[sym] = pos
                self._event("info", sym, f"adopted existing {side} {abs(amt):g} @ {entry:.6g} from the exchange")
                try:
                    open_orders = self.rest.open_orders(sym)
                    for o in open_orders:
                        if o.get("type") == "STOP_MARKET":
                            pos.stop = float(o.get("stopPrice", pos.stop))
                            self.stop_orders[sym] = int(o.get("orderId", 0))
                except BinanceAPIError:
                    pass
            else:
                pos = self.positions[sym]
                pos.qty = abs(amt)
                pos.entry_price = float(r.get("entryPrice", pos.entry_price) or pos.entry_price)
                pos.liquidation_price = float(r.get("liquidationPrice", 0) or 0) or pos.liquidation_price
                if pos.qty > pos.original_qty:
                    pos.original_qty = pos.qty

    def _on_closed(self, sym: str) -> None:
        pos = self.positions.pop(sym)
        pnl, fees = 0.0, 0.0
        exit_price = pos.entry_price
        try:
            trades = self.rest.user_trades(sym, limit=200, start_ms=max(0, pos.opened_ts - 60_000))
            for tr in trades:
                pnl += float(tr.get("realizedPnl", 0) or 0)
                fees += float(tr.get("commission", 0) or 0)
                exit_price = float(tr.get("price", exit_price) or exit_price)
        except BinanceAPIError as exc:
            log.warning("userTrades unavailable for %s: %s", sym, exc)
        try:
            self.rest.cancel_all(sym)
        except BinanceAPIError:
            pass
        net = pnl - fees
        r = net / (pos.initial_risk * pos.original_qty) if pos.initial_risk > 0 and pos.original_qty > 0 else 0.0
        reason = pos.tags.get("close_reason") or ("stop" if (pos.direction > 0 and exit_price <= pos.stop) or (pos.direction < 0 and exit_price >= pos.stop) else "take_profit")
        bars = max(1, int((now_ms() - pos.opened_ts) / (60_000 if pos.mode == "scalp" else 3_600_000)))
        ct = ClosedTrade(symbol=sym, mode=pos.mode, side=pos.side, entry_price=pos.entry_price, exit_price=exit_price,
                         qty=pos.original_qty, leverage=pos.leverage, pnl=net, r_multiple=r, bars_held=bars, exit_reason=reason,
                         mfe_r=pos.tags.get("mfe_r", 0.0), mae_r=pos.tags.get("mae_r", 0.0), opened_ts=pos.opened_ts,
                         closed_ts=now_ms(), decision=self.decisions.pop(sym, None), plan=self.plans.pop(sym, None))
        self._consecutive_losses = self._consecutive_losses + 1 if net <= 0 else 0
        self._daily_pnl += net
        self.stop_orders.pop(sym, None)
        self.closed.append(ct)
        self._event("close", sym, f"{reason} @ {exit_price:.6g} pnl {net:+.2f} ({r:+.2f}R)", closed_trade=ct)

    def poll(self) -> list[BrokerEvent]:
        try:
            self.reconcile()
            for sym, pos in self.positions.items():
                mp = self.mark_price(sym)
                if mp and pos.initial_risk > 0:
                    d = pos.direction
                    fav = (mp - pos.entry_price) * d / pos.initial_risk
                    pos.tags["mfe_r"] = max(pos.tags.get("mfe_r", 0.0), fav)
                    pos.tags["mae_r"] = max(pos.tags.get("mae_r", 0.0), -fav)
        except BinanceAPIError as exc:
            log.warning("reconcile failed: %s", exc)
        out, self.events = self.events, []
        return out

    def reset_daily(self) -> None:
        self._daily_pnl = 0.0

    def _event(self, kind: str, sym: str, detail: str, data: dict | None = None, closed_trade: ClosedTrade | None = None) -> None:
        self.events.append(BrokerEvent(kind, sym, now_ms(), detail, data or {}, closed_trade))

    def shutdown(self) -> None:
        return None
