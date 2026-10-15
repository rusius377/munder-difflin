import json
import tempfile
import time
import unittest
from pathlib import Path

from munder_trader.config import RiskSettings, Settings
from munder_trader.data.binance_rest import BinanceFuturesREST
from munder_trader.data.history import resample_ohlcv, synthetic_ohlcv
from munder_trader.execution.binance_futures import BinanceFuturesBroker, load_filters
from munder_trader.execution.paper import PaperBroker
from munder_trader.live.engine import DeskEngine
from munder_trader.live.journal import Journal
from munder_trader.strategy.params import ScalpParams, SwingParams
from munder_trader.strategy.plan import AccountState
from munder_trader.strategy.position_sizing import build_plan
from munder_trader.strategy.signals import Signal

from .helpers import FakeResponse, FakeSession, eth_filters


def long_plan(entry=2000.0):
    sig = Signal(mode="scalp", symbol="ETHUSDT", ts=0, direction=1, strength=0.9, entry=entry, stop=entry - 4, tp1=entry + 4,
                 tp2=entry + 8, atr=2.0, regime="trend_up", setup="momentum")
    return build_plan(sig, conviction=0.7, account=AccountState(10_000, 10_000, 0), filters=eth_filters(), risk=RiskSettings(), params=ScalpParams())


class PaperBrokerTests(unittest.TestCase):
    def test_fill_partial_tp_breakeven_and_restore(self):
        state = {"price": 2000.0, "high": 2000.0, "low": 2000.0}
        broker = PaperBroker(10_000, {"ETHUSDT": eth_filters()}, lambda s: dict(state, ts=int(time.time() * 1000)))
        plan = long_plan()
        pos = broker.place_plan(plan, decision={"hold_bias": "extend"})
        self.assertIsNotNone(pos)
        self.assertLess(broker.state.balance, 10_000)                      # fee paid
        acct = broker.account()
        self.assertAlmostEqual(acct.used_margin, pos.margin)
        state.update(price=2004.5, high=2004.5, low=2000.0)
        ev = broker.poll()
        self.assertEqual([e.kind for e in ev if e.kind != "fill"], ["partial_tp"])
        self.assertLess(broker.state.positions["ETHUSDT"].qty, pos.original_qty)
        self.assertGreater(broker.state.positions["ETHUSDT"].stop, pos.entry_price - 4)   # breakeven moved
        snap = broker.snapshot()
        json.dumps(snap, default=str)
        broker2 = PaperBroker(10_000, {"ETHUSDT": eth_filters()}, lambda s: dict(state, ts=int(time.time() * 1000)))
        broker2.restore(snap)
        self.assertIn("ETHUSDT", broker2.state.positions)
        state.update(price=2009.0, high=2009.0, low=2004.0)
        ev2 = broker2.poll()
        closes = [e for e in ev2 if e.kind == "close"]
        self.assertEqual(len(closes), 1)
        self.assertEqual(closes[0].closed_trade.exit_reason, "tp2")
        self.assertGreater(closes[0].closed_trade.pnl, 0)
        self.assertGreater(broker2.state.balance, 10_000)

    def test_stop_and_manual_close(self):
        state = {"price": 2000.0, "high": 2000.0, "low": 2000.0}
        broker = PaperBroker(10_000, {"ETHUSDT": eth_filters()}, lambda s: dict(state, ts=int(time.time() * 1000)))
        broker.place_plan(long_plan())
        state.update(price=1995.0, high=2000.0, low=1995.0)
        ev = broker.poll()
        ct = [e for e in ev if e.kind == "close"][0].closed_trade
        self.assertEqual(ct.exit_reason, "stop")
        self.assertLess(ct.pnl, 0)
        # a 0.2% stop pays ~0.1% round-trip taker fees → about -1.5R realised
        self.assertLess(ct.r_multiple, -1.0)
        self.assertGreater(ct.r_multiple, -2.0)
        self.assertEqual(broker.state.consecutive_losses, 1)
        broker.place_plan(long_plan())
        self.assertTrue(broker.close_position("ETHUSDT", reason="manual"))
        self.assertNotIn("ETHUSDT", broker.state.positions)


class BinanceBrokerTests(unittest.TestCase):
    def _session(self):
        exchange_info = {"symbols": [{"symbol": "ETHUSDT", "pricePrecision": 2, "quantityPrecision": 3, "contractType": "PERPETUAL",
                                      "filters": [{"filterType": "PRICE_FILTER", "tickSize": "0.01"},
                                                  {"filterType": "LOT_SIZE", "stepSize": "0.001", "minQty": "0.001"},
                                                  {"filterType": "MIN_NOTIONAL", "notional": "5"}]}]}
        brackets = [{"symbol": "ETHUSDT", "brackets": [{"notionalCap": 50000, "initialLeverage": 125, "maintMarginRatio": 0.004, "cum": 0}]}]
        return FakeSession([
            FakeResponse(200, {"serverTime": 1_700_000_000_000}),      # sync_time
            FakeResponse(200, exchange_info),                          # exchangeInfo
            FakeResponse(200, brackets),                               # leverageBracket
            FakeResponse(200, {"dualSidePosition": False}),            # position mode
            FakeResponse(200, []),                                     # positionRisk (reconcile)
        ])

    def test_place_plan_sends_expected_orders(self):
        sess = self._session()
        sess.responses += [
            FakeResponse(200, {"code": -4046, "msg": "No need to change margin type."}) if False else FakeResponse(200, {}),  # marginType
            FakeResponse(200, {"leverage": 88}),                                                                            # leverage
            FakeResponse(200, {"orderId": 1, "avgPrice": "2000.5", "executedQty": "2.000"}),                                 # MARKET entry
            FakeResponse(200, {"orderId": 2}),                                                                              # STOP_MARKET
            FakeResponse(200, {"orderId": 3}),                                                                              # TP1
            FakeResponse(200, {"orderId": 4}),                                                                              # TP2
        ]
        rest = BinanceFuturesREST("https://testnet.binancefuture.com", "k", "s", session=sess, time_sync=False)
        broker = BinanceFuturesBroker(rest, ["ETHUSDT"])
        self.assertEqual(broker.name, "binance-testnet")
        plan = long_plan()
        pos = broker.place_plan(plan, decision={"hold_bias": "quick"})
        self.assertIsNotNone(pos)
        orders = [c["params"] for c in sess.calls if c["url"].endswith("/fapi/v1/order")]
        self.assertEqual(orders[0]["type"], "MARKET")
        self.assertEqual(orders[0]["side"], "BUY")
        self.assertEqual(orders[1]["type"], "STOP_MARKET")
        self.assertEqual(orders[1]["closePosition"], "true")
        self.assertEqual(orders[1]["side"], "SELL")
        self.assertEqual(orders[2]["type"], "TAKE_PROFIT_MARKET")
        self.assertEqual(orders[2]["reduceOnly"], "true")
        self.assertEqual(orders[3]["closePosition"], "true")
        lev_call = [c for c in sess.calls if c["url"].endswith("/fapi/v1/leverage")][0]
        self.assertLessEqual(int(lev_call["params"]["leverage"]), 100)
        self.assertEqual(pos.leverage, 88)
        self.assertAlmostEqual(pos.entry_price, 2000.5)
        # closed on the exchange → reconcile books the trade from userTrades
        sess.responses += [
            FakeResponse(200, []),                                                               # positionRisk → flat
            FakeResponse(200, [{"realizedPnl": "12.5", "commission": "0.8", "price": "2006.0"}]),   # userTrades
            FakeResponse(200, {}),                                                               # cancel all
        ]
        broker.reconcile(force=True)
        self.assertEqual(len(broker.closed), 1)
        self.assertAlmostEqual(broker.closed[0].pnl, 11.7)

    def test_load_filters_defaults_for_unknown_symbol(self):
        sess = FakeSession([FakeResponse(200, {"symbols": []})])
        rest = BinanceFuturesREST("https://x", session=sess, time_sync=False)
        f = load_filters(rest, ["SPCXUSDT"], with_brackets=False)
        self.assertEqual(f["SPCXUSDT"].symbol, "SPCXUSDT")


class FakeFeed:
    """Minimal MarketFeed stand-in: synthetic book/tape, bars pushed by the test."""

    def __init__(self, symbols, frames):
        from munder_trader.data.orderbook import OrderBook, SyntheticBook
        from munder_trader.data.tradeflow import TradeFlow, synthetic_trades

        self.symbols = symbols
        self.cbs = []
        self.books = {}
        self.tapes = {}
        self.last_bar = {}
        for s in symbols:
            price = float(frames[(s, "1m")]["close"].iloc[-1])
            self.books[s] = SyntheticBook(s, price, tick=price * 1e-5, skew=0.2).book()
            tf = TradeFlow(s)
            for t in synthetic_trades(400, int(time.time() * 1000) - 200_000, price, buy_bias=0.6):
                tf.add(t)
            self.tapes[s] = tf
        self.mode = "fake"
        self.connected = True
        self.messages = 0
        self.last_message_ts = 0

    def on_bar(self, cb):
        self.cbs.append(cb)

    def start(self):
        pass

    def stop(self):
        pass

    def book(self, s):
        return self.books[s]

    def book_features(self, s, levels=20):
        return self.books[s].features(levels)

    def tape_features(self, s):
        return self.tapes[s].features()

    def mark_info(self, s):
        return {"mark": self.books[s].mid(), "index": self.books[s].mid(), "funding": 0.0001, "next_funding": 0}

    def health(self):
        return {"mode": "fake", "connected": True}

    def push_bar(self, s, tf, bar):
        for cb in self.cbs:
            cb(s, tf, bar)

    def set_price(self, s, price):
        from munder_trader.data.orderbook import SyntheticBook
        from munder_trader.data.tradeflow import Trade

        self.books[s] = SyntheticBook(s, price, tick=price * 1e-5, skew=0.2).book()
        now = int(time.time() * 1000)
        for i in range(5):
            self.tapes[s].add(Trade(ts=now - 500 + i * 100, price=price, qty=1.0, buyer_is_maker=False))


class EngineOfflineTests(unittest.TestCase):
    def test_engine_runs_bars_executes_and_journals(self):
        with tempfile.TemporaryDirectory() as tmp:
            s = Settings(state_dir=tmp, symbols=["ETHUSDT"], learning={"enabled": False}, server={"enabled": False})
            s.risk.base_risk_per_trade_pct = 0.5
            frames = {("ETHUSDT", "1m"): synthetic_ohlcv(1500, "1m", 3000.0, seed=3, start_ms=1_700_000_000_000),
                      ("ETHUSDT", "1h"): synthetic_ohlcv(900, "1h", 3000.0, seed=4, start_ms=1_690_000_000_000)}
            feed = FakeFeed(["ETHUSDT"], frames)
            engine = DeskEngine(s, offline=True, feed=feed, filters={"ETHUSDT": eth_filters()},
                                data_provider=lambda sym, tf: frames[(sym, tf)])
            engine.setup()
            self.assertIsInstance(engine.broker, PaperBroker)
            # one-shot evaluations without execution work for both desks
            ev_sw = engine.evaluate("ETHUSDT", "swing", execute=False)
            ev_sc = engine.evaluate("ETHUSDT", "scalp", execute=False)
            self.assertIsNotNone(ev_sw)
            self.assertIsNotNone(ev_sc)
            self.assertEqual(len(engine.journal.recent_decisions(10)), 2)
            # force a trade through the paper broker and drive the loop
            plan = long_plan(entry=float(frames[("ETHUSDT", "1m")]["close"].iloc[-1]))
            feed.set_price("ETHUSDT", plan.entry_ref)
            pos = engine.broker.place_plan(plan, decision=ev_sc.decision.to_dict())
            self.assertIsNotNone(pos)
            feed.set_price("ETHUSDT", plan.entry_ref + 9.0)        # through TP1 and TP2
            engine.step()
            trades = engine.journal.recent_trades(10)
            self.assertEqual(len(trades), 1)
            self.assertEqual(trades[0]["reason"], "tp2")
            self.assertEqual(engine.memory.stats()["lessons"], 1)
            # a closed 1m bar schedules a scalp evaluation in the background
            bar = frames[("ETHUSDT", "1m")].iloc[-1].to_dict()
            bar = {k: (int(v) if k in ("open_time", "close_time", "trades") else float(v)) for k, v in bar.items()}
            bar["open_time"] += 60_000
            bar["close_time"] += 60_000
            bar["closed"] = True
            feed.push_bar("ETHUSDT", "1m", bar)
            engine.step()
            for _ in range(100):
                if ("ETHUSDT", "scalp") not in engine._inflight:
                    break
                time.sleep(0.05)
            self.assertEqual(len(engine.frames[("ETHUSDT", "1m")]), 1501)
            st = engine.status()
            self.assertIn("ETHUSDT", st["last_decisions"])
            engine.write_status()
            self.assertTrue((Path(tmp) / "status.json").exists())
            engine.shutdown()
            j = Journal(Path(tmp) / "journal.sqlite")
            self.assertIsNotNone(j.get_kv("paper_state"))
            self.assertGreaterEqual(len(j.recent_decisions(10)), 2)
            j.close()


if __name__ == "__main__":
    unittest.main()


class PyramidTests(unittest.TestCase):
    def test_paper_add_to_position_averages_entry(self):
        state = {"price": 2000.0, "high": 2000.0, "low": 2000.0}
        broker = PaperBroker(10_000, {"ETHUSDT": eth_filters()}, lambda s: dict(state, ts=int(time.time() * 1000)))
        pos = broker.place_plan(long_plan())
        q0 = pos.qty
        state.update(price=2006.0, high=2006.0, low=2000.0)
        self.assertTrue(broker.add_to_position("ETHUSDT", q0 * 0.5, reason="test"))
        self.assertAlmostEqual(pos.qty, q0 * 1.5, places=3)
        self.assertGreater(pos.entry_price, 2000.0)
        self.assertEqual(pos.tags["pyramided"], 1)
        self.assertFalse(broker.add_to_position("ETHUSDT", 1e9))     # no margin for that

    def test_engine_pyramids_only_with_fresh_agreeing_decision(self):
        from munder_trader.live.engine import Evaluation
        from munder_trader.util import now_ms

        with tempfile.TemporaryDirectory() as tmp:
            s = Settings(state_dir=tmp, symbols=["ETHUSDT"], learning={"enabled": False}, server={"enabled": False})
            frames = {("ETHUSDT", "1m"): synthetic_ohlcv(1500, "1m", 3000.0, seed=3, start_ms=1_700_000_000_000),
                      ("ETHUSDT", "1h"): synthetic_ohlcv(900, "1h", 3000.0, seed=4, start_ms=1_690_000_000_000)}
            feed = FakeFeed(["ETHUSDT"], frames)
            engine = DeskEngine(s, offline=True, feed=feed, filters={"ETHUSDT": eth_filters()}, data_provider=lambda sym, tf: frames[(sym, tf)])
            engine.setup()
            entry = float(frames[("ETHUSDT", "1m")]["close"].iloc[-1])
            feed.set_price("ETHUSDT", entry)
            plan = long_plan(entry=entry)
            plan.take_profits[0].price = entry + 50; plan.take_profits[1].price = entry + 100   # keep targets out of the way
            pos = engine.broker.place_plan(plan, decision={"hold_bias": "extend"})
            ev = engine.evaluate("ETHUSDT", "scalp", execute=False)
            # fabricate a fresh, confident, same-direction committee call
            ev.decision.approve, ev.decision.direction, ev.decision.conviction, ev.decision.ts = True, 1, 0.9, now_ms()
            engine.last_eval[("ETHUSDT", "scalp")] = ev
            feed.set_price("ETHUSDT", entry + 6.0)   # ≈ +1.5R on a 4-point risk
            engine._maybe_pyramid("ETHUSDT", pos, entry + 6.0, 0.9, "extend")
            self.assertEqual(pos.tags.get("pyramided", 0), 1)
            engine._maybe_pyramid("ETHUSDT", pos, entry + 7.0, 0.9, "extend")
            self.assertEqual(pos.tags.get("pyramided", 0), 1)          # only once
            engine.shutdown()
