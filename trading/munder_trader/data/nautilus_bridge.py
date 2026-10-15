"""Optional nautilus_trader bridge: exchange-grade L2 book + tick feed and L2 replay.

Why both feeds exist
--------------------
:class:`munder_trader.data.stream.MarketFeed` talks to Binance directly and is
enough for most set-ups. nautilus_trader adds a Rust order-book engine with the
exact same semantics as the venue (managed books, delta/depth reconciliation,
gap detection, sequence recovery) and the ability to *replay* recorded depth and
trade data through the same code path as live trading. Turn it on with
``data.use_nautilus: true`` in ``settings.yaml`` after ``pip install nautilus_trader``.

This module targets the nautilus_trader v2 Python API (``LiveNode.builder``,
``BinanceDataClientConfig(product_type=BinanceProductType.USD_M)``,
``DataActor`` with ``subscribe_book_deltas`` / ``subscribe_trades``). The import
is lazy so the rest of the desk never depends on it.
"""

from __future__ import annotations

import logging
import threading
from typing import Callable

from ..symbols import meta_for
from ..util import now_ms
from .orderbook import BookFeatures, OrderBook
from .tradeflow import TapeFeatures, Trade, TradeFlow

log = logging.getLogger(__name__)

BarCallback = Callable[[str, str, dict], None]


def nautilus_available() -> bool:
    try:
        import nautilus_trader  # noqa: F401

        return True
    except ImportError:
        return False


def _levels(book, side: str, depth: int) -> list[tuple[float, float]]:
    """Extract ``[(price, size), ...]`` from a nautilus OrderBook, tolerant to API shape."""
    out: list[tuple[float, float]] = []
    fn = getattr(book, "bids" if side == "bid" else "asks", None)
    if fn is not None:
        try:
            levels = fn(depth) if depth else fn()
        except TypeError:
            levels = fn()
        for lvl in list(levels)[:depth] if depth else list(levels):
            price = getattr(lvl, "price", None)
            size = getattr(lvl, "size", None)
            try:
                p = float(price.as_double()) if hasattr(price, "as_double") else float(price)
                s = size() if callable(size) else size
                s = float(s.as_double()) if hasattr(s, "as_double") else float(s)
            except Exception:
                continue
            if s > 0:
                out.append((p, s))
    if not out:  # top-of-book fallback
        try:
            p = book.best_bid_price() if side == "bid" else book.best_ask_price()
            s = book.best_bid_size() if side == "bid" else book.best_ask_size()
            if p is not None and s is not None:
                out.append((float(p.as_double()) if hasattr(p, "as_double") else float(p),
                            float(s.as_double()) if hasattr(s, "as_double") else float(s)))
        except Exception:
            pass
    return out


class NautilusFeed:
    """Drop-in replacement for :class:`MarketFeed` backed by a nautilus ``LiveNode``."""

    def __init__(self, symbols: list[str], *, testnet: bool = False, api_key: str = "", api_secret: str = "",
                 book_depth: int = 50, tape_short_s: int = 30, tape_long_s: int = 300) -> None:
        self.symbols = [s.upper() for s in symbols]
        self.testnet = testnet
        self.api_key, self.api_secret = api_key, api_secret
        self.book_depth = book_depth
        self.books: dict[str, OrderBook] = {s: OrderBook(s) for s in self.symbols}
        self.tapes: dict[str, TradeFlow] = {s: TradeFlow(s, tape_short_s, tape_long_s) for s in self.symbols}
        self.mark: dict[str, dict] = {s: {} for s in self.symbols}
        self.last_bar: dict[tuple[str, str], dict] = {}
        self._bar_callbacks: list[BarCallback] = []
        self._lock = threading.RLock()
        self._thread: threading.Thread | None = None
        self._node = None
        self.mode = "nautilus"
        self.connected = False
        self.messages = 0
        self.last_message_ts = 0

    # same public surface as MarketFeed ------------------------------------------------
    def on_bar(self, cb: BarCallback) -> None:
        self._bar_callbacks.append(cb)

    def book_features(self, symbol: str, levels: int = 20) -> BookFeatures | None:
        with self._lock:
            return self.books[symbol.upper()].features(levels)

    def tape_features(self, symbol: str) -> TapeFeatures | None:
        with self._lock:
            return self.tapes[symbol.upper()].features()

    def mark_info(self, symbol: str) -> dict:
        with self._lock:
            return dict(self.mark.get(symbol.upper(), {}))

    def book(self, symbol: str) -> OrderBook:
        return self.books[symbol.upper()]

    def health(self) -> dict:
        return {"mode": self.mode, "connected": self.connected, "messages": self.messages,
                "last_message_age_s": (now_ms() - self.last_message_ts) / 1000 if self.last_message_ts else None,
                "books_synced": {s: b.synced for s, b in self.books.items()}}

    # ingestion from the actor ---------------------------------------------------------
    def _ingest_book(self, symbol: str, book) -> None:
        bids = _levels(book, "bid", self.book_depth)
        asks = _levels(book, "ask", self.book_depth)
        if not bids or not asks:
            return
        with self._lock:
            ob = self.books[symbol]
            ob.bids = {p: s for p, s in bids}
            ob.asks = {p: s for p, s in asks}
            ob.synced = True
            ob.ts = now_ms()
        self.messages += 1
        self.last_message_ts = now_ms()

    def _ingest_trade(self, symbol: str, tick) -> None:
        try:
            price = float(tick.price.as_double()) if hasattr(tick.price, "as_double") else float(tick.price)
            size = float(tick.size.as_double()) if hasattr(tick.size, "as_double") else float(tick.size)
            side = str(getattr(tick, "aggressor_side", ""))
            is_buy = "BUY" in side.upper()
            ts = int(getattr(tick, "ts_event", now_ms() * 1_000_000)) // 1_000_000
        except Exception:
            return
        with self._lock:
            self.tapes[symbol].add(Trade(ts=ts, price=price, qty=size, buyer_is_maker=not is_buy))
        self.messages += 1
        self.last_message_ts = now_ms()

    def _ingest_bar(self, symbol: str, bar) -> None:
        try:
            ts_ns = int(getattr(bar, "ts_event", 0))
            step = 60_000
            close_time = ts_ns // 1_000_000
            b = {"open_time": close_time - step + 1, "close_time": close_time,
                 "open": float(bar.open), "high": float(bar.high), "low": float(bar.low), "close": float(bar.close),
                 "volume": float(bar.volume), "quote_volume": float(bar.volume) * float(bar.close), "trades": 0,
                 "taker_buy_base": 0.0, "taker_buy_quote": 0.0, "closed": True}
        except Exception:
            return
        self.last_bar[(symbol, "1m")] = b
        for cb in list(self._bar_callbacks):
            try:
                cb(symbol, "1m", b)
            except Exception:  # pragma: no cover
                log.exception("bar callback failed")

    # node lifecycle ---------------------------------------------------------------------
    def start(self) -> None:
        if not nautilus_available():
            raise RuntimeError("nautilus_trader is not installed (pip install nautilus_trader)")
        self._thread = threading.Thread(target=self._run, name="nautilus-feed", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        node = self._node
        if node is not None:
            try:
                node.stop()
            except Exception:  # pragma: no cover
                pass
        if self._thread:
            self._thread.join(timeout=10)
        self.connected = False

    def _run(self) -> None:  # pragma: no cover - needs nautilus_trader + network
        from nautilus_trader.adapters.binance import (BinanceDataClientConfig, BinanceDataClientFactory,
                                                      BinanceEnvironment, BinanceProductType)
        from nautilus_trader.common import DataActor, Environment
        from nautilus_trader.config import DataActorConfig
        from nautilus_trader.live import LiveNode
        from nautilus_trader.model import BarType, BookType, InstrumentId, TraderId

        feed = self
        instrument_ids = [InstrumentId.from_str(meta_for(s).nautilus_id) for s in self.symbols]

        class DeskFeedConfig(DataActorConfig):
            def __init__(self, **_kwargs):
                super().__init__()

        class DeskFeedActor(DataActor):
            def on_start(self) -> None:
                for iid in instrument_ids:
                    self.subscribe_book_deltas(iid, BookType.L2_MBP, managed=True)
                    self.subscribe_trades(iid)
                    self.subscribe_bars(BarType.from_str(f"{iid}-1-MINUTE-LAST-EXTERNAL"))
                feed.connected = True

            def on_book_deltas(self, deltas) -> None:
                iid = deltas.instrument_id
                book = self.cache.order_book(iid)
                if book is not None:
                    feed._ingest_book(str(iid.symbol).split("-")[0], book)

            def on_trade(self, tick) -> None:
                feed._ingest_trade(str(tick.instrument_id.symbol).split("-")[0], tick)

            def on_bar(self, bar) -> None:
                feed._ingest_bar(str(bar.bar_type.instrument_id.symbol).split("-")[0], bar)

            def on_stop(self) -> None:
                feed.connected = False

        builder = LiveNode.builder("MUNDER-DESK-FEED", TraderId.from_str("MUNDER-001"), Environment.LIVE)
        builder = builder.add_data_client(
            None,
            BinanceDataClientFactory(),
            BinanceDataClientConfig(
                product_type=BinanceProductType.USD_M,
                environment=BinanceEnvironment.TESTNET if self.testnet else BinanceEnvironment.LIVE,
                api_key=self.api_key or None,
                api_secret=self.api_secret or None,
            ),
        )
        node = builder.build()
        node.add_actor(DeskFeedActor(DeskFeedConfig()))
        self._node = node
        try:
            node.run()
        except Exception:
            log.exception("nautilus node stopped")
        finally:
            self.connected = False


def replay_depth_csv(symbol: str, snapshot_csv: str, updates_csv: str, on_book: Callable[[OrderBook], None],
                     nrows: int | None = None) -> int:  # pragma: no cover - needs nautilus_trader
    """Replay recorded Binance depth CSVs (nautilus format) through our OrderBook; returns event count."""
    from nautilus_trader.adapters.binance import load_binance_order_book_deltas

    snap = load_binance_order_book_deltas(snapshot_csv, nrows=nrows)
    upd = load_binance_order_book_deltas(updates_csv, nrows=nrows)
    ob = OrderBook(symbol)
    count = 0
    for df in (snap, upd):
        for row in df.itertuples(index=False):
            side = str(getattr(row, "side", "")).upper()
            price = float(getattr(row, "price", 0))
            size = float(getattr(row, "size", 0))
            target = ob.bids if side.startswith("B") else ob.asks
            if size <= 0:
                target.pop(price, None)
            else:
                target[price] = size
            count += 1
            if count % 50 == 0:
                ob.synced = True
                on_book(ob)
    return count
