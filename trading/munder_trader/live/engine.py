"""DeskEngine — the headless 24/7 loop that runs both desks on every symbol.

Flow per closed candle (1m → scalp desk, 1h → swing desk):

    frame update → quant signal (+ live book/tape gate for scalp) → MarketContext
    → DeskGraph committee (analysts / debate / trader / risk / PM) → DeskDecision
    → sizer (risk budget, split entries, leverage ≤ cap) → RiskManager → broker

Between candles the engine manages open positions with the HoldPolicy
(breakeven, trailing, quick take vs. extend, time stop), polls the broker,
reflects on closed trades (memory + agent weights + Kelly stats), records
equity, serves the status page and lets the ContinuousLearner retune params in
the background. Everything is journaled with its reasoning.
"""

from __future__ import annotations

import json
import logging
import queue
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import pandas as pd

from ..agents.base import MarketContext
from ..agents.graph import DeskDecision, DeskGraph
from ..agents.llm import LLMClient
from ..agents.weights import AgentWeights
from ..config import Settings
from ..data.binance_rest import BinanceFuturesREST
from ..data.derivatives import DerivativesContext, FearGreed
from ..data.history import HistoryStore, resample_ohlcv
from ..data.stream import MarketFeed
from ..execution.base import Broker, BrokerEvent
from ..execution.paper import PaperBroker
from ..learn.feedback import ClosedTrade, TradeReflector
from ..learn.memory import LessonMemory
from ..learn.scheduler import ContinuousLearner, LearningEvent
from ..strategy.params import ParamStore
from ..strategy.plan import OrderPlan
from ..strategy.position_sizing import build_plan
from ..strategy.risk import HoldPolicy, RiskManager, RiskVerdict
from ..strategy.signals import apply_microstructure, compute_scalp, compute_swing, signal_at
from ..symbols import SymbolFilters, meta_for
from ..util import iso, now_ms, setup_logging, to_json
from .journal import Journal
from .notify import Notifier

log = logging.getLogger(__name__)

FRAME_LIMITS = {"1m": 4000, "5m": 2000, "1h": 3000, "4h": 1500, "1d": 800}


@dataclass
class Evaluation:
    decision: DeskDecision
    plan: OrderPlan | None
    verdict: RiskVerdict | None
    executed: bool
    reasons: list[str]

    def to_dict(self) -> dict:
        return {"decision": self.decision.to_dict(), "plan": self.plan.to_dict() if self.plan else None,
                "verdict": {"allowed": self.verdict.allowed, "severity": self.verdict.severity, "reasons": self.verdict.reasons} if self.verdict else None,
                "executed": self.executed, "reasons": self.reasons}


class DeskEngine:
    def __init__(self, settings: Settings, *, rest: BinanceFuturesREST | None = None, feed: Any | None = None,
                 broker: Broker | None = None, history: HistoryStore | None = None, journal: Journal | None = None,
                 llm_client: LLMClient | None = None, filters: dict[str, SymbolFilters] | None = None,
                 data_provider: Callable[[str, str], pd.DataFrame] | None = None, offline: bool = False,
                 news_provider: Callable[[str], list[dict]] | None = None) -> None:
        self.s = settings
        self.offline = offline
        self.log = setup_logging(settings.log_level, str(Path(settings.state_dir) / "desk.log") if not offline else None)
        Path(settings.state_dir).mkdir(parents=True, exist_ok=True)
        self.rest = rest or (None if offline else BinanceFuturesREST(settings.rest_base, settings.binance.api_key,
                                                                     settings.binance.api_secret, recv_window_ms=settings.binance.recv_window_ms))
        self.filters: dict[str, SymbolFilters] = filters or {}
        self.history = history or HistoryStore(self.rest, settings.data.cache_dir)
        self.journal = journal or Journal(Path(settings.state_dir) / "journal.sqlite")
        self.params = ParamStore(Path(settings.state_dir) / "params.json")
        self.weights = AgentWeights(Path(settings.state_dir) / "agent_weights.json")
        self.memory = LessonMemory(Path(settings.state_dir) / "lessons.jsonl")
        self.llm = llm_client or LLMClient(settings.llm)
        self.graph = DeskGraph(settings.risk, settings.llm, weights=self.weights, llm_client=self.llm)
        self.reflector = TradeReflector(self.memory, self.weights, self.llm, settings.llm.output_language)
        self.risk = RiskManager(settings.risk, kill_switch_file=Path(settings.state_dir) / Path(settings.risk.kill_switch_file).name)
        self.hold_policy = HoldPolicy()
        self.notifier = Notifier(settings.notify)
        self.derivatives = DerivativesContext(self.rest) if self.rest is not None else None
        self.fear_greed = FearGreed() if not offline else None
        self.news_provider = news_provider
        self.data_provider = data_provider
        self.frames: dict[tuple[str, str], pd.DataFrame] = {}
        self.feed = feed
        self.broker = broker
        self.learner: ContinuousLearner | None = None
        self._bars: queue.Queue = queue.Queue()
        self._stop = threading.Event()
        self._exec = ThreadPoolExecutor(max_workers=3, thread_name_prefix="desk-eval")
        self._inflight: set[tuple[str, str]] = set()
        self._broker_lock = threading.RLock()
        self.last_eval: dict[tuple[str, str], Evaluation] = {}
        self._last_poll_ts: dict[str, int] = {}
        self._last_status_write = 0.0
        self._last_equity_write = 0.0
        self._last_manage = 0.0
        self._day_key = ""
        self._last_trigger_check = 0.0
        self._last_trigger: dict[str, float] = {}
        self.started_ts = now_ms()
        self.errors = 0

    # ------------------------------------------------------------------ setup
    def setup(self) -> None:
        if not self.filters:
            if self.rest is not None and not self.offline:
                try:
                    from ..execution.binance_futures import load_filters

                    self.filters = load_filters(self.rest, self.s.symbols, with_brackets=self.rest.has_keys)
                except Exception as exc:
                    log.warning("exchangeInfo unavailable (%s); using default filters", exc)
            self.filters = {s: self.filters.get(s) or SymbolFilters(s) for s in self.s.symbols}
        if self.broker is None:
            self.broker = self._make_broker()
        if self.feed is None and not self.offline:
            self.feed = self._make_feed()
        if self.feed is not None:
            self.feed.on_bar(self._on_bar)
        self._load_frames()
        for sym in self.s.symbols:
            for mode in ("swing", "scalp"):
                self.reflector.seed_stats(mode, sym, self.journal.trade_stats(mode, sym))
        if self.s.learning.enabled and not self.offline:
            self.learner = ContinuousLearner(self.s, self.history, self.filters, self.params, self.weights, on_event=self._on_learning)
        self._restore_paper()

    def _make_broker(self) -> Broker:
        if self.s.trading_env in ("testnet", "live") and self.rest is not None and self.rest.has_keys:
            from ..execution.binance_futures import BinanceFuturesBroker

            broker = BinanceFuturesBroker(self.rest, self.s.symbols, isolated=self.s.binance.isolated_margin,
                                          taker_fee=self.s.binance.taker_fee, maker_fee=self.s.binance.maker_fee)
            self.filters.update({k: v for k, v in broker._filters.items()})
            return broker
        if self.s.trading_env in ("testnet", "live"):
            log.warning("trading_env=%s but no API keys → falling back to PAPER trading", self.s.trading_env)
        return PaperBroker(self.s.paper_starting_balance, self.filters, self._paper_price, taker_fee=self.s.binance.taker_fee,
                           maker_fee=self.s.binance.maker_fee, funding_source=self._funding_rate)

    def _make_feed(self) -> Any:
        if self.s.data.use_nautilus:
            try:
                from ..data.nautilus_bridge import NautilusFeed, nautilus_available

                if nautilus_available():
                    return NautilusFeed(self.s.symbols, testnet=self.s.trading_env == "testnet", api_key=self.s.binance.api_key,
                                        api_secret=self.s.binance.api_secret, tape_short_s=self.s.scalp.tape_window_s)
                log.warning("data.use_nautilus is on but nautilus_trader is not installed → using the native feed")
            except Exception as exc:  # pragma: no cover
                log.warning("nautilus feed unavailable (%s) → native feed", exc)
        return MarketFeed(self.rest, self.s.symbols, ws_base=self.s.ws_base, kline_intervals=("1m", "1h"),
                          depth_speed=self.s.data.stream_depth_speed, tape_short_s=self.s.scalp.tape_window_s,
                          poll_interval_s=self.s.data.poll_interval_s)

    def _load_frames(self) -> None:
        for sym in self.s.symbols:
            if self.data_provider is not None:
                for tf in ("1m", "1h"):
                    self.frames[(sym, tf)] = self.data_provider(sym, tf)
                continue
            try:
                self.frames[(sym, "1m")] = self.history.get(sym, "1m", days=3)
                self.frames[(sym, "1h")] = self.history.get(sym, "1h", days=90)
                self.frames[(sym, "4h")] = self.history.get(sym, "4h", days=120)
            except Exception as exc:
                log.warning("history load failed for %s: %s", sym, exc)
        log.info("frames loaded: %s", {k: len(v) for k, v in self.frames.items()})

    def _restore_paper(self) -> None:
        if isinstance(self.broker, PaperBroker):
            snap = self.journal.get_kv("paper_state")
            if snap:
                try:
                    self.broker.restore(snap)
                    log.info("paper state restored: balance %.2f, %d positions", self.broker.state.balance, len(self.broker.state.positions))
                except Exception as exc:
                    log.warning("could not restore paper state: %s", exc)

    # ------------------------------------------------------------------ data helpers
    def frame(self, symbol: str, interval: str) -> pd.DataFrame:
        key = (symbol, interval)
        if key in self.frames and not self.frames[key].empty:
            return self.frames[key]
        if interval in ("5m", "4h", "1d"):
            base = self.frames.get((symbol, "1m" if interval == "5m" else "1h"))
            if base is not None and not base.empty:
                return resample_ohlcv(base, interval)
        return pd.DataFrame()

    def _append_bar(self, symbol: str, interval: str, bar: dict) -> None:
        key = (symbol, interval)
        row = pd.DataFrame([{k: v for k, v in bar.items() if k != "closed"}])
        row.index = pd.to_datetime(row["open_time"], unit="ms", utc=True)
        row.index.name = "time"
        df = self.frames.get(key)
        df = row if df is None or df.empty else pd.concat([df[df["open_time"] != bar["open_time"]], row]).sort_index()
        limit = FRAME_LIMITS.get(interval, 3000)
        if len(df) > limit:
            df = df.iloc[-limit:]
        self.frames[key] = df

    def _on_bar(self, symbol: str, interval: str, bar: dict) -> None:
        self._bars.put((symbol, interval, bar))

    def _paper_price(self, symbol: str) -> dict | None:
        price = high = low = None
        book = None
        if self.feed is not None:
            try:
                book = self.feed.book(symbol)
                mid = book.mid() if book.synced else None
                price = mid
                last = self._last_poll_ts.get(symbol, now_ms() - 5000)
                trades = [t for t in self.feed.tapes[symbol].trades if t.ts > last]
                if trades:
                    high = max(t.price for t in trades)
                    low = min(t.price for t in trades)
                    if price is None:
                        price = trades[-1].price
            except Exception:
                pass
        if price is None:
            df = self.frames.get((symbol, "1m"))
            if df is None or df.empty:
                return None
            price = float(df["close"].iloc[-1])
        self._last_poll_ts[symbol] = now_ms()
        return {"price": price, "high": high if high is not None else price, "low": low if low is not None else price,
                "ts": now_ms(), "book": book}

    def _funding_rate(self, symbol: str) -> float:
        if self.feed is not None:
            info = self.feed.mark_info(symbol)
            if info.get("funding") is not None:
                return float(info["funding"])
        return 0.0001

    # ------------------------------------------------------------------ evaluation
    def evaluate(self, symbol: str, mode: str, *, execute: bool = True, use_llm: bool | None = None) -> Evaluation | None:
        symbol = symbol.upper()
        base_tf = "1m" if mode == "scalp" else "1h"
        df = self.frame(symbol, base_tf)
        if df.empty or len(df) < (300 if mode == "scalp" else 220):
            log.debug("not enough %s bars for %s %s", base_tf, symbol, mode)
            return None
        params = self.params.get(mode, symbol)
        ctx_frame = self.frame(symbol, "5m" if mode == "scalp" else "4h")
        enriched = compute_scalp(df, params, ctx_frame) if mode == "scalp" else compute_swing(df, params, ctx_frame)
        sig = signal_at(mode, symbol, enriched)
        book = tape = None
        if self.feed is not None:
            try:
                book = self.feed.book_features(symbol, self.s.scalp.book_depth_levels)
                tape = self.feed.tape_features(symbol)
            except Exception:
                pass
        if mode == "scalp":
            sig = apply_microstructure(sig, book, tape, params)
        price = sig.entry
        if book is not None and book.mid:
            price = book.mid if mode == "scalp" else price
        mark_info = self.feed.mark_info(symbol) if self.feed is not None else {}
        derivs = self.derivatives.get(symbol, mark_info=mark_info) if self.derivatives is not None else {}
        sentiment: dict[str, Any] = {}
        if self.fear_greed is not None and mode == "swing":
            fg = self.fear_greed.get()
            if fg is not None:
                sentiment["fear_greed"] = fg
        news = []
        if self.news_provider is not None and mode == "swing":
            try:
                news = self.news_provider(symbol) or []
            except Exception as exc:
                log.debug("news provider failed: %s", exc)
        account = self.broker.account()
        position = account.positions.get(symbol)
        situation = f"{mode} {symbol} {sig.setup} {sig.regime} {' '.join(k for k in sig.components)}"
        lessons = self.memory.lessons_for(situation, mode=mode, symbol=symbol, k=3)
        session_liq = self.risk.session_liquidity(symbol)
        ctx = MarketContext(symbol=symbol, mode=mode, ts=sig.ts or now_ms(), price=price, frame=enriched, signal=sig,
                            context_frames={"ctx": ctx_frame}, book=book, tape=tape, derivatives=derivs, news=news,
                            sentiment=sentiment, lessons=lessons, position=position,
                            stats=self.reflector.stats_for(mode, symbol), session_liquidity=session_liq)
        decision = self.graph.run(ctx, use_llm=self.llm.enabled if use_llm is None else use_llm)
        reasons: list[str] = []
        plan = None
        verdict = None
        executed = False
        dec_id = self.journal.decision(decision.to_dict())
        if decision.approve and decision.direction != 0 and position is None:
            # the committee may have moved stop/targets (committee-initiated); carry them into the signal
            sig.direction = decision.direction
            sig.stop, sig.tp1, sig.tp2 = decision.stop, decision.tp1, decision.tp2
            if sig.setup == "none":
                sig.setup = "committee"
            share = (self.s.scalp.budget_share if mode == "scalp" else self.s.swing.budget_share) / 0.5
            risk_cfg = self.s.risk.model_copy(update={"max_leverage": min(self.s.risk.max_leverage, decision.leverage_cap)})
            plan = build_plan(sig, conviction=decision.conviction, account=account, filters=self.filters.get(symbol) or SymbolFilters(symbol),
                              risk=risk_cfg, params=params, stats=ctx.stats, size_multiplier=decision.size_multiplier * share,
                              reasons=[decision.summary])
            if plan is None:
                reasons.append("sizer produced no plan (stop too tight, below exchange minimum or no margin)")
            else:
                verdict = self.risk.check(plan, account, funding_rate=float(derivs.get("funding_rate", 0.0) or 0.0),
                                          session_liquidity=session_liq, agent_agreement=decision.agreement)
                self.journal.plan(plan.to_dict(), allowed=verdict.allowed, verdict="; ".join(verdict.reasons))
                reasons.extend(verdict.reasons)
                if verdict.allowed and verdict.plan is not None and execute:
                    with self._broker_lock:
                        pos = self.broker.place_plan(verdict.plan, decision=decision.to_dict())
                    executed = pos is not None
                    if executed:
                        self.journal.mark_executed(dec_id)
                        self.notifier.send(f"[{self.broker.name}] {decision.mode} {symbol} {verdict.plan.side} {verdict.plan.total_qty:g} lev {verdict.plan.leverage}x\n{decision.summary}")
        elif position is not None:
            reasons.append(f"already holding {position.side} on {symbol} ({position.mode} desk) → no new entry")
        elif not decision.approve:
            reasons.append("committee did not approve a trade")
        ev = Evaluation(decision, plan, verdict, executed, reasons)
        self.last_eval[(symbol, mode)] = ev
        log.info("%s %s → %s (conv %.2f, agree %.0f%%)%s", mode, symbol, decision.action, decision.conviction,
                 decision.agreement * 100, " EXECUTED" if executed else "")
        return ev

    def _evaluate_async(self, symbol: str, mode: str) -> None:
        key = (symbol, mode)
        if key in self._inflight:
            return
        self._inflight.add(key)

        def task() -> None:
            try:
                self.evaluate(symbol, mode)
            except Exception:
                self.errors += 1
                log.exception("evaluation failed for %s %s", symbol, mode)
            finally:
                self._inflight.discard(key)

        self._exec.submit(task)

    # ------------------------------------------------------------------ position management
    def manage_positions(self) -> None:
        account = self.broker.account()
        for sym, pos in list(account.positions.items()):
            price = None
            book = tape = None
            if self.feed is not None:
                try:
                    b = self.feed.book(sym)
                    price = b.mid() if b.synced else None
                    book = self.feed.book_features(sym, self.s.scalp.book_depth_levels)
                    tape = self.feed.tape_features(sym)
                except Exception:
                    pass
            if price is None:
                price = self.broker.mark_price(sym)
            if price is None:
                continue
            tf = "1m" if pos.mode == "scalp" else "1h"
            df = self.frame(sym, tf)
            adx = slope = 0.0
            rsi = 50.0
            atr = pos.atr
            regime = pos.tags.get("regime", "range")
            if not df.empty and len(df) > 50:
                params = self.params.get(pos.mode, sym)
                ctx_frame = self.frame(sym, "5m" if pos.mode == "scalp" else "4h")
                try:
                    enriched = (compute_scalp if pos.mode == "scalp" else compute_swing)(df.iloc[-400:], params, ctx_frame)
                    last = enriched.iloc[-1]
                    adx, slope, rsi, atr, regime = float(last["adx"]), float(last["ema_fast_slope"]), float(last["rsi"]), float(last["atr"]), str(last["regime"])
                except Exception as exc:
                    log.debug("indicator refresh failed for %s: %s", sym, exc)
            bar_ms = 60_000 if pos.mode == "scalp" else 3_600_000
            bars = int((now_ms() - pos.opened_ts) / bar_ms)
            wall = False
            if book is not None:
                w = book.ask_wall if pos.direction > 0 else book.bid_wall
                wall = bool(w and abs(w[0] - price) / price < 0.002)
            hd = self.hold_policy.evaluate(pos, price, adx=adx, ema_slope_pct=slope, rsi=rsi,
                                           book_pressure=book.pressure() if book else 0.0, tape_pressure=tape.pressure() if tape else 0.0,
                                           atr=atr, regime=regime, opposing_wall=wall, bars_since_entry=bars)
            bias = pos.tags.get("hold_bias", "balanced")
            action = hd.action
            if bias == "quick" and action == "extend":
                action = "keep"
            if bias == "extend" and action == "take_quick" and hd.continuation >= 0.45:
                action = "tighten"
            with self._broker_lock:
                if action in ("exit", "take_quick"):
                    self.broker.close_position(sym, 1.0, reason="time_stop" if action == "exit" else "take_quick")
                    self.journal.event("hold_policy", sym, f"{action}: " + "; ".join(hd.reasons))
                    continue
                if hd.new_stop is not None:
                    if self.broker.update_stop(sym, hd.new_stop, reason=action):
                        self.journal.event("hold_policy", sym, f"{action}: stop → {hd.new_stop:.6g}; " + "; ".join(hd.reasons[-2:]))
                # pyramiding: a winner with strong continuation and a fresh same-direction committee call gets one add
                self._maybe_pyramid(sym, pos, price, hd.continuation, action)

    def _maybe_pyramid(self, sym: str, pos: Any, price: float, continuation: float, action: str) -> None:
        if pos.tags.get("pyramided", 0) >= 1 or pos.r_multiple(price) < 1.0 or continuation < 0.7 or action not in ("extend", "keep"):
            return
        ev = self.last_eval.get((sym, pos.mode))
        if ev is None or not ev.decision.approve or ev.decision.direction != pos.direction or ev.decision.conviction < 0.7:
            return
        if now_ms() - ev.decision.ts > (15 if pos.mode == "scalp" else 180) * 60_000:
            return
        account = self.broker.account()
        add_qty = pos.original_qty * 0.5
        extra_margin = add_qty * price / pos.leverage
        if account.used_margin + extra_margin > account.equity * self.s.risk.max_margin_fraction or self.risk.kill_switch_active() or self.risk.is_paused:
            return
        if self.broker.add_to_position(sym, add_qty, reason=f"pyramid: R={pos.r_multiple(price):.2f} continuation {continuation:.2f} conviction {ev.decision.conviction:.2f}"):
            be = pos.entry_price + pos.direction * max(pos.atr * 0.1, pos.entry_price * 0.0003)
            self.broker.update_stop(sym, be, reason="pyramid → stop to new breakeven")
            self.journal.event("pyramid", sym, f"added {add_qty:g} (R≥1, continuation {continuation:.2f}, committee {ev.decision.conviction:.2f})")

    def _microstructure_triggers(self) -> None:
        """Between candles: re-run the scalp desk when book + tape pressure align hard (rate-limited)."""
        if self.feed is None or not self.s.scalp.enabled or not self.s.scalp.microstructure_trigger:
            return
        now = time.time()
        if now - self._last_trigger_check < 5.0:
            return
        self._last_trigger_check = now
        try:
            positions = self.broker.account().positions
        except Exception:
            return
        for sym in self.s.symbols:
            if sym in positions or now - self._last_trigger.get(sym, 0.0) < 45.0:
                continue
            try:
                book = self.feed.book_features(sym, self.s.scalp.book_depth_levels)
                tape = self.feed.tape_features(sym)
            except Exception:
                continue
            if book is None or tape is None or not book.synced:
                continue
            bp, tp = book.pressure(), tape.pressure()
            if abs(bp) >= 0.3 and abs(tp) >= 0.3 and (bp > 0) == (tp > 0) and tape.intensity >= 1.5:
                self._last_trigger[sym] = now
                self.journal.event("trigger", sym, f"microstructure trigger: book {bp:+.2f} tape {tp:+.2f} intensity {tape.intensity:.1f}")
                self._evaluate_async(sym, "scalp")

    # ------------------------------------------------------------------ events
    def _handle_broker_events(self, events: list[BrokerEvent]) -> None:
        for ev in events:
            self.journal.event(ev.kind, ev.symbol, ev.detail)
            if ev.kind == "close" and ev.closed_trade is not None:
                self._on_closed_trade(ev.closed_trade)
            elif ev.kind in ("fill", "reject"):
                log.info("broker %s %s: %s", ev.kind, ev.symbol, ev.detail)

    def _on_closed_trade(self, ct: ClosedTrade) -> None:
        self.journal.trade(ct)
        try:
            lesson = self.reflector.reflect(ct)
            self.journal.event("lesson", ct.symbol, lesson.lesson)
            log.info("closed %s %s pnl %+.2f (%+.2fR) — lesson: %s", ct.symbol, ct.side, ct.pnl, ct.r_multiple, lesson.lesson[:140])
            self.notifier.send(f"[{self.broker.name}] closed {ct.symbol} {ct.side} {ct.exit_reason} pnl {ct.pnl:+.2f} ({ct.r_multiple:+.2f}R)\n{lesson.lesson[:200]}")
        except Exception:
            log.exception("reflection failed")

    def _on_learning(self, ev: LearningEvent) -> None:
        self.journal.learning(ev.to_dict())
        if ev.promoted:
            self.notifier.send(f"[learning] {ev.mode} {ev.symbol}: new parameters promoted — {ev.reason[:160]}")

    # ------------------------------------------------------------------ loop
    def step(self) -> None:
        """One iteration of the main loop (used by the daemon and by tests)."""
        self._roll_day()
        drained = 0
        while drained < 50:
            try:
                sym, tf, bar = self._bars.get_nowait()
            except queue.Empty:
                break
            drained += 1
            self._append_bar(sym, tf, bar)
            if tf == "1m" and self.s.scalp.enabled:
                self._evaluate_async(sym, "scalp")
            elif tf == "1h" and self.s.swing.enabled:
                self._evaluate_async(sym, "swing")
        with self._broker_lock:
            events = self.broker.poll()
        self._handle_broker_events(events)
        self._microstructure_triggers()
        if time.time() - self._last_manage >= 3.0:
            self._last_manage = time.time()
            try:
                self.manage_positions()
            except Exception:
                self.errors += 1
                log.exception("position management failed")
        if time.time() - self._last_equity_write >= 60.0:
            self._last_equity_write = time.time()
            acct = self.broker.account()
            self.journal.equity(acct.equity, acct.equity - sum(p.unrealized(self.broker.mark_price(s) or p.entry_price) for s, p in acct.positions.items()) if acct.positions else acct.equity,
                                acct.used_margin, len(acct.positions))
            if isinstance(self.broker, PaperBroker):
                self.journal.set_kv("paper_state", self.broker.snapshot())
        if time.time() - self._last_status_write >= 5.0:
            self._last_status_write = time.time()
            self.write_status()

    def _roll_day(self) -> None:
        key = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        if key != self._day_key:
            self._day_key = key
            if isinstance(self.broker, PaperBroker):
                self.broker.state.daily_pnl = 0.0
            elif hasattr(self.broker, "reset_daily"):
                self.broker.reset_daily()

    def run_forever(self, *, kickoff: bool = True) -> None:
        self.setup()
        if self.feed is not None:
            self.feed.start()
        if self.learner is not None:
            self.learner.start(initial_delay_s=180.0)
        log.info("desk running: env=%s broker=%s symbols=%s cap=%dx llm=%s", self.s.trading_env, self.broker.name,
                 ",".join(self.s.symbols), self.s.risk.max_leverage, self.s.llm.provider)
        if kickoff:
            for sym in self.s.symbols:
                if self.s.swing.enabled:
                    self._evaluate_async(sym, "swing")
                if self.s.scalp.enabled:
                    self._evaluate_async(sym, "scalp")
        try:
            while not self._stop.is_set():
                t0 = time.time()
                try:
                    self.step()
                except Exception:
                    self.errors += 1
                    log.exception("engine step failed")
                self._stop.wait(max(0.2, 1.0 - (time.time() - t0)))
        finally:
            self.shutdown()

    def stop(self) -> None:
        self._stop.set()

    def shutdown(self) -> None:
        log.info("shutting down desk")
        if self.learner is not None:
            self.learner.stop()
        if self.feed is not None:
            try:
                self.feed.stop()
            except Exception:
                pass
        if isinstance(self.broker, PaperBroker):
            self.journal.set_kv("paper_state", self.broker.snapshot())
        self.write_status()
        self._exec.shutdown(wait=False, cancel_futures=True)
        try:
            self.broker.shutdown()
        except Exception:
            pass

    # ------------------------------------------------------------------ status
    def status(self) -> dict[str, Any]:
        acct = self.broker.account()
        positions = {}
        for sym, pos in acct.positions.items():
            price = self.broker.mark_price(sym) or pos.entry_price
            d = pos.to_dict()
            d.update(mark=price, unrealized=pos.unrealized(price), r_multiple=pos.r_multiple(price))
            positions[sym] = d
        last = {}
        for (sym, mode), ev in self.last_eval.items():
            last.setdefault(sym, {})[mode] = {
                "ts": iso(ev.decision.ts), "action": ev.decision.action, "rating": ev.decision.rating,
                "conviction": round(ev.decision.conviction, 3), "agreement": round(ev.decision.agreement, 3),
                "executed": ev.executed, "summary": ev.decision.summary, "reasons": ev.reasons,
                "explain": ev.decision.explain(),
            }
        return {
            "ts": iso(), "started": iso(self.started_ts), "env": self.s.trading_env, "broker": self.broker.name,
            "symbols": self.s.symbols, "max_leverage": self.s.risk.max_leverage, "llm": self.s.llm.provider,
            "equity": acct.equity, "available": acct.available, "used_margin": acct.used_margin, "daily_pnl": acct.daily_pnl,
            "peak_equity": acct.peak_equity, "positions": positions, "risk": {"paused": self.risk.is_paused, "pause_reason": self.risk.pause_reason,
                                                                             "kill_switch": self.risk.kill_switch_active()},
            "feed": self.feed.health() if self.feed is not None else {"mode": "offline"},
            "learning": self.learner.status() if self.learner is not None else {"enabled": False},
            "memory": self.memory.stats(), "agent_weights": self.weights.snapshot(), "journal": self.journal.summary(),
            "last_decisions": last, "errors": self.errors,
        }

    def write_status(self) -> None:
        try:
            p = Path(self.s.state_dir) / "status.json"
            tmp = p.with_suffix(".tmp")
            tmp.write_text(to_json(self.status(), indent=1), encoding="utf-8")
            tmp.replace(p)
        except Exception as exc:  # pragma: no cover
            log.debug("status write failed: %s", exc)
