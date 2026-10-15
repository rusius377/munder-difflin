"""Built-in event-driven backtester for both desks.

Fast enough for thousands of optimisation runs (vectorised signals, a light
Python loop per bar) yet faithful to how the live engine behaves:

* entries fill on the *next* bar's open (no look-ahead), market tranches pay
  taker fee + slippage, limit tranches fill when price trades through them;
* stops / take-profits resolve intrabar, adverse-first when both are touched
  in one bar (conservative);
* partial TP1, breakeven move, ATR trailing driven by the same
  :class:`HoldPolicy` used live, time stops, liquidation checks;
* funding every eight hours, leverage selected by the same sizer.

The trade log records R-multiples, MFE/MAE and bars held so the scorer can
measure stop speed and take-profit capture, not just P&L.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd

from ..config import RiskSettings
from ..strategy.params import ScalpParams, SwingParams
from ..strategy.plan import AccountState, Position, TakeProfit
from ..strategy.position_sizing import PerformanceStats, build_plan
from ..strategy.risk import HoldPolicy
from ..strategy.signals import SETUPS, Signal, compute_scalp, compute_swing
from ..symbols import SymbolFilters
from ..util import interval_ms


@dataclass
class Trade:
    symbol: str
    mode: str
    side: str
    entry_ts: int
    exit_ts: int
    entry_price: float
    exit_price: float
    qty: float
    leverage: int
    pnl: float                # net of fees and funding
    fees: float
    funding: float
    r_multiple: float
    bars_held: int
    exit_reason: str
    mfe_r: float              # max favourable excursion in R
    mae_r: float              # max adverse excursion in R
    setup: str
    regime: str
    conviction: float
    partial_exits: int = 0
    tags: dict[str, Any] = field(default_factory=dict)

    @property
    def won(self) -> bool:
        return self.pnl > 0


@dataclass
class BacktestResult:
    symbol: str
    mode: str
    starting_balance: float
    ending_balance: float
    trades: list[Trade]
    equity_curve: pd.Series
    bars: int
    interval: str
    liquidations: int = 0
    params: dict[str, Any] = field(default_factory=dict)

    @property
    def total_return_pct(self) -> float:
        return (self.ending_balance / self.starting_balance - 1.0) * 100.0 if self.starting_balance else 0.0


@dataclass
class BacktestConfig:
    starting_balance: float = 10_000.0
    taker_fee: float = 0.0005
    maker_fee: float = 0.0002
    slippage_bps: float = 1.5
    funding_rate: float = 0.0001      # per 8h, applied to notional (longs pay when positive)
    conviction_floor: float = 0.35
    committee: Any | None = None      # optional callable(signal, frame, i) -> (conviction, size_multiplier, approve)
    allow_pyramiding: bool = False
    size_scale: float = 1.0           # extra multiplier on risk per trade (learning knob)


class BacktestEngine:
    def __init__(self, risk: RiskSettings, filters: SymbolFilters, config: BacktestConfig | None = None) -> None:
        self.risk = risk
        self.filters = filters
        self.cfg = config or BacktestConfig()
        self.hold_policy = HoldPolicy()

    # ------------------------------------------------------------------ public
    def run(self, df: pd.DataFrame, mode: str, params: SwingParams | ScalpParams, *, symbol: str = "SYM",
            context: pd.DataFrame | None = None, interval: str | None = None, precomputed: pd.DataFrame | None = None) -> BacktestResult:
        if precomputed is not None:
            f = precomputed
        else:
            f = compute_swing(df, params, context) if mode == "swing" else compute_scalp(df, params, context)
        interval = interval or ("1h" if mode == "swing" else "1m")
        step = interval_ms(interval)
        n = len(f)
        o = f["open"].to_numpy(); h = f["high"].to_numpy(); l = f["low"].to_numpy(); c = f["close"].to_numpy()
        ts = f["close_time"].to_numpy() if "close_time" in f else (f["open_time"].to_numpy() + step - 1)
        sig_dir = f["sig_dir"].to_numpy(); sig_str = f["sig_strength"].to_numpy()
        sig_stop = f["sig_stop"].to_numpy(); sig_tp1 = f["sig_tp1"].to_numpy(); sig_tp2 = f["sig_tp2"].to_numpy()
        sig_setup = f["sig_setup"].to_numpy(); atr = f["atr"].to_numpy()
        adx = f["adx"].to_numpy() if "adx" in f else np.zeros(n)
        slope = f["ema_fast_slope"].to_numpy() if "ema_fast_slope" in f else np.zeros(n)
        rsi = f["rsi"].to_numpy() if "rsi" in f else np.full(n, 50.0)
        regime = f["regime"].to_numpy() if "regime" in f else np.full(n, "range", dtype=object)

        balance = self.cfg.starting_balance
        equity = [balance]
        eq_index = [f.index[0]]
        trades: list[Trade] = []
        pos: Position | None = None
        pending_limits: list[tuple[float, float]] = []   # (price, qty)
        pending_market: tuple[Signal, float, float, int, list] | None = None  # (signal, conviction, size_mult, bar_index, plan tranches)
        last_funding_bucket = int(ts[0] // (8 * 3_600_000))
        liquidations = 0
        stats = PerformanceStats()
        consecutive_losses = 0
        pnl_mfe = pnl_mae = 0.0

        def record_exit(i: int, price: float, qty: float, reason: str, taker: bool) -> None:
            nonlocal pos, balance, trades, consecutive_losses, stats
            assert pos is not None
            fee_rate = self.cfg.taker_fee if taker else self.cfg.maker_fee
            fee = qty * price * fee_rate
            gross = (price - pos.entry_price) * qty * pos.direction
            balance += gross - fee
            pos.realized_pnl += gross
            pos.fees_paid += fee
            pos.qty -= qty
            if pos.qty <= 1e-12 or reason in ("stop", "breakeven_stop", "liquidation", "time_stop", "take_quick", "final", "tp2"):
                # full close: book the trade
                qty_total = pos.original_qty
                pnl = pos.realized_pnl - pos.fees_paid - pos.funding_paid
                if pos.qty > 1e-12:  # close remainder at the same price
                    gross2 = (price - pos.entry_price) * pos.qty * pos.direction
                    fee2 = pos.qty * price * fee_rate
                    balance += gross2 - fee2
                    pnl += gross2 - fee2
                    pos.qty = 0.0
                r_mult = (pnl / (pos.initial_risk * qty_total)) if pos.initial_risk > 0 and qty_total > 0 else 0.0
                trades.append(Trade(
                    symbol=symbol, mode=mode, side=pos.side, entry_ts=pos.opened_ts, exit_ts=int(ts[i]),
                    entry_price=pos.entry_price, exit_price=price, qty=qty_total, leverage=pos.leverage, pnl=pnl,
                    fees=pos.fees_paid, funding=pos.funding_paid, r_multiple=r_mult, bars_held=pos.bars_held,
                    exit_reason=reason, mfe_r=pos.tags.get("mfe_r", 0.0), mae_r=pos.tags.get("mae_r", 0.0),
                    setup=pos.tags.get("setup", "?"), regime=pos.tags.get("regime", "?"),
                    conviction=pos.tags.get("conviction", 0.0), partial_exits=pos.tags.get("partials", 0),
                ))
                consecutive_losses = consecutive_losses + 1 if pnl <= 0 else 0
                pos = None
            else:
                pos.tags["partials"] = pos.tags.get("partials", 0) + 1

        for i in range(n):
            # ---- fill pending market entry at this bar's open (signal came from bar i-1)
            if pending_market is not None and pos is None:
                sig, conv, size_mult, j, tranches = pending_market
                pending_market = None
                acct = AccountState(equity=balance, available=balance, used_margin=0.0, consecutive_losses=consecutive_losses)
                plan = build_plan(sig, conviction=conv, account=acct, filters=self.filters, risk=self.risk, params=params,
                                  stats=stats, size_multiplier=size_mult * self.cfg.size_scale)
                if plan is not None:
                    slip = o[i] * self.cfg.slippage_bps / 10_000 * plan.direction
                    fill_px = o[i] + slip
                    mk = [t for t in plan.tranches if t.kind == "market"]
                    lim = [t for t in plan.tranches if t.kind == "limit"]
                    qty0 = sum(t.qty for t in mk) or plan.total_qty
                    fee = qty0 * fill_px * self.cfg.taker_fee
                    balance -= fee
                    # keep the original stop distance relative to the signal entry
                    stop = plan.stop + (fill_px - plan.entry_ref)
                    tps = [TakeProfit(tp.price + (fill_px - plan.entry_ref), tp.fraction, tp.note) for tp in plan.take_profits]
                    pos = Position(symbol=symbol, side=plan.side, qty=qty0, entry_price=fill_px, leverage=plan.leverage,
                                   margin=qty0 * fill_px / plan.leverage, stop=stop, take_profits=tps, mode=mode,
                                   opened_ts=int(ts[i]), trail_atr=plan.trail_atr, atr=plan.atr,
                                   time_stop_bars=plan.time_stop_bars, breakeven_after_r=plan.breakeven_after_r,
                                   initial_risk=abs(fill_px - stop), fees_paid=fee, original_qty=qty0,
                                   liquidation_price=plan.liquidation_est,
                                   tags={"setup": plan.setup, "regime": plan.regime, "conviction": conv, "mfe_r": 0.0, "mae_r": 0.0})
                    pending_limits = [(t.price, t.qty) for t in lim]
            if pos is not None:
                pos.bars_held += 1
                d = pos.direction
                # ---- limit tranche fills (scale-in)
                still: list[tuple[float, float]] = []
                for price, qty in pending_limits:
                    hit = (d > 0 and l[i] <= price) or (d < 0 and h[i] >= price)
                    if hit:
                        fee = qty * price * self.cfg.maker_fee
                        balance -= fee
                        new_qty = pos.qty + qty
                        pos.entry_price = (pos.entry_price * pos.qty + price * qty) / new_qty
                        pos.qty = new_qty
                        pos.original_qty += qty
                        pos.fees_paid += fee
                        pos.margin = pos.qty * pos.entry_price / pos.leverage
                    else:
                        still.append((price, qty))
                pending_limits = still
                # ---- liquidation / stop / TP resolution (adverse first)
                # A resting STOP_MARKET fires before price can reach liquidation, so only a bar that
                # *opens* beyond the liquidation price (gap) liquidates.
                liq = pos.liquidation_price
                if liq is not None and ((d > 0 and o[i] <= liq) or (d < 0 and o[i] >= liq)):
                    liquidations += 1
                    pending_limits = []
                    record_exit(i, liq, pos.qty, "liquidation", True)
                    equity.append(balance); eq_index.append(f.index[i])
                    continue
                stop_hit = (d > 0 and l[i] <= pos.stop) or (d < 0 and h[i] >= pos.stop)
                if stop_hit:
                    # gap through the stop → fill at open
                    px = o[i] if ((d > 0 and o[i] < pos.stop) or (d < 0 and o[i] > pos.stop)) else pos.stop
                    px -= d * px * self.cfg.slippage_bps / 10_000
                    pending_limits = []
                    reason = "breakeven_stop" if pos.tags.get("be", False) else "stop"
                    record_exit(i, px, pos.qty, reason, True)
                    equity.append(balance); eq_index.append(f.index[i])
                    continue
                # take profits (maker fills at the limit)
                remaining_tps: list[TakeProfit] = []
                for tp in pos.take_profits:
                    hit = (d > 0 and h[i] >= tp.price) or (d < 0 and l[i] <= tp.price)
                    if hit and pos is not None:
                        is_last = tp is pos.take_profits[-1]
                        qty = pos.qty if is_last else min(pos.qty, pos.original_qty * tp.fraction)
                        record_exit(i, tp.price, qty, "tp2" if is_last else "tp1", False)
                        if pos is None:
                            break
                        if not is_last:
                            pos.tags["be"] = True
                            be = pos.entry_price + d * max(pos.atr * 0.1, pos.entry_price * 0.0003)
                            if (d > 0 and be > pos.stop) or (d < 0 and be < pos.stop):
                                pos.stop = be
                    else:
                        remaining_tps.append(tp)
                if pos is None:
                    equity.append(balance); eq_index.append(f.index[i])
                    continue
                pos.take_profits = remaining_tps
                if not pos.take_profits and pos.qty > 1e-12:
                    record_exit(i, c[i], pos.qty, "final", True)
                    equity.append(balance); eq_index.append(f.index[i])
                    continue
                # ---- excursion tracking
                if pos.initial_risk > 0:
                    fav = (h[i] - pos.entry_price) * d / pos.initial_risk if d > 0 else (pos.entry_price - l[i]) / pos.initial_risk
                    adv = (pos.entry_price - l[i]) / pos.initial_risk if d > 0 else (h[i] - pos.entry_price) / pos.initial_risk
                    pos.tags["mfe_r"] = max(pos.tags.get("mfe_r", 0.0), fav)
                    pos.tags["mae_r"] = max(pos.tags.get("mae_r", 0.0), adv)
                # ---- hold policy: breakeven, trailing, time stop, quick take
                hd = self.hold_policy.evaluate(pos, c[i], adx=float(adx[i]), ema_slope_pct=float(slope[i]), rsi=float(rsi[i]),
                                               atr=float(atr[i]), regime=str(regime[i]), bars_since_entry=pos.bars_held)
                if hd.action == "exit" or hd.action == "take_quick":
                    pending_limits = []
                    record_exit(i, c[i] - d * c[i] * self.cfg.slippage_bps / 10_000, pos.qty, "time_stop" if hd.action == "exit" else "take_quick", True)
                    equity.append(balance); eq_index.append(f.index[i])
                    continue
                if hd.new_stop is not None:
                    if (d > 0 and hd.new_stop > pos.stop) or (d < 0 and hd.new_stop < pos.stop):
                        pos.stop = hd.new_stop
                        pos.tags["be"] = True
                # ---- funding
                bucket = int(ts[i] // (8 * 3_600_000))
                if bucket != last_funding_bucket:
                    last_funding_bucket = bucket
                    fund = pos.qty * c[i] * self.cfg.funding_rate * (1 if d > 0 else -1)
                    balance -= fund
                    pos.funding_paid += fund
            else:
                last_funding_bucket = int(ts[i] // (8 * 3_600_000))

            # ---- new signal on this closed bar → enter at next open
            if pos is None and pending_market is None and sig_dir[i] != 0 and i < n - 1 and balance > 0:
                sig = Signal(mode=mode, symbol=symbol, ts=int(ts[i]), direction=int(sig_dir[i]), strength=float(sig_str[i]),
                             entry=float(c[i]), stop=float(sig_stop[i]), tp1=float(sig_tp1[i]), tp2=float(sig_tp2[i]),
                             atr=float(atr[i]), regime=str(regime[i]), setup=SETUPS.get(int(sig_setup[i]), "none"))
                conv, size_mult, ok = float(sig.strength), 1.0, True
                if self.cfg.committee is not None:
                    conv, size_mult, ok = self.cfg.committee(sig, f, i)
                if ok and conv >= self.cfg.conviction_floor:
                    pending_market = (sig, conv, size_mult, i, [])
            equity.append(balance + (pos.unrealized(c[i]) if pos is not None else 0.0))
            eq_index.append(f.index[i])

        # close anything left at the last close
        if pos is not None:
            record_exit(n - 1, c[-1], pos.qty, "final", True)
        curve = pd.Series(equity, index=pd.DatetimeIndex(eq_index))
        curve = curve[~curve.index.duplicated(keep="last")]
        return BacktestResult(symbol=symbol, mode=mode, starting_balance=self.cfg.starting_balance, ending_balance=balance,
                              trades=trades, equity_curve=curve, bars=n, interval=interval, liquidations=liquidations,
                              params=params.__dict__.copy())
