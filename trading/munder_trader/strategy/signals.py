"""Quant signal engine for the SWING and SCALP desks.

Each function enriches an OHLCV frame with vectorised, look-ahead-free signal
columns (``sig_dir``, ``sig_strength``, ``sig_setup``, ``sig_stop``, ``sig_tp1``,
``sig_tp2``, ``regime``). The backtester iterates those columns; the live engine
reads the last closed bar and, for the scalp desk, gates the signal with live
order-book and tape pressure (:func:`apply_microstructure`).

Every signal carries the *evidence* that produced it (``components``) so the
agents can argue about it and the journal can show why the desk acted.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from ..data.orderbook import BookFeatures
from ..data.tradeflow import TapeFeatures
from ..util import clamp
from . import indicators as ind
from .params import ScalpParams, SwingParams

SETUPS = {
    0: "none", 1: "pullback", 2: "breakout", 3: "mean_revert", 4: "vwap_revert", 5: "momentum", 6: "squeeze",
}


@dataclass
class Signal:
    mode: str
    symbol: str
    ts: int
    direction: int            # +1 long / -1 short / 0 flat
    strength: float           # 0..1
    entry: float
    stop: float
    tp1: float
    tp2: float
    atr: float
    regime: str
    setup: str
    components: dict[str, float] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)
    microstructure: dict[str, float] = field(default_factory=dict)

    @property
    def risk_per_unit(self) -> float:
        return abs(self.entry - self.stop)

    @property
    def stop_pct(self) -> float:
        return abs(self.entry - self.stop) / self.entry * 100 if self.entry else 0.0

    @property
    def reward_risk(self) -> float:
        r = self.risk_per_unit
        return abs(self.tp2 - self.entry) / r if r > 0 else 0.0

    def to_dict(self) -> dict:
        d = self.__dict__.copy()
        d.update(stop_pct=self.stop_pct, reward_risk=self.reward_risk)
        return d


# ----------------------------------------------------------------------------------
# SWING
# ----------------------------------------------------------------------------------

def compute_swing(df: pd.DataFrame, p: SwingParams, context: pd.DataFrame | None = None) -> pd.DataFrame:
    """Vectorised swing signals on the base timeframe (1h by default)."""
    out = ind.enrich(df, ema_fast=p.ema_fast, ema_slow=p.ema_slow, ema_trend=p.ema_trend, adx_len=p.adx_len,
                     rsi_len=p.rsi_len, atr_len=p.atr_len, donchian_len=p.donchian_len)
    c, o = out["close"], out["open"]
    atr = out["atr"].replace(0, np.nan).fillna(c * 0.01)

    # higher-timeframe alignment (context frame resampled/aligned forward-fill, no look-ahead)
    if context is not None and not context.empty:
        ctx = ind.enrich(context, ema_fast=p.ema_fast, ema_slow=p.ema_slow, ema_trend=p.ema_trend)
        ctx_dir = np.sign(ctx["ema_fast"] - ctx["ema_slow"]).rename("ctx_dir")
        # a context candle is only known once closed → shift by one then align
        ctx_dir = ctx_dir.shift(1).reindex(out.index, method="ffill").fillna(0.0)
        out["ctx_dir"] = ctx_dir
    else:
        out["ctx_dir"] = np.sign(out["ema_slow"] - out["ema_trend"]).fillna(0.0)

    trend_up = (c > out["ema_trend"]) & (out["ema_fast"] > out["ema_slow"]) & (out["adx"] >= p.adx_min)
    trend_dn = (c < out["ema_trend"]) & (out["ema_fast"] < out["ema_slow"]) & (out["adx"] >= p.adx_min)
    volatile = out["atr_pct"] > out["atr_pct"].rolling(100, min_periods=10).mean() * 1.8
    regime = np.where(trend_up, "trend_up", np.where(trend_dn, "trend_down", np.where(volatile, "volatile", "range")))
    out["regime"] = regime

    bullish_bar = c > o
    bearish_bar = c < o
    adx_norm = clamp_series((out["adx"] - p.adx_min) / 25.0, 0.0, 1.0)
    vol_norm = clamp_series((out["vol_ratio"] - 1.0) / 1.5, 0.0, 1.0)

    # 1) pullback in trend
    pb_long = trend_up & (out["rsi"] <= p.rsi_pullback_long) & (c >= out["ema_slow"]) & bullish_bar
    pb_short = trend_dn & (out["rsi"] >= p.rsi_pullback_short) & (c <= out["ema_slow"]) & bearish_bar
    pb_depth_l = clamp_series((p.rsi_pullback_long - out["rsi"]) / 15.0, 0.0, 1.0)
    pb_depth_s = clamp_series((out["rsi"] - p.rsi_pullback_short) / 15.0, 0.0, 1.0)
    pb_strength_l = 0.45 * adx_norm + 0.25 * pb_depth_l + 0.15 * (out["ctx_dir"] > 0) + 0.15 * vol_norm
    pb_strength_s = 0.45 * adx_norm + 0.25 * pb_depth_s + 0.15 * (out["ctx_dir"] < 0) + 0.15 * vol_norm

    # 2) breakout with volume
    bo_long = (c > out["dc_hi"]) & (out["vol_ratio"] >= p.vol_confirm) & (out["ema_fast"] > out["ema_slow"])
    bo_short = (c < out["dc_lo"]) & (out["vol_ratio"] >= p.vol_confirm) & (out["ema_fast"] < out["ema_slow"])
    bo_strength = 0.4 * vol_norm + 0.35 * adx_norm + 0.25 * clamp_series(out["adx"].diff(3) / 5.0, 0.0, 1.0)
    bo_strength_l = bo_strength + 0.1 * (out["ctx_dir"] > 0)
    bo_strength_s = bo_strength + 0.1 * (out["ctx_dir"] < 0)

    # 3) mean reversion in range
    rng_mask = (out["regime"] == "range")
    mr_long = rng_mask & (c < out["bb_dn"]) & (out["rsi"] <= p.rsi_revert_long) & bullish_bar
    mr_short = rng_mask & (c > out["bb_up"]) & (out["rsi"] >= p.rsi_revert_short) & bearish_bar
    mr_strength_l = 0.5 * clamp_series((p.rsi_revert_long - out["rsi"]) / 12.0, 0.0, 1.0) + 0.3
    mr_strength_s = 0.5 * clamp_series((out["rsi"] - p.rsi_revert_short) / 12.0, 0.0, 1.0) + 0.3

    direction = np.zeros(len(out), dtype=int)
    strength = np.zeros(len(out))
    setup = np.zeros(len(out), dtype=int)
    stop = np.full(len(out), np.nan)

    def place(mask, d, s, code, stop_series):
        nonlocal direction, strength, setup, stop
        m = mask.to_numpy() & (direction == 0)
        direction = np.where(m, d, direction)
        strength = np.where(m, s.to_numpy(), strength)
        setup = np.where(m, code, setup)
        stop = np.where(m, stop_series.to_numpy(), stop)

    swing_lo = out["swing_lo"].fillna(c - p.stop_atr * atr)
    swing_hi = out["swing_hi"].fillna(c + p.stop_atr * atr)
    # structure stop capped by ATR multiple so a far swing never makes the stop huge
    pb_stop_l = np.maximum(swing_lo - 0.2 * atr, c - p.stop_atr * atr)
    pb_stop_s = np.minimum(swing_hi + 0.2 * atr, c + p.stop_atr * atr)
    place(pb_long, 1, pb_strength_l, 1, pd.Series(pb_stop_l, index=out.index))
    place(pb_short, -1, pb_strength_s, 1, pd.Series(pb_stop_s, index=out.index))
    place(bo_long, 1, bo_strength_l, 2, np.maximum(out["dc_hi"] - 0.5 * atr, c - p.stop_atr * atr))
    place(bo_short, -1, bo_strength_s, 2, np.minimum(out["dc_lo"] + 0.5 * atr, c + p.stop_atr * atr))
    place(mr_long, 1, mr_strength_l, 3, c - max(1.0, p.stop_atr * 0.75) * atr)
    place(mr_short, -1, mr_strength_s, 3, c + max(1.0, p.stop_atr * 0.75) * atr)

    strength = np.clip(strength, 0.0, 1.0)
    direction = np.where(strength < p.min_strength, 0, direction)
    cn, an = c.to_numpy(), atr.to_numpy()
    # signed distance to the stop; a structure stop on the wrong side of price falls back to the ATR stop
    risk = (cn - np.nan_to_num(stop, nan=cn)) * direction
    risk = np.where(risk <= 0.3 * an, an * p.stop_atr, risk)
    stop = np.where(direction != 0, cn - direction * risk, np.nan)
    out["sig_dir"] = direction
    out["sig_strength"] = np.where(direction != 0, strength, 0.0)
    out["sig_setup"] = setup
    out["sig_stop"] = stop
    out["sig_tp1"] = np.where(direction != 0, cn + direction * p.tp1_r * risk, np.nan)
    out["sig_tp2"] = np.where(direction != 0, cn + direction * p.tp2_r * risk, np.nan)
    out["sig_trail_atr"] = p.trail_atr
    return out


# ----------------------------------------------------------------------------------
# SCALP
# ----------------------------------------------------------------------------------

def compute_scalp(df: pd.DataFrame, p: ScalpParams, context: pd.DataFrame | None = None) -> pd.DataFrame:
    """Vectorised scalp signals on 1m bars with a 5m context for regime."""
    out = ind.enrich(df, ema_fast=p.ema_fast, ema_slow=p.ema_slow, ema_trend=max(50, p.ema_slow * 3), adx_len=14,
                     atr_len=p.atr_len, bb_len=p.bb_len, bb_k=p.bb_k, donchian_len=p.momo_break_bars,
                     vwap_len=p.vwap_len, vol_len=30)
    c, o, h, l = out["close"], out["open"], out["high"], out["low"]
    atr = out["atr"].replace(0, np.nan).fillna(c * 0.002)

    if context is not None and not context.empty:
        ctx = ind.enrich(context, ema_fast=p.ema_fast, ema_slow=p.ema_slow, adx_len=14)
        ctx_adx = ctx["adx"].shift(1).reindex(out.index, method="ffill").bfill().fillna(0.0)
        ctx_dir = np.sign(ctx["ema_fast"] - ctx["ema_slow"]).shift(1).reindex(out.index, method="ffill").fillna(0.0)
    else:
        ctx_adx = out["adx"]
        ctx_dir = np.sign(out["ema_fast"] - out["ema_slow"]).fillna(0.0)
    out["ctx_adx"], out["ctx_dir"] = ctx_adx, ctx_dir

    ranging = ctx_adx < p.range_adx_max
    regime = np.where(ranging, "range", np.where(ctx_dir > 0, "trend_up", np.where(ctx_dir < 0, "trend_down", "range")))
    out["regime"] = regime

    bar_range = (h - l).replace(0, np.nan)
    close_pos = ((c - l) / bar_range).fillna(0.5)            # 1 = closed at high
    vol_norm = clamp_series((out["vol_ratio"] - 1.0) / 1.5, 0.0, 1.0)

    # 1) VWAP reversion in range: stretched z-score + rejection candle
    vr_long = ranging & (out["vwap_z"] <= -p.revert_z) & (close_pos >= 0.6) & (c < out["vwap"])
    vr_short = ranging & (out["vwap_z"] >= p.revert_z) & (close_pos <= 0.4) & (c > out["vwap"])
    vr_strength_l = 0.5 * clamp_series((-out["vwap_z"] - p.revert_z) / 1.5 + 0.4, 0.0, 1.0) + 0.3 * close_pos + 0.2 * vol_norm
    vr_strength_s = 0.5 * clamp_series((out["vwap_z"] - p.revert_z) / 1.5 + 0.4, 0.0, 1.0) + 0.3 * (1 - close_pos) + 0.2 * vol_norm

    # 2) momentum ignition: break of recent high/low with a volume burst, EMA alignment
    mo_long = (c > out["dc_hi"]) & (out["vol_ratio"] >= p.vol_burst) & (out["ema_fast"] > out["ema_slow"]) & (close_pos >= 0.55)
    mo_short = (c < out["dc_lo"]) & (out["vol_ratio"] >= p.vol_burst) & (out["ema_fast"] < out["ema_slow"]) & (close_pos <= 0.45)
    mo_strength = 0.45 * vol_norm + 0.25 * clamp_series(out["ema_fast_slope"].abs() * 40, 0.0, 1.0) + 0.1
    mo_strength_l = mo_strength + 0.2 * (ctx_dir > 0)
    mo_strength_s = mo_strength + 0.2 * (ctx_dir < 0)

    # 3) squeeze release: Bollinger width contraction then expansion in trend direction
    bb_width = ((out["bb_up"] - out["bb_dn"]) / out["bb_mid"].replace(0, np.nan)).fillna(0.0)
    squeeze = bb_width < bb_width.rolling(60, min_periods=20).quantile(0.25)
    sq_long = squeeze.shift(1).fillna(False) & (c > out["bb_up"]) & (ctx_dir > 0) & (out["vol_ratio"] >= 1.2)
    sq_short = squeeze.shift(1).fillna(False) & (c < out["bb_dn"]) & (ctx_dir < 0) & (out["vol_ratio"] >= 1.2)
    sq_strength = 0.4 + 0.4 * vol_norm

    direction = np.zeros(len(out), dtype=int)
    strength = np.zeros(len(out))
    setup = np.zeros(len(out), dtype=int)
    stop = np.full(len(out), np.nan)

    def place(mask, d, s, code, stop_series):
        nonlocal direction, strength, setup, stop
        m = mask.to_numpy() & (direction == 0)
        direction = np.where(m, d, direction)
        strength = np.where(m, np.asarray(s), strength)
        setup = np.where(m, code, setup)
        stop = np.where(m, np.asarray(stop_series), stop)

    min_stop = atr * p.stop_atr
    place(vr_long, 1, vr_strength_l, 4, np.minimum(l - 0.25 * atr, c - min_stop))
    place(vr_short, -1, vr_strength_s, 4, np.maximum(h + 0.25 * atr, c + min_stop))
    place(mo_long, 1, mo_strength_l, 5, c - min_stop)
    place(mo_short, -1, mo_strength_s, 5, c + min_stop)
    place(sq_long, 1, sq_strength, 6, c - min_stop)
    place(sq_short, -1, sq_strength, 6, c + min_stop)

    strength = np.clip(strength, 0.0, 1.0)
    direction = np.where(strength < p.min_strength, 0, direction)
    cn = c.to_numpy()
    risk = np.abs(cn - np.nan_to_num(stop, nan=cn))
    risk = np.where(risk <= 0, atr.to_numpy() * p.stop_atr, risk)
    # a stop inside fee + spread noise is a coin flip → widen to the floor
    risk = np.maximum(risk, cn * p.min_stop_pct / 100.0)
    stop = np.where(direction != 0, cn - direction * risk, np.nan)
    out["sig_dir"] = direction
    out["sig_strength"] = np.where(direction != 0, strength, 0.0)
    out["sig_setup"] = setup
    out["sig_stop"] = stop
    tp1 = c + direction * p.tp1_r * risk
    # VWAP-reversion targets the VWAP itself when that is closer than tp2
    tp2 = c + direction * p.tp2_r * risk
    vwap_target = out["vwap"].to_numpy()
    use_vwap = (setup == 4) & (np.abs(vwap_target - c.to_numpy()) < np.abs(tp2 - c.to_numpy()))
    tp2 = np.where(use_vwap, vwap_target, tp2)
    out["sig_tp1"] = np.where(direction != 0, tp1, np.nan)
    out["sig_tp2"] = np.where(direction != 0, tp2, np.nan)
    out["sig_trail_atr"] = p.trail_atr
    return out


# ----------------------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------------------

def clamp_series(s: pd.Series, lo: float, hi: float) -> pd.Series:
    return s.clip(lower=lo, upper=hi).fillna(lo)


def signal_at(mode: str, symbol: str, df: pd.DataFrame, i: int = -1) -> Signal:
    """Build a :class:`Signal` for row ``i`` of a frame produced by ``compute_*``."""
    row = df.iloc[i]
    ts = int(row.get("close_time", row.get("open_time", 0)))
    d = int(row["sig_dir"])
    comps = {
        k: float(row[k]) for k in ("rsi", "adx", "atr_pct", "vol_ratio", "vwap_z", "ema_fast_slope", "ctx_dir", "macd_hist")
        if k in row.index and pd.notna(row[k])
    }
    comps["ema_fast_vs_slow_pct"] = float((row["ema_fast"] - row["ema_slow"]) / row["ema_slow"] * 100) if row["ema_slow"] else 0.0
    comps["close_vs_ema_trend_pct"] = float((row["close"] - row["ema_trend"]) / row["ema_trend"] * 100) if "ema_trend" in row and row["ema_trend"] else 0.0
    sig = Signal(
        mode=mode, symbol=symbol, ts=ts, direction=d, strength=float(row["sig_strength"]), entry=float(row["close"]),
        stop=float(row["sig_stop"]) if d != 0 and pd.notna(row["sig_stop"]) else float(row["close"]),
        tp1=float(row["sig_tp1"]) if d != 0 and pd.notna(row["sig_tp1"]) else float(row["close"]),
        tp2=float(row["sig_tp2"]) if d != 0 and pd.notna(row["sig_tp2"]) else float(row["close"]),
        atr=float(row["atr"]), regime=str(row["regime"]), setup=SETUPS.get(int(row["sig_setup"]), "none"),
        components=comps,
    )
    if d == 0:
        sig.notes.append("no qualifying setup on the last closed bar")
    return sig


def _orderflow_initiation(sig: Signal, bp: float, tp: float, tape: TapeFeatures | None, p: ScalpParams, *, penalty: float = 1.0) -> bool:
    """Start a scalp purely from order flow when book and tape agree hard and the tape is accelerating."""
    agree = (bp > 0) == (tp > 0) and abs(bp) >= 2 * p.book_pressure_min and abs(tp) >= 2 * p.tape_pressure_min
    if not (agree and tape is not None and tape.intensity >= 1.5):
        return False
    sig.direction = 1 if bp > 0 else -1
    sig.strength = clamp((0.35 + 0.3 * abs(bp) + 0.3 * abs(tp)) * penalty, 0.0, 1.0)
    sig.setup = "orderflow"
    r = max(sig.atr * p.stop_atr, sig.entry * max(p.min_stop_pct / 100.0, 0.0008))
    sig.stop = sig.entry - sig.direction * r
    sig.tp1 = sig.entry + sig.direction * p.tp1_r * r
    sig.tp2 = sig.entry + sig.direction * p.tp2_r * r
    sig.notes.append("order-flow initiated: book and tape pressure aligned with rising intensity")
    return True


def apply_microstructure(sig: Signal, book: BookFeatures | None, tape: TapeFeatures | None, p: ScalpParams) -> Signal:
    """Gate / scale a scalp signal with live order-book and tape evidence."""
    if book is None and tape is None:
        return sig
    bp = book.pressure() if book else 0.0
    tp = tape.pressure() if tape else 0.0
    sig.microstructure = {
        "book_pressure": bp, "tape_pressure": tp,
        "spread_bps": book.spread_bps if book else 0.0,
        "imbalance_n": book.imbalance_n if book else 0.0,
        "cvd_short": tape.cvd_short if tape else 0.0,
        "intensity": tape.intensity if tape else 1.0,
        "absorption": tape.absorption if tape else 0.0,
        "sweep": float(tape.sweep) if tape else 0.0,
    }
    if book and book.spread_bps > p.max_spread_bps:
        sig.notes.append(f"spread {book.spread_bps:.1f}bps > {p.max_spread_bps}bps → no scalp")
        sig.direction = 0
        sig.strength = 0.0
        return sig
    if sig.direction == 0:
        _orderflow_initiation(sig, bp, tp, tape, p)
        return sig
    aligned = 0.5 * bp + 0.5 * tp
    score = aligned * sig.direction
    if score < -max(p.book_pressure_min, p.tape_pressure_min):
        sig.notes.append(f"microstructure opposes the {sig.setup} signal (score {score:+.2f}) → stand down")
        sig.direction = 0
        sig.strength = 0.0
        # the opposing flow may itself be strong enough to trade the other way (at a discount)
        if _orderflow_initiation(sig, bp, tp, tape, p, penalty=0.85):
            sig.notes.append("flipped to the order-flow direction against the bar setup")
        return sig
    sig.strength = clamp(sig.strength + 0.5 * score, 0.0, 1.0)
    if tape and tape.absorption * sig.direction > 0.2:
        sig.strength = clamp(sig.strength + 0.1, 0.0, 1.0)
        sig.notes.append("absorption in our favour")
    if book:
        wall = book.ask_wall if sig.direction > 0 else book.bid_wall
        if wall and abs(wall[0] - sig.entry) / sig.entry < abs(sig.tp1 - sig.entry) / sig.entry:
            # a liquidity wall sits before TP1 → take profit in front of it
            adj = wall[0] - sig.direction * max(book.spread_bps / 10_000 * sig.entry, 1e-9)
            sig.tp1 = adj
            sig.notes.append(f"liquidity wall at {wall[0]:.6g} → TP1 moved in front of it")
    return sig
