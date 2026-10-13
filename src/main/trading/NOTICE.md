# Third-party notice — TradingAgents

Parts of this folder are derived from **TradingAgents** by Tauric Research
(https://github.com/TauricResearch/TradingAgents), licensed under the Apache
License, Version 2.0. A copy of that license is in `TRADINGAGENTS-LICENSE`.

Derived material and what was changed:

- `prompts.ts` — the agent roles (analysts, bull/bear researchers, research
  manager, trader, aggressive/conservative/neutral risk analysts, portfolio
  manager), their prompts, the five-tier rating scale and the "commit to the
  stronger case" rule. Translated to Korean; the fundamentals analyst replaced by
  a derivatives analyst for perpetual futures; trader/portfolio manager rewritten
  for long/short with leverage and absolute stop/target prices; a JSON decision
  block added for the risk engine; a compressed "bias desk" prompt added for
  scalping.
- `agents.ts` — the TradingAgents graph (parallel analysts, research debate,
  research manager, trader, three-way risk debate, portfolio manager) and its
  turn-order/termination logic, re-implemented as plain TypeScript, extended so
  every role can be staffed by several agents (see `teams.ts`).
- `decision.ts` — rating parsing follows TradingAgents' "first Rating line wins"
  behaviour.

Everything else in this folder (Binance client, market data, indicators, risk
engine, brokers, scalper, engine, IPC, the multi-agent teams in `teams.ts`:
personas, team-lead merges, committee and panel vote tallies, and the per-agent
project folders in `agentProjects.ts`, order flow, leverage brackets, replays,
experience and backtests) is original to Munder Difflin and is covered by the
repository's MIT license.

NautilusTrader (https://github.com/nautechsystems/nautilus_trader, LGPL-3.0) is
not bundled. On request the app pip-installs `nautilus_trader` into a separate
Python virtual environment under the user's data folder and runs
`resources/nautilus/desk_backtest.py` (original, MIT) against its public API in a
separate process. Historical market data comes from Binance's public data
archive (https://data.binance.vision) at run time and is not redistributed.
