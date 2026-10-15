"""Small shared helpers: time, maths, json, logging."""

from __future__ import annotations

import json
import logging
import math
import time
from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone
from enum import Enum
from typing import Any

INTERVAL_MS: dict[str, int] = {
    "1m": 60_000,
    "3m": 180_000,
    "5m": 300_000,
    "15m": 900_000,
    "30m": 1_800_000,
    "1h": 3_600_000,
    "2h": 7_200_000,
    "4h": 14_400_000,
    "6h": 21_600_000,
    "8h": 28_800_000,
    "12h": 43_200_000,
    "1d": 86_400_000,
}


def interval_ms(interval: str) -> int:
    try:
        return INTERVAL_MS[interval]
    except KeyError as exc:
        raise ValueError(f"unsupported interval {interval!r}") from exc


def now_ms() -> int:
    return int(time.time() * 1000)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso(ts_ms: int | float | None = None) -> str:
    if ts_ms is None:
        return utc_now().isoformat(timespec="seconds")
    return datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).isoformat(timespec="seconds")


def clamp(x: float, lo: float, hi: float) -> float:
    return lo if x < lo else hi if x > hi else x


def safe_div(a: float, b: float, default: float = 0.0) -> float:
    try:
        if b == 0 or b != b:
            return default
        return a / b
    except Exception:
        return default


def pct(a: float, b: float) -> float:
    """(a - b) / b in percent."""
    return safe_div(a - b, b) * 100.0


def bps(a: float, b: float) -> float:
    return safe_div(a - b, b) * 10_000.0


def sign(x: float) -> int:
    return 1 if x > 0 else -1 if x < 0 else 0


def json_default(o: Any) -> Any:
    if is_dataclass(o) and not isinstance(o, type):
        return asdict(o)
    if isinstance(o, Enum):
        return o.value
    if isinstance(o, (datetime,)):
        return o.isoformat()
    if hasattr(o, "item"):
        try:
            return o.item()
        except Exception:  # pragma: no cover
            pass
    if hasattr(o, "tolist"):
        return o.tolist()
    if isinstance(o, float) and (math.isnan(o) or math.isinf(o)):
        return None
    if hasattr(o, "model_dump"):
        return o.model_dump()
    return str(o)


def to_json(obj: Any, **kw: Any) -> str:
    kw.setdefault("ensure_ascii", False)
    kw.setdefault("default", json_default)
    return json.dumps(obj, **kw)


def setup_logging(level: str = "INFO", logfile: str | None = None) -> logging.Logger:
    root = logging.getLogger()
    if root.handlers:
        root.setLevel(level.upper())
        return logging.getLogger("munder_trader")
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s", "%Y-%m-%d %H:%M:%S")
    handler = logging.StreamHandler()
    handler.setFormatter(fmt)
    root.addHandler(handler)
    if logfile:
        fh = logging.FileHandler(logfile, encoding="utf-8")
        fh.setFormatter(fmt)
        root.addHandler(fh)
    root.setLevel(level.upper())
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    logging.getLogger("websockets").setLevel(logging.WARNING)
    return logging.getLogger("munder_trader")


class RateLimiter:
    """Token bucket used by the REST client to stay below Binance request weights."""

    def __init__(self, capacity: int = 1200, refill_per_min: int = 1200) -> None:
        self.capacity = capacity
        self.tokens = float(capacity)
        self.refill_per_s = refill_per_min / 60.0
        self.updated = time.monotonic()

    def acquire(self, weight: int = 1) -> None:
        while True:
            now = time.monotonic()
            self.tokens = min(self.capacity, self.tokens + (now - self.updated) * self.refill_per_s)
            self.updated = now
            if self.tokens >= weight:
                self.tokens -= weight
                return
            time.sleep(max(0.01, (weight - self.tokens) / self.refill_per_s))
