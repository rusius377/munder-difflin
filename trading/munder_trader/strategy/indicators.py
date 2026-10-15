"""Vectorised technical indicators (pandas/numpy only)."""

from __future__ import annotations

import numpy as np
import pandas as pd


def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=max(1, int(n)), adjust=False, min_periods=1).mean()


def sma(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(max(1, int(n)), min_periods=1).mean()


def rsi(close: pd.Series, n: int = 14) -> pd.Series:
    delta = close.diff()
    up = delta.clip(lower=0.0)
    down = -delta.clip(upper=0.0)
    roll_up = up.ewm(alpha=1 / max(1, n), adjust=False, min_periods=1).mean()
    roll_down = down.ewm(alpha=1 / max(1, n), adjust=False, min_periods=1).mean()
    rs = roll_up / roll_down.replace(0, np.nan)
    out = 100 - 100 / (1 + rs)
    return out.fillna(50.0)


def true_range(df: pd.DataFrame) -> pd.Series:
    prev_close = df["close"].shift(1)
    tr = pd.concat([
        df["high"] - df["low"],
        (df["high"] - prev_close).abs(),
        (df["low"] - prev_close).abs(),
    ], axis=1).max(axis=1)
    return tr.fillna(df["high"] - df["low"])


def atr(df: pd.DataFrame, n: int = 14) -> pd.Series:
    return true_range(df).ewm(alpha=1 / max(1, n), adjust=False, min_periods=1).mean()


def adx(df: pd.DataFrame, n: int = 14) -> pd.DataFrame:
    """Returns DataFrame with ``adx``, ``plus_di``, ``minus_di``."""
    high, low = df["high"], df["low"]
    up = high.diff()
    down = -low.diff()
    plus_dm = np.where((up > down) & (up > 0), up, 0.0)
    minus_dm = np.where((down > up) & (down > 0), down, 0.0)
    tr = true_range(df)
    alpha = 1 / max(1, n)
    atr_ = tr.ewm(alpha=alpha, adjust=False, min_periods=1).mean().replace(0, np.nan)
    plus_di = 100 * pd.Series(plus_dm, index=df.index).ewm(alpha=alpha, adjust=False, min_periods=1).mean() / atr_
    minus_di = 100 * pd.Series(minus_dm, index=df.index).ewm(alpha=alpha, adjust=False, min_periods=1).mean() / atr_
    dx = (100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)).fillna(0.0)
    adx_ = dx.ewm(alpha=alpha, adjust=False, min_periods=1).mean()
    return pd.DataFrame({"adx": adx_.fillna(0.0), "plus_di": plus_di.fillna(0.0), "minus_di": minus_di.fillna(0.0)})


def bollinger(close: pd.Series, n: int = 20, k: float = 2.0) -> pd.DataFrame:
    mid = sma(close, n)
    sd = close.rolling(max(2, int(n)), min_periods=2).std().bfill().fillna(0.0)
    return pd.DataFrame({"bb_mid": mid, "bb_up": mid + k * sd, "bb_dn": mid - k * sd, "bb_sd": sd})


def donchian(df: pd.DataFrame, n: int = 20) -> pd.DataFrame:
    n = max(2, int(n))
    return pd.DataFrame({
        "dc_hi": df["high"].rolling(n, min_periods=1).max().shift(1),
        "dc_lo": df["low"].rolling(n, min_periods=1).min().shift(1),
    })


def rolling_vwap(df: pd.DataFrame, n: int = 60) -> pd.Series:
    n = max(1, int(n))
    tp = (df["high"] + df["low"] + df["close"]) / 3.0
    pv = (tp * df["volume"]).rolling(n, min_periods=1).sum()
    v = df["volume"].rolling(n, min_periods=1).sum().replace(0, np.nan)
    return (pv / v).fillna(tp)


def zscore(s: pd.Series, n: int = 50) -> pd.Series:
    n = max(2, int(n))
    mu = s.rolling(n, min_periods=2).mean()
    sd = s.rolling(n, min_periods=2).std()
    return ((s - mu) / sd.replace(0, np.nan)).fillna(0.0)


def realized_vol(close: pd.Series, n: int = 48) -> pd.Series:
    r = np.log(close / close.shift(1)).fillna(0.0)
    return r.rolling(max(2, int(n)), min_periods=2).std().bfill().fillna(0.0)


def swing_points(df: pd.DataFrame, left: int = 3, right: int = 3) -> pd.DataFrame:
    """Most recent confirmed swing high/low (shifted so no look-ahead)."""
    hi = df["high"]
    lo = df["low"]
    win = left + right + 1
    is_hi = hi == hi.rolling(win, center=True, min_periods=win).max()
    is_lo = lo == lo.rolling(win, center=True, min_periods=win).min()
    sh = hi.where(is_hi).shift(right).ffill()
    sl = lo.where(is_lo).shift(right).ffill()
    return pd.DataFrame({"swing_hi": sh, "swing_lo": sl})


def volume_ratio(volume: pd.Series, n: int = 20) -> pd.Series:
    base = volume.rolling(max(2, int(n)), min_periods=1).mean().shift(1)
    return (volume / base.replace(0, np.nan)).fillna(1.0)


def slope(s: pd.Series, n: int = 5) -> pd.Series:
    """Percent slope over n bars."""
    return ((s - s.shift(n)) / s.shift(n).replace(0, np.nan) * 100.0).fillna(0.0)


def macd(close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9) -> pd.DataFrame:
    m = ema(close, fast) - ema(close, slow)
    sig = ema(m, signal)
    return pd.DataFrame({"macd": m, "macd_signal": sig, "macd_hist": m - sig})


def enrich(df: pd.DataFrame, *, ema_fast: int = 20, ema_slow: int = 50, ema_trend: int = 200, adx_len: int = 14,
           rsi_len: int = 14, atr_len: int = 14, bb_len: int = 20, bb_k: float = 2.0, donchian_len: int = 20,
           vwap_len: int = 60, vol_len: int = 20) -> pd.DataFrame:
    """Attach every indicator the desks use to a copy of ``df``."""
    out = df.copy()
    c = out["close"]
    out["ema_fast"] = ema(c, ema_fast)
    out["ema_slow"] = ema(c, ema_slow)
    out["ema_trend"] = ema(c, ema_trend)
    out["rsi"] = rsi(c, rsi_len)
    out["atr"] = atr(out, atr_len)
    a = adx(out, adx_len)
    out["adx"], out["plus_di"], out["minus_di"] = a["adx"], a["plus_di"], a["minus_di"]
    b = bollinger(c, bb_len, bb_k)
    for col in b.columns:
        out[col] = b[col]
    d = donchian(out, donchian_len)
    out["dc_hi"], out["dc_lo"] = d["dc_hi"], d["dc_lo"]
    out["vwap"] = rolling_vwap(out, vwap_len)
    out["vwap_z"] = zscore(c - out["vwap"], max(10, vwap_len))
    out["vol_ratio"] = volume_ratio(out["volume"], vol_len)
    out["rv"] = realized_vol(c, max(10, atr_len * 3))
    sp = swing_points(out)
    out["swing_hi"], out["swing_lo"] = sp["swing_hi"], sp["swing_lo"]
    out["ema_fast_slope"] = slope(out["ema_fast"], 3)
    m = macd(c)
    out["macd_hist"] = m["macd_hist"]
    out["atr_pct"] = (out["atr"] / c * 100).fillna(0.0)
    return out
