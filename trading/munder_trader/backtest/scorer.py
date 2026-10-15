"""Scoring a backtest the way the operator asked for.

The objective rewards, in this order of weight:

1. **win rate** — more winners than losers;
2. **short-horizon return** — equity growth per day, so a strategy that makes
   its money quickly beats one that needs months;
3. **take-profit capture** — how much of each winner's maximum favourable
   excursion was actually banked (익절은 최대로);
4. **stop speed** — losers should be cut fast: few bars held, small MAE
   (손절은 빠르게);
5. **entry quality** — small MAE on winners means the entry timing was sharp
   (타점은 빠르게).

Penalties: drawdown, liquidations, too few trades to trust the number, and a
negative profit factor. All metrics are returned so the learner can explain
*why* one parameter set beat another.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from .engine import BacktestResult


@dataclass
class Metrics:
    trades: int = 0
    win_rate: float = 0.0
    profit_factor: float = 0.0
    expectancy_r: float = 0.0
    avg_win_r: float = 0.0
    avg_loss_r: float = 0.0
    total_return_pct: float = 0.0
    return_per_day_pct: float = 0.0
    max_drawdown_pct: float = 0.0
    sharpe: float = 0.0
    avg_bars_win: float = 0.0
    avg_bars_loss: float = 0.0
    tp_capture: float = 0.0
    entry_quality: float = 0.0
    liquidations: int = 0
    days: float = 0.0
    score: float = 0.0
    breakdown: dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return self.__dict__.copy()


def compute_metrics(res: BacktestResult, min_trades: int = 20) -> Metrics:
    m = Metrics()
    tr = res.trades
    m.trades = len(tr)
    m.liquidations = res.liquidations
    curve = res.equity_curve
    if len(curve) >= 2:
        days = max(1e-9, (curve.index[-1] - curve.index[0]).total_seconds() / 86_400)
    else:
        days = 1.0
    m.days = days
    m.total_return_pct = res.total_return_pct
    m.return_per_day_pct = m.total_return_pct / days if days > 0 else 0.0
    if len(curve) >= 2:
        peak = curve.cummax()
        dd = ((peak - curve) / peak.replace(0, np.nan)).fillna(0.0)
        m.max_drawdown_pct = float(dd.max() * 100.0)
        # daily-ish sharpe from resampled equity
        try:
            daily = curve.resample("1D").last().dropna().pct_change().dropna()
            if len(daily) >= 3 and daily.std() > 0:
                m.sharpe = float(daily.mean() / daily.std() * math.sqrt(365))
        except Exception:
            pass
    if tr:
        wins = [t for t in tr if t.pnl > 0]
        losses = [t for t in tr if t.pnl <= 0]
        m.win_rate = len(wins) / len(tr)
        gp = sum(t.pnl for t in wins)
        gl = -sum(t.pnl for t in losses)
        m.profit_factor = gp / gl if gl > 0 else (float("inf") if gp > 0 else 0.0)
        m.expectancy_r = float(np.mean([t.r_multiple for t in tr]))
        m.avg_win_r = float(np.mean([t.r_multiple for t in wins])) if wins else 0.0
        m.avg_loss_r = float(-np.mean([t.r_multiple for t in losses])) if losses else 0.0
        m.avg_bars_win = float(np.mean([t.bars_held for t in wins])) if wins else 0.0
        m.avg_bars_loss = float(np.mean([t.bars_held for t in losses])) if losses else 0.0
        caps = [min(1.5, t.r_multiple / t.mfe_r) for t in wins if t.mfe_r > 0]
        m.tp_capture = float(np.mean(caps)) if caps else 0.0
        maes = [t.mae_r for t in wins]
        m.entry_quality = float(1.0 - min(1.0, np.mean(maes))) if maes else 0.0
    m.score, m.breakdown = score_metrics(m, min_trades=min_trades)
    return m


def score_metrics(m: Metrics, *, min_trades: int = 20) -> tuple[float, dict[str, float]]:
    """Composite objective in roughly [-2, 3]. Higher is better."""
    if m.trades == 0:
        return -2.0, {"no_trades": -2.0}
    b: dict[str, float] = {}
    b["win_rate"] = 1.2 * (m.win_rate - 0.5)                                   # ±0.6 for 0%..100%
    b["return_per_day"] = 0.9 * float(np.tanh(m.return_per_day_pct / 1.5))        # saturates around +1.5%/day
    b["tp_capture"] = 0.5 * (min(1.0, m.tp_capture) - 0.5)
    pf = m.profit_factor if np.isfinite(m.profit_factor) else 3.0
    b["profit_factor"] = 0.6 * float(np.tanh((pf - 1.0) / 1.0))
    # stop speed: losers held much longer than winners is bad
    if m.avg_bars_win > 0 and m.avg_bars_loss > 0:
        ratio = m.avg_bars_loss / m.avg_bars_win
        b["stop_speed"] = 0.3 * float(np.tanh(1.0 - ratio))
    else:
        b["stop_speed"] = 0.0
    b["entry_quality"] = 0.3 * (m.entry_quality - 0.5)
    b["drawdown"] = -0.8 * float(np.tanh(m.max_drawdown_pct / 20.0))
    b["liquidations"] = -0.5 * m.liquidations
    if m.trades < min_trades:
        b["few_trades"] = -0.8 * (1.0 - m.trades / min_trades)
    b["expectancy"] = 0.4 * float(np.tanh(m.expectancy_r))
    score = sum(b.values())
    return float(score), {k: round(v, 4) for k, v in b.items()}
