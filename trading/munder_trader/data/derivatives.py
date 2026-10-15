"""Derivatives context for the Fundamentals / Sentiment analysts (cached, rate-limit friendly)."""

from __future__ import annotations

import logging
import time
from typing import Any

import requests

from ..util import now_ms
from .binance_rest import BinanceFuturesREST

log = logging.getLogger(__name__)


class DerivativesContext:
    def __init__(self, rest: BinanceFuturesREST, ttl_s: float = 300.0) -> None:
        self.rest = rest
        self.ttl = ttl_s
        self._cache: dict[str, tuple[float, dict[str, Any]]] = {}

    def get(self, symbol: str, *, mark_info: dict | None = None) -> dict[str, Any]:
        symbol = symbol.upper()
        cached = self._cache.get(symbol)
        if cached and time.time() - cached[0] < self.ttl:
            out = dict(cached[1])
        else:
            out = self._fetch(symbol)
            self._cache[symbol] = (time.time(), out)
            out = dict(out)
        if mark_info:
            if mark_info.get("funding") is not None:
                out["funding_rate"] = float(mark_info["funding"])
            if mark_info.get("mark") and mark_info.get("index"):
                out["basis_bps"] = (float(mark_info["mark"]) - float(mark_info["index"])) / float(mark_info["index"]) * 10_000
            if mark_info.get("next_funding"):
                out["minutes_to_funding"] = max(0.0, (int(mark_info["next_funding"]) - now_ms()) / 60_000)
        return out

    def _fetch(self, symbol: str) -> dict[str, Any]:
        out: dict[str, Any] = {}
        try:
            pi = self.rest.premium_index(symbol)
            out["funding_rate"] = float(pi.get("lastFundingRate", 0) or 0)
            mark, index = float(pi.get("markPrice", 0) or 0), float(pi.get("indexPrice", 0) or 0)
            if mark and index:
                out["basis_bps"] = (mark - index) / index * 10_000
            if pi.get("nextFundingTime"):
                out["minutes_to_funding"] = max(0.0, (int(pi["nextFundingTime"]) - now_ms()) / 60_000)
        except Exception as exc:
            log.debug("premiumIndex failed %s: %s", symbol, exc)
        try:
            hist = self.rest.open_interest_hist(symbol, period="15m", limit=9)   # ~2 hours
            if len(hist) >= 2:
                first, last = float(hist[0]["sumOpenInterest"]), float(hist[-1]["sumOpenInterest"])
                out["oi_change_pct"] = (last - first) / first * 100 if first else 0.0
                out["open_interest"] = last
            kl = self.rest.klines(symbol, "15m", limit=9)
            if len(kl) >= 2:
                o, c = float(kl[0][1]), float(kl[-1][4])
                out["price_change_pct"] = (c - o) / o * 100 if o else 0.0
        except Exception as exc:
            log.debug("open interest failed %s: %s", symbol, exc)
        try:
            ls = self.rest.long_short_ratio(symbol, period="15m", limit=1)
            if ls:
                out["long_short_ratio"] = float(ls[-1]["longShortRatio"])
        except Exception as exc:
            log.debug("long/short ratio failed %s: %s", symbol, exc)
        try:
            tk = self.rest.taker_ratio(symbol, period="15m", limit=1)
            if tk:
                out["taker_buy_sell_ratio"] = float(tk[-1]["buySellRatio"])
        except Exception as exc:
            log.debug("taker ratio failed %s: %s", symbol, exc)
        return out


class FearGreed:
    """Crypto Fear & Greed index (alternative.me). Optional; failures return ``None``."""

    URL = "https://api.alternative.me/fng/?limit=1"

    def __init__(self, ttl_s: float = 900.0, session: Any | None = None) -> None:
        self.ttl = ttl_s
        self.session = session or requests.Session()
        self._val: float | None = None
        self._ts = 0.0

    def get(self) -> float | None:
        if time.time() - self._ts < self.ttl:
            return self._val
        self._ts = time.time()
        try:
            r = self.session.get(self.URL, timeout=8)
            data = r.json()
            self._val = float(data["data"][0]["value"])
        except Exception as exc:
            log.debug("fear & greed unavailable: %s", exc)
            self._val = None
        return self._val
