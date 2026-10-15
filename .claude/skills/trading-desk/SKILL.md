---
name: trading-desk
description: Operate the Munder Trading Desk (trading/ — TradingAgents-style Binance USDⓈ-M futures desk with swing + scalp modes, self-learning backtests, 24/7 headless engine). Use when the user asks to analyze a symbol, run/paper/backtest/optimize the desk, explain a trade decision, check desk status, or deploy it to run 24/7.
---

# Trading Desk skill

The desk lives in `trading/` (package `munder_trader`, CLI `munder-trader`). It is **headless**: it does not need
the Electron app. Everything it decides is journaled with the reasoning of every agent.

## Commands (run from `trading/`, inside its venv)

| Goal | Command |
|---|---|
| Health / keys / region check | `munder-trader doctor` |
| Offline end-to-end check (no network) | `munder-trader selftest` |
| Both desks' judgment for a symbol, no orders | `munder-trader analyze ETHUSDT` (`--mode swing|scalp|both`, `--offline` for synthetic data) |
| Paper trade 24/7 | `munder-trader paper` → dashboard http://127.0.0.1:8787 |
| Testnet / live | `munder-trader run --env testnet` / `munder-trader run --env live --yes` |
| Backtest | `munder-trader backtest --symbol BTCUSDT --mode swing --days 90 --backtrader` |
| Optimize / learn | `munder-trader optimize --symbol ETHUSDT --mode scalp` · `munder-trader learn` |
| Explain journaled decisions | `munder-trader explain --symbol ETHUSDT --limit 5 --full` |
| Status / emergency | `munder-trader status` · `munder-trader kill` (no new entries) · `munder-trader resume` |

## Where things are

- `trading/config/settings.yaml` — the only operator knob that matters is `risk.max_leverage` (hard cap, 100). Everything else is automatic.
- `trading/state/journal.sqlite` — decisions (full agent reports), plans, trades, equity, learning events.
- `trading/state/params.json` — live parameters per (mode, symbol) promoted by the learner.
- `trading/state/lessons.jsonl` — reflection memory; `state/agent_weights.json` — learned analyst reliability.
- `trading/state/status.json` — refreshed every 5 s; `GET http://127.0.0.1:8787/status` when the desk runs.
- `.env` — `BINANCE_API_KEY`, `BINANCE_API_SECRET`, `MT_TRADING_ENV`, optional LLM keys (never commit).

## Rules for agents operating the desk

1. Default to **paper**. Never start `--env live` unless the human explicitly asked for live trading in this session.
2. Never raise `risk.max_leverage` above what the human set; never remove guardrails in `settings.yaml` without being asked.
3. When asked "why did it trade / not trade", answer from `munder-trader explain --full` or the `/decisions?full=1` endpoint — quote the
   analysts' evidence, the debate outcome, the trader proposal and the portfolio manager's reasoning for **both** desks.
4. If the desk looks wrong (feed disconnected, repeated rejections, drawdown pause), say so and suggest `munder-trader doctor` / `kill`.
5. Code changes: run `python -m unittest discover -s tests -t .` from `trading/` before claiming a fix.
