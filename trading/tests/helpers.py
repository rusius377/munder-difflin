"""Shared test fixtures (no network, no API keys)."""

from __future__ import annotations

import numpy as np
import pandas as pd

from munder_trader.config import Settings
from munder_trader.symbols import SymbolFilters
from munder_trader.util import interval_ms


def eth_filters() -> SymbolFilters:
    f = SymbolFilters("ETHUSDT", tick_size=0.01, step_size=0.001, min_qty=0.001, min_notional=5, price_precision=2, qty_precision=3)
    f.apply_brackets([
        {"notionalCap": 50_000, "initialLeverage": 125, "maintMarginRatio": 0.004, "cum": 0},
        {"notionalCap": 500_000, "initialLeverage": 100, "maintMarginRatio": 0.005, "cum": 50},
        {"notionalCap": 2_000_000, "initialLeverage": 50, "maintMarginRatio": 0.01, "cum": 2550},
    ])
    return f


def settings() -> Settings:
    return Settings()


def path_frame(closes: list[float], interval: str = "1m", start_ms: int = 1_700_000_000_000, wick: float = 0.0) -> pd.DataFrame:
    """OHLCV frame following an explicit close path (open = previous close)."""
    step = interval_ms(interval)
    n = len(closes)
    opens = [closes[0]] + closes[:-1]
    highs = [max(o, c) * (1 + wick) for o, c in zip(opens, closes)]
    lows = [min(o, c) * (1 - wick) for o, c in zip(opens, closes)]
    ot = np.arange(n) * step + start_ms
    df = pd.DataFrame({
        "open_time": ot.astype("int64"), "open": opens, "high": highs, "low": lows, "close": closes,
        "volume": [1000.0] * n, "close_time": (ot + step - 1).astype("int64"), "quote_volume": [1000.0 * c for c in closes],
        "trades": [100] * n, "taker_buy_base": [500.0] * n, "taker_buy_quote": [500.0 * c for c in closes],
    })
    df.index = pd.to_datetime(df["open_time"], unit="ms", utc=True)
    df.index.name = "time"
    return df


def with_signal_columns(df: pd.DataFrame, *, at: int, direction: int, stop: float, tp1: float, tp2: float,
                        strength: float = 0.8, setup: int = 5, atr: float = 1.0) -> pd.DataFrame:
    """Attach precomputed signal/indicator columns with a single signal at row ``at``."""
    n = len(df)
    out = df.copy()
    out["sig_dir"] = 0
    out["sig_strength"] = 0.0
    out["sig_setup"] = 0
    out["sig_stop"] = np.nan
    out["sig_tp1"] = np.nan
    out["sig_tp2"] = np.nan
    out.iloc[at, out.columns.get_loc("sig_dir")] = direction
    out.iloc[at, out.columns.get_loc("sig_strength")] = strength
    out.iloc[at, out.columns.get_loc("sig_setup")] = setup
    out.iloc[at, out.columns.get_loc("sig_stop")] = stop
    out.iloc[at, out.columns.get_loc("sig_tp1")] = tp1
    out.iloc[at, out.columns.get_loc("sig_tp2")] = tp2
    out["atr"] = atr
    out["adx"] = 10.0
    out["ema_fast_slope"] = 0.0
    out["rsi"] = 50.0
    out["regime"] = "range"
    out["sig_trail_atr"] = 1.0
    return out


class FakeResponse:
    def __init__(self, status: int, payload, headers: dict | None = None) -> None:
        self.status_code = status
        self._payload = payload
        self.headers = headers or {}
        self.text = str(payload)

    def json(self):
        return self._payload


class FakeSession:
    """Records requests and replays scripted responses."""

    def __init__(self, responses: list[FakeResponse] | None = None) -> None:
        self.responses = list(responses or [])
        self.calls: list[dict] = []

    def request(self, method, url, params=None, headers=None, timeout=None):
        self.calls.append({"method": method, "url": url, "params": dict(params or {}), "headers": dict(headers or {})})
        if self.responses:
            return self.responses.pop(0)
        return FakeResponse(200, {})
