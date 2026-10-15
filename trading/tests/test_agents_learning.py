import json
import tempfile
import unittest
from pathlib import Path

from munder_trader.agents.analysts import LLMEnhancer, MarketAnalyst
from munder_trader.agents.base import MarketContext, weighted_score
from munder_trader.agents.graph import DeskGraph
from munder_trader.agents.llm import LLMClient, extract_json
from munder_trader.agents.researchers import rating_from_score
from munder_trader.agents.weights import AgentWeights
from munder_trader.config import LLMSettings, RiskSettings
from munder_trader.data.history import resample_ohlcv, synthetic_ohlcv
from munder_trader.data.orderbook import SyntheticBook
from munder_trader.data.tradeflow import TradeFlow, synthetic_trades
from munder_trader.learn.feedback import ClosedTrade, TradeReflector
from munder_trader.learn.memory import Lesson, LessonMemory
from munder_trader.strategy.params import ScalpParams, SwingParams
from munder_trader.strategy.signals import apply_microstructure, compute_scalp, compute_swing, signal_at


def scalp_context(direction_bias: float = 0.3):
    df = synthetic_ohlcv(1500, "1m", 3000.0, seed=3)
    out = compute_scalp(df, ScalpParams(), resample_ohlcv(df, "5m"))
    i = int(out.index.get_loc(out.index[out["sig_dir"] != 0][-1]))
    sub = out.iloc[: i + 1]
    sig = signal_at("scalp", "ETHUSDT", sub)
    book = SyntheticBook("ETHUSDT", sig.entry, tick=0.01, skew=direction_bias * sig.direction).book().features(20)
    tf = TradeFlow("ETHUSDT")
    for t in synthetic_trades(600, sig.ts - 300_000, sig.entry, buy_bias=0.5 + 0.2 * sig.direction):
        tf.add(t)
    sig = apply_microstructure(sig, book, tf.features(), ScalpParams())
    return MarketContext(symbol="ETHUSDT", mode="scalp", ts=sig.ts, price=sig.entry, frame=sub, signal=sig, book=book, tape=tf.features(),
                         derivatives={"funding_rate": 0.0002})


def swing_context():
    df = synthetic_ohlcv(1500, "1h", 60_000.0, seed=5)
    out = compute_swing(df, SwingParams(), resample_ohlcv(df, "4h"))
    i = int(out.index.get_loc(out.index[out["sig_dir"] != 0][-1]))
    sub = out.iloc[: i + 1]
    sig = signal_at("swing", "BTCUSDT", sub)
    return MarketContext(symbol="BTCUSDT", mode="swing", ts=sig.ts, price=sig.entry, frame=sub, signal=sig,
                         derivatives={"funding_rate": 0.0009, "oi_change_pct": 3, "price_change_pct": 1.0, "long_short_ratio": 2.3},
                         sentiment={"fear_greed": 82}, news=[{"title": "Major exchange hack"}, {"title": "ETF approval rally"}])


class FakeLLM(LLMClient):
    def __init__(self, reply):
        super().__init__(LLMSettings(provider="openai_compatible", base_url="http://x"))
        self.reply = reply
        self.prompts = []

    def complete(self, system, user, *, deep=False, json_mode=True):
        self.calls += 1
        self.prompts.append((system, user))
        return self.reply


class CommitteeTests(unittest.TestCase):
    def test_both_desks_produce_full_reports(self):
        g = DeskGraph(RiskSettings(), LLMSettings())
        for ctx in (scalp_context(), swing_context()):
            dec = g.run(ctx, use_llm=False)
            self.assertEqual(len(dec.reports), 5)
            self.assertIn(dec.rating, ("Buy", "Overweight", "Hold", "Underweight", "Sell"))
            self.assertTrue(dec.research.debate)
            self.assertTrue(dec.proposal.rationale)
            self.assertTrue(dec.portfolio.reasoning)
            text = dec.explain()
            self.assertIn("판단", text)
            d = dec.to_dict()
            json.dumps(d, ensure_ascii=False, default=str)   # serialisable
            self.assertLessEqual(dec.leverage_cap, 100)
            if dec.approve:
                self.assertNotEqual(dec.direction, 0)
                self.assertGreater(dec.size_multiplier, 0)

    def test_weighted_score_and_rating_bands(self):
        from munder_trader.agents.base import AgentReport

        reps = [AgentReport("a", "analyst", "swing", "X", "bullish", 0.8, 0.9), AgentReport("b", "analyst", "swing", "X", "bearish", -0.4, 0.5),
                AgentReport("c", "analyst", "swing", "X", "neutral", 0.0, 0.3)]
        comp, agree = weighted_score(reps)
        self.assertGreater(comp, 0)
        self.assertAlmostEqual(agree, 0.5)
        comp2, _ = weighted_score(reps, {"a": 0.6, "b": 1.5})
        self.assertLess(comp2, comp)
        self.assertEqual(rating_from_score(0.5), "Buy")
        self.assertEqual(rating_from_score(-0.2), "Underweight")
        self.assertEqual(rating_from_score(0.0), "Hold")

    def test_llm_enhancer_is_bounded(self):
        ctx = scalp_context()
        rep = MarketAnalyst().analyze(ctx)
        base = rep.score
        llm = FakeLLM(json.dumps({"score": 1.0 if base < 0.5 else -1.0, "confidence": 0.9, "reasoning": "모델 의견"}))
        enh = LLMEnhancer(llm, max_adjustment=0.2)
        out = enh.enhance(rep, ctx)
        self.assertTrue(out.llm_used)
        self.assertLessEqual(abs(out.score - base), 0.2 + 1e-9)
        self.assertIn("모델 의견", out.reasoning)
        # garbage reply → untouched
        rep2 = MarketAnalyst().analyze(ctx)
        out2 = LLMEnhancer(FakeLLM("not json at all"), 0.2).enhance(rep2, ctx)
        self.assertFalse(out2.llm_used)

    def test_llm_manager_and_pm_respect_hard_cap(self):
        ctx = scalp_context()
        llm = FakeLLM(json.dumps({"recommendation": "Buy", "rationale": "r", "strategic_actions": "a", "composite_adjustment": 0.9,
                                  "action": "Buy", "conviction": 1.0, "size_multiplier": 9.0, "entry_style": "market",
                                  "rating": "Buy", "approve": True, "leverage_cap": 500, "hold_bias": "extend", "reasoning": "pm"}))
        g = DeskGraph(RiskSettings(max_leverage=100), LLMSettings(provider="openai_compatible", base_url="http://x"), llm_client=llm)
        dec = g.run(ctx, use_llm=True)
        self.assertGreater(dec.llm_calls, 0)
        self.assertLessEqual(dec.leverage_cap, 100)
        self.assertLessEqual(dec.size_multiplier, 1.6)
        self.assertLessEqual(dec.conviction, 1.0)

    def test_extract_json(self):
        self.assertEqual(extract_json('```json\n{"a": 1}\n```')["a"], 1)
        self.assertEqual(extract_json('text before {"b": [1,2]} after')["b"], [1, 2])
        self.assertIsNone(extract_json("nothing"))


class LearningTests(unittest.TestCase):
    def test_memory_retrieval_prefers_similar_recent_big_outcomes(self):
        with tempfile.TemporaryDirectory() as tmp:
            mem = LessonMemory(Path(tmp) / "l.jsonl")
            mem.add(Lesson(ts=1_700_000_000_000, mode="scalp", symbol="ETHUSDT", situation="scalp ETHUSDT momentum trend_up imbalance",
                           outcome="tp2", lesson="momentum in trend_up: let the runner go", r_multiple=2.0, won=True))
            mem.add(Lesson(ts=1_700_000_000_000, mode="swing", symbol="BTCUSDT", situation="swing BTCUSDT pullback range",
                           outcome="stop", lesson="pullback in range fails", r_multiple=-1.0, won=False))
            hits = mem.retrieve("scalp ETHUSDT momentum trend_up", mode="scalp")
            self.assertEqual(len(hits), 1)
            self.assertIn("runner", hits[0].lesson)
            again = LessonMemory(Path(tmp) / "l.jsonl")
            self.assertEqual(len(again.items), 2)
            self.assertTrue(mem.lessons_for("swing pullback range", mode="swing")[0].startswith("패"))

    def test_reflector_updates_weights_and_stats(self):
        with tempfile.TemporaryDirectory() as tmp:
            weights = AgentWeights(Path(tmp) / "w.json")
            mem = LessonMemory(Path(tmp) / "l.jsonl")
            refl = TradeReflector(mem, weights)
            decision = {"setup": "momentum", "regime": "trend_up", "conviction": 0.7, "hold_bias": "extend",
                        "reports": [{"agent": "tape_analyst", "stance": "bullish", "score": 0.8, "evidence": [{"name": "cvd"}]},
                                    {"agent": "fundamentals_analyst", "stance": "bearish", "score": -0.5, "evidence": []}]}
            ct = ClosedTrade("ETHUSDT", "scalp", "LONG", 100, 103, 1.0, 20, 2.8, 1.5, 6, "tp2", 2.0, 0.3, 1, 2, decision=decision)
            lesson = refl.reflect(ct)
            self.assertTrue(lesson.won)
            self.assertGreater(weights.weight("scalp", "tape_analyst"), 1.0)
            self.assertLess(weights.weight("scalp", "fundamentals_analyst"), 1.0)
            self.assertIn("tape_analyst", lesson.tags["credit"])
            st = refl.stats_for("scalp", "ETHUSDT")
            self.assertEqual(st.trades, 1)
            lost = ClosedTrade("ETHUSDT", "scalp", "LONG", 100, 98, 1.0, 20, -2.0, -1.0, 12, "time_stop", 0.2, 1.2, 1, 2, decision=decision)
            l2 = refl.reflect(lost)
            self.assertFalse(l2.won)
            self.assertTrue("시간 손절" in l2.lesson or "time stop" in l2.lesson)
            self.assertEqual(refl.stats_for("scalp", "ETHUSDT").trades, 2)
            hits_before = weights._stats["scalp:tape_analyst"]["hits"]
            weights.decay(0.5)
            self.assertAlmostEqual(weights._stats["scalp:tape_analyst"]["hits"], hits_before * 0.5)


if __name__ == "__main__":
    unittest.main()
