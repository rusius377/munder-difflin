"""Munder Trading Desk.

A TradingAgents-style multi-agent desk for Binance USDⓈ-M perpetual futures with two
trading desks that run side by side and explain every call they make:

* ``SWING`` — the original TradingAgents pipeline (analysts → bull/bear debate →
  research manager → trader → risk debate → portfolio manager) on 1h/4h/1d bars.
* ``SCALP`` — the same committee on 1m/5m bars plus live order-book and trade-flow
  microstructure (order book imbalance, tape pressure, liquidity walls).

Around the desks sit a quant signal engine, an automatic position sizer / leverage
selector (hard cap 100x), a risk manager, a fast built-in backtester plus an
optional backtrader adapter, an evolutionary optimizer with walk-forward
validation, a reflection memory that learns from every closed trade, a paper
broker, a Binance futures broker and a 24/7 headless engine.
"""

__version__ = "0.1.0"
