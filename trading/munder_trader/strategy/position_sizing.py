"""Automatic sizing, split entries and leverage selection (hard cap configurable, 100x default).

The operator fixes only the ceiling. For every trade the sizer decides:

* **risk budget** — base risk scaled by the committee's conviction and a
  fractional-Kelly estimate from recent performance of the same (mode, symbol);
* **quantity** — risk budget / stop distance, rounded to exchange filters;
* **leverage** — the *lowest* leverage that funds the notional with little
  margin while keeping the liquidation price at least
  ``liquidation_buffer_multiple`` stop-distances beyond the stop, never above
  the cap or the symbol's bracket limit for that notional;
* **split entries** — pullback-style setups ladder into weakness, momentum
  setups take the whole size at market (plus a retest tranche for swing);
* **take-profit ladder** — a partial at TP1, the runner at TP2 with a trailing
  stop so winners can be stretched when the hold policy says so.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass

from ..config import RiskSettings
from ..symbols import SymbolFilters
from ..util import clamp
from .params import ScalpParams, SwingParams
from .plan import AccountState, EntryTranche, OrderPlan, TakeProfit
from .signals import Signal

log = logging.getLogger(__name__)


@dataclass
class PerformanceStats:
    """Recent realised stats for Kelly scaling."""

    trades: int = 0
    win_rate: float = 0.5
    avg_win_r: float = 1.0
    avg_loss_r: float = 1.0

    @property
    def kelly(self) -> float:
        b = self.avg_win_r / self.avg_loss_r if self.avg_loss_r > 0 else 1.0
        p = self.win_rate
        return p - (1 - p) / b if b > 0 else 0.0

    def scale(self) -> float:
        """Multiplier in [0.4, 1.6] from fractional Kelly; 1.0 when too little data."""
        if self.trades < 10:
            return 1.0
        # quarter-Kelly expressed as a multiplier around 1.0 (kelly 0.25 → ×1.25, kelly -0.2 → ×0.8)
        return clamp(1.0 + self.kelly, 0.4, 1.6)


def estimate_liquidation(side: str, entry: float, qty: float, margin: float, mmr: float, maint_amount: float) -> float:
    """Binance isolated-margin liquidation price for a single one-way position."""
    if qty <= 0:
        return 0.0
    if side == "LONG":
        return (qty * entry - margin - maint_amount) / (qty * (1 - mmr))
    return (margin + maint_amount + qty * entry) / (qty * (1 + mmr))


def choose_leverage(stop_pct: float, notional: float, filters: SymbolFilters, risk: RiskSettings) -> tuple[int, list[str]]:
    reasons: list[str] = []
    mmr, _ = filters.maintenance_margin(notional)
    stop_frac = max(stop_pct / 100.0, 1e-5)
    by_liq = int(math.floor(1.0 / (risk.liquidation_buffer_multiple * stop_frac + mmr)))
    by_bracket = filters.leverage_for_notional(notional)
    lev = max(1, min(risk.max_leverage, by_bracket, by_liq))
    reasons.append(
        f"leverage {lev}x = min(cap {risk.max_leverage}x, bracket {by_bracket}x, liquidation-safe {by_liq}x "
        f"for stop {stop_pct:.2f}% × buffer {risk.liquidation_buffer_multiple:g})"
    )
    return lev, reasons


def build_plan(
    sig: Signal,
    *,
    conviction: float,
    account: AccountState,
    filters: SymbolFilters,
    risk: RiskSettings,
    params: SwingParams | ScalpParams,
    stats: PerformanceStats | None = None,
    size_multiplier: float = 1.0,
    reasons: list[str] | None = None,
) -> OrderPlan | None:
    """Turn a signal + conviction into a fully sized :class:`OrderPlan` (or ``None``)."""
    reasons = list(reasons or [])
    if sig.direction == 0:
        return None
    side = "LONG" if sig.direction > 0 else "SHORT"
    entry = sig.entry
    stop = sig.stop
    stop_pct = abs(entry - stop) / entry * 100.0
    if stop_pct <= 0.01:
        reasons.append("stop too close to entry (<0.01%) → no trade")
        return None
    stats = stats or PerformanceStats()
    conv_mult = clamp(0.5 + 1.5 * clamp(conviction, 0.0, 1.0), 0.5, 2.0)
    kelly_mult = stats.scale()
    risk_pct = clamp(risk.base_risk_per_trade_pct * conv_mult * kelly_mult * size_multiplier, 0.05, risk.max_risk_per_trade_pct)
    risk_amount = account.equity * risk_pct / 100.0
    reasons.append(
        f"risk {risk_pct:.2f}% of equity (base {risk.base_risk_per_trade_pct}% × conviction {conv_mult:.2f} × kelly {kelly_mult:.2f}"
        + (f" × size {size_multiplier:.2f}" if size_multiplier != 1.0 else "") + f") = {risk_amount:.2f} USDT"
    )
    qty = risk_amount / (entry * stop_pct / 100.0)
    notional = qty * entry
    lev, lev_reasons = choose_leverage(stop_pct, notional, filters, risk)
    reasons.extend(lev_reasons)
    margin = notional / lev
    # margin walls
    cap_margin = max(0.0, account.equity * risk.max_margin_fraction - account.used_margin)
    cap_margin = min(cap_margin, account.available)
    if margin > cap_margin:
        if cap_margin <= 0:
            reasons.append("no free margin inside the margin cap → no trade")
            return None
        scale = cap_margin / margin
        qty *= scale
        notional *= scale
        margin = cap_margin
        risk_amount *= scale
        reasons.append(f"size scaled ×{scale:.2f} to respect margin cap ({risk.max_margin_fraction:.0%} of equity)")
    qty = filters.round_qty(qty)
    if qty < filters.min_qty or qty * entry < filters.min_notional:
        reasons.append(f"quantity {qty} below exchange minimum (minQty {filters.min_qty}, minNotional {filters.min_notional}) → no trade")
        return None
    notional = qty * entry
    margin = notional / lev
    mmr, maint = filters.maintenance_margin(notional)
    liq = estimate_liquidation(side, entry, qty, margin, mmr, maint)
    # entries
    tranches = _tranches(sig, params, filters)
    for t in tranches:
        t.qty = filters.round_qty(qty * t.fraction)
    # drop tranches that round to zero and renormalise
    tranches = [t for t in tranches if t.qty >= filters.min_qty] or [EntryTranche(entry, 1.0, "market", qty, "single market entry")]
    tot = sum(t.qty for t in tranches)
    if tot <= 0:
        return None
    # take-profit ladder
    tp1_fraction = clamp(getattr(params, "tp1_fraction", 0.5), 0.1, 0.9)
    tps = [TakeProfit(filters.round_price(sig.tp1), tp1_fraction, "TP1 partial"),
           TakeProfit(filters.round_price(sig.tp2), 1.0 - tp1_fraction, "TP2 runner (trailed)")]
    time_stop = getattr(params, "time_stop_bars", 0) if sig.mode == "scalp" else getattr(params, "max_hold_bars", 0)
    plan = OrderPlan(
        symbol=sig.symbol, mode=sig.mode, side=side, entry_ref=filters.round_price(entry), stop=filters.round_price(stop),
        tranches=tranches, take_profits=tps, leverage=lev, total_qty=tot, notional=tot * entry, margin=tot * entry / lev,
        risk_amount=risk_amount, risk_pct=risk_pct, conviction=conviction, trail_atr=getattr(params, "trail_atr", 1.5),
        atr=sig.atr, time_stop_bars=int(time_stop), breakeven_after_r=getattr(params, "breakeven_after_r", 0.8),
        setup=sig.setup, regime=sig.regime, reasons=reasons, liquidation_est=liq,
        tags={"stop_pct": stop_pct, "reward_risk": sig.reward_risk, "strength": sig.strength},
    )
    plan.reasons.append(
        f"{side} {tot:g} {sig.symbol} @≈{entry:.6g} stop {stop:.6g} ({stop_pct:.2f}%) TP1 {sig.tp1:.6g} TP2 {sig.tp2:.6g} "
        f"lev {lev}x margin {plan.margin:.2f} liq≈{liq:.6g}"
    )
    return plan


def _tranches(sig: Signal, params: SwingParams | ScalpParams, filters: SymbolFilters) -> list[EntryTranche]:
    d = sig.direction
    atr = sig.atr if sig.atr > 0 else sig.entry * 0.005
    if sig.setup in ("pullback", "mean_revert", "vwap_revert"):
        ladder = [(0.0, 0.5, "market"), (0.5, 0.3, "limit"), (1.0, 0.2, "limit")]
        out: list[EntryTranche] = []
        for k, frac, kind in ladder:
            price = sig.entry - d * k * atr
            # never ladder beyond 70% of the way to the stop
            if k > 0 and abs(price - sig.entry) > 0.7 * abs(sig.stop - sig.entry):
                continue
            out.append(EntryTranche(filters.round_price(price), frac, kind,
                                    note="scale into weakness" if k > 0 else "initial tranche"))
        total = sum(t.fraction for t in out)
        for t in out:
            t.fraction /= total
        return out
    if sig.mode == "swing" and sig.setup == "breakout":
        return [EntryTranche(filters.round_price(sig.entry), 0.7, "market", note="breakout entry"),
                EntryTranche(filters.round_price(sig.entry - d * 0.4 * atr), 0.3, "limit", note="retest add")]
    return [EntryTranche(filters.round_price(sig.entry), 1.0, "market", note="momentum entry at market")]
