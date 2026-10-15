"""TradingAgents-style committee: analysts → researchers → trader → risk team → portfolio manager.

The pipeline shape follows `TauricResearch/TradingAgents` (analyst reports, a
bull/bear research debate adjudicated by a research manager, a trader proposal,
and an aggressive/neutral/conservative risk debate adjudicated by a portfolio
manager producing a five-tier rating). Two desks share the committee:

* ``swing`` — the original mode on 1h/4h/1d bars with crypto-derivatives
  fundamentals (funding, open interest, long/short and taker ratios) and news.
* ``scalp`` — the added mode on 1m/5m bars whose analysts read the live order
  book and trade tape.

Every agent is rule-based first (so the desk runs 24/7 without any LLM key and
backtests stay deterministic); when an LLM provider is configured the same
agents ask the model to argue, critique and adjust conviction inside a bounded
band around the quantitative evidence.
"""

from .graph import DeskDecision, DeskGraph  # noqa: F401
