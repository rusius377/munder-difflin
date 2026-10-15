"""Offline self-test: runs the whole desk on synthetic data without any network or API key.

Used by ``munder-trader selftest`` and by CI. It exercises both desks' signal
engines, the committee, sizing and risk, the built-in backtester (+ backtrader
when installed), a mini walk-forward optimisation, the paper broker fill
simulation, trade reflection / memory and the journal.
"""

from __future__ import annotations

import random
import tempfile
import time
from pathlib import Path

from .agents.base import MarketContext
from .agents.graph import DeskGraph
from .backtest.bt_adapter import backtrader_available, run_backtrader
from .backtest.engine import BacktestConfig, BacktestEngine
from .backtest.optimizer import WalkForwardOptimizer
from .backtest.scorer import compute_metrics
from .config import Settings
from .data.history import resample_ohlcv, synthetic_ohlcv
from .data.orderbook import SyntheticBook
from .data.tradeflow import TradeFlow, synthetic_trades
from .execution.paper import PaperBroker
from .learn.feedback import TradeReflector
from .learn.memory import LessonMemory
from .live.journal import Journal
from .strategy.params import ScalpParams, SwingParams
from .strategy.plan import AccountState
from .strategy.position_sizing import build_plan
from .strategy.risk import RiskManager
from .strategy.signals import apply_microstructure, compute_scalp, compute_swing, signal_at
from .symbols import SymbolFilters


def run_selftest(settings: Settings | None = None, *, verbose: bool = True) -> dict:
    s = settings or Settings()
    out: dict = {}
    t0 = time.time()
    filters = SymbolFilters("ETHUSDT", tick_size=0.01, step_size=0.001, min_qty=0.001, min_notional=5, price_precision=2, qty_precision=3)
    filters.apply_brackets([{"notionalCap": 50000, "initialLeverage": 125, "maintMarginRatio": 0.004, "cum": 0},
                            {"notionalCap": 500000, "initialLeverage": 100, "maintMarginRatio": 0.005, "cum": 50}])
    # 1) signals for both desks
    df1m = synthetic_ohlcv(5000, "1m", 3000.0, seed=3)
    df5m = resample_ohlcv(df1m, "5m")
    sc = compute_scalp(df1m, ScalpParams(), df5m)
    df1h = synthetic_ohlcv(3000, "1h", 60000.0, seed=5)
    df4h = resample_ohlcv(df1h, "4h")
    sw = compute_swing(df1h, SwingParams(), df4h)
    out["scalp_signals"] = int((sc["sig_dir"] != 0).sum())
    out["swing_signals"] = int((sw["sig_dir"] != 0).sum())
    assert out["scalp_signals"] > 0 and out["swing_signals"] > 0, "signal engines produced nothing"
    # 2) committee on the last scalp signal with synthetic book/tape
    i = int(sc.index.get_loc(sc.index[sc["sig_dir"] != 0][-1]))
    sub = sc.iloc[: i + 1]
    sig = signal_at("scalp", "ETHUSDT", sub)
    book = SyntheticBook("ETHUSDT", sig.entry, tick=0.01, skew=0.3 * sig.direction).book().features(20)
    tf = TradeFlow("ETHUSDT")
    for tr in synthetic_trades(600, int(sub["close_time"].iloc[-1]) - 300_000, sig.entry, buy_bias=0.5 + 0.2 * sig.direction):
        tf.add(tr)
    sig = apply_microstructure(sig, book, tf.features(), ScalpParams())
    graph = DeskGraph(s.risk, s.llm)
    ctx = MarketContext(symbol="ETHUSDT", mode="scalp", ts=sig.ts, price=sig.entry, frame=sub, signal=sig, book=book, tape=tf.features(),
                        derivatives={"funding_rate": 0.0003, "oi_change_pct": 2.5, "price_change_pct": 0.4})
    dec = graph.run(ctx, use_llm=False)
    out["scalp_decision"] = {"action": dec.action, "rating": dec.rating, "conviction": round(dec.conviction, 3), "agreement": round(dec.agreement, 3)}
    j = int(sw.index.get_loc(sw.index[sw["sig_dir"] != 0][-1]))
    subw = sw.iloc[: j + 1]
    sigw = signal_at("swing", "BTCUSDT", subw)
    ctxw = MarketContext(symbol="BTCUSDT", mode="swing", ts=sigw.ts, price=sigw.entry, frame=subw, signal=sigw,
                         derivatives={"funding_rate": -0.0006, "long_short_ratio": 0.55}, sentiment={"fear_greed": 18},
                         news=[{"title": "Spot ETF inflow hits record"}, {"title": "Exchange hack drains funds"}])
    decw = graph.run(ctxw, use_llm=False)
    out["swing_decision"] = {"action": decw.action, "rating": decw.rating, "conviction": round(decw.conviction, 3), "agreement": round(decw.agreement, 3)}
    # 3) sizing + risk
    acct = AccountState(equity=10_000, available=10_000, used_margin=0)
    plan = build_plan(sig, conviction=max(dec.conviction, 0.5), account=acct, filters=filters, risk=s.risk, params=ScalpParams(),
                      size_multiplier=max(dec.size_multiplier, 0.8))
    assert plan is not None and 1 <= plan.leverage <= s.risk.max_leverage, "sizer failed"
    out["plan"] = {"side": plan.side, "qty": plan.total_qty, "leverage": plan.leverage, "margin": round(plan.margin, 2),
                   "risk_pct": round(plan.risk_pct, 3), "liq": round(plan.liquidation_est or 0, 2)}
    with tempfile.TemporaryDirectory() as tmp:
        rm = RiskManager(s.risk, kill_switch_file=Path(tmp) / "KILL")
        verdict = rm.check(plan, acct)
        assert verdict.allowed, verdict.reasons
        out["risk"] = verdict.severity
        # 4) backtests
        cfg = BacktestConfig(starting_balance=10_000)
        eng = BacktestEngine(s.risk, filters, cfg)
        res_s = eng.run(df1m, "scalp", ScalpParams(), symbol="ETHUSDT", context=df5m, interval="1m")
        res_w = eng.run(df1h, "swing", SwingParams(), symbol="BTCUSDT", context=df4h, interval="1h")
        ms, mw = compute_metrics(res_s), compute_metrics(res_w)
        out["backtest_scalp"] = {"trades": ms.trades, "win_rate": round(ms.win_rate, 3), "score": round(ms.score, 3)}
        out["backtest_swing"] = {"trades": mw.trades, "win_rate": round(mw.win_rate, 3), "score": round(mw.score, 3)}
        assert ms.trades > 0 and mw.trades > 0
        if backtrader_available():
            bt = run_backtrader(df1h, "swing", SwingParams(), risk=s.risk, filters=filters, symbol="BTCUSDT", context=df4h)
            out["backtrader_swing"] = {"trades": bt.metrics.trades, "win_rate": round(bt.metrics.win_rate, 3), "score": round(bt.metrics.score, 3)}
        else:
            out["backtrader_swing"] = "not installed"
        # 5) mini optimisation
        s.learning.population, s.learning.generations = 6, 2
        opt = WalkForwardOptimizer("scalp", "ETHUSDT", s.risk, filters, s.learning, cfg, random.Random(1))
        rep = opt.run(df1m, context=df5m, interval="1m")
        out["optimizer"] = {"promoted": rep.promoted, "evaluations": rep.evaluations, "best_fitness": round(rep.best.fitness, 3)}
        # 6) paper broker fill simulation + reflection + journal
        price_state = {"price": sig.entry, "high": sig.entry, "low": sig.entry}
        broker = PaperBroker(10_000, {"ETHUSDT": filters}, lambda sym: dict(price_state, ts=int(time.time() * 1000)))
        pos = broker.place_plan(plan, decision=dec.to_dict())
        assert pos is not None, "paper fill failed"
        d = pos.direction
        price_state.update(price=pos.take_profits[0].price + d * 0.01, high=max(pos.take_profits[0].price, sig.entry) + 0.01, low=min(pos.take_profits[0].price, sig.entry) - 0.01)
        ev1 = broker.poll()
        price_state.update(price=pos.stop - d * 0.01, high=max(pos.stop, price_state["price"]) + 0.01, low=min(pos.stop, price_state["price"]) - 0.01)
        ev2 = broker.poll()
        closed = [e for e in ev1 + ev2 if e.kind == "close"]
        assert closed, "paper position never closed"
        ct = closed[0].closed_trade
        journal = Journal(Path(tmp) / "j.sqlite")
        journal.decision(dec.to_dict(), executed=True)
        journal.trade(ct)
        mem = LessonMemory(Path(tmp) / "lessons.jsonl")
        from .agents.weights import AgentWeights

        refl = TradeReflector(mem, AgentWeights(Path(tmp) / "w.json"))
        lesson = refl.reflect(ct)
        out["paper_trade"] = {"pnl": round(ct.pnl, 2), "r": round(ct.r_multiple, 2), "reason": ct.exit_reason, "partials": ct.decision is not None}
        out["lesson"] = lesson.lesson[:160]
        out["memory_hits"] = len(mem.retrieve(f"scalp ETHUSDT {sig.setup} {sig.regime}", mode="scalp"))
        out["journal"] = journal.summary()
        journal.close()
    out["elapsed_s"] = round(time.time() - t0, 2)
    out["ok"] = True
    if verbose:
        from .util import to_json

        print(to_json(out, indent=2))
    return out
