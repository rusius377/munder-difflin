"""Live market feed: order book, trade tape, closed candles, mark price & funding.

:class:`MarketFeed` runs in a background thread. With the ``websockets`` package it
multiplexes ``depth@100ms``, ``aggTrade``, ``kline_<tf>`` and ``markPrice@1s`` for
every symbol over one Binance combined stream and keeps each :class:`OrderBook`
synchronised the way the exchange documents it. Without ``websockets`` it falls
back to REST polling (depth snapshot + incremental aggTrades) so the desk still
works — just with a coarser tape.

The same interface is what :mod:`munder_trader.data.nautilus_bridge` fills when
``data.use_nautilus`` is on, so the rest of the engine never knows which feed is
underneath.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from collections import defaultdict
from typing import Callable

from ..util import now_ms
from .binance_rest import BinanceFuturesREST
from .orderbook import BookFeatures, OrderBook
from .tradeflow import TapeFeatures, Trade, TradeFlow

log = logging.getLogger(__name__)

BarCallback = Callable[[str, str, dict], None]


class MarketFeed:
    def __init__(
        self,
        rest: BinanceFuturesREST,
        symbols: list[str],
        *,
        ws_base: str = "wss://fstream.binance.com",
        kline_intervals: tuple[str, ...] = ("1m",),
        depth_speed: str = "100ms",
        tape_short_s: int = 30,
        tape_long_s: int = 300,
        poll_interval_s: float = 2.0,
        prefer_websocket: bool = True,
    ) -> None:
        self.rest = rest
        self.symbols = [s.upper() for s in symbols]
        self.ws_base = ws_base.rstrip("/")
        self.kline_intervals = kline_intervals
        self.depth_speed = depth_speed
        self.poll_interval_s = poll_interval_s
        self.books: dict[str, OrderBook] = {s: OrderBook(s) for s in self.symbols}
        self.tapes: dict[str, TradeFlow] = {s: TradeFlow(s, tape_short_s, tape_long_s) for s in self.symbols}
        self.mark: dict[str, dict] = defaultdict(dict)       # symbol → {mark, index, funding, next_funding}
        self.last_bar: dict[tuple[str, str], dict] = {}
        self._bar_callbacks: list[BarCallback] = []
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._needs_snapshot: set[str] = set(self.symbols)
        self._last_agg_id: dict[str, int] = {}
        self.mode = "idle"
        self.connected = False
        self.messages = 0
        self.last_message_ts = 0
        self.prefer_websocket = prefer_websocket

    # ------------------------------------------------------------------ public api
    def on_bar(self, cb: BarCallback) -> None:
        self._bar_callbacks.append(cb)

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        use_ws = False
        if self.prefer_websocket:
            try:
                import websockets  # noqa: F401

                use_ws = True
            except ImportError:
                log.warning("'websockets' not installed → REST polling feed (pip install websockets for L2 streams)")
        target = self._run_ws if use_ws else self._run_poll
        self.mode = "websocket" if use_ws else "polling"
        self._thread = threading.Thread(target=target, name="market-feed", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)

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
        with self._lock:
            return {
                "mode": self.mode,
                "connected": self.connected,
                "messages": self.messages,
                "last_message_age_s": (now_ms() - self.last_message_ts) / 1000 if self.last_message_ts else None,
                "books_synced": {s: b.synced for s, b in self.books.items()},
                "resyncs": {s: b.resync_count for s, b in self.books.items()},
            }

    # ------------------------------------------------------------------ event handling (shared)
    def handle_message(self, stream: str, data: dict) -> None:
        """Dispatch one combined-stream payload. Public so tests/bridges can inject events."""
        self.messages += 1
        self.last_message_ts = now_ms()
        sym = str(data.get("s", "")).upper() or stream.split("@")[0].upper()
        if sym not in self.books:
            return
        kind = stream.split("@", 1)[1] if "@" in stream else data.get("e", "")
        with self._lock:
            if kind.startswith("depth"):
                book = self.books[sym]
                if sym in self._needs_snapshot:
                    book.buffer(data)
                    return
                if not book.apply_diff(data):
                    self._needs_snapshot.add(sym)
                    book.buffer(data)
            elif kind == "aggTrade" or data.get("e") == "aggTrade":
                self.tapes[sym].add_agg(data)
            elif kind.startswith("kline") or data.get("e") == "kline":
                k = data.get("k", {})
                interval = k.get("i", "1m")
                bar = {
                    "open_time": int(k["t"]), "close_time": int(k["T"]), "open": float(k["o"]), "high": float(k["h"]),
                    "low": float(k["l"]), "close": float(k["c"]), "volume": float(k["v"]), "quote_volume": float(k["q"]),
                    "trades": int(k["n"]), "taker_buy_base": float(k["V"]), "taker_buy_quote": float(k["Q"]),
                    "closed": bool(k.get("x", False)),
                }
                self.last_bar[(sym, interval)] = bar
                if bar["closed"]:
                    cbs = list(self._bar_callbacks)
                else:
                    cbs = []
            elif kind.startswith("markPrice") or data.get("e") == "markPriceUpdate":
                self.mark[sym] = {
                    "mark": float(data.get("p", 0) or 0), "index": float(data.get("i", 0) or 0),
                    "funding": float(data.get("r", 0) or 0), "next_funding": int(data.get("T", 0) or 0),
                    "ts": int(data.get("E", 0) or 0),
                }
                return
            else:
                return
        if kind.startswith("kline") and bar["closed"]:
            for cb in cbs:
                try:
                    cb(sym, interval, bar)
                except Exception:  # pragma: no cover - user callback
                    log.exception("bar callback failed")

    def _resync_books(self) -> None:
        for sym in list(self._needs_snapshot):
            try:
                snap = self.rest.depth(sym, limit=1000)
            except Exception as exc:
                log.warning("depth snapshot failed for %s: %s", sym, exc)
                continue
            with self._lock:
                self.books[sym].apply_snapshot(snap)
                self._needs_snapshot.discard(sym)

    # ------------------------------------------------------------------ websocket loop
    def _stream_names(self) -> list[str]:
        names = []
        for s in self.symbols:
            ls = s.lower()
            names.append(f"{ls}@depth@{self.depth_speed}")
            names.append(f"{ls}@aggTrade")
            names.append(f"{ls}@markPrice@1s")
            for tf in self.kline_intervals:
                names.append(f"{ls}@kline_{tf}")
        return names

    def _run_ws(self) -> None:
        import asyncio

        async def main() -> None:
            import websockets

            url = f"{self.ws_base}/stream?streams={'/'.join(self._stream_names())}"
            backoff = 1.0
            while not self._stop.is_set():
                try:
                    async with websockets.connect(url, ping_interval=20, ping_timeout=20, max_size=2**22) as ws:
                        self.connected = True
                        backoff = 1.0
                        with self._lock:
                            self._needs_snapshot = set(self.symbols)
                        self._seed_tapes()
                        loop = asyncio.get_running_loop()
                        await loop.run_in_executor(None, self._resync_books)
                        last_resync = time.monotonic()
                        async for raw in ws:
                            if self._stop.is_set():
                                break
                            try:
                                msg = json.loads(raw)
                            except ValueError:
                                continue
                            stream = msg.get("stream", "")
                            data = msg.get("data", msg)
                            self.handle_message(stream, data)
                            if self._needs_snapshot and time.monotonic() - last_resync > 1.0:
                                last_resync = time.monotonic()
                                await loop.run_in_executor(None, self._resync_books)
                except Exception as exc:
                    self.connected = False
                    if self._stop.is_set():
                        break
                    log.warning("websocket feed error: %s (reconnect in %.0fs)", exc, backoff)
                    await asyncio.sleep(backoff)
                    backoff = min(30.0, backoff * 2)
            self.connected = False

        try:
            asyncio.run(main())
        except Exception:  # pragma: no cover
            log.exception("websocket feed crashed")
            self.connected = False

    def _seed_tapes(self) -> None:
        """Pre-fill the tape with recent REST trades so features exist immediately."""
        for sym in self.symbols:
            try:
                rows = self.rest.agg_trades(sym, limit=1000)
            except Exception as exc:
                log.debug("agg trade seed failed for %s: %s", sym, exc)
                continue
            with self._lock:
                self.tapes[sym].extend_rest(rows)
                if rows:
                    self._last_agg_id[sym] = int(rows[-1]["a"])

    # ------------------------------------------------------------------ polling fallback
    def _run_poll(self) -> None:
        self._seed_tapes()
        self.connected = True
        last_kline_check = 0.0
        while not self._stop.is_set():
            t0 = time.monotonic()
            for sym in self.symbols:
                try:
                    snap = self.rest.depth(sym, limit=100)
                    with self._lock:
                        self.books[sym].apply_snapshot(snap)
                        self.books[sym].synced = True
                    rows = self.rest.agg_trades(sym, limit=500, from_id=self._last_agg_id.get(sym))
                    with self._lock:
                        for r in rows:
                            if int(r["a"]) > self._last_agg_id.get(sym, -1):
                                self.tapes[sym].add(Trade.from_agg(r))
                                self._last_agg_id[sym] = int(r["a"])
                    pi = self.rest.premium_index(sym)
                    with self._lock:
                        self.mark[sym] = {"mark": float(pi.get("markPrice", 0)), "index": float(pi.get("indexPrice", 0)),
                                          "funding": float(pi.get("lastFundingRate", 0)),
                                          "next_funding": int(pi.get("nextFundingTime", 0)), "ts": int(pi.get("time", 0))}
                    self.messages += 1
                    self.last_message_ts = now_ms()
                except Exception as exc:
                    log.debug("poll error %s: %s", sym, exc)
            # closed candle detection via REST
            if time.monotonic() - last_kline_check > 5.0:
                last_kline_check = time.monotonic()
                for sym in self.symbols:
                    for tf in self.kline_intervals:
                        try:
                            rows = self.rest.klines(sym, tf, limit=2)
                        except Exception:
                            continue
                        if len(rows) < 2:
                            continue
                        r = rows[-2]
                        bar = {"open_time": int(r[0]), "close_time": int(r[6]), "open": float(r[1]), "high": float(r[2]),
                               "low": float(r[3]), "close": float(r[4]), "volume": float(r[5]), "quote_volume": float(r[7]),
                               "trades": int(r[8]), "taker_buy_base": float(r[9]), "taker_buy_quote": float(r[10]),
                               "closed": True}
                        key = (sym, tf)
                        prev = self.last_bar.get(key)
                        if prev is None or prev["open_time"] != bar["open_time"]:
                            self.last_bar[key] = bar
                            if prev is not None:
                                for cb in list(self._bar_callbacks):
                                    try:
                                        cb(sym, tf, bar)
                                    except Exception:  # pragma: no cover
                                        log.exception("bar callback failed")
            elapsed = time.monotonic() - t0
            self._stop.wait(max(0.2, self.poll_interval_s - elapsed))
        self.connected = False
