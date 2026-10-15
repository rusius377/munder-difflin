"""``munder-trader`` command line.

    munder-trader run            # 24/7 desk (paper / testnet / live per settings)
    munder-trader paper          # same, forced paper trading
    munder-trader analyze ETHUSDT --mode both   # one-shot: both desks explain their call, no orders
    munder-trader backtest --symbol BTCUSDT --mode swing --days 90 [--backtrader]
    munder-trader optimize --symbol ETHUSDT --mode scalp
    munder-trader learn          # one full learning pass over all symbols / desks (cron friendly)
    munder-trader explain --symbol ETHUSDT --limit 5
    munder-trader status | doctor | selftest | kill | resume
"""

from __future__ import annotations

import argparse
import json
import signal
import sys
from pathlib import Path

from . import __version__
from .config import Settings, load_settings
from .util import iso, setup_logging, to_json


def _settings(args: argparse.Namespace) -> Settings:
    s = load_settings(args.config)
    if getattr(args, "env", None):
        s.trading_env = args.env
    if getattr(args, "symbols", None):
        s.symbols = [x.strip().upper() for x in args.symbols.split(",") if x.strip()]
    if getattr(args, "no_llm", False):
        s.llm.provider = "none"
    if getattr(args, "max_leverage", None):
        s.risk.max_leverage = int(args.max_leverage)
    return s


def cmd_run(args: argparse.Namespace) -> int:
    s = _settings(args)
    if args.cmd == "paper":
        s.trading_env = "paper"
    if s.trading_env == "live" and not args.yes:
        print("⚠️  LIVE trading with real funds. Re-run with --yes to confirm (or use `paper` / `testnet`).")
        return 2
    from .live.engine import DeskEngine
    from .live.status_server import StatusServer

    engine = DeskEngine(s)
    server = StatusServer(engine, s.server.host, s.server.port) if s.server.enabled else None

    def _sig(*_a):
        engine.stop()

    signal.signal(signal.SIGINT, _sig)
    signal.signal(signal.SIGTERM, _sig)
    if server:
        try:
            server.start()
        except OSError as exc:
            print(f"status server disabled: {exc}")
            server = None
    try:
        engine.run_forever()
    finally:
        if server:
            server.stop()
    return 0


def cmd_analyze(args: argparse.Namespace) -> int:
    s = _settings(args)
    setup_logging(s.log_level)
    from .live.engine import DeskEngine

    offline = args.offline
    engine = DeskEngine(s, offline=offline, data_provider=_synthetic_provider() if offline else None)
    engine.setup()
    if engine.feed is not None and not offline:
        engine.feed.start()
        import time

        print("warming up market feed (order book / tape)…")
        time.sleep(min(20, max(5, args.warmup)))
    modes = ("swing", "scalp") if args.mode == "both" else (args.mode,)
    for sym in ([args.symbol.upper()] if args.symbol else s.symbols):
        for mode in modes:
            ev = engine.evaluate(sym, mode, execute=False)
            if ev is None:
                print(f"[{mode}] {sym}: not enough data")
                continue
            print(ev.decision.explain())
            if ev.plan:
                print("\n[사이징/리스크]")
                for r in ev.plan.reasons:
                    print("  •", r)
            if ev.reasons:
                print("[실행 판단] " + "; ".join(ev.reasons))
            print()
    engine.shutdown()
    return 0


def _synthetic_provider():
    from .data.history import synthetic_ohlcv

    def provider(symbol: str, tf: str):
        seed = sum(ord(c) for c in symbol)
        return synthetic_ohlcv(4000 if tf == "1m" else 3000, tf, 100.0 + seed % 50, seed=seed)

    return provider


def cmd_backtest(args: argparse.Namespace) -> int:
    s = _settings(args)
    setup_logging(s.log_level)
    from .backtest.engine import BacktestConfig, BacktestEngine
    from .backtest.scorer import compute_metrics
    from .data.binance_rest import BinanceFuturesREST
    from .data.history import HistoryStore, resample_ohlcv, synthetic_ohlcv
    from .strategy.params import ParamStore
    from .symbols import SymbolFilters

    sym = args.symbol.upper()
    mode = args.mode
    filters = SymbolFilters(sym)
    if args.synthetic:
        base = synthetic_ohlcv(args.bars, "1m" if mode == "scalp" else "1h", 100.0, seed=args.seed)
    else:
        rest = BinanceFuturesREST(s.rest_base)
        try:
            from .execution.binance_futures import load_filters

            filters = load_filters(rest, [sym], with_brackets=False)[sym]
        except Exception as exc:
            print(f"exchangeInfo unavailable ({exc}); default filters")
        hist = HistoryStore(rest, s.data.cache_dir)
        base = hist.get(sym, "1m" if mode == "scalp" else "1h", days=args.days)
    if base.empty:
        print("no data")
        return 1
    ctx = resample_ohlcv(base, "5m" if mode == "scalp" else "4h")
    params = ParamStore(Path(s.state_dir) / "params.json").get(mode, sym) if not args.defaults else None
    if params is None:
        from .strategy.params import params_for

        params = params_for(mode)
    cfg = BacktestConfig(starting_balance=s.paper_starting_balance, taker_fee=s.binance.taker_fee, maker_fee=s.binance.maker_fee)
    res = BacktestEngine(s.risk, filters, cfg).run(base, mode, params, symbol=sym, context=ctx)
    m = compute_metrics(res, min_trades=s.learning.min_trades)
    print(f"== built-in engine · {mode} · {sym} · {len(base)} bars ==")
    print(to_json(m.to_dict(), indent=2))
    reasons: dict[str, int] = {}
    for t in res.trades:
        reasons[t.exit_reason] = reasons.get(t.exit_reason, 0) + 1
    print("exit reasons:", reasons)
    if args.backtrader:
        from .backtest.bt_adapter import backtrader_available, run_backtrader

        if backtrader_available():
            bt = run_backtrader(base, mode, params, risk=s.risk, filters=filters, symbol=sym, context=ctx,
                                starting_balance=s.paper_starting_balance, taker_fee=s.binance.taker_fee, maker_fee=s.binance.maker_fee)
            print("== backtrader ==")
            print(to_json(bt.metrics.to_dict(), indent=2))
        else:
            print("backtrader not installed (pip install backtrader)")
    return 0


def cmd_optimize(args: argparse.Namespace) -> int:
    s = _settings(args)
    setup_logging(s.log_level)
    from .agents.weights import AgentWeights
    from .data.binance_rest import BinanceFuturesREST
    from .data.history import HistoryStore
    from .learn.scheduler import ContinuousLearner
    from .strategy.params import ParamStore
    from .symbols import SymbolFilters

    rest = None if args.synthetic else BinanceFuturesREST(s.rest_base)
    filters = {}
    if rest is not None:
        try:
            from .execution.binance_futures import load_filters

            filters = load_filters(rest, s.symbols, with_brackets=False)
        except Exception as exc:
            print(f"exchangeInfo unavailable ({exc}); default filters")
    filters = {sym: filters.get(sym) or SymbolFilters(sym) for sym in s.symbols}
    if args.population:
        s.learning.population = args.population
    if args.generations:
        s.learning.generations = args.generations
    store = ParamStore(Path(s.state_dir) / "params.json")
    provider = None
    if args.synthetic:
        from .data.history import resample_ohlcv, synthetic_ohlcv

        def provider(mode: str, symbol: str):
            base = synthetic_ohlcv(6000 if mode == "scalp" else 3000, "1m" if mode == "scalp" else "1h", 100.0, seed=args.seed)
            return base, resample_ohlcv(base, "5m" if mode == "scalp" else "4h")

    learner = ContinuousLearner(s, HistoryStore(rest, s.data.cache_dir), filters, store, AgentWeights(Path(s.state_dir) / "agent_weights.json"),
                                data_provider=provider)
    if args.cmd == "learn":
        events = learner.learn_all()
    else:
        ev = learner.learn_one(args.mode, args.symbol.upper(), time_budget_s=args.time_budget)
        events = [ev] if ev else []
    for ev in events:
        print(f"[{iso(ev.ts)}] {ev.mode} {ev.symbol}: {'PROMOTED' if ev.promoted else 'kept'} — {ev.reason}")
        print("   best:", to_json({k: v for k, v in ev.best.items() if k != 'params'}))
    print(f"parameters stored in {store.path}")
    return 0


def cmd_explain(args: argparse.Namespace) -> int:
    s = _settings(args)
    from .live.journal import Journal

    j = Journal(Path(s.state_dir) / "journal.sqlite")
    rows = j.recent_decisions(args.limit, args.symbol, None if args.mode == "both" else args.mode, full=True)
    if not rows:
        print("no decisions journaled yet")
        return 0
    from .agents.graph import MODE_SPECS

    for r in rows:
        p = r.get("payload") or {}
        label = MODE_SPECS.get(r["mode"], {}).get("label_ko", r["mode"])
        print(f"=== {iso(r['ts'])} · {r['symbol']} · {label} · {r['action']} ({r['rating']}) conv {r['conviction']:.2f} agree {r['agreement']:.0%} {'EXECUTED' if r['executed'] else ''}")
        print("  " + (r.get("summary") or ""))
        if args.full and p:
            for rep in p.get("reports", []):
                print(f"  • {rep['agent']}: {rep['stance']} ({rep['score']:+.2f}) — " + rep["reasoning"].replace("\n", " | ")[:400])
            print("  [research] " + (p.get("research", {}).get("rationale", "")).replace("\n", " | ")[:500])
            print("  [trader] " + (p.get("proposal", {}).get("rationale", "")).replace("\n", " | ")[:400])
            print("  [PM] " + (p.get("portfolio", {}).get("reasoning", "")).replace("\n", " | ")[:400])
        print()
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    s = _settings(args)
    p = Path(s.state_dir) / "status.json"
    if not p.exists():
        print("no status.json yet (is the desk running?)")
        return 1
    data = json.loads(p.read_text(encoding="utf-8"))
    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=1))
        return 0
    print(f"{data['ts']} env={data['env']} broker={data['broker']} equity={data['equity']:.2f} daily={data['daily_pnl']:+.2f} positions={len(data['positions'])}")
    for sym, pos in data["positions"].items():
        print(f"  {sym}: {pos['side']} {pos['qty']} @ {pos['entry_price']} lev {pos['leverage']}x stop {pos['stop']} unreal {pos['unrealized']:+.2f} ({pos['r_multiple']:+.2f}R)")
    for sym, modes in data.get("last_decisions", {}).items():
        for mode, d in modes.items():
            print(f"  {sym} {mode}: {d['action']} ({d['rating']}, conv {d['conviction']}, agree {d['agreement']}) {d['ts']}{' EXECUTED' if d['executed'] else ''}")
    print("feed:", data.get("feed"), "| risk:", data.get("risk"), "| memory:", data.get("memory"))
    return 0


def cmd_doctor(args: argparse.Namespace) -> int:
    s = _settings(args)
    print(f"munder-trader {__version__}")
    print(f"env={s.trading_env} symbols={s.symbols} max_leverage={s.risk.max_leverage}x llm={s.llm.provider}")
    ok = True
    for name in ("websockets", "backtrader", "nautilus_trader", "openai", "anthropic"):
        try:
            __import__(name)
            print(f"  [dep] {name}: ok")
        except ImportError:
            print(f"  [dep] {name}: missing (optional)")
    from .data.binance_rest import BinanceAPIError, BinanceFuturesREST

    rest = BinanceFuturesREST(s.rest_base, s.binance.api_key, s.binance.api_secret)
    try:
        rest.ping()
        off = rest.sync_time()
        print(f"  [net] {s.rest_base} reachable, clock offset {off} ms")
    except Exception as exc:
        ok = False
        msg = str(exc)
        if "451" in msg or "restricted" in msg.lower():
            msg += " ← Binance blocks this region (US etc.). Run the desk on a VPS in a permitted region."
        print(f"  [net] FAILED: {msg}")
    try:
        from .execution.binance_futures import load_filters

        flt = load_filters(rest, s.symbols, with_brackets=rest.has_keys)
        for sym, f in flt.items():
            print(f"  [sym] {sym}: status={f.status} tick={f.tick_size} step={f.step_size} minNotional={f.min_notional} maxLev={f.max_leverage}x type={f.underlying_type}")
    except Exception as exc:
        ok = False
        print(f"  [sym] exchangeInfo failed: {exc}")
    if rest.has_keys:
        try:
            acct = rest.account()
            print(f"  [acct] wallet={float(acct.get('totalWalletBalance', 0)):.2f} USDT available={float(acct.get('availableBalance', 0)):.2f} canTrade={acct.get('canTrade')}")
            mode = rest.position_mode()
            print(f"  [acct] hedge mode={mode.get('dualSidePosition')} (one-way required)")
        except BinanceAPIError as exc:
            ok = False
            print(f"  [acct] FAILED: {exc} ← check API key permissions (Enable Futures) and IP whitelist")
    else:
        print("  [acct] no API keys → paper trading only (set BINANCE_API_KEY / BINANCE_API_SECRET for testnet/live)")
    print("doctor:", "OK" if ok else "problems found")
    return 0 if ok else 1


def cmd_selftest(args: argparse.Namespace) -> int:
    from .selftest import run_selftest

    s = _settings(args)
    out = run_selftest(s)
    return 0 if out.get("ok") else 1


def cmd_kill(args: argparse.Namespace) -> int:
    s = _settings(args)
    p = Path(s.state_dir) / Path(s.risk.kill_switch_file).name
    if args.cmd == "kill":
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(f"kill switch set {iso()}\n")
        print(f"kill switch ON ({p}) — no new entries; existing positions keep their stops/targets")
    else:
        if p.exists():
            p.unlink()
        print("kill switch cleared")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="munder-trader", description="Munder Trading Desk — TradingAgents-style Binance futures desk")
    p.add_argument("--config", default=None, help="settings.yaml path (default config/settings.yaml or MT_CONFIG)")
    p.add_argument("--env", choices=["paper", "testnet", "live"], default=None)
    p.add_argument("--symbols", default=None, help="comma separated override")
    p.add_argument("--no-llm", action="store_true", help="force rule-based agents")
    p.add_argument("--max-leverage", type=int, default=None)
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("run", "paper"):
        sp = sub.add_parser(name, help="run the 24/7 desk")
        sp.add_argument("--yes", action="store_true", help="confirm live trading")
        sp.set_defaults(fn=cmd_run)
    sp = sub.add_parser("analyze", help="one-shot committee run for both desks (no orders)")
    sp.add_argument("symbol", nargs="?")
    sp.add_argument("--mode", choices=["swing", "scalp", "both"], default="both")
    sp.add_argument("--offline", action="store_true", help="synthetic data, no network")
    sp.add_argument("--warmup", type=int, default=12, help="seconds to let the live feed fill the book/tape")
    sp.set_defaults(fn=cmd_analyze)
    sp = sub.add_parser("backtest")
    sp.add_argument("--symbol", required=True)
    sp.add_argument("--mode", choices=["swing", "scalp"], default="swing")
    sp.add_argument("--days", type=int, default=60)
    sp.add_argument("--backtrader", action="store_true")
    sp.add_argument("--defaults", action="store_true", help="ignore learned params")
    sp.add_argument("--synthetic", action="store_true")
    sp.add_argument("--bars", type=int, default=5000)
    sp.add_argument("--seed", type=int, default=7)
    sp.set_defaults(fn=cmd_backtest)
    for name in ("optimize", "learn"):
        sp = sub.add_parser(name)
        if name == "optimize":
            sp.add_argument("--symbol", required=True)
            sp.add_argument("--mode", choices=["swing", "scalp"], default="scalp")
        sp.add_argument("--population", type=int, default=None)
        sp.add_argument("--generations", type=int, default=None)
        sp.add_argument("--time-budget", type=float, default=None)
        sp.add_argument("--synthetic", action="store_true")
        sp.add_argument("--seed", type=int, default=7)
        sp.set_defaults(fn=cmd_optimize)
    sp = sub.add_parser("explain", help="print journaled decisions with their reasoning")
    sp.add_argument("--symbol", default=None)
    sp.add_argument("--mode", choices=["swing", "scalp", "both"], default="both")
    sp.add_argument("--limit", type=int, default=6)
    sp.add_argument("--full", action="store_true")
    sp.set_defaults(fn=cmd_explain)
    sp = sub.add_parser("status")
    sp.add_argument("--json", action="store_true")
    sp.set_defaults(fn=cmd_status)
    sub.add_parser("doctor").set_defaults(fn=cmd_doctor)
    sub.add_parser("selftest").set_defaults(fn=cmd_selftest)
    sub.add_parser("kill").set_defaults(fn=cmd_kill)
    sub.add_parser("resume").set_defaults(fn=cmd_kill)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.fn(args) or 0)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
