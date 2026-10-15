import random
import unittest

from munder_trader.backtest.bt_adapter import backtrader_available, run_backtrader
from munder_trader.backtest.engine import BacktestConfig, BacktestEngine
from munder_trader.backtest.optimizer import WalkForwardOptimizer
from munder_trader.backtest.scorer import Metrics, compute_metrics, score_metrics
from munder_trader.config import LearningSettings, RiskSettings
from munder_trader.data.history import resample_ohlcv, synthetic_ohlcv
from munder_trader.strategy.params import ScalpParams, SwingParams

from .helpers import eth_filters, path_frame, with_signal_columns


def _engine(**cfg):
    return BacktestEngine(RiskSettings(max_leverage=100), eth_filters(), BacktestConfig(slippage_bps=0.0, funding_rate=0.0, **cfg))


class DeterministicPathTests(unittest.TestCase):
    def test_long_hits_tp1_then_tp2(self):
        closes = [100.0] * 5 + [100.0, 101.0, 102.5, 103.0, 104.0, 106.0, 106.0, 106.0]
        df = with_signal_columns(path_frame(closes), at=4, direction=1, stop=98.0, tp1=102.0, tp2=105.0)
        res = _engine().run(df, "scalp", ScalpParams(time_stop_bars=0, breakeven_after_r=9), symbol="ETHUSDT", precomputed=df)
        self.assertEqual(len(res.trades), 1)
        t = res.trades[0]
        self.assertEqual(t.side, "LONG")
        self.assertEqual(t.exit_reason, "tp2")
        self.assertEqual(t.partial_exits, 1)
        self.assertGreater(t.pnl, 0)
        self.assertAlmostEqual(t.entry_price, 100.0, places=6)      # filled at next open
        self.assertGreater(res.ending_balance, res.starting_balance)
        # realised ≈ 0.6*(102-100) + 0.4*(105-100) per unit minus fees → R ≈ (1.2+2.0)/2 = 1.6
        self.assertAlmostEqual(t.r_multiple, 1.6, delta=0.15)

    def test_short_stopped_out_with_gap(self):
        closes = [100.0] * 5 + [100.0, 99.0, 103.0, 104.0]
        df = with_signal_columns(path_frame(closes), at=4, direction=-1, stop=102.0, tp1=98.0, tp2=96.0)
        res = _engine().run(df, "scalp", ScalpParams(time_stop_bars=0), symbol="ETHUSDT", precomputed=df)
        t = res.trades[0]
        self.assertEqual(t.side, "SHORT")
        self.assertEqual(t.exit_reason, "stop")
        self.assertLess(t.pnl, 0)
        self.assertAlmostEqual(t.r_multiple, -1.0, delta=0.1)

    def test_time_stop_closes_stale_position(self):
        closes = [100.0] * 5 + [100.0] + [100.1, 99.9] * 10
        df = with_signal_columns(path_frame(closes), at=4, direction=1, stop=97.0, tp1=103.0, tp2=106.0)
        res = _engine().run(df, "scalp", ScalpParams(time_stop_bars=5), symbol="ETHUSDT", precomputed=df)
        self.assertEqual(res.trades[0].exit_reason, "time_stop")

    def test_adverse_first_when_both_touched(self):
        # one bar whose range covers both stop and tp2 → conservative: stop
        closes = [100.0] * 5 + [100.0, 100.0]
        df = path_frame(closes, wick=0.08)
        df = with_signal_columns(df, at=4, direction=1, stop=96.0, tp1=103.0, tp2=106.0)
        res = _engine().run(df, "scalp", ScalpParams(time_stop_bars=0), symbol="ETHUSDT", precomputed=df)
        self.assertEqual(res.trades[0].exit_reason, "stop")

    def test_liquidation_only_on_gap_open(self):
        closes = [100.0] * 5 + [100.0, 80.0]
        df = with_signal_columns(path_frame(closes), at=4, direction=1, stop=99.5, tp1=100.5, tp2=101.0)
        res = _engine().run(df, "scalp", ScalpParams(time_stop_bars=0), symbol="ETHUSDT", precomputed=df)
        # close 100 → open 100 (no gap) then low 80: the stop fires before liquidation
        self.assertEqual(res.trades[0].exit_reason, "stop")
        self.assertEqual(res.liquidations, 0)


class MetricsTests(unittest.TestCase):
    def test_score_rewards_better_strategies(self):
        good = Metrics(trades=60, win_rate=0.62, profit_factor=1.9, expectancy_r=0.4, return_per_day_pct=1.0, max_drawdown_pct=5,
                       avg_bars_win=6, avg_bars_loss=2, tp_capture=0.8, entry_quality=0.8)
        bad = Metrics(trades=60, win_rate=0.4, profit_factor=0.8, expectancy_r=-0.2, return_per_day_pct=-0.5, max_drawdown_pct=30,
                      avg_bars_win=3, avg_bars_loss=9, tp_capture=0.3, entry_quality=0.3)
        self.assertGreater(score_metrics(good)[0], score_metrics(bad)[0])
        few = Metrics(**{**good.__dict__, "trades": 5, "breakdown": {}})
        self.assertLess(score_metrics(few)[0], score_metrics(good)[0])

    def test_compute_metrics_on_synthetic_run(self):
        df = synthetic_ohlcv(2500, "1h", 50_000.0, seed=12)
        res = BacktestEngine(RiskSettings(), eth_filters()).run(df, "swing", SwingParams(), symbol="BTCUSDT", context=resample_ohlcv(df, "4h"))
        m = compute_metrics(res)
        self.assertEqual(m.trades, len(res.trades))
        self.assertGreaterEqual(m.max_drawdown_pct, 0)
        self.assertTrue(0 <= m.win_rate <= 1)


class OptimizerTests(unittest.TestCase):
    def test_walk_forward_promotes_only_on_oos_gain(self):
        df = synthetic_ohlcv(4000, "1m", 100.0, seed=21)
        learning = LearningSettings(population=6, generations=2, walk_forward_folds=3, promotion_margin=0.03, min_trades=10)
        opt = WalkForwardOptimizer("scalp", "ETHUSDT", RiskSettings(), eth_filters(), learning, rng=random.Random(5))
        rep = opt.run(df, context=resample_ohlcv(df, "5m"), interval="1m")
        self.assertEqual(rep.generations, 2)
        self.assertGreater(rep.evaluations, 0)
        self.assertEqual(len(rep.best.test_scores), 3)
        if rep.promoted:
            self.assertGreaterEqual(rep.best.fitness, rep.incumbent.fitness + 0.03 - 1e-9)
        else:
            self.assertIs(rep.best, rep.incumbent)
        # a huge margin can never be cleared
        learning2 = LearningSettings(population=4, generations=1, walk_forward_folds=3, promotion_margin=99.0)
        rep2 = WalkForwardOptimizer("scalp", "ETHUSDT", RiskSettings(), eth_filters(), learning2, rng=random.Random(5)).run(df, context=resample_ohlcv(df, "5m"))
        self.assertFalse(rep2.promoted)


@unittest.skipUnless(backtrader_available(), "backtrader not installed")
class BacktraderAgreementTests(unittest.TestCase):
    def test_engines_agree_on_swing(self):
        df = synthetic_ohlcv(2500, "1h", 60_000.0, seed=12)
        ctx = resample_ohlcv(df, "4h")
        risk = RiskSettings(base_risk_per_trade_pct=1.0)
        cfg = BacktestConfig(funding_rate=0.0, slippage_bps=0.0, conviction_floor=0.0, committee=lambda s, f, i: (1 / 3, 1.0, True))
        ours = compute_metrics(BacktestEngine(risk, eth_filters(), cfg).run(df, "swing", SwingParams(), symbol="ETHUSDT", context=ctx))
        theirs = run_backtrader(df, "swing", SwingParams(), risk=risk, filters=eth_filters(), symbol="ETHUSDT", context=ctx, risk_pct=1.0).metrics
        self.assertGreater(theirs.trades, 0)
        self.assertLessEqual(abs(theirs.trades - ours.trades), max(5, int(0.15 * ours.trades)))
        self.assertLessEqual(abs(theirs.win_rate - ours.win_rate), 0.12)


if __name__ == "__main__":
    unittest.main()
