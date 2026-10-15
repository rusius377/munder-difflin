"""Historical kline download + on-disk cache.

``HistoryStore.get(symbol, interval, days)`` returns a clean OHLCV ``DataFrame``
indexed by UTC timestamps. Downloads are incremental: only the gap after the last
cached candle is fetched, so the 24/7 learner can refresh 120 days of 1m data for
seven symbols without hammering the API.

The same module also builds *synthetic* series (``synthetic_ohlcv``) so the whole
pipeline — signals, backtests, optimizer, agents — can be exercised and unit
tested offline, which the CI job and ``munder-trader selftest`` rely on.
"""

from __future__ import annotations

import logging
import math
from pathlib import Path

import numpy as np
import pandas as pd

from ..util import interval_ms, now_ms
from .binance_rest import BinanceFuturesREST

log = logging.getLogger(__name__)

KLINE_COLUMNS = [
    "open_time", "open", "high", "low", "close", "volume", "close_time", "quote_volume",
    "trades", "taker_buy_base", "taker_buy_quote",
]


def klines_to_frame(rows: list[list]) -> pd.DataFrame:
    if not rows:
        return pd.DataFrame(columns=KLINE_COLUMNS).set_index(pd.DatetimeIndex([], name="time"))
    arr = [r[:11] for r in rows]
    df = pd.DataFrame(arr, columns=KLINE_COLUMNS)
    for c in ("open", "high", "low", "close", "volume", "quote_volume", "taker_buy_base", "taker_buy_quote"):
        df[c] = pd.to_numeric(df[c], errors="coerce").astype(float)
    df["open_time"] = df["open_time"].astype("int64")
    df["close_time"] = df["close_time"].astype("int64")
    df["trades"] = pd.to_numeric(df["trades"], errors="coerce").fillna(0).astype("int64")
    df.index = pd.to_datetime(df["open_time"], unit="ms", utc=True)
    df.index.name = "time"
    df = df[~df.index.duplicated(keep="last")].sort_index()
    return df


class HistoryStore:
    def __init__(self, rest: BinanceFuturesREST | None, cache_dir: str | Path = "data") -> None:
        self.rest = rest
        self.cache_dir = Path(cache_dir)   # created lazily on first save

    def _path(self, symbol: str, interval: str) -> Path:
        return self.cache_dir / f"{symbol.upper()}_{interval}.csv.gz"

    def load_cached(self, symbol: str, interval: str) -> pd.DataFrame:
        p = self._path(symbol, interval)
        if not p.exists():
            return klines_to_frame([])
        try:
            df = pd.read_csv(p, compression="gzip")
            df.index = pd.to_datetime(df["open_time"], unit="ms", utc=True)
            df.index.name = "time"
            return df[~df.index.duplicated(keep="last")].sort_index()
        except Exception as exc:  # corrupted cache → rebuild
            log.warning("cache %s unreadable (%s); ignoring", p, exc)
            return klines_to_frame([])

    def save(self, symbol: str, interval: str, df: pd.DataFrame) -> None:
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        p = self._path(symbol, interval)
        df.reset_index(drop=True).to_csv(p, index=False, compression="gzip")

    def fetch_range(self, symbol: str, interval: str, start_ms: int, end_ms: int | None = None) -> pd.DataFrame:
        if self.rest is None:
            raise RuntimeError("no REST client configured for history download")
        end_ms = end_ms or now_ms()
        step = interval_ms(interval)
        frames: list[pd.DataFrame] = []
        cursor = start_ms
        while cursor < end_ms:
            rows = self.rest.klines(symbol, interval, start_ms=cursor, end_ms=end_ms, limit=1500)
            if not rows:
                break
            frames.append(klines_to_frame(rows))
            last_open = int(rows[-1][0])
            nxt = last_open + step
            if nxt <= cursor:
                break
            cursor = nxt
            if len(rows) < 1500:
                break
        if not frames:
            return klines_to_frame([])
        df = pd.concat(frames)
        return df[~df.index.duplicated(keep="last")].sort_index()

    def get(self, symbol: str, interval: str, days: int = 60, *, refresh: bool = True,
            drop_open_candle: bool = True) -> pd.DataFrame:
        """Cached + incremental history for ``days`` back from now."""
        step = interval_ms(interval)
        want_start = now_ms() - days * 86_400_000
        df = self.load_cached(symbol, interval)
        if refresh and self.rest is not None:
            if df.empty or int(df["open_time"].iloc[0]) > want_start + step:
                start = want_start
            else:
                start = int(df["open_time"].iloc[-1]) + step
            try:
                fresh = self.fetch_range(symbol, interval, start)
                if not fresh.empty:
                    df = pd.concat([df, fresh]) if not df.empty else fresh
                    df = df[~df.index.duplicated(keep="last")].sort_index()
                    self.save(symbol, interval, df)
            except Exception as exc:
                log.warning("history refresh failed for %s %s: %s", symbol, interval, exc)
        if df.empty:
            return df
        df = df[df["open_time"] >= want_start]
        if drop_open_candle and not df.empty:
            if int(df["close_time"].iloc[-1]) > now_ms():
                df = df.iloc[:-1]
        return df


# --------------------------------------------------------------------------------
# Synthetic data for offline runs / tests
# --------------------------------------------------------------------------------

def synthetic_ohlcv(n: int = 3000, interval: str = "1m", start_price: float = 100.0, seed: int | None = 7,
                    regime: str = "mixed", start_ms: int | None = None) -> pd.DataFrame:
    """Regime-switching GBM with volatility clustering, volume bursts and realistic wicks."""
    rng = np.random.default_rng(seed)
    step = interval_ms(interval)
    start_ms = start_ms if start_ms is not None else now_ms() - n * step
    base_sigma = {"1m": 0.0009, "3m": 0.0015, "5m": 0.002, "15m": 0.0035, "30m": 0.005,
                  "1h": 0.007, "4h": 0.014, "1d": 0.03}.get(interval, 0.005)
    prices = np.empty(n + 1)
    prices[0] = start_price
    sigma = base_sigma
    drift = 0.0
    regime_len = 0
    opens = np.empty(n); highs = np.empty(n); lows = np.empty(n); closes = np.empty(n); vols = np.empty(n)
    for i in range(n):
        if regime_len <= 0:
            regime_len = int(rng.integers(60, 400))
            if regime == "trend":
                drift = rng.choice([-1, 1]) * base_sigma * 0.35
            elif regime == "range":
                drift = 0.0
            else:
                drift = rng.choice([-1.0, 0.0, 0.0, 1.0]) * base_sigma * 0.3
            sigma = base_sigma * float(rng.uniform(0.6, 1.8))
        regime_len -= 1
        # GARCH-ish volatility persistence
        sigma = 0.92 * sigma + 0.08 * base_sigma * float(rng.uniform(0.5, 2.0))
        r = drift + sigma * float(rng.standard_normal())
        # mean reversion in range regimes keeps price bounded
        if regime == "range":
            r -= 0.02 * math.log(prices[i] / start_price)
        o = prices[i]
        c = o * math.exp(r)
        wick = abs(r) * float(rng.uniform(0.2, 1.2)) + sigma * 0.3
        h = max(o, c) * (1 + wick * float(rng.uniform(0.2, 1.0)))
        l = min(o, c) * (1 - wick * float(rng.uniform(0.2, 1.0)))
        v = float(rng.lognormal(mean=math.log(1000), sigma=0.5)) * (1 + 6 * abs(r) / base_sigma * 0.1)
        opens[i], highs[i], lows[i], closes[i], vols[i] = o, h, l, c, v
        prices[i + 1] = c
    open_time = start_ms + np.arange(n) * step
    df = pd.DataFrame({
        "open_time": open_time.astype("int64"),
        "open": opens, "high": highs, "low": lows, "close": closes, "volume": vols,
        "close_time": (open_time + step - 1).astype("int64"),
        "quote_volume": vols * closes,
        "trades": (vols / 3).astype("int64"),
        "taker_buy_base": vols * np.clip(0.5 + np.sign(closes - opens) * 0.1 + rng.normal(0, 0.05, n), 0.1, 0.9),
    })
    df["taker_buy_quote"] = df["taker_buy_base"] * closes
    df.index = pd.to_datetime(df["open_time"], unit="ms", utc=True)
    df.index.name = "time"
    return df


def resample_ohlcv(df: pd.DataFrame, interval: str) -> pd.DataFrame:
    """Aggregate a lower-timeframe frame to ``interval`` (e.g. 1m → 5m / 1h)."""
    if df.empty:
        return df
    rule = {"1m": "1min", "3m": "3min", "5m": "5min", "15m": "15min", "30m": "30min", "1h": "1h", "2h": "2h",
            "4h": "4h", "6h": "6h", "8h": "8h", "12h": "12h", "1d": "1D"}[interval]
    agg = {
        "open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum",
        "quote_volume": "sum", "trades": "sum", "taker_buy_base": "sum", "taker_buy_quote": "sum",
    }
    cols = {k: v for k, v in agg.items() if k in df.columns}
    out = df.resample(rule, label="left", closed="left").agg(cols).dropna(subset=["open"])
    out["open_time"] = (out.index.astype("int64") // 1_000_000).astype("int64")
    out["close_time"] = out["open_time"] + interval_ms(interval) - 1
    return out
