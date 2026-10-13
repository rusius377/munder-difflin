#!/usr/bin/env python3
"""
Munder Difflin trading desk — NautilusTrader execution of the desk's scalping signals.

The desk decides (src/main/trading/replay.ts runs the live scalper over history and
exports every evaluation that could open or close a trade). NautilusTrader executes:
Binance's historical aggregate trades become TradeTicks, the simulated exchange matches
the desk's bracket orders (market entry, STOP_MARKET stop, MARKET_IF_TOUCHED target)
against the actual tape, charges the instrument's taker/maker fees, keeps a leveraged
margin account, and applies its fill model (one-tick slippage probability) and latency.

    python desk_backtest.py <job.json>

job.json (written by src/main/trading/nautilus.ts):
    {
      "symbol": "BTCUSDT", "from": <ms>, "to": <ms>,
      "tapeFiles": ["…/aggTrades/2026-10-01.zip", …],   Binance data archive zips
      "signalsPath": "…/signals.json",                  the desk's evaluation stream
      "out": "…/result.json",
      "params": { leverage, takerFeePct, makerFeePct, slippageBps, startEquity,
                  riskPerTradePct, maxNotionalPct, maxHoldMinutes, cooldownMinutes,
                  maxTradesPerHour, breakevenAtR, minScore, dailyLossLimitPct,
                  maxConsecutiveLosses, evalEverySec, mmr, cum,
                  tickSize, stepSize, minQty, minNotional, latencyMs }
    }

Progress goes to stdout as "PROGRESS <0..1> <message>"; the result is written to "out".
Requires Python 3.12+ and nautilus_trader==1.231.0 (the desk installs it into its own venv).
"""

from __future__ import annotations

import io
import json
import math
import sys
import zipfile
from decimal import Decimal

NAUTILUS_VERSION = "1.231.0"
AGG_COLS = ["agg_trade_id", "price", "quantity", "first_trade_id", "last_trade_id", "transact_time", "is_buyer_maker"]


def progress(pct: float, msg: str) -> None:
    print(f"PROGRESS {max(0.0, min(1.0, pct)):.3f} {msg}", flush=True)


# ─── data (pandas only — testable without NautilusTrader) ────────────────────


def read_csv_from_zip(path: str):
    import pandas as pd

    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        name = next((n for n in names if n.lower().endswith(".csv")), names[0])
        raw = z.read(name)
    first = raw[: raw.find(b"\n")].decode("latin1") if b"\n" in raw else raw.decode("latin1")
    has_header = not first.split(",")[0].strip().isdigit()
    df = pd.read_csv(io.BytesIO(raw), header=0 if has_header else None)
    df = df.iloc[:, : len(AGG_COLS)]
    df.columns = AGG_COLS[: df.shape[1]]
    return df


def agg_trades_frame(paths: list[str], t_from: int, t_to: int):
    """Binance aggTrades zips → DataFrame(price, quantity, side, trade_id) indexed by UTC time."""
    import numpy as np
    import pandas as pd

    frames = [read_csv_from_zip(p) for p in paths]
    if not frames:
        return pd.DataFrame(columns=["price", "quantity", "side", "trade_id"])
    df = pd.concat(frames, ignore_index=True)
    ts = df["transact_time"].astype("int64")
    ts = ts.where(ts < 10**14, ts // 1000)  # a few archive files use µs
    df = df.assign(ts=ts)
    df = df[(df["ts"] >= t_from) & (df["ts"] < t_to)].sort_values(["ts", "agg_trade_id"], kind="stable")
    buyer_maker = df["is_buyer_maker"].astype(str).str.strip().str.lower().eq("true").to_numpy()
    # The wrangler reads `side` ("BUY"/"SELL" = aggressor). Its `buyer_maker` path tests
    # `x is True`, which numpy booleans never are, so the side is spelled out here.
    out = pd.DataFrame(
        {
            "price": df["price"].astype(float).to_numpy(),
            "quantity": df["quantity"].astype(float).to_numpy(),
            "side": np.where(buyer_maker, "SELL", "BUY"),
            "trade_id": df["agg_trade_id"].astype("int64").astype(str).to_numpy(),
        },
        # Nanosecond UTC index: pandas 3 would otherwise infer millisecond resolution.
        index=pd.to_datetime(df["ts"].to_numpy(), unit="ms", utc=True).as_unit("ns"),
    )
    return out[out["quantity"] > 0]


# ─── the desk's rules, mirrored (risk.ts sizeOrder, scalper.ts manageScalp) ──


def floor_step(x: float, step: float) -> float:
    if step <= 0:
        return x
    return math.floor(x / step + 1e-9) * step


def max_safe_leverage(stop_frac: float, mmr: float, buffer: float = 1.25) -> int:
    """Highest leverage whose isolated liquidation is `buffer` stop-distances away (leverage.ts)."""
    if stop_frac <= 0:
        return 1
    return max(1, math.floor(1 / (mmr + buffer * stop_frac * (1 + mmr))))


def size_order(side: str, entry: float, stop: float, p: dict, equity: float, available: float) -> dict | None:
    """Position size from the stop distance and the risk budget, as risk.ts does."""
    stop_dist = abs(entry - stop)
    stop_frac = stop_dist / entry if entry else 0
    if stop_frac < 0.0008 or stop_frac > 0.15:
        return None
    if (side == "LONG" and stop >= entry) or (side == "SHORT" and stop <= entry):
        return None
    fee = p["takerFeePct"] / 100
    slip = p["slippageBps"] / 10_000
    per_unit = stop_dist + entry * fee + stop * fee + (entry + stop) * slip
    qty = equity * (p["riskPerTradePct"] / 100) / per_unit
    qty = min(qty, equity * (p["maxNotionalPct"] / 100) / entry)
    # Lower the leverage until liquidation sits safely beyond the stop (risk.ts maxSafeLeverage).
    lev = max(1, min(int(p["leverage"]), max_safe_leverage(stop_frac, p["mmr"])))
    qty = min(qty, max(0.0, available) * lev * 0.95 / entry)
    qty = floor_step(qty, p["stepSize"])
    if qty <= 0 or qty < p["minQty"] or qty * entry < p["minNotional"]:
        return None
    return {"qty": qty, "riskUsdt": qty * per_unit, "leverage": lev, "margin": qty * entry / lev}


def liquidation_price(side: str, entry: float, qty: float, leverage: float, mmr: float, cum: float) -> float:
    margin = entry * qty / leverage
    if side == "LONG":
        return max(0.0, (qty * entry - margin - cum) / (qty * (1 - mmr)))
    return (qty * entry + margin + cum) / (qty * (1 + mmr))


# ─── NautilusTrader ──────────────────────────────────────────────────────────


def run(job: dict) -> dict:
    import nautilus_trader
    from nautilus_trader.backtest.config import BacktestEngineConfig
    from nautilus_trader.backtest.engine import BacktestEngine
    from nautilus_trader.backtest.models import FillModel, LatencyModel
    from nautilus_trader.config import LoggingConfig, StrategyConfig
    from nautilus_trader.model.currencies import BTC, ETH, USDT
    from nautilus_trader.model.enums import AccountType, BookType, OmsType, OrderSide, OrderType
    from nautilus_trader.model.identifiers import InstrumentId, Symbol, TraderId, Venue
    from nautilus_trader.model.instruments import CryptoPerpetual
    from nautilus_trader.model.objects import Currency, Money, Price, Quantity
    from nautilus_trader.persistence.wranglers import TradeTickDataWrangler
    from nautilus_trader.trading.strategy import Strategy

    p = job["params"]
    symbol = job["symbol"]
    venue = Venue("BINANCE")
    base = {"BTC": BTC, "ETH": ETH}.get(symbol.replace("USDT", "")) or Currency.from_str(symbol.replace("USDT", ""))
    tick = Decimal(str(p["tickSize"]))
    step = Decimal(str(p["stepSize"]))
    lev = Decimal(str(p["leverage"]))
    instrument = CryptoPerpetual(
        instrument_id=InstrumentId(Symbol(f"{symbol}-PERP"), venue),
        raw_symbol=Symbol(symbol),
        base_currency=base,
        quote_currency=USDT,
        settlement_currency=USDT,
        is_inverse=False,
        price_precision=max(0, -tick.normalize().as_tuple().exponent),
        size_precision=max(0, -step.normalize().as_tuple().exponent),
        price_increment=Price.from_str(str(tick.normalize())),
        size_increment=Quantity.from_str(str(step.normalize())),
        ts_event=0,
        ts_init=0,
        min_quantity=Quantity.from_str(str(Decimal(str(p["minQty"])).normalize())),
        min_notional=Money(p["minNotional"], USDT),
        # The leveraged margin model divides by leverage: initial = notional / lev × 1,
        # maintenance = notional / lev × (MMR × lev) = notional × MMR — Binance's tier rule.
        margin_init=Decimal("1"),
        margin_maint=Decimal(str(p["mmr"])) * lev,
        maker_fee=Decimal(str(p["makerFeePct"] / 100)),
        taker_fee=Decimal(str(p["takerFeePct"] / 100)),
    )

    t_from, t_to = int(job["from"]), int(job["to"])
    tape_files = list(job["tapeFiles"])
    if not tape_files:
        raise RuntimeError("이 기간의 체결 데이터가 없습니다")
    progress(0.02, f"체결 데이터 {len(tape_files)}일치를 하루씩 노틸러스에 넣습니다")

    with open(job["signalsPath"], encoding="utf-8") as fh:
        signals = json.load(fh)

    class DeskConfig(StrategyConfig, frozen=True):
        instrument_id: InstrumentId
        total_ns: int
        start_ns: int

    class DeskSignals(Strategy):
        """Executes the desk's exported evaluations with the desk's own entry/exit rules."""

        def __init__(self, config: DeskConfig) -> None:
            super().__init__(config)
            self.sig = signals
            self.i = 0
            self.trades: list[dict] = []
            self.open: dict | None = None
            self.pending_entry: dict | None = None
            self.close_reason: str | None = None
            self.sl_order = None
            self.moved_to_be = False
            self.last_exit_ms = -(10**15)
            self.entries: list[int] = []
            self.day = ""
            self.day_start = float(p["startEquity"])
            self.streak = 0
            self.next_manage_ms = 0
            self.last_progress = -1
            self.fee = p["takerFeePct"] / 100

        def on_start(self) -> None:
            self.subscribe_trade_ticks(self.config.instrument_id)

        # ─ helpers ─
        def equity(self) -> float:
            acct = self.portfolio.account(venue)
            if acct is None:
                return float(p["startEquity"])
            bal = acct.balance_total(USDT)
            return float(bal.as_double()) if bal is not None else float(p["startEquity"])

        def position(self):
            pos = self.cache.positions_open(instrument_id=self.config.instrument_id)
            return pos[0] if pos else None

        def close(self, reason: str) -> None:
            pos = self.position()
            if pos is None or self.close_reason:
                return
            self.close_reason = reason
            self.cancel_all_orders(self.config.instrument_id)
            self.close_position(pos, tags=["DESK_CLOSE"])

        # ─ data ─
        def on_trade_tick(self, t) -> None:
            now_ms = t.ts_event // 1_000_000
            px = float(t.price)
            pct = int((t.ts_event - self.config.start_ns) * 50 / max(1, self.config.total_ns))
            if pct != self.last_progress:
                self.last_progress = pct
                progress(0.25 + 0.7 * pct / 50, f"노틸러스 실행 중 · 거래 {len(self.trades)}건")
            day = str(int(now_ms // 86_400_000))
            if day != self.day:
                self.day = day
                self.day_start = self.equity()
                self.streak = 0
            while self.i < len(self.sig) and self.sig[self.i]["t"] <= now_ms:
                self.on_signal(self.sig[self.i], px, now_ms)
                self.i += 1
            if self.open and now_ms >= self.next_manage_ms:
                self.next_manage_ms = now_ms + int(p["evalEverySec"]) * 1000
                self.manage(px, now_ms)

        def manage(self, px: float, now_ms: int) -> None:
            o = self.open
            if o is None or self.close_reason:
                return
            if now_ms - o["entryTime"] >= p["maxHoldMinutes"] * 60_000:
                self.close("시간 청산")
                return
            # Break-even + round-trip fees once the trade has gone breakevenAtR in favour.
            if p["breakevenAtR"] > 0 and self.sl_order is not None and not self.moved_to_be:
                d = 1 if o["side"] == "LONG" else -1
                risk_dist = d * (o["entryPrice"] - o["stopLoss"])
                if risk_dist > 0 and d * (px - o["entryPrice"]) / risk_dist >= p["breakevenAtR"]:
                    be = o["entryPrice"] * (1 + d * 2 * self.fee)
                    if d * (px - be) > 0 and self.sl_order.is_open:
                        self.modify_order(self.sl_order, trigger_price=instrument.make_price(be))
                        self.moved_to_be = True

        def on_signal(self, s: dict, px: float, now_ms: int) -> None:
            if self.open is not None:
                opposite = s["shortScore"] if self.open["side"] == "LONG" else s["longScore"]
                if opposite >= min(100, p["minScore"] + 10):
                    self.close("강한 반대 신호")
                return
            e = s.get("entry")
            if not e or self.pending_entry is not None or self.position() is not None:
                return
            eq = self.equity()
            day_loss = (eq - self.day_start) / self.day_start * 100 if self.day_start > 0 else 0
            if day_loss <= -p["dailyLossLimitPct"] or self.streak >= p["maxConsecutiveLosses"]:
                return
            if now_ms - self.last_exit_ms < p["cooldownMinutes"] * 60_000:
                return
            self.entries = [x for x in self.entries if now_ms - x < 3_600_000]
            if len(self.entries) >= p["maxTradesPerHour"]:
                return
            sized = size_order(e["side"], px, e["stopLoss"], p, eq, eq)
            if sized is None:
                return
            side = OrderSide.BUY if e["side"] == "LONG" else OrderSide.SELL
            bracket = self.order_factory.bracket(
                instrument_id=self.config.instrument_id,
                order_side=side,
                quantity=instrument.make_qty(sized["qty"]),
                entry_order_type=OrderType.MARKET,
                sl_trigger_price=instrument.make_price(e["stopLoss"]),
                tp_order_type=OrderType.MARKET_IF_TOUCHED,
                tp_trigger_price=instrument.make_price(e["takeProfit"]),
                tp_post_only=False,
            )
            for order in bracket.orders:
                if "STOP_LOSS" in (order.tags or []):
                    self.sl_order = order
            self.pending_entry = {**e, **sized, "signalTime": s["t"]}
            self.moved_to_be = False
            self.entries.append(now_ms)
            self.submit_order_list(bracket)

        # ─ events ─
        def on_position_opened(self, event) -> None:
            e = self.pending_entry or {}
            entry = float(event.avg_px_open)
            qty = float(event.quantity)
            side = "LONG" if event.entry == OrderSide.BUY else "SHORT"
            self.open = {
                "side": side, "entryTime": event.ts_opened // 1_000_000, "entryPrice": entry, "quantity": qty,
                "stopLoss": e.get("stopLoss", 0.0), "takeProfit": e.get("takeProfit", 0.0),
                "riskUsdt": e.get("riskUsdt", 0.0), "leverage": float(e.get("leverage", p["leverage"])), "features": e.get("features"),
                # The entry fill's commission arrived before this event.
                "fees": e.get("entryFee", 0.0),
            }
            self.pending_entry = None

        def on_order_filled(self, event) -> None:
            if self.open is not None:
                self.open["fees"] += float(event.commission.as_double())
            elif self.pending_entry is not None:
                self.pending_entry["entryFee"] = self.pending_entry.get("entryFee", 0.0) + float(event.commission.as_double())
            order = self.cache.order(event.client_order_id)
            tags = (order.tags or []) if order is not None else []
            if self.close_reason is None and "STOP_LOSS" in tags:
                self.close_reason = "본전 손절" if self.moved_to_be else "손절"
            elif self.close_reason is None and "TAKE_PROFIT" in tags:
                self.close_reason = "익절"

        def on_position_closed(self, event) -> None:
            o = self.open
            if o is None:
                return
            exit_px = float(event.avg_px_close)
            d = 1 if o["side"] == "LONG" else -1
            gross = d * (exit_px - o["entryPrice"]) * o["quantity"]
            fees = o["fees"]
            pnl = gross - fees
            margin = o["entryPrice"] * o["quantity"] / o["leverage"]
            self.trades.append(
                {
                    "side": o["side"], "entryTime": o["entryTime"], "exitTime": event.ts_closed // 1_000_000,
                    "entryPrice": o["entryPrice"], "exitPrice": exit_px, "stopLoss": o["stopLoss"],
                    "takeProfit": o["takeProfit"], "quantity": o["quantity"], "leverage": o["leverage"],
                    "liquidationPrice": liquidation_price(o["side"], o["entryPrice"], o["quantity"], o["leverage"], p["mmr"], p["cum"]),
                    "margin": margin, "pnl": pnl, "pnlR": pnl / o["riskUsdt"] if o["riskUsdt"] > 0 else 0.0,
                    "roe": pnl / margin * 100 if margin > 0 else 0.0, "fees": fees,
                    "exitReason": self.close_reason or "청산", "features": o["features"],
                }
            )
            self.streak = 0 if pnl > 0 else self.streak + 1
            self.last_exit_ms = event.ts_closed // 1_000_000
            self.open = None
            self.close_reason = None
            self.sl_order = None
            self.cancel_all_orders(self.config.instrument_id)

        def on_stop(self) -> None:
            self.cancel_all_orders(self.config.instrument_id)

        def finish_open(self, last_px: float, last_ms: int) -> None:
            """A position still open when the tape ends is closed at the last trade (taker fee)."""
            o = self.open
            if o is None:
                return
            d = 1 if o["side"] == "LONG" else -1
            fees = o["fees"] + last_px * o["quantity"] * self.fee
            pnl = d * (last_px - o["entryPrice"]) * o["quantity"] - fees
            margin = o["entryPrice"] * o["quantity"] / o["leverage"]
            self.trades.append(
                {
                    "side": o["side"], "entryTime": o["entryTime"], "exitTime": last_ms, "entryPrice": o["entryPrice"],
                    "exitPrice": last_px, "stopLoss": o["stopLoss"], "takeProfit": o["takeProfit"], "quantity": o["quantity"],
                    "leverage": o["leverage"],
                    "liquidationPrice": liquidation_price(o["side"], o["entryPrice"], o["quantity"], o["leverage"], p["mmr"], p["cum"]),
                    "margin": margin, "pnl": pnl, "pnlR": pnl / o["riskUsdt"] if o["riskUsdt"] > 0 else 0.0,
                    "roe": pnl / margin * 100 if margin > 0 else 0.0, "fees": fees, "exitReason": "기간 종료", "features": o["features"],
                }
            )
            self.open = None

    engine = BacktestEngine(config=BacktestEngineConfig(trader_id=TraderId("DESK-001"), logging=LoggingConfig(log_level="ERROR")))
    engine.add_venue(
        venue=venue,
        oms_type=OmsType.NETTING,
        account_type=AccountType.MARGIN,
        base_currency=USDT,
        starting_balances=[Money(float(p["startEquity"]), USDT)],
        default_leverage=lev,
        book_type=BookType.L1_MBP,
        trade_execution=True,
        fill_model=FillModel(prob_fill_on_limit=1.0, prob_slippage=0.5, random_seed=42),
        latency_model=LatencyModel(base_latency_nanos=int(p.get("latencyMs", 50)) * 1_000_000),
    )
    engine.add_instrument(instrument)
    strategy = DeskSignals(DeskConfig(instrument_id=instrument.id, total_ns=(t_to - t_from) * 1_000_000, start_ns=t_from * 1_000_000))
    engine.add_strategy(strategy)

    # One day of the tape at a time (Nautilus's streaming mode): a busy BTCUSDT day is
    # millions of trades, and holding a whole week of TradeTicks would exhaust memory.
    wrangler = TradeTickDataWrangler(instrument=instrument)
    total_ticks = 0
    last_px = None
    last_ms = None
    for path in tape_files:
        frame = agg_trades_frame([path], t_from, t_to)
        if frame.empty:
            continue
        ticks = wrangler.process(frame)
        total_ticks += len(ticks)
        last_px = float(frame["price"].iloc[-1])
        last_ms = int(frame.index[-1].value // 1_000_000)
        del frame
        engine.add_data(ticks)
        del ticks
        engine.run(streaming=True)
        engine.clear_data()
    if total_ticks == 0:
        engine.dispose()
        raise RuntimeError("이 기간의 체결 데이터가 없습니다")
    engine.end()
    strategy.finish_open(last_px, last_ms)
    progress(0.97, "결과 정리")
    acct = engine.portfolio.account(venue)
    ending = float(acct.balance_total(USDT).as_double()) if acct is not None else None
    result = {
        "engine": "nautilus",
        "nautilusVersion": getattr(nautilus_trader, "__version__", NAUTILUS_VERSION),
        "ticks": total_ticks,
        "trades": strategy.trades,
        "endingBalance": ending,
        "notes": [
            "NautilusTrader가 실제 체결 흐름(aggTrades)에 주문을 맞춰 체결했습니다 (L1, 체결 기반, 1틱 슬리피지 확률 50%, 지연 "
            + str(int(p.get("latencyMs", 50)))
            + "ms)",
            "노틸러스 백테스트에는 강제 청산과 펀딩비가 반영되지 않습니다 (손절이 항상 청산가보다 먼저 닿도록 데스크가 레버리지를 정합니다)",
        ],
    }
    engine.dispose()
    return result


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: desk_backtest.py <job.json>", file=sys.stderr)
        return 2
    with open(argv[1], encoding="utf-8") as fh:
        job = json.load(fh)
    try:
        result = run(job)
    except Exception as exc:  # reported to the desk, which shows it to the user
        result = {"engine": "nautilus", "error": f"{type(exc).__name__}: {exc}"}
    with open(job["out"], "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False)
    progress(1.0, "완료" if "error" not in result else "실패")
    return 0 if "error" not in result else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
