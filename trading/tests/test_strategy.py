import tempfile
import unittest
from pathlib import Path

import numpy as np

from munder_trader.config import RiskSettings
from munder_trader.data.history import resample_ohlcv, synthetic_ohlcv
from munder_trader.data.orderbook import SyntheticBook
from munder_trader.data.tradeflow import TradeFlow, synthetic_trades
from munder_trader.strategy.params import (ParamStore, ScalpParams, SwingParams, crossover, from_dict, mutate,
                                           random_params, to_dict)
from munder_trader.strategy.plan import AccountState, Position, TakeProfit
from munder_trader.strategy.position_sizing import PerformanceStats, build_plan, choose_leverage, estimate_liquidation
from munder_trader.strategy.risk import HoldPolicy, RiskManager
from munder_trader.strategy.signals import apply_microstructure, compute_scalp, compute_swing, signal_at

from .helpers import eth_filters


class SignalTests(unittest.TestCase):
    def test_signal_columns_and_no_lookahead(self):
        df = synthetic_ohlcv(1500, "1m", 100.0, seed=4)
        ctx = resample_ohlcv(df, "5m")
        full = compute_scalp(df, ScalpParams(), ctx)
        for col in ("sig_dir", "sig_strength", "sig_stop", "sig_tp1", "sig_tp2", "regime", "atr"):
            self.assertIn(col, full.columns)
        # truncating the frame must not change signals already emitted (causality)
        cut = 1200
        part = compute_scalp(df.iloc[:cut], ScalpParams(), resample_ohlcv(df.iloc[:cut], "5m"))
        a = full["sig_dir"].iloc[cut - 60:cut - 1].to_numpy()
        b = part["sig_dir"].iloc[cut - 60:cut - 1].to_numpy()
        self.assertTrue((a == b).all())

    def test_swing_signals_have_consistent_structure(self):
        df = synthetic_ohlcv(1500, "1h", 50_000.0, seed=9)
        out = compute_swing(df, SwingParams(), resample_ohlcv(df, "4h"))
        sig_rows = out[out["sig_dir"] != 0]
        self.assertGreater(len(sig_rows), 0)
        longs = sig_rows[sig_rows["sig_dir"] > 0]
        shorts = sig_rows[sig_rows["sig_dir"] < 0]
        if len(longs):
            self.assertTrue((longs["sig_stop"] < longs["close"]).all())
            self.assertTrue((longs["sig_tp2"] > longs["sig_tp1"]).all())
        if len(shorts):
            self.assertTrue((shorts["sig_stop"] > shorts["close"]).all())
            self.assertTrue((shorts["sig_tp2"] < shorts["sig_tp1"]).all())

    def test_scalp_stop_floor(self):
        df = synthetic_ohlcv(1500, "1m", 100.0, seed=4)
        out = compute_scalp(df, ScalpParams(min_stop_pct=0.5), resample_ohlcv(df, "5m"))
        rows = out[out["sig_dir"] != 0]
        dist = (rows["close"] - rows["sig_stop"]).abs() / rows["close"] * 100
        self.assertTrue((dist >= 0.499).all())

    def test_microstructure_gate(self):
        df = synthetic_ohlcv(800, "1m", 100.0, seed=4)
        out = compute_scalp(df, ScalpParams(), resample_ohlcv(df, "5m"))
        i = int(np.where(out["sig_dir"].to_numpy() != 0)[0][-1])
        sig = signal_at("scalp", "ETHUSDT", out.iloc[: i + 1])
        d = sig.direction
        # opposing book + tape → veto
        book = SyntheticBook("ETHUSDT", sig.entry, tick=0.01, skew=-0.5 * d).book().features(20)
        tf = TradeFlow("ETHUSDT")
        for t in synthetic_trades(500, sig.ts - 200_000, sig.entry, buy_bias=0.5 - 0.35 * d):
            tf.add(t)
        vetoed = apply_microstructure(signal_at("scalp", "ETHUSDT", out.iloc[: i + 1]), book, tf.features(), ScalpParams())
        self.assertEqual(vetoed.direction, 0)
        # aligned → stronger
        book2 = SyntheticBook("ETHUSDT", sig.entry, tick=0.01, skew=0.5 * d).book().features(20)
        tf2 = TradeFlow("ETHUSDT")
        for t in synthetic_trades(500, sig.ts - 200_000, sig.entry, buy_bias=0.5 + 0.35 * d):
            tf2.add(t)
        boosted = apply_microstructure(signal_at("scalp", "ETHUSDT", out.iloc[: i + 1]), book2, tf2.features(), ScalpParams())
        self.assertEqual(boosted.direction, d)
        self.assertGreaterEqual(boosted.strength, sig.strength)
        # wide spread → no scalp
        wide = SyntheticBook("ETHUSDT", sig.entry, tick=sig.entry * 0.001, skew=0.5 * d).book().features(20)
        blocked = apply_microstructure(signal_at("scalp", "ETHUSDT", out.iloc[: i + 1]), wide, tf2.features(), ScalpParams(max_spread_bps=5))
        self.assertEqual(blocked.direction, 0)


class ParamTests(unittest.TestCase):
    def test_mutation_crossover_and_store(self):
        import random

        rng = random.Random(3)
        p = random_params("scalp", rng)
        q = mutate("scalp", p, rng)
        c = crossover("scalp", p, q, rng)
        self.assertLess(c.ema_fast, c.ema_slow)
        self.assertGreater(c.tp2_r, c.tp1_r)
        self.assertEqual(from_dict("swing", to_dict(SwingParams(ema_fast=11))).ema_fast, 11)
        with tempfile.TemporaryDirectory() as tmp:
            store = ParamStore(Path(tmp) / "p.json")
            store.set("scalp", "ETHUSDT", c, fitness=1.0)
            again = ParamStore(Path(tmp) / "p.json")
            self.assertEqual(to_dict(again.get("scalp", "ETHUSDT")), to_dict(c))
            self.assertEqual(to_dict(again.get("scalp", "BTCUSDT")), to_dict(ScalpParams()))


class SizingTests(unittest.TestCase):
    def test_leverage_respects_cap_bracket_and_liquidation(self):
        f = eth_filters()
        risk = RiskSettings(max_leverage=100, liquidation_buffer_multiple=3.0)
        lev, _ = choose_leverage(0.2, 10_000, f, risk)          # tight stop → high leverage allowed but ≤ cap
        self.assertLessEqual(lev, 100)
        self.assertGreater(lev, 50)
        lev2, _ = choose_leverage(2.0, 10_000, f, risk)         # 2% stop → liquidation-safe leverage ≈ 1/(0.06+0.004)
        self.assertLessEqual(lev2, 15)
        lev3, _ = choose_leverage(0.2, 1_000_000, f, risk)      # bracket for big notional caps at 50x
        self.assertLessEqual(lev3, 50)
        lev4, _ = choose_leverage(0.2, 10_000, f, RiskSettings(max_leverage=10))
        self.assertEqual(lev4, 10)

    def test_liquidation_estimate_direction(self):
        liq_l = estimate_liquidation("LONG", 100.0, 10.0, 100.0, 0.005, 0.0)   # 10x
        liq_s = estimate_liquidation("SHORT", 100.0, 10.0, 100.0, 0.005, 0.0)
        self.assertLess(liq_l, 100.0)
        self.assertGreater(liq_s, 100.0)
        self.assertAlmostEqual(liq_l, (1000 - 100) / (10 * 0.995), places=6)

    def test_build_plan_tranches_and_margin_cap(self):
        from munder_trader.strategy.signals import Signal

        f = eth_filters()
        risk = RiskSettings(max_leverage=100)
        acct = AccountState(equity=10_000, available=10_000, used_margin=0)
        sig = Signal(mode="swing", symbol="ETHUSDT", ts=0, direction=1, strength=0.7, entry=2000.0, stop=1960.0, tp1=2040.0,
                     tp2=2100.0, atr=20.0, regime="trend_up", setup="pullback")
        plan = build_plan(sig, conviction=0.6, account=acct, filters=f, risk=risk, params=SwingParams())
        self.assertIsNotNone(plan)
        self.assertEqual(plan.side, "LONG")
        self.assertEqual(len(plan.tranches), 3)                     # pullback ladder
        self.assertAlmostEqual(sum(t.fraction for t in plan.tranches), 1.0, places=6)
        self.assertTrue(all(t.price > plan.stop for t in plan.tranches))
        self.assertLessEqual(plan.leverage, risk.max_leverage)
        self.assertLess(plan.liquidation_est, plan.stop)
        # stats scale: losing history shrinks risk
        plan_bad = build_plan(sig, conviction=0.6, account=acct, filters=f, risk=risk, params=SwingParams(),
                              stats=PerformanceStats(trades=30, win_rate=0.3, avg_win_r=1.0, avg_loss_r=1.0))
        self.assertLess(plan_bad.risk_pct, plan.risk_pct)
        # margin cap forces smaller size
        tight = RiskSettings(max_leverage=2, max_margin_fraction=0.2)
        plan_small = build_plan(sig, conviction=1.0, account=acct, filters=f, risk=tight, params=SwingParams())
        self.assertLessEqual(plan_small.margin, acct.equity * 0.2 + 1e-6)
        self.assertEqual(plan_small.leverage, 2)

    def test_momentum_setup_single_market_tranche(self):
        from munder_trader.strategy.signals import Signal

        sig = Signal(mode="scalp", symbol="ETHUSDT", ts=0, direction=-1, strength=0.9, entry=2000.0, stop=2004.0, tp1=1996.0,
                     tp2=1993.0, atr=2.0, regime="trend_down", setup="momentum")
        plan = build_plan(sig, conviction=0.8, account=AccountState(10_000, 10_000, 0), filters=eth_filters(), risk=RiskSettings(), params=ScalpParams())
        self.assertEqual(len(plan.tranches), 1)
        self.assertEqual(plan.tranches[0].kind, "market")
        self.assertEqual(plan.side, "SHORT")
        self.assertGreater(plan.liquidation_est, plan.stop)


class RiskManagerTests(unittest.TestCase):
    def _plan(self, symbol="ETHUSDT", side="LONG"):
        from munder_trader.strategy.signals import Signal

        d = 1 if side == "LONG" else -1
        sig = Signal(mode="swing", symbol=symbol, ts=0, direction=d, strength=0.7, entry=100.0, stop=100 - d * 2, tp1=100 + d * 2,
                     tp2=100 + d * 5, atr=1.0, regime="trend_up", setup="breakout")
        return build_plan(sig, conviction=0.6, account=AccountState(10_000, 10_000, 0), filters=eth_filters(), risk=RiskSettings(), params=SwingParams())

    def test_kill_switch_and_daily_loss(self):
        with tempfile.TemporaryDirectory() as tmp:
            ks = Path(tmp) / "KILL"
            rm = RiskManager(RiskSettings(daily_loss_limit_pct=5.0), kill_switch_file=ks)
            acct = AccountState(10_000, 10_000, 0, peak_equity=10_000)
            self.assertTrue(rm.check(self._plan(), acct).allowed)
            ks.write_text("x")
            self.assertEqual(rm.check(self._plan(), acct).severity, "blocked")
            ks.unlink()
            rm.roll_day(10_000)
            v = rm.check(self._plan(), AccountState(9_400, 9_400, 0, peak_equity=10_000))
            self.assertEqual(v.severity, "paused")
            self.assertTrue(rm.is_paused)

    def test_correlation_and_position_limits(self):
        with tempfile.TemporaryDirectory() as tmp:
            rm = RiskManager(RiskSettings(max_concurrent_positions=3), kill_switch_file=Path(tmp) / "K")
            pos = Position(symbol="BTCUSDT", side="LONG", qty=1, entry_price=100, leverage=5, margin=20, stop=98, take_profits=[])
            pos2 = Position(symbol="SOLUSDT", side="LONG", qty=1, entry_price=100, leverage=5, margin=20, stop=98, take_profits=[])
            acct = AccountState(10_000, 9_000, 40, positions={"BTCUSDT": pos})
            v = rm.check(self._plan("ETHUSDT"), acct)
            self.assertTrue(v.allowed)
            self.assertEqual(v.severity, "reduced")       # correlated long → ×0.6
            acct2 = AccountState(10_000, 9_000, 40, positions={"BTCUSDT": pos, "SOLUSDT": pos2})
            self.assertFalse(rm.check(self._plan("ETHUSDT"), acct2).allowed)   # two longs already in crypto-major
            self.assertTrue(rm.check(self._plan("XAUUSDT"), acct2).allowed)    # different cluster
            acct3 = AccountState(10_000, 9_000, 40, positions={"BTCUSDT": pos, "SOLUSDT": pos2, "ZECUSDT": pos2})
            self.assertFalse(rm.check(self._plan("XAUUSDT"), acct3).allowed)   # max positions

    def test_session_liquidity(self):
        from datetime import datetime, timezone

        rm = RiskManager(RiskSettings())
        self.assertEqual(rm.session_liquidity("BTCUSDT"), 1.0)
        sat = datetime(2026, 10, 17, 15, 0, tzinfo=timezone.utc)
        self.assertLess(rm.session_liquidity("SNDKUSDT", sat), 0.5)
        ny_open = datetime(2026, 10, 15, 15, 0, tzinfo=timezone.utc)
        self.assertEqual(rm.session_liquidity("SNDKUSDT", ny_open), 1.0)


class HoldPolicyTests(unittest.TestCase):
    def _pos(self):
        return Position(symbol="ETHUSDT", side="LONG", qty=1, entry_price=100.0, leverage=10, margin=10, stop=98.0,
                        take_profits=[TakeProfit(102, 0.5), TakeProfit(105, 0.5)], mode="swing", trail_atr=1.5, atr=1.0,
                        time_stop_bars=20, breakeven_after_r=0.8, initial_risk=2.0)

    def test_breakeven_then_extend(self):
        hp = HoldPolicy()
        d = hp.evaluate(self._pos(), 101.8, adx=22, atr=1.0, regime="trend_up", bars_since_entry=3)
        self.assertEqual(d.action, "keep")
        self.assertIsNotNone(d.new_stop)
        self.assertGreater(d.new_stop, 100.0)
        d2 = hp.evaluate(self._pos(), 103.0, adx=35, ema_slope_pct=0.2, tape_pressure=0.6, book_pressure=0.4, atr=1.0, regime="trend_up", bars_since_entry=5)
        self.assertEqual(d2.action, "extend")
        self.assertGreaterEqual(d2.new_stop, 101.0)

    def test_take_quick_and_time_stop(self):
        hp = HoldPolicy()
        d = hp.evaluate(self._pos(), 102.0, adx=8, ema_slope_pct=-0.3, tape_pressure=-0.8, book_pressure=-0.6, rsi=80, atr=1.0, regime="range", bars_since_entry=4)
        self.assertEqual(d.action, "take_quick")
        d2 = hp.evaluate(self._pos(), 100.2, adx=10, atr=1.0, bars_since_entry=25)
        self.assertEqual(d2.action, "exit")


if __name__ == "__main__":
    unittest.main()
