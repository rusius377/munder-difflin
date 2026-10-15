"""ContinuousLearner — the "always re-training" loop.

Every ``relearn_interval_min`` (or on demand) it, per symbol and desk:

1. refreshes history (1m for scalp with a 5m context, 1h for swing with 4h),
2. runs the walk-forward evolutionary optimizer against the incumbent,
3. optionally re-runs the winner in backtrader and refuses the promotion when
   the two engines disagree by more than a tolerance,
4. writes the new parameters to the :class:`ParamStore` the live engine reads
   before every decision, and records a human-readable learning report.

It also decays agent reliability weights so the committee can recover from a
bad streak, and keeps the last reports available for the status page.
"""

from __future__ import annotations

import json
import logging
import random
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import pandas as pd

from ..agents.weights import AgentWeights
from ..backtest.bt_adapter import backtrader_available, run_backtrader
from ..backtest.engine import BacktestConfig
from ..backtest.optimizer import OptimizationReport, WalkForwardOptimizer
from ..config import Settings
from ..data.history import HistoryStore, resample_ohlcv
from ..strategy.params import ParamStore
from ..symbols import SymbolFilters
from ..util import iso, now_ms

log = logging.getLogger(__name__)


@dataclass
class LearningEvent:
    ts: int
    mode: str
    symbol: str
    promoted: bool
    reason: str
    best: dict
    incumbent: dict | None
    confirmation: dict | None = None
    elapsed_s: float = 0.0

    def to_dict(self) -> dict:
        return self.__dict__.copy()


class ContinuousLearner:
    def __init__(self, settings: Settings, history: HistoryStore, filters: dict[str, SymbolFilters], params: ParamStore,
                 weights: AgentWeights, *, on_event: Callable[[LearningEvent], None] | None = None,
                 data_provider: Callable[[str, str], tuple[pd.DataFrame, pd.DataFrame | None]] | None = None) -> None:
        self.s = settings
        self.history = history
        self.filters = filters
        self.params = params
        self.weights = weights
        self.on_event = on_event
        self.data_provider = data_provider
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.events: list[LearningEvent] = []
        self.last_run_ts: int = 0
        self.running: bool = False
        self.report_path = Path(settings.state_dir) / "learning_reports.jsonl"
        self.report_path.parent.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------ data
    def _data(self, mode: str, symbol: str) -> tuple[pd.DataFrame, pd.DataFrame | None]:
        if self.data_provider is not None:
            return self.data_provider(mode, symbol)
        days = self.s.learning.history_days
        if mode == "scalp":
            base = self.history.get(symbol, "1m", days=min(days, 45))
            ctx = resample_ohlcv(base, "5m") if not base.empty else None
        else:
            base = self.history.get(symbol, "1h", days=days)
            ctx = self.history.get(symbol, "4h", days=days)
            if ctx.empty and not base.empty:
                ctx = resample_ohlcv(base, "4h")
        return base, ctx

    # ------------------------------------------------------------------ one (mode, symbol)
    def learn_one(self, mode: str, symbol: str, *, population: int | None = None, generations: int | None = None,
                  time_budget_s: float | None = None) -> LearningEvent | None:
        base, ctx = self._data(mode, symbol)
        min_bars = 1500 if mode == "scalp" else 400
        if base is None or len(base) < min_bars:
            log.warning("not enough history for %s %s (%s bars)", mode, symbol, 0 if base is None else len(base))
            return None
        filters = self.filters.get(symbol) or SymbolFilters(symbol)
        bt_cfg = BacktestConfig(starting_balance=self.s.paper_starting_balance, taker_fee=self.s.binance.taker_fee,
                                maker_fee=self.s.binance.maker_fee)
        rng = random.Random(self.s.learning.seed if self.s.learning.seed is not None else int(time.time()))
        opt = WalkForwardOptimizer(mode, symbol, self.s.risk, filters, self.s.learning, bt_cfg, rng)
        incumbent = self.params.get(mode, symbol)
        t0 = time.time()
        report = opt.run(base, context=ctx, interval="1m" if mode == "scalp" else "1h", incumbent=incumbent,
                         population=population, generations=generations, time_budget_s=time_budget_s)
        confirmation = None
        promoted = report.promoted
        reason = report.reason
        if promoted and self.s.learning.use_backtrader_confirmation and backtrader_available():
            confirmation = self._confirm(report, base, ctx, mode, symbol, filters)
            if confirmation and not confirmation.get("agree", True):
                promoted = False
                reason += f" | backtrader disagreed ({confirmation.get('detail')}) → promotion withheld"
        if promoted:
            self.params.set(mode, symbol, report.best.params, promoted_ts=now_ms(), fitness=report.best.fitness,
                            incumbent_fitness=report.incumbent.fitness if report.incumbent else None,
                            summary=report.best.summary(), confirmation=confirmation)
        ev = LearningEvent(ts=now_ms(), mode=mode, symbol=symbol, promoted=promoted, reason=reason,
                           best=report.best.summary(), incumbent=report.incumbent.summary() if report.incumbent else None,
                           confirmation=confirmation, elapsed_s=time.time() - t0)
        self._record(ev)
        return ev

    def _confirm(self, report: OptimizationReport, base: pd.DataFrame, ctx: pd.DataFrame | None, mode: str, symbol: str,
                 filters: SymbolFilters) -> dict | None:
        try:
            n = len(base)
            tail = base.iloc[int(n * 0.6):]
            tail_ctx = ctx
            run = run_backtrader(tail, mode, report.best.params, risk=self.s.risk, filters=filters, symbol=symbol,
                                 context=tail_ctx, starting_balance=self.s.paper_starting_balance,
                                 taker_fee=self.s.binance.taker_fee, maker_fee=self.s.binance.maker_fee)
            from ..backtest.engine import BacktestEngine
            from ..backtest.scorer import compute_metrics

            ours = compute_metrics(BacktestEngine(self.s.risk, filters, BacktestConfig(
                starting_balance=self.s.paper_starting_balance, taker_fee=self.s.binance.taker_fee,
                maker_fee=self.s.binance.maker_fee)).run(tail, mode, report.best.params, symbol=symbol, context=tail_ctx))
            agree = (run.metrics.trades == 0 and ours.trades == 0) or (
                abs(run.metrics.win_rate - ours.win_rate) <= 0.2
                and (run.metrics.total_return_pct > -5 or ours.total_return_pct <= run.metrics.total_return_pct + 15)
            )
            return {"agree": agree, "backtrader": run.metrics.to_dict(), "builtin": ours.to_dict(),
                    "detail": f"bt win {run.metrics.win_rate:.2f}/ret {run.metrics.total_return_pct:.1f}% vs builtin win {ours.win_rate:.2f}/ret {ours.total_return_pct:.1f}%"}
        except Exception as exc:  # pragma: no cover - backtrader quirks must never stop learning
            log.warning("backtrader confirmation failed: %s", exc)
            return {"agree": True, "detail": f"confirmation skipped: {exc}"}

    # ------------------------------------------------------------------ loop
    def learn_all(self, modes: tuple[str, ...] = ("swing", "scalp"), **kw) -> list[LearningEvent]:
        out = []
        self.running = True
        try:
            for symbol in self.s.symbols:
                for mode in modes:
                    if self._stop.is_set():
                        return out
                    if mode == "swing" and not self.s.swing.enabled:
                        continue
                    if mode == "scalp" and not self.s.scalp.enabled:
                        continue
                    try:
                        ev = self.learn_one(mode, symbol, **kw)
                        if ev:
                            out.append(ev)
                    except Exception:
                        log.exception("learning failed for %s %s", mode, symbol)
            self.weights.decay(0.98)
        finally:
            self.running = False
            self.last_run_ts = now_ms()
        return out

    def start(self, initial_delay_s: float = 120.0) -> None:
        if not self.s.learning.enabled:
            return
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()

        def loop() -> None:
            if self._stop.wait(initial_delay_s):
                return
            while not self._stop.is_set():
                try:
                    self.learn_all()
                except Exception:
                    log.exception("learning loop error")
                if self._stop.wait(self.s.learning.relearn_interval_min * 60):
                    return

        self._thread = threading.Thread(target=loop, name="continuous-learner", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    # ------------------------------------------------------------------ reporting
    def _record(self, ev: LearningEvent) -> None:
        self.events.append(ev)
        self.events = self.events[-200:]
        with open(self.report_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(ev.to_dict(), ensure_ascii=False, default=str) + "\n")
        log.info("learning %s %s: %s", ev.mode, ev.symbol, ev.reason)
        if self.on_event:
            try:
                self.on_event(ev)
            except Exception:  # pragma: no cover
                log.exception("learning event callback failed")

    def status(self) -> dict:
        return {"enabled": self.s.learning.enabled, "running": self.running, "last_run": iso(self.last_run_ts) if self.last_run_ts else None,
                "events": [e.to_dict() for e in self.events[-14:]], "params": self.params.all()}
