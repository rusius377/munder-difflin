"""backtrader adapter — independent confirmation of a parameter set.

The built-in engine is what the optimizer hammers; backtrader (``pip install
backtrader``) re-runs the winner with its own broker, order book semantics
(Stop / Limit exec types, OCO), commission scheme and analyzers. If the two
engines disagree wildly the learner refuses to promote the candidate.

Signals are *not* recomputed inside backtrader: the frame produced by
``compute_swing`` / ``compute_scalp`` is fed as extra data lines so both engines
trade the very same bars. Execution rules are reproduced with native orders:

* market entry on the next bar (``cheat-on-close`` off),
* protective ``Stop`` for the full size, ``Limit`` TP1 for a fraction,
  ``Limit`` TP2 for the rest in an OCO group with the stop,
* on TP1 fill the stop is re-issued at breakeven for the remainder,
* ATR trailing when the trade is ≥ 1R in profit, and a time stop.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pandas as pd

from ..config import RiskSettings
from ..strategy.params import ScalpParams, SwingParams
from ..strategy.position_sizing import choose_leverage
from ..strategy.signals import compute_scalp, compute_swing
from ..symbols import SymbolFilters
from .engine import BacktestResult, Trade
from .scorer import Metrics, compute_metrics


def backtrader_available() -> bool:
    try:
        import backtrader  # noqa: F401

        return True
    except ImportError:
        return False


@dataclass
class BacktraderRun:
    result: BacktestResult
    metrics: Metrics
    analyzers: dict[str, Any]


def run_backtrader(df: pd.DataFrame, mode: str, params: SwingParams | ScalpParams, *, risk: RiskSettings,
                   filters: SymbolFilters, symbol: str = "SYM", context: pd.DataFrame | None = None,
                   starting_balance: float = 10_000.0, taker_fee: float = 0.0005, maker_fee: float = 0.0002,
                   risk_pct: float = 1.0, precomputed: pd.DataFrame | None = None, interval: str | None = None) -> BacktraderRun:
    import backtrader as bt

    f = precomputed if precomputed is not None else (compute_swing(df, params, context) if mode == "swing" else compute_scalp(df, params, context))
    f = f.copy()
    f["sig_stop"] = f["sig_stop"].fillna(0.0)
    f["sig_tp1"] = f["sig_tp1"].fillna(0.0)
    f["sig_tp2"] = f["sig_tp2"].fillna(0.0)
    f.index = f.index.tz_localize(None) if getattr(f.index, "tz", None) is not None else f.index
    interval = interval or ("1h" if mode == "swing" else "1m")

    class SignalData(bt.feeds.PandasData):
        lines = ("sig_dir", "sig_stop", "sig_tp1", "sig_tp2", "sig_strength", "atr", "adx", "ema_fast_slope")
        params = (("datetime", None), ("open", "open"), ("high", "high"), ("low", "low"), ("close", "close"),
                  ("volume", "volume"), ("openinterest", None), ("sig_dir", "sig_dir"), ("sig_stop", "sig_stop"),
                  ("sig_tp1", "sig_tp1"), ("sig_tp2", "sig_tp2"), ("sig_strength", "sig_strength"), ("atr", "atr"),
                  ("adx", "adx"), ("ema_fast_slope", "ema_fast_slope"))

    class PerpCommInfo(bt.CommInfoBase):
        params = (("stocklike", False), ("commtype", bt.CommInfoBase.COMM_PERC), ("percabs", True),
                  ("leverage_x", 10.0), ("maker", maker_fee))

        def get_margin(self, price):
            return price / self.p.leverage_x

        def _getcommission(self, size, price, pseudoexec):
            return abs(size) * self.p.commission * price

    trades_log: list[Trade] = []
    equity_log: list[tuple[pd.Timestamp, float]] = []
    desk_params = params  # class bodies cannot see a function argument shadowed by a class attribute

    class DeskStrategy(bt.Strategy):
        params = dict(tp1_fraction=getattr(desk_params, "tp1_fraction", 0.5),
                      time_stop=getattr(desk_params, "time_stop_bars", 0) if mode == "scalp" else getattr(desk_params, "max_hold_bars", 0),
                      breakeven_after_r=getattr(desk_params, "breakeven_after_r", 0.8),
                      trail_atr=getattr(desk_params, "trail_atr", 1.5), risk_pct=risk_pct)

        def __init__(self):
            self.entry_order = None
            self.stop_order = None
            self.tp1_order = None
            self.tp2_order = None
            self.pending_signal = None
            self.entry_bar = None
            self.entry_price = 0.0
            self.initial_risk = 0.0
            self.direction = 0
            self.qty = 0.0
            self.stop_price = 0.0
            self.tp1_price = 0.0
            self.tp2_price = 0.0
            self.mfe = 0.0
            self.mae = 0.0
            self.partials = 0
            self.lev = 1
            self.setup_tag = ""
            self.conviction = 0.0
            self.last_exit_price = 0.0
            self.last_exit_reason = ""

        # ---------------------------------------------------------------- helpers
        def _cancel(self, order):
            if order is not None and order.alive():
                self.broker.cancel(order)

        def _place_exits(self, remaining: float, stop_price: float, with_tp1: bool = False):
            """(Re)issue the protective stop, the TP2 full close and optionally the partial TP1, all in one OCO group.

            A fill of any one cancels the others, so a bar that trades through two
            levels can never over-close and flip the position. The stop is submitted
            first so a bar touching both stop and target resolves adverse-first.
            """
            d = self.direction
            for o in (self.stop_order, self.tp1_order, self.tp2_order):
                self._cancel(o)
            self.stop_order = self.tp1_order = self.tp2_order = None
            q1 = min(remaining, self.qty * self.p.tp1_fraction) if with_tp1 else 0.0
            place = self.sell if d > 0 else self.buy
            self.stop_order = place(size=remaining, exectype=bt.Order.Stop, price=stop_price)
            if with_tp1 and q1 > 0 and q1 < remaining:
                self.tp1_order = place(size=q1, exectype=bt.Order.Limit, price=self.tp1_price, oco=self.stop_order)
            self.tp2_order = place(size=remaining, exectype=bt.Order.Limit, price=self.tp2_price, oco=self.stop_order)
            self.stop_price = stop_price

        # ---------------------------------------------------------------- lifecycle
        def notify_order(self, order):
            if order.status in (order.Submitted, order.Accepted):
                return
            ref = order.ref
            if order.status == order.Completed:
                if self.entry_order is not None and ref == self.entry_order.ref:
                    self.entry_price = order.executed.price
                    self.qty = abs(order.executed.size)
                    self.entry_bar = len(self)
                    d = self.direction
                    # keep the signal's stop distance relative to the actual fill
                    shift = self.entry_price - self.pending_signal["entry"]
                    self.stop_price = self.pending_signal["stop"] + shift
                    self.tp1_price = self.pending_signal["tp1"] + shift
                    self.tp2_price = self.pending_signal["tp2"] + shift
                    self.initial_risk = abs(self.entry_price - self.stop_price)
                    self._place_exits(self.qty, self.stop_price, with_tp1=True)
                    self.entry_order = None
                elif self.tp1_order is not None and ref == self.tp1_order.ref:
                    self.partials += 1
                    self.last_exit_price, self.last_exit_reason = order.executed.price, "tp1"
                    self.tp1_order = None
                    remaining = abs(self.position.size)
                    if remaining > 0:
                        be = self.entry_price + self.direction * max(float(self.data.atr[0]) * 0.1, self.entry_price * 0.0003)
                        new_stop = max(self.stop_price, be) if self.direction > 0 else min(self.stop_price, be)
                        self._place_exits(remaining, new_stop, with_tp1=False)
                elif (self.stop_order is not None and ref == self.stop_order.ref) or (self.tp2_order is not None and ref == self.tp2_order.ref):
                    self.last_exit_price = order.executed.price
                    self.last_exit_reason = "stop" if (self.stop_order is not None and ref == self.stop_order.ref) else "tp2"
                    self.stop_order = self.tp2_order = self.tp1_order = None  # OCO cancelled the rest
            elif order.status in (order.Canceled, order.Margin, order.Rejected):
                if self.entry_order is not None and ref == self.entry_order.ref:
                    self.entry_order = None

        def notify_trade(self, trade):
            if not trade.isclosed:
                return
            pnl = trade.pnlcomm
            r = pnl / (self.initial_risk * (self.qty or 1.0)) if self.initial_risk > 0 else 0.0
            ts = int(pd.Timestamp(bt.num2date(trade.dtclose)).timestamp() * 1000)
            ts_open = int(pd.Timestamp(bt.num2date(trade.dtopen)).timestamp() * 1000)
            trades_log.append(Trade(symbol=symbol, mode=mode, side="LONG" if self.direction > 0 else "SHORT", entry_ts=ts_open,
                                    exit_ts=ts, entry_price=self.entry_price, exit_price=self.last_exit_price or trade.price, qty=self.qty,
                                    leverage=self.lev, pnl=pnl, fees=trade.commission, funding=0.0, r_multiple=r,
                                    bars_held=trade.barlen, exit_reason=self.last_exit_reason or "close", mfe_r=self.mfe, mae_r=self.mae,
                                    setup=self.setup_tag, regime="?", conviction=self.conviction, partial_exits=self.partials))
            self.direction = 0
            self.mfe = self.mae = 0.0
            self.partials = 0
            self.initial_risk = 0.0

        def next(self):
            equity_log.append((pd.Timestamp(self.data.datetime.datetime(0)), float(self.broker.getvalue())))
            if self.position:
                d = self.direction
                if self.initial_risk > 0:
                    high, low = float(self.data.high[0]), float(self.data.low[0])
                    fav = (high - self.entry_price) / self.initial_risk if d > 0 else (self.entry_price - low) / self.initial_risk
                    adv = (self.entry_price - low) / self.initial_risk if d > 0 else (high - self.entry_price) / self.initial_risk
                    self.mfe, self.mae = max(self.mfe, fav), max(self.mae, adv)
                bars = len(self) - (self.entry_bar or len(self))
                close = float(self.data.close[0])
                r_now = (close - self.entry_price) * d / self.initial_risk if self.initial_risk > 0 else 0.0
                if self.p.time_stop and bars >= self.p.time_stop and r_now < 0.3:
                    self._cancel(self.tp1_order); self._cancel(self.stop_order); self._cancel(self.tp2_order)
                    self.last_exit_reason = "time_stop"
                    self.last_exit_price = close
                    self.close()
                    return
                atr = float(self.data.atr[0])
                adx = float(self.data.adx[0]) if self.data.adx[0] == self.data.adx[0] else 0.0
                if r_now >= 1.0 and adx >= 25 and atr > 0:
                    trail = close - d * self.p.trail_atr * atr
                    if (d > 0 and trail > self.stop_price) or (d < 0 and trail < self.stop_price):
                        self._place_exits(abs(self.position.size), trail, with_tp1=self.tp1_order is not None)
                elif r_now >= self.p.breakeven_after_r:
                    be = self.entry_price + d * max(atr * 0.1, self.entry_price * 0.0003)
                    if (d > 0 and be > self.stop_price) or (d < 0 and be < self.stop_price):
                        self._place_exits(abs(self.position.size), be, with_tp1=self.tp1_order is not None)
                return
            if self.entry_order is not None:
                return
            sd = int(self.data.sig_dir[0])
            if sd == 0:
                return
            entry = float(self.data.close[0])
            stop = float(self.data.sig_stop[0])
            if stop <= 0 or abs(entry - stop) / entry < 0.0001:
                return
            stop_pct = abs(entry - stop) / entry * 100.0
            equity = float(self.broker.getvalue())
            risk_amount = equity * self.p.risk_pct / 100.0
            qty = filters.round_qty(risk_amount / (entry * stop_pct / 100.0))
            if qty < filters.min_qty or qty * entry < filters.min_notional:
                return
            lev, _ = choose_leverage(stop_pct, qty * entry, filters, risk)
            self.lev = lev
            comm = PerpCommInfo(commission=taker_fee, leverage_x=float(lev))
            self.broker.addcommissioninfo(comm, name=self.data._name)
            # margin wall
            if qty * entry / lev > equity * risk.max_margin_fraction:
                qty = filters.round_qty(equity * risk.max_margin_fraction * lev / entry)
                if qty < filters.min_qty:
                    return
            self.direction = sd
            self.conviction = float(self.data.sig_strength[0])
            self.setup_tag = "signal"
            self.pending_signal = {"entry": entry, "stop": stop, "tp1": float(self.data.sig_tp1[0]), "tp2": float(self.data.sig_tp2[0])}
            self.entry_order = self.buy(size=qty) if sd > 0 else self.sell(size=qty)

    cerebro = bt.Cerebro(stdstats=False)
    cerebro.broker.setcash(starting_balance)
    cerebro.broker.set_coc(False)
    data = SignalData(dataname=f, name=symbol)
    cerebro.adddata(data)
    cerebro.broker.addcommissioninfo(PerpCommInfo(commission=taker_fee, leverage_x=10.0), name=symbol)
    cerebro.addstrategy(DeskStrategy)
    cerebro.addanalyzer(bt.analyzers.TradeAnalyzer, _name="trades")
    cerebro.addanalyzer(bt.analyzers.DrawDown, _name="dd")
    results = cerebro.run()
    strat = results[0]
    ending = float(cerebro.broker.getvalue())
    if equity_log:
        idx, vals = zip(*equity_log)
        curve = pd.Series(vals, index=pd.DatetimeIndex(idx))
    else:
        curve = pd.Series([starting_balance], index=pd.DatetimeIndex([f.index[0]]))
    res = BacktestResult(symbol=symbol, mode=mode, starting_balance=starting_balance, ending_balance=ending, trades=trades_log,
                         equity_curve=curve, bars=len(f), interval=interval, params=params.__dict__.copy())
    analyzers = {}
    try:
        analyzers["trades"] = dict(strat.analyzers.trades.get_analysis())
        analyzers["drawdown"] = dict(strat.analyzers.dd.get_analysis())
    except Exception:
        pass
    return BacktraderRun(res, compute_metrics(res), analyzers)
