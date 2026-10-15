import hashlib
import hmac
import unittest
from urllib.parse import urlencode

from munder_trader.config import load_settings
from munder_trader.data.binance_rest import BinanceAPIError, BinanceFuturesREST
from munder_trader.data.history import klines_to_frame, resample_ohlcv, synthetic_ohlcv
from munder_trader.data.orderbook import OrderBook, SyntheticBook
from munder_trader.data.stream import MarketFeed
from munder_trader.data.tradeflow import TradeFlow, synthetic_trades
from munder_trader.symbols import SymbolFilters, meta_for

from .helpers import FakeResponse, FakeSession


class RestClientTests(unittest.TestCase):
    def test_signature_matches_hmac_sha256(self):
        sess = FakeSession([FakeResponse(200, {"serverTime": 1_700_000_000_000}), FakeResponse(200, {"orderId": 1})])
        c = BinanceFuturesREST("https://x", "key", "secret", session=sess)
        c.new_order(symbol="ETHUSDT", side="BUY", type="MARKET", quantity=0.5)
        call = sess.calls[-1]
        self.assertEqual(call["headers"]["X-MBX-APIKEY"], "key")
        params = call["params"]
        sig = params.pop("signature")
        expected = hmac.new(b"secret", urlencode(params, doseq=True).encode(), hashlib.sha256).hexdigest()
        self.assertEqual(sig, expected)
        self.assertEqual(params["symbol"], "ETHUSDT")
        self.assertIn("timestamp", params)

    def test_api_error_carries_code(self):
        sess = FakeSession([FakeResponse(400, {"code": -4164, "msg": "min notional"})])
        c = BinanceFuturesREST("https://x", session=sess)
        with self.assertRaises(BinanceAPIError) as ctx:
            c.klines("ETHUSDT", "1m")
        self.assertEqual(ctx.exception.code, -4164)

    def test_timestamp_drift_triggers_resync_and_retry(self):
        sess = FakeSession([
            FakeResponse(200, {"serverTime": 1_700_000_000_000}),        # initial sync
            FakeResponse(400, {"code": -1021, "msg": "Timestamp"}),      # first attempt
            FakeResponse(200, {"serverTime": 1_700_000_005_000}),        # resync
            FakeResponse(200, {"totalWalletBalance": "10"}),             # retry succeeds
        ])
        c = BinanceFuturesREST("https://x", "k", "s", session=sess)
        out = c.account()
        self.assertEqual(out["totalWalletBalance"], "10")

    def test_signed_endpoint_without_keys_raises(self):
        c = BinanceFuturesREST("https://x", session=FakeSession())
        with self.assertRaises(BinanceAPIError):
            c.account()


class HistoryTests(unittest.TestCase):
    def test_klines_to_frame_and_resample(self):
        base = 1_700_000_100_000 - (1_700_000_100_000 % 300_000)   # aligned to a 5-minute boundary
        rows = [[base + i * 60_000, "100", "101", "99", "100.5", "10", base + i * 60_000 + 59_999,
                 "1000", 5, "6", "600", "0"] for i in range(20)]
        df = klines_to_frame(rows)
        self.assertEqual(len(df), 20)
        self.assertEqual(df["close"].iloc[0], 100.5)
        r5 = resample_ohlcv(df, "5m")
        self.assertEqual(len(r5), 4)
        self.assertAlmostEqual(r5["volume"].iloc[0], 50.0)

    def test_synthetic_is_deterministic(self):
        a = synthetic_ohlcv(200, "1m", 100.0, seed=1, start_ms=1_700_000_000_000)
        b = synthetic_ohlcv(200, "1m", 100.0, seed=1, start_ms=1_700_000_000_000)
        self.assertTrue((a["close"].to_numpy() == b["close"].to_numpy()).all())
        self.assertTrue((a["high"] >= a[["open", "close"]].max(axis=1)).all())


class OrderBookTests(unittest.TestCase):
    def test_diff_sync_protocol(self):
        ob = OrderBook("ETHUSDT")
        ob.buffer({"U": 1, "u": 5, "pu": 0, "b": [["99", "1"]], "a": [["101", "1"]]})        # stale (u < lastUpdateId)
        ob.buffer({"U": 9, "u": 12, "pu": 5, "b": [["100", "2"]], "a": [["101", "0"]]})     # bridges snapshot id 10
        ob.apply_snapshot({"lastUpdateId": 10, "bids": [["100", "1"], ["99.5", "3"]], "asks": [["101", "1"], ["101.5", "2"]]})
        self.assertTrue(ob.synced)
        self.assertEqual(ob.bids[100.0], 2.0)
        self.assertNotIn(101.0, ob.asks)
        ok = ob.apply_diff({"U": 13, "u": 14, "pu": 12, "b": [["100", "0"]], "a": [["102", "5"]]})
        self.assertTrue(ok)
        self.assertNotIn(100.0, ob.bids)
        self.assertFalse(ob.apply_diff({"U": 20, "u": 21, "pu": 19, "b": [], "a": []}))     # gap → resync
        self.assertFalse(ob.synced)
        self.assertEqual(ob.resync_count, 1)

    def test_features_and_fill_price(self):
        ob = SyntheticBook("ETHUSDT", 2000.0, tick=0.1, skew=0.4).book()
        f = ob.features(10)
        self.assertIsNotNone(f)
        self.assertGreater(f.imbalance_n, 0.2)
        self.assertGreater(f.pressure(), 0.0)
        self.assertAlmostEqual(f.mid, 2000.0, places=6)
        px, filled = ob.fill_price("BUY", 25.0)
        self.assertGreater(px, 2000.0)
        self.assertAlmostEqual(filled, 25.0)
        big, filled_big = ob.fill_price("SELL", 1e9)
        self.assertLess(filled_big, 1e9)
        self.assertLess(big, 2000.0)


class TradeFlowTests(unittest.TestCase):
    def test_buy_bias_gives_positive_pressure(self):
        tf = TradeFlow("ETHUSDT", short_s=30, long_s=300)
        for t in synthetic_trades(800, 1_700_000_000_000, 100.0, buy_bias=0.8, seed=2):
            tf.add(t)
        f = tf.features()
        self.assertIsNotNone(f)
        self.assertGreater(f.buy_ratio_short, 0.6)
        self.assertGreater(f.pressure(), 0.2)
        self.assertGreater(f.cvd_long, 0)

    def test_window_eviction(self):
        tf = TradeFlow("ETHUSDT", short_s=5, long_s=10)
        for t in synthetic_trades(200, 1_700_000_000_000, 100.0, spacing_ms=1000):
            tf.add(t)
        self.assertLessEqual(len(tf.trades), 11)


class FeedDispatchTests(unittest.TestCase):
    def test_handle_message_routes_streams(self):
        feed = MarketFeed(rest=None, symbols=["ETHUSDT"], prefer_websocket=False)
        feed._needs_snapshot = set()
        feed.books["ETHUSDT"].apply_snapshot({"lastUpdateId": 1, "bids": [["100", "1"]], "asks": [["101", "1"]]})
        feed.handle_message("ethusdt@depth@100ms", {"s": "ETHUSDT", "U": 1, "u": 2, "pu": 1, "b": [["100", "3"]], "a": [], "E": 5})
        self.assertEqual(feed.books["ETHUSDT"].bids[100.0], 3.0)
        feed.handle_message("ethusdt@aggTrade", {"e": "aggTrade", "s": "ETHUSDT", "a": 1, "p": "100.5", "q": "2", "T": 1_700_000_000_000, "m": False})
        self.assertEqual(len(feed.tapes["ETHUSDT"].trades), 1)
        got = []
        feed.on_bar(lambda s, i, b: got.append((s, i, b["close"])))
        k = {"t": 1, "T": 2, "i": "1m", "o": "1", "h": "2", "l": "0.5", "c": "1.5", "v": "9", "q": "9", "n": 3, "V": "4", "Q": "4", "x": True}
        feed.handle_message("ethusdt@kline_1m", {"e": "kline", "s": "ETHUSDT", "k": k})
        self.assertEqual(got, [("ETHUSDT", "1m", 1.5)])
        feed.handle_message("ethusdt@markPrice@1s", {"e": "markPriceUpdate", "s": "ETHUSDT", "p": "100", "i": "99.9", "r": "0.0001", "T": 9, "E": 8})
        self.assertAlmostEqual(feed.mark_info("ETHUSDT")["funding"], 0.0001)


class SymbolsAndConfigTests(unittest.TestCase):
    def test_filters_from_exchange_info_and_rounding(self):
        info = {"symbol": "SOLUSDT", "pricePrecision": 3, "quantityPrecision": 0, "contractType": "PERPETUAL",
                "filters": [{"filterType": "PRICE_FILTER", "tickSize": "0.001"}, {"filterType": "LOT_SIZE", "stepSize": "1", "minQty": "1"},
                            {"filterType": "MIN_NOTIONAL", "notional": "5"}]}
        f = SymbolFilters.from_exchange_info(info)
        self.assertEqual(f.round_qty(12.7), 12)
        self.assertEqual(f.round_price(150.12345), 150.123)
        f.apply_brackets([{"notionalCap": 1000, "initialLeverage": 75, "maintMarginRatio": 0.01, "cum": 0},
                          {"notionalCap": 10000, "initialLeverage": 20, "maintMarginRatio": 0.02, "cum": 10}])
        self.assertEqual(f.leverage_for_notional(500), 75)
        self.assertEqual(f.leverage_for_notional(5000), 20)
        self.assertEqual(f.maintenance_margin(5000), (0.02, 10.0))
        self.assertEqual(meta_for("XAUUSDT").asset_class, "gold")
        self.assertEqual(meta_for("XAUUSDT").nautilus_id, "XAUUSDT-PERP.BINANCE")

    def test_env_overrides(self):
        s = load_settings("/nonexistent.yaml", environ={"MT_TRADING_ENV": "testnet", "MT_RISK__MAX_LEVERAGE": "50",
                                                        "BINANCE_API_KEY": "k", "MT_SYMBOLS": "btcusdt, ethusdt"})
        self.assertEqual(s.trading_env, "testnet")
        self.assertEqual(s.risk.max_leverage, 50)
        self.assertEqual(s.binance.api_key, "k")
        self.assertEqual(s.symbols, ["BTCUSDT", "ETHUSDT"])
        self.assertTrue(s.rest_base.startswith("https://testnet"))


if __name__ == "__main__":
    unittest.main()
