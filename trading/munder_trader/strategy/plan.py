"""Order plans, positions and account snapshots shared by every layer."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class EntryTranche:
    price: float          # limit price (market tranche uses the signal entry)
    fraction: float       # share of total quantity
    kind: str = "market"  # market | limit
    qty: float = 0.0      # resolved by the sizer
    note: str = ""


@dataclass
class TakeProfit:
    price: float
    fraction: float       # share of position to close at this level
    note: str = ""


@dataclass
class OrderPlan:
    symbol: str
    mode: str
    side: str                     # LONG | SHORT
    entry_ref: float
    stop: float
    tranches: list[EntryTranche]
    take_profits: list[TakeProfit]
    leverage: int
    total_qty: float
    notional: float
    margin: float
    risk_amount: float
    risk_pct: float
    conviction: float
    trail_atr: float
    atr: float
    time_stop_bars: int
    breakeven_after_r: float
    setup: str
    regime: str
    reasons: list[str] = field(default_factory=list)
    tags: dict[str, Any] = field(default_factory=dict)
    liquidation_est: float | None = None

    @property
    def direction(self) -> int:
        return 1 if self.side == "LONG" else -1

    @property
    def risk_per_unit(self) -> float:
        return abs(self.entry_ref - self.stop)

    def to_dict(self) -> dict:
        d = self.__dict__.copy()
        d["tranches"] = [t.__dict__ for t in self.tranches]
        d["take_profits"] = [t.__dict__ for t in self.take_profits]
        return d


@dataclass
class Position:
    symbol: str
    side: str
    qty: float
    entry_price: float
    leverage: int
    margin: float
    stop: float
    take_profits: list[TakeProfit]
    mode: str = "swing"
    opened_ts: int = 0
    bars_held: int = 0
    trail_atr: float = 0.0
    atr: float = 0.0
    time_stop_bars: int = 0
    breakeven_after_r: float = 0.8
    initial_risk: float = 0.0        # price distance of the original stop
    realized_pnl: float = 0.0
    fees_paid: float = 0.0
    funding_paid: float = 0.0
    peak_price: float = 0.0
    trough_price: float = 0.0
    plan_id: str = ""
    tags: dict[str, Any] = field(default_factory=dict)
    liquidation_price: float | None = None
    original_qty: float = 0.0

    @property
    def direction(self) -> int:
        return 1 if self.side == "LONG" else -1

    def unrealized(self, price: float) -> float:
        return (price - self.entry_price) * self.qty * self.direction

    def r_multiple(self, price: float) -> float:
        if self.initial_risk <= 0:
            return 0.0
        return (price - self.entry_price) * self.direction / self.initial_risk

    def notional(self, price: float) -> float:
        return self.qty * price

    def to_dict(self) -> dict:
        d = self.__dict__.copy()
        d["take_profits"] = [t.__dict__ for t in self.take_profits]
        return d


@dataclass
class AccountState:
    equity: float
    available: float
    used_margin: float
    positions: dict[str, Position] = field(default_factory=dict)
    daily_pnl: float = 0.0
    peak_equity: float = 0.0
    consecutive_losses: int = 0

    @property
    def margin_fraction(self) -> float:
        return self.used_margin / self.equity if self.equity > 0 else 1.0
