"""Tunable parameters for both desks and the search space the optimizer explores."""

from __future__ import annotations

import json
import random
from dataclasses import asdict, dataclass, fields
from pathlib import Path
from typing import Any


@dataclass
class SwingParams:
    ema_fast: int = 20
    ema_slow: int = 50
    ema_trend: int = 200
    adx_len: int = 14
    adx_min: float = 20.0
    rsi_len: int = 14
    rsi_pullback_long: float = 45.0
    rsi_pullback_short: float = 55.0
    rsi_revert_long: float = 30.0
    rsi_revert_short: float = 70.0
    atr_len: int = 14
    stop_atr: float = 2.0
    tp1_r: float = 1.0
    tp2_r: float = 2.6
    trail_atr: float = 2.0
    donchian_len: int = 20
    vol_confirm: float = 1.3
    min_strength: float = 0.35
    max_hold_bars: int = 72
    tp1_fraction: float = 0.5   # share closed at the first target
    breakeven_after_r: float = 0.8


@dataclass
class ScalpParams:
    ema_fast: int = 9
    ema_slow: int = 21
    vwap_len: int = 60
    bb_len: int = 20
    bb_k: float = 2.0
    atr_len: int = 14
    stop_atr: float = 0.9
    tp1_r: float = 1.0
    tp2_r: float = 1.8
    trail_atr: float = 1.2
    time_stop_bars: int = 15
    revert_z: float = 1.8
    momo_break_bars: int = 12
    vol_burst: float = 1.6
    range_adx_max: float = 22.0
    min_strength: float = 0.4
    max_spread_bps: float = 6.0
    book_pressure_min: float = 0.12
    tape_pressure_min: float = 0.12
    tp1_fraction: float = 0.6
    breakeven_after_r: float = 0.6
    # stops narrower than this (% of price) sit inside fee/spread noise → widened to this floor
    min_stop_pct: float = 0.18


# (low, high, kind) per parameter. kind: int | float
SWING_SPACE: dict[str, tuple[float, float, str]] = {
    "ema_fast": (8, 40, "int"), "ema_slow": (30, 120, "int"), "ema_trend": (100, 300, "int"),
    "adx_min": (12, 30, "float"), "rsi_pullback_long": (35, 55, "float"), "rsi_pullback_short": (45, 65, "float"),
    "rsi_revert_long": (18, 38, "float"), "rsi_revert_short": (62, 82, "float"),
    "stop_atr": (1.0, 3.5, "float"), "tp1_r": (0.6, 2.0, "float"), "tp2_r": (1.5, 5.0, "float"),
    "trail_atr": (1.0, 4.0, "float"), "donchian_len": (10, 55, "int"), "vol_confirm": (1.0, 2.5, "float"),
    "min_strength": (0.2, 0.6, "float"), "max_hold_bars": (24, 200, "int"), "tp1_fraction": (0.3, 0.8, "float"),
    "breakeven_after_r": (0.5, 1.5, "float"),
}

SCALP_SPACE: dict[str, tuple[float, float, str]] = {
    "ema_fast": (5, 15, "int"), "ema_slow": (15, 40, "int"), "vwap_len": (30, 180, "int"),
    "bb_k": (1.5, 3.0, "float"), "stop_atr": (0.5, 1.8, "float"), "tp1_r": (0.6, 1.6, "float"),
    "tp2_r": (1.2, 3.0, "float"), "trail_atr": (0.8, 2.5, "float"), "time_stop_bars": (6, 40, "int"),
    "revert_z": (1.2, 2.8, "float"), "momo_break_bars": (6, 30, "int"), "vol_burst": (1.2, 2.5, "float"),
    "range_adx_max": (15, 30, "float"), "min_strength": (0.25, 0.65, "float"), "tp1_fraction": (0.3, 0.8, "float"),
    "breakeven_after_r": (0.4, 1.2, "float"), "min_stop_pct": (0.08, 0.6, "float"),
}


def params_for(mode: str) -> SwingParams | ScalpParams:
    return SwingParams() if mode == "swing" else ScalpParams()


def space_for(mode: str) -> dict[str, tuple[float, float, str]]:
    return SWING_SPACE if mode == "swing" else SCALP_SPACE


def to_dict(p: SwingParams | ScalpParams) -> dict[str, Any]:
    return asdict(p)


def from_dict(mode: str, d: dict[str, Any]) -> SwingParams | ScalpParams:
    cls = SwingParams if mode == "swing" else ScalpParams
    allowed = {f.name: f.type for f in fields(cls)}
    kwargs = {}
    for k, v in d.items():
        if k in allowed:
            kwargs[k] = int(round(v)) if allowed[k] in ("int", int) else float(v)
    return cls(**kwargs)


def random_params(mode: str, rng: random.Random) -> SwingParams | ScalpParams:
    base = to_dict(params_for(mode))
    for k, (lo, hi, kind) in space_for(mode).items():
        base[k] = rng.randint(int(lo), int(hi)) if kind == "int" else rng.uniform(lo, hi)
    return _fix(mode, from_dict(mode, base))


def mutate(mode: str, p: SwingParams | ScalpParams, rng: random.Random, rate: float = 0.3, scale: float = 0.25):
    d = to_dict(p)
    for k, (lo, hi, kind) in space_for(mode).items():
        if rng.random() > rate:
            continue
        span = hi - lo
        v = d[k] + rng.gauss(0, scale * span)
        v = max(lo, min(hi, v))
        d[k] = int(round(v)) if kind == "int" else float(v)
    return _fix(mode, from_dict(mode, d))


def crossover(mode: str, a: SwingParams | ScalpParams, b: SwingParams | ScalpParams, rng: random.Random):
    da, db = to_dict(a), to_dict(b)
    child = {k: (da[k] if rng.random() < 0.5 else db[k]) for k in da}
    return _fix(mode, from_dict(mode, child))


def _fix(mode: str, p):
    """Keep relationships sane after random edits."""
    if p.ema_fast >= p.ema_slow:
        p.ema_slow = p.ema_fast + 5
    if mode == "swing" and p.ema_slow >= p.ema_trend:
        p.ema_trend = p.ema_slow + 20
    if p.tp2_r <= p.tp1_r:
        p.tp2_r = p.tp1_r + 0.5
    return p


class ParamStore:
    """Persist the live parameter set per (mode, symbol) as JSON."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._data: dict[str, Any] = {}
        if self.path.exists():
            try:
                self._data = json.loads(self.path.read_text(encoding="utf-8"))
            except Exception:
                self._data = {}

    def get(self, mode: str, symbol: str) -> SwingParams | ScalpParams:
        entry = self._data.get(f"{mode}:{symbol.upper()}") or self._data.get(f"{mode}:*")
        if entry and "params" in entry:
            return from_dict(mode, entry["params"])
        return params_for(mode)

    def meta(self, mode: str, symbol: str) -> dict[str, Any]:
        entry = self._data.get(f"{mode}:{symbol.upper()}") or {}
        return {k: v for k, v in entry.items() if k != "params"}

    def set(self, mode: str, symbol: str, params: SwingParams | ScalpParams, **meta: Any) -> None:
        self._data[f"{mode}:{symbol.upper()}"] = {"params": to_dict(params), **meta}
        self.save()

    def save(self) -> None:
        self.path.write_text(json.dumps(self._data, indent=2, ensure_ascii=False, default=str), encoding="utf-8")

    def all(self) -> dict[str, Any]:
        return dict(self._data)
