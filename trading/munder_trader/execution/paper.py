"""Paper broker — realistic simulated execution against live (or synthetic) prices.

Market tranches are filled by walking the live order book when one is
available (so size really costs slippage), otherwise at the last price plus a
slippage assumption. Resting limit tranches, stops, take-profits, liquidation
and funding are evaluated on every :meth:`poll` with the latest price band
(high/low since the previous poll), mirroring the backtester so paper results
and backtests speak the same language.
"""

from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

from ..learn.feedback import ClosedTrade
from ..strategy.plan import AccountState, OrderPlan, Position, TakeProfit
from ..symbols import SymbolFilters
from ..util import now_ms
from .base import Broker, BrokerEvent

log = logging.getLogger(__name__)

PriceSource = Callable[[str], dict | None]   # returns {"price", "high", "low", "ts", "book"?}


@dataclass
class _Pending:
    price: float
    qty: float
    note: str = ""


@dataclass
class PaperState:
    balance: float
    positions: dict[str, Position] = field(default_factory=dict)
    pending: dict[str, list[_Pending]] = field(default_factory=dict)
    decisions: dict[str, dict] = field(default_factory=dict)
    plans: dict[str, dict] = field(default_factory=dict)
    peak_equity: float = 0.0
    consecutive_losses: int = 0
    daily_pnl: float = 0.0
    last_funding_bucket: dict[str, int] = field(default_factory=dict)


class PaperBroker(Broker):
    name = "paper"

    def __init__(self, starting_balance: float, filters: dict[str, SymbolFilters], price_source: PriceSource, *,
                 taker_fee: float = 0.0005, maker_fee: float = 0.0002, slippage_bps: float = 1.5,
                 funding_source: Callable[[str], float] | None = None) -> None:
        self.state = PaperState(balance=starting_balance, peak_equity=starting_balance)
        self._filters = filters
        self.price_source = price_source
        self.taker_fee = taker_fee
        self.maker_fee = maker_fee
        self.slippage_bps = slippage_bps
        self.funding_source = funding_source
        self.events: list[BrokerEvent] = []
        self.closed: list[ClosedTrade] = []

    # ------------------------------------------------------------------ helpers
    def filters(self, symbol: str) -> SymbolFilters:
        return self._filters.get(symbol) or SymbolFilters(symbol)

    def _price(self, symbol: str) -> dict | None:
        try:
            return self.price_source(symbol)
        except Exception as exc:  # pragma: no cover
            log.debug("price source failed for %s: %s", symbol, exc)
            return None

    def mark_price(self, symbol: str) -> float | None:
        p = self._price(symbol)
        return float(p["price"]) if p else None

    def account(self) -> AccountState:
        st = self.state
        unreal = 0.0
        used = 0.0
        for sym, pos in st.positions.items():
            p = self._price(sym)
            if p:
                unreal += pos.unrealized(float(p["price"]))
            used += pos.margin
        equity = st.balance + unreal
        st.peak_equity = max(st.peak_equity, equity)
        return AccountState(equity=equity, available=max(0.0, st.balance - used), used_margin=used, positions=dict(st.positions),
                            daily_pnl=st.daily_pnl, peak_equity=st.peak_equity, consecutive_losses=st.consecutive_losses)

    # ------------------------------------------------------------------ orders
    def place_plan(self, plan: OrderPlan, *, decision: dict[str, Any] | None = None) -> Position | None:
        sym = plan.symbol
        if sym in self.state.positions:
            self._event("reject", sym, f"position already open on {sym}")
            return None
        p = self._price(sym)
        if not p:
            self._event("reject", sym, "no price available")
            return None
        price = float(p["price"])
        book = p.get("book")
        d = plan.direction
        market = [t for t in plan.tranches if t.kind == "market"]
        limits = [t for t in plan.tranches if t.kind == "limit"]
        qty0 = sum(t.qty for t in market) or plan.total_qty
        if book is not None and getattr(book, "synced", False):
            fill, filled = book.fill_price("BUY" if d > 0 else "SELL", qty0)
            if filled <= 0:
                fill = price * (1 + d * self.slippage_bps / 10_000)
        else:
            fill = price * (1 + d * self.slippage_bps / 10_000)
        fee = qty0 * fill * self.taker_fee
        margin = qty0 * fill / plan.leverage
        if margin + fee > self.state.balance:
            self._event("reject", sym, f"insufficient paper balance for margin {margin:.2f}")
            return None
        self.state.balance -= fee
        shift = fill - plan.entry_ref
        pos = Position(symbol=sym, side=plan.side, qty=qty0, entry_price=fill, leverage=plan.leverage, margin=margin,
                       stop=plan.stop + shift, take_profits=[TakeProfit(tp.price + shift, tp.fraction, tp.note) for tp in plan.take_profits],
                       mode=plan.mode, opened_ts=now_ms(), trail_atr=plan.trail_atr, atr=plan.atr,
                       time_stop_bars=plan.time_stop_bars, breakeven_after_r=plan.breakeven_after_r,
                       initial_risk=abs(fill - (plan.stop + shift)), fees_paid=fee, original_qty=qty0,
                       plan_id=str(uuid.uuid4())[:8], liquidation_price=plan.liquidation_est,
                       tags={"setup": plan.setup, "regime": plan.regime, "conviction": plan.conviction, "mfe_r": 0.0, "mae_r": 0.0,
                             "hold_bias": (decision or {}).get("hold_bias", "balanced")})
        self.state.positions[sym] = pos
        self.state.pending[sym] = [_Pending(t.price, t.qty, t.note) for t in limits]
        self.state.decisions[sym] = decision or {}
        self.state.plans[sym] = plan.to_dict()
        self._event("fill", sym, f"{plan.side} {qty0:g} @ {fill:.6g} lev {plan.leverage}x stop {pos.stop:.6g}", {"position": pos.to_dict()})
        return pos

    def update_stop(self, symbol: str, new_stop: float, reason: str = "") -> bool:
        pos = self.state.positions.get(symbol)
        if not pos:
            return False
        d = pos.direction
        if (d > 0 and new_stop <= pos.stop) or (d < 0 and new_stop >= pos.stop):
            return False
        pos.stop = new_stop
        pos.tags["be"] = True
        self._event("info", symbol, f"stop → {new_stop:.6g} ({reason})")
        return True

    def close_position(self, symbol: str, fraction: float = 1.0, reason: str = "") -> bool:
        pos = self.state.positions.get(symbol)
        p = self._price(symbol)
        if not pos or not p:
            return False
        price = float(p["price"]) * (1 - pos.direction * self.slippage_bps / 10_000)
        qty = pos.qty if fraction >= 0.999 else pos.qty * fraction
        self._exit(symbol, price, qty, reason or "manual", taker=True)
        return True

    def add_to_position(self, symbol: str, qty: float, reason: str = "") -> bool:
        pos = self.state.positions.get(symbol)
        p = self._price(symbol)
        if not pos or not p or qty <= 0:
            return False
        qty = self.filters(symbol).round_qty(qty)
        if qty <= 0:
            return False
        price = float(p["price"]) * (1 + pos.direction * self.slippage_bps / 10_000)
        fee = qty * price * self.taker_fee
        extra_margin = qty * price / pos.leverage
        if fee + extra_margin > self.state.balance - sum(x.margin for x in self.state.positions.values()):
            return False
        self.state.balance -= fee
        new_qty = pos.qty + qty
        pos.entry_price = (pos.entry_price * pos.qty + price * qty) / new_qty
        pos.qty = new_qty
        pos.original_qty += qty
        pos.fees_paid += fee
        pos.margin = pos.qty * pos.entry_price / pos.leverage
        pos.tags["pyramided"] = pos.tags.get("pyramided", 0) + 1
        self._event("fill", symbol, f"pyramid +{qty:g} @ {price:.6g} ({reason})")
        return True

    # ------------------------------------------------------------------ simulation
    def poll(self) -> list[BrokerEvent]:
        for sym in list(self.state.positions):
            p = self._price(sym)
            if not p:
                continue
            self._simulate(sym, float(p["price"]), float(p.get("high", p["price"])), float(p.get("low", p["price"])), int(p.get("ts", now_ms())))
        out, self.events = self.events, []
        return out

    def _simulate(self, sym: str, price: float, high: float, low: float, ts: int) -> None:
        pos = self.state.positions.get(sym)
        if not pos:
            return
        d = pos.direction
        # limit tranches
        still = []
        for pend in self.state.pending.get(sym, []):
            if (d > 0 and low <= pend.price) or (d < 0 and high >= pend.price):
                fee = pend.qty * pend.price * self.maker_fee
                self.state.balance -= fee
                new_qty = pos.qty + pend.qty
                pos.entry_price = (pos.entry_price * pos.qty + pend.price * pend.qty) / new_qty
                pos.qty = new_qty
                pos.original_qty += pend.qty
                pos.fees_paid += fee
                pos.margin = pos.qty * pos.entry_price / pos.leverage
                self._event("fill", sym, f"scale-in {pend.qty:g} @ {pend.price:.6g} ({pend.note})")
            else:
                still.append(pend)
        self.state.pending[sym] = still
        # liquidation (only if price trades beyond it — a resting stop would normally fire first; be conservative on gaps)
        liq = pos.liquidation_price
        if liq is not None and ((d > 0 and low <= liq and price <= pos.stop) or (d < 0 and high >= liq and price >= pos.stop)):
            self.state.pending[sym] = []
            self._exit(sym, liq, pos.qty, "liquidation", taker=True)
            return
        if (d > 0 and low <= pos.stop) or (d < 0 and high >= pos.stop):
            px = pos.stop * (1 - d * self.slippage_bps / 10_000)
            self.state.pending[sym] = []
            self._exit(sym, px, pos.qty, "breakeven_stop" if pos.tags.get("be") else "stop", taker=True)
            return
        remaining: list[TakeProfit] = []
        for tp in pos.take_profits:
            if sym not in self.state.positions:
                break
            if (d > 0 and high >= tp.price) or (d < 0 and low <= tp.price):
                is_last = tp is pos.take_profits[-1]
                qty = pos.qty if is_last else min(pos.qty, pos.original_qty * tp.fraction)
                self._exit(sym, tp.price, qty, "tp2" if is_last else "tp1", taker=False)
                if sym in self.state.positions and not is_last:
                    pos.tags["be"] = True
                    be = pos.entry_price + d * max(pos.atr * 0.1, pos.entry_price * 0.0003)
                    if (d > 0 and be > pos.stop) or (d < 0 and be < pos.stop):
                        pos.stop = be
            else:
                remaining.append(tp)
        if sym in self.state.positions:
            pos.take_profits = remaining
            if pos.initial_risk > 0:
                fav = (high - pos.entry_price) / pos.initial_risk if d > 0 else (pos.entry_price - low) / pos.initial_risk
                adv = (pos.entry_price - low) / pos.initial_risk if d > 0 else (high - pos.entry_price) / pos.initial_risk
                pos.tags["mfe_r"] = max(pos.tags.get("mfe_r", 0.0), fav)
                pos.tags["mae_r"] = max(pos.tags.get("mae_r", 0.0), adv)
            bucket = int(ts // (8 * 3_600_000))
            last = self.state.last_funding_bucket.get(sym)
            if last is None:
                self.state.last_funding_bucket[sym] = bucket
            elif bucket != last:
                self.state.last_funding_bucket[sym] = bucket
                rate = self.funding_source(sym) if self.funding_source else 0.0001
                fund = pos.qty * price * rate * (1 if d > 0 else -1)
                self.state.balance -= fund
                pos.funding_paid += fund

    def _exit(self, sym: str, price: float, qty: float, reason: str, *, taker: bool) -> None:
        pos = self.state.positions.get(sym)
        if not pos:
            return
        fee = qty * price * (self.taker_fee if taker else self.maker_fee)
        gross = (price - pos.entry_price) * qty * pos.direction
        self.state.balance += gross - fee
        self.state.daily_pnl += gross - fee
        pos.realized_pnl += gross
        pos.fees_paid += fee
        pos.qty -= qty
        full = pos.qty <= 1e-12 or reason in ("stop", "breakeven_stop", "liquidation", "time_stop", "take_quick", "manual", "tp2", "final", "kill")
        if not full:
            pos.tags["partials"] = pos.tags.get("partials", 0) + 1
            self._event("partial_tp", sym, f"{reason} {qty:g} @ {price:.6g} (+{gross - fee:.2f})")
            return
        if pos.qty > 1e-12:
            gross2 = (price - pos.entry_price) * pos.qty * pos.direction
            fee2 = pos.qty * price * (self.taker_fee if taker else self.maker_fee)
            self.state.balance += gross2 - fee2
            self.state.daily_pnl += gross2 - fee2
            pos.realized_pnl += gross2
            pos.fees_paid += fee2
            pos.qty = 0.0
        pnl = pos.realized_pnl - pos.fees_paid - pos.funding_paid
        r = pnl / (pos.initial_risk * pos.original_qty) if pos.initial_risk > 0 and pos.original_qty > 0 else 0.0
        bars = max(1, int((now_ms() - pos.opened_ts) / (60_000 if pos.mode == "scalp" else 3_600_000)))
        ct = ClosedTrade(symbol=sym, mode=pos.mode, side=pos.side, entry_price=pos.entry_price, exit_price=price,
                         qty=pos.original_qty, leverage=pos.leverage, pnl=pnl, r_multiple=r, bars_held=bars,
                         exit_reason=reason, mfe_r=pos.tags.get("mfe_r", 0.0), mae_r=pos.tags.get("mae_r", 0.0),
                         opened_ts=pos.opened_ts, closed_ts=now_ms(), decision=self.state.decisions.pop(sym, None),
                         plan=self.state.plans.pop(sym, None))
        self.state.consecutive_losses = self.state.consecutive_losses + 1 if pnl <= 0 else 0
        del self.state.positions[sym]
        self.state.pending.pop(sym, None)
        self.closed.append(ct)
        self._event("close", sym, f"{reason} @ {price:.6g} pnl {pnl:+.2f} ({r:+.2f}R)", closed_trade=ct)

    def _event(self, kind: str, sym: str, detail: str, data: dict | None = None, closed_trade: ClosedTrade | None = None) -> None:
        self.events.append(BrokerEvent(kind, sym, now_ms(), detail, data or {}, closed_trade))

    # ------------------------------------------------------------------ persistence
    def snapshot(self) -> dict:
        st = self.state
        return {"balance": st.balance, "peak_equity": st.peak_equity, "consecutive_losses": st.consecutive_losses,
                "daily_pnl": st.daily_pnl, "positions": {s: p.to_dict() for s, p in st.positions.items()},
                "pending": {s: [p.__dict__ for p in v] for s, v in st.pending.items()},
                "decisions": st.decisions, "plans": st.plans, "last_funding_bucket": st.last_funding_bucket, "ts": time.time()}

    def restore(self, snap: dict) -> None:
        st = self.state
        st.balance = float(snap.get("balance", st.balance))
        st.peak_equity = float(snap.get("peak_equity", st.balance))
        st.consecutive_losses = int(snap.get("consecutive_losses", 0))
        st.daily_pnl = float(snap.get("daily_pnl", 0.0))
        st.positions = {}
        for sym, pd_ in (snap.get("positions") or {}).items():
            tps = [TakeProfit(**tp) for tp in pd_.pop("take_profits", [])]
            st.positions[sym] = Position(take_profits=tps, **pd_)
        st.pending = {s: [_Pending(**p) for p in v] for s, v in (snap.get("pending") or {}).items()}
        st.decisions = dict(snap.get("decisions") or {})
        st.plans = dict(snap.get("plans") or {})
        st.last_funding_bucket = dict(snap.get("last_funding_bucket") or {})
