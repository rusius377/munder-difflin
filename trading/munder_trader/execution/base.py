"""Broker interface shared by the paper and Binance brokers."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from ..learn.feedback import ClosedTrade
from ..strategy.plan import AccountState, OrderPlan, Position
from ..symbols import SymbolFilters


@dataclass
class BrokerEvent:
    kind: str                  # fill | partial_tp | stop | close | reject | info
    symbol: str
    ts: int
    detail: str
    data: dict[str, Any] = field(default_factory=dict)
    closed_trade: ClosedTrade | None = None


class Broker(ABC):
    name = "broker"

    @abstractmethod
    def account(self) -> AccountState: ...

    @abstractmethod
    def filters(self, symbol: str) -> SymbolFilters: ...

    @abstractmethod
    def place_plan(self, plan: OrderPlan, *, decision: dict[str, Any] | None = None) -> Position | None: ...

    @abstractmethod
    def update_stop(self, symbol: str, new_stop: float, reason: str = "") -> bool: ...

    @abstractmethod
    def close_position(self, symbol: str, fraction: float = 1.0, reason: str = "") -> bool: ...

    @abstractmethod
    def poll(self) -> list[BrokerEvent]:
        """Advance the broker (paper: simulate fills; live: reconcile) and return what happened."""

    def add_to_position(self, symbol: str, qty: float, reason: str = "") -> bool:  # pragma: no cover - optional
        """Pyramid into a winning position at market (same side)."""
        return False

    def mark_price(self, symbol: str) -> float | None:  # pragma: no cover - optional
        return None

    def shutdown(self) -> None:  # pragma: no cover - optional
        return None
