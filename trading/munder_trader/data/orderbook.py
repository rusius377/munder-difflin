"""Level-2 order book with Binance diff-depth synchronisation and microstructure features.

The sync protocol follows Binance's USDⓈ-M documentation exactly:

1. buffer ``<symbol>@depth@100ms`` events;
2. fetch a ``/fapi/v1/depth?limit=1000`` snapshot with ``lastUpdateId``;
3. drop buffered events whose ``u < lastUpdateId``;
4. the first applied event must satisfy ``U <= lastUpdateId <= u``;
5. every following event must have ``pu == previous u`` or the book resyncs.

``OrderBook.features(levels)`` returns what the scalping desk reasons about:
spread, micro-price, multi-level imbalance, depth in quote currency, liquidity
walls, and an estimated fill price for a given order size (used by the paper
broker for realistic slippage).
"""

from __future__ import annotations

import heapq
import statistics
from dataclasses import dataclass, field
from typing import Iterable


@dataclass
class BookFeatures:
    symbol: str
    ts: int
    best_bid: float
    best_ask: float
    mid: float
    spread_bps: float
    microprice: float
    imbalance_1: float          # (bid - ask) / (bid + ask) at best level
    imbalance_n: float          # same over N levels (size-weighted)
    bid_depth_quote: float      # quote value resting within N levels
    ask_depth_quote: float
    bid_wall: tuple[float, float] | None   # (price, qty) of the largest bid level within N
    ask_wall: tuple[float, float] | None
    bid_slope: float            # cumulative depth per bp on the bid side
    ask_slope: float
    levels: int
    synced: bool

    def pressure(self) -> float:
        """Signed book pressure in [-1, 1]; positive favours buyers."""
        return 0.6 * self.imbalance_n + 0.4 * self.imbalance_1

    def to_dict(self) -> dict:
        d = self.__dict__.copy()
        d["pressure"] = self.pressure()
        return d


class OrderBook:
    def __init__(self, symbol: str, max_levels: int = 1000) -> None:
        self.symbol = symbol.upper()
        self.max_levels = max_levels
        self.bids: dict[float, float] = {}
        self.asks: dict[float, float] = {}
        self.last_update_id: int = 0
        self.synced: bool = False
        self.ts: int = 0
        self._buffer: list[dict] = []
        self._last_u: int | None = None
        self.resync_count = 0

    # ------------------------------------------------------------------ sync protocol
    def apply_snapshot(self, snapshot: dict) -> None:
        self.bids = {float(p): float(q) for p, q in snapshot.get("bids", []) if float(q) > 0}
        self.asks = {float(p): float(q) for p, q in snapshot.get("asks", []) if float(q) > 0}
        self.last_update_id = int(snapshot.get("lastUpdateId", 0))
        self.ts = int(snapshot.get("E", snapshot.get("T", self.ts)) or self.ts)
        self._last_u = None
        self.synced = False
        buffered, self._buffer = self._buffer, []
        for ev in buffered:
            self.apply_diff(ev)

    def buffer(self, event: dict) -> None:
        self._buffer.append(event)
        if len(self._buffer) > 5000:
            del self._buffer[:-5000]

    def apply_diff(self, event: dict) -> bool:
        """Apply a depth diff event. Returns ``False`` when a resync is required."""
        U, u = int(event["U"]), int(event["u"])
        if u < self.last_update_id:
            return True  # stale
        if not self.synced:
            if U <= self.last_update_id <= u:
                self.synced = True
            else:
                return True  # wait for the bridging event
        else:
            pu = event.get("pu")
            if pu is not None and self._last_u is not None and int(pu) != self._last_u:
                self.synced = False
                self.resync_count += 1
                self._last_u = None
                return False
        self._apply_levels(self.bids, event.get("b", []))
        self._apply_levels(self.asks, event.get("a", []))
        self._last_u = u
        self.last_update_id = u
        self.ts = int(event.get("E", event.get("T", self.ts)) or self.ts)
        return True

    @staticmethod
    def _apply_levels(side: dict[float, float], levels: Iterable) -> None:
        for p, q in levels:
            price, qty = float(p), float(q)
            if qty <= 0:
                side.pop(price, None)
            else:
                side[price] = qty

    # ------------------------------------------------------------------ views
    def best_bid(self) -> float | None:
        return max(self.bids) if self.bids else None

    def best_ask(self) -> float | None:
        return min(self.asks) if self.asks else None

    def top(self, n: int = 20) -> tuple[list[tuple[float, float]], list[tuple[float, float]]]:
        bids = heapq.nlargest(n, self.bids.items(), key=lambda kv: kv[0])
        asks = heapq.nsmallest(n, self.asks.items(), key=lambda kv: kv[0])
        return bids, asks

    def mid(self) -> float | None:
        b, a = self.best_bid(), self.best_ask()
        if b is None or a is None:
            return None
        return (a + b) / 2.0

    def fill_price(self, side: str, qty: float) -> tuple[float, float]:
        """Walk the book for a market order. Returns ``(avg_price, filled_qty)``."""
        levels = sorted(self.asks.items()) if side.upper() == "BUY" else sorted(self.bids.items(), reverse=True)
        remaining, cost, filled = qty, 0.0, 0.0
        for price, size in levels:
            take = min(size, remaining)
            cost += take * price
            filled += take
            remaining -= take
            if remaining <= 1e-12:
                break
        if filled <= 0:
            ref = self.best_ask() if side.upper() == "BUY" else self.best_bid()
            return (ref or 0.0, 0.0)
        return (cost / filled, filled)

    def features(self, levels: int = 20) -> BookFeatures | None:
        bids, asks = self.top(levels)
        if not bids or not asks:
            return None
        bb, ba = bids[0][0], asks[0][0]
        mid = (bb + ba) / 2.0
        spread_bps = (ba - bb) / mid * 10_000 if mid > 0 else 0.0
        bq1, aq1 = bids[0][1], asks[0][1]
        micro = (bb * aq1 + ba * bq1) / (bq1 + aq1) if (bq1 + aq1) > 0 else mid
        imb1 = (bq1 - aq1) / (bq1 + aq1) if (bq1 + aq1) > 0 else 0.0
        # distance-weighted imbalance: nearer levels matter more
        wb = sum(q / (1 + i) for i, (_, q) in enumerate(bids))
        wa = sum(q / (1 + i) for i, (_, q) in enumerate(asks))
        imb_n = (wb - wa) / (wb + wa) if (wb + wa) > 0 else 0.0
        bid_depth = sum(p * q for p, q in bids)
        ask_depth = sum(p * q for p, q in asks)
        med_b = statistics.median([q for _, q in bids]) if bids else 0.0
        med_a = statistics.median([q for _, q in asks]) if asks else 0.0
        bid_wall = max(bids, key=lambda pq: pq[1])
        ask_wall = max(asks, key=lambda pq: pq[1])
        bid_wall_t = bid_wall if med_b > 0 and bid_wall[1] >= 4 * med_b else None
        ask_wall_t = ask_wall if med_a > 0 and ask_wall[1] >= 4 * med_a else None
        bid_span_bps = max(1e-9, (mid - bids[-1][0]) / mid * 10_000)
        ask_span_bps = max(1e-9, (asks[-1][0] - mid) / mid * 10_000)
        return BookFeatures(
            symbol=self.symbol, ts=self.ts, best_bid=bb, best_ask=ba, mid=mid, spread_bps=spread_bps,
            microprice=micro, imbalance_1=imb1, imbalance_n=imb_n, bid_depth_quote=bid_depth,
            ask_depth_quote=ask_depth, bid_wall=bid_wall_t, ask_wall=ask_wall_t,
            bid_slope=bid_depth / bid_span_bps, ask_slope=ask_depth / ask_span_bps,
            levels=min(len(bids), len(asks)), synced=self.synced,
        )


@dataclass
class SyntheticBook:
    """Deterministic book generator for tests / offline paper trading."""

    symbol: str
    mid: float
    tick: float = 0.01
    depth_levels: int = 25
    base_qty: float = 10.0
    skew: float = 0.0   # >0 → heavier bids
    _ts: int = field(default=0)

    def snapshot(self, ts: int | None = None) -> dict:
        self._ts = ts if ts is not None else self._ts + 100
        bids, asks = [], []
        for i in range(1, self.depth_levels + 1):
            bq = self.base_qty * (1 + self.skew) * (1 + 0.15 * i)
            aq = self.base_qty * (1 - self.skew) * (1 + 0.15 * i)
            bids.append([f"{self.mid - i * self.tick:.8f}", f"{bq:.6f}"])
            asks.append([f"{self.mid + i * self.tick:.8f}", f"{aq:.6f}"])
        return {"lastUpdateId": self._ts, "E": self._ts, "bids": bids, "asks": asks}

    def book(self) -> OrderBook:
        ob = OrderBook(self.symbol)
        ob.apply_snapshot(self.snapshot())
        ob.synced = True
        return ob
