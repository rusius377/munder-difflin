"""Evolutionary parameter search with walk-forward validation.

The learner never trusts an in-sample number. Data is cut into ``K`` chronological
folds; each candidate is scored on every fold's *test* window after being seen
on the train window (signals are causal, so a single signal computation can be
sliced). Fitness is the mean out-of-sample score minus a dispersion penalty and
an overfitting penalty (train ≫ test). A candidate only replaces the incumbent
when it beats it out-of-sample by ``promotion_margin``.
"""

from __future__ import annotations

import logging
import random
import time
from dataclasses import dataclass, field
from typing import Callable

import numpy as np
import pandas as pd

from ..config import LearningSettings, RiskSettings
from ..strategy.params import (ScalpParams, SwingParams, crossover, mutate, params_for, random_params, to_dict)
from ..strategy.signals import compute_scalp, compute_swing
from ..symbols import SymbolFilters
from .engine import BacktestConfig, BacktestEngine
from .scorer import Metrics, compute_metrics

log = logging.getLogger(__name__)


@dataclass
class Candidate:
    params: SwingParams | ScalpParams
    train_scores: list[float] = field(default_factory=list)
    test_scores: list[float] = field(default_factory=list)
    test_metrics: list[Metrics] = field(default_factory=list)
    fitness: float = -9.0
    origin: str = "random"

    def summary(self) -> dict:
        tm = self.test_metrics
        agg = {}
        if tm:
            agg = {
                "trades": int(sum(m.trades for m in tm)), "win_rate": float(np.mean([m.win_rate for m in tm])),
                "return_per_day_pct": float(np.mean([m.return_per_day_pct for m in tm])),
                "max_drawdown_pct": float(np.max([m.max_drawdown_pct for m in tm])),
                "profit_factor": float(np.mean([min(5.0, m.profit_factor) for m in tm])),
                "tp_capture": float(np.mean([m.tp_capture for m in tm])),
                "avg_bars_loss": float(np.mean([m.avg_bars_loss for m in tm])),
                "liquidations": int(sum(m.liquidations for m in tm)),
            }
        return {"params": to_dict(self.params), "fitness": round(self.fitness, 4), "origin": self.origin,
                "train_mean": round(float(np.mean(self.train_scores)), 4) if self.train_scores else None,
                "test_mean": round(float(np.mean(self.test_scores)), 4) if self.test_scores else None,
                "test_std": round(float(np.std(self.test_scores)), 4) if self.test_scores else None, **agg}


@dataclass
class OptimizationReport:
    mode: str
    symbol: str
    best: Candidate
    incumbent: Candidate | None
    promoted: bool
    generations: int
    evaluations: int
    elapsed_s: float
    hall_of_fame: list[Candidate]
    reason: str

    def to_dict(self) -> dict:
        return {"mode": self.mode, "symbol": self.symbol, "best": self.best.summary(),
                "incumbent": self.incumbent.summary() if self.incumbent else None, "promoted": self.promoted,
                "generations": self.generations, "evaluations": self.evaluations, "elapsed_s": round(self.elapsed_s, 1),
                "hall_of_fame": [c.summary() for c in self.hall_of_fame[:5]], "reason": self.reason}


class WalkForwardOptimizer:
    def __init__(self, mode: str, symbol: str, risk: RiskSettings, filters: SymbolFilters, learning: LearningSettings,
                 bt_config: BacktestConfig | None = None, rng: random.Random | None = None) -> None:
        self.mode = mode
        self.symbol = symbol
        self.risk = risk
        self.filters = filters
        self.learning = learning
        self.bt_config = bt_config or BacktestConfig()
        self.rng = rng or random.Random(learning.seed)
        self.engine = BacktestEngine(risk, filters, self.bt_config)
        self.evaluations = 0

    # ------------------------------------------------------------------ folds
    def folds(self, n: int) -> list[tuple[slice, slice]]:
        k = max(2, self.learning.walk_forward_folds)
        frac = min(0.9, max(0.5, self.learning.train_fraction))
        out = []
        seg = n // k
        warm = min(300, seg // 3)
        for j in range(k):
            start = j * seg
            end = n if j == k - 1 else (j + 1) * seg
            split = start + int((end - start) * frac)
            # train window includes a warm-up tail from before the fold so indicators are stable
            tr = slice(max(0, start - warm), split)
            te = slice(max(0, split - warm), end)
            out.append((tr, te))
        return out

    # ------------------------------------------------------------------ evaluation
    def evaluate(self, params: SwingParams | ScalpParams, df: pd.DataFrame, context: pd.DataFrame | None,
                 interval: str, origin: str = "random") -> Candidate:
        cand = Candidate(params=params, origin=origin)
        f = compute_swing(df, params, context) if self.mode == "swing" else compute_scalp(df, params, context)
        for tr, te in self.folds(len(f)):
            for sl, bucket in ((tr, cand.train_scores), (te, cand.test_scores)):
                part = f.iloc[sl]
                if len(part) < 50:
                    bucket.append(-2.0)
                    continue
                res = self.engine.run(part, self.mode, params, symbol=self.symbol, interval=interval, precomputed=part)
                m = compute_metrics(res, min_trades=max(3, self.learning.min_trades // max(2, self.learning.walk_forward_folds)))
                bucket.append(m.score)
                if bucket is cand.test_scores:
                    cand.test_metrics.append(m)
                self.evaluations += 1
        test = np.array(cand.test_scores)
        train = np.array(cand.train_scores)
        overfit = max(0.0, float(train.mean() - test.mean())) if len(train) and len(test) else 0.0
        cand.fitness = float(test.mean() - 0.5 * test.std() - 0.25 * overfit) if len(test) else -9.0
        return cand

    # ------------------------------------------------------------------ search
    def run(self, df: pd.DataFrame, *, context: pd.DataFrame | None = None, interval: str | None = None,
            incumbent: SwingParams | ScalpParams | None = None, population: int | None = None,
            generations: int | None = None, progress: Callable[[int, Candidate], None] | None = None,
            time_budget_s: float | None = None) -> OptimizationReport:
        t0 = time.time()
        interval = interval or ("1h" if self.mode == "swing" else "1m")
        pop_n = population or self.learning.population
        gens = generations or self.learning.generations
        base = incumbent or params_for(self.mode)
        inc_cand = self.evaluate(base, df, context, interval, origin="incumbent")
        pop: list[Candidate] = [inc_cand]
        while len(pop) < pop_n:
            if len(pop) < pop_n // 2:
                p = mutate(self.mode, base, self.rng, rate=0.5, scale=0.2)
                origin = "mutant"
            else:
                p = random_params(self.mode, self.rng)
                origin = "random"
            pop.append(self.evaluate(p, df, context, interval, origin))
        hall: list[Candidate] = sorted(pop, key=lambda c: -c.fitness)
        best = hall[0]
        stale = 0
        g = 0
        for g in range(1, gens + 1):
            if time_budget_s is not None and time.time() - t0 > time_budget_s:
                log.info("optimizer time budget reached at generation %d", g)
                break
            pop.sort(key=lambda c: -c.fitness)
            elite = pop[: max(2, pop_n // 4)]
            children: list[Candidate] = list(elite)
            while len(children) < pop_n:
                a, b = self.rng.sample(elite, 2) if len(elite) >= 2 else (elite[0], elite[0])
                child = crossover(self.mode, a.params, b.params, self.rng)
                child = mutate(self.mode, child, self.rng, rate=0.35, scale=0.15)
                children.append(self.evaluate(child, df, context, interval, origin=f"gen{g}"))
            pop = children
            hall = sorted(hall + pop, key=lambda c: -c.fitness)[:20]
            if hall[0].fitness > best.fitness + 1e-9:
                best = hall[0]
                stale = 0
            else:
                stale += 1
            if progress:
                progress(g, best)
            if stale >= 3:
                break
        promoted = best is not inc_cand and best.fitness >= inc_cand.fitness + self.learning.promotion_margin
        if best is inc_cand:
            reason = "incumbent parameters remain the best out-of-sample"
        elif promoted:
            reason = (f"candidate beat the incumbent out-of-sample ({best.fitness:.3f} vs {inc_cand.fitness:.3f}, "
                      f"margin {self.learning.promotion_margin})")
        else:
            reason = (f"best candidate {best.fitness:.3f} did not clear the promotion margin over the incumbent "
                      f"{inc_cand.fitness:.3f}")
        return OptimizationReport(self.mode, self.symbol, best if promoted else inc_cand, inc_cand, promoted, g,
                                  self.evaluations, time.time() - t0, hall, reason)
