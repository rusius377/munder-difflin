"""Symbol universe and per-symbol trading metadata.

The seven Binance USDⓈ-M perpetuals the desk trades by default. Exchange filters
(tick size, step size, min notional, leverage brackets) are *not* hard-coded: the
engine fetches ``/fapi/v1/exchangeInfo`` and ``/fapi/v1/leverageBracket`` at start
and refreshes them, because Binance changes them without notice. The static table
below only carries what the agents need to reason about an instrument before any
network call has been made (asset class, correlation group, session behaviour).
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class SymbolMeta:
    symbol: str
    base: str
    quote: str = "USDT"
    asset_class: str = "crypto"          # crypto | gold | equity (tokenized / TradFi perp)
    correlation_group: str = "crypto-major"
    session_aware: bool = False          # liquidity collapses outside the underlying's session
    display: str = ""
    default_price_precision: int = 2
    default_qty_precision: int = 3

    @property
    def nautilus_id(self) -> str:
        """nautilus_trader v2 instrument id for the USDⓈ-M perpetual."""
        return f"{self.symbol}-PERP.BINANCE"


SYMBOL_META: dict[str, SymbolMeta] = {
    "BTCUSDT": SymbolMeta("BTCUSDT", "BTC", display="Bitcoin", default_price_precision=1, default_qty_precision=3),
    "ETHUSDT": SymbolMeta("ETHUSDT", "ETH", display="Ethereum", default_price_precision=2, default_qty_precision=3),
    "SOLUSDT": SymbolMeta("SOLUSDT", "SOL", display="Solana", default_price_precision=3, default_qty_precision=0),
    "ZECUSDT": SymbolMeta("ZECUSDT", "ZEC", asset_class="crypto", correlation_group="crypto-alt",
                          display="Zcash", default_price_precision=2, default_qty_precision=3),
    "XAUUSDT": SymbolMeta("XAUUSDT", "XAU", asset_class="gold", correlation_group="macro-gold",
                          session_aware=True, display="Gold (tokenized perpetual)",
                          default_price_precision=2, default_qty_precision=3),
    "SNDKUSDT": SymbolMeta("SNDKUSDT", "SNDK", asset_class="equity", correlation_group="equity-tech",
                           session_aware=True, display="SNDK equity-linked perpetual",
                           default_price_precision=2, default_qty_precision=2),
    "SPCXUSDT": SymbolMeta("SPCXUSDT", "SPCX", asset_class="equity", correlation_group="equity-space",
                           session_aware=True, display="SPCX equity-linked perpetual",
                           default_price_precision=2, default_qty_precision=2),
}

DEFAULT_SYMBOLS: tuple[str, ...] = (
    "ETHUSDT",
    "BTCUSDT",
    "XAUUSDT",
    "SOLUSDT",
    "SNDKUSDT",
    "SPCXUSDT",
    "ZECUSDT",
)


def meta_for(symbol: str) -> SymbolMeta:
    symbol = symbol.upper()
    if symbol in SYMBOL_META:
        return SYMBOL_META[symbol]
    base = symbol[:-4] if symbol.endswith("USDT") else symbol
    return SymbolMeta(symbol, base, correlation_group="crypto-alt", display=base)


@dataclass
class SymbolFilters:
    """Exchange-side trading filters resolved from ``exchangeInfo`` / ``leverageBracket``."""

    symbol: str
    tick_size: float = 0.01
    step_size: float = 0.001
    min_qty: float = 0.001
    max_qty: float = 1_000_000.0
    min_notional: float = 5.0
    price_precision: int = 2
    qty_precision: int = 3
    max_leverage: int = 125
    contract_type: str = "PERPETUAL"
    underlying_type: str = "COIN"
    status: str = "TRADING"
    # (notional cap, max leverage, maintenance margin rate, maintenance amount) ascending by cap.
    brackets: list[tuple[float, int, float, float]] = field(default_factory=list)

    def round_price(self, price: float) -> float:
        if self.tick_size <= 0:
            return price
        steps = round(price / self.tick_size)
        return round(steps * self.tick_size, self.price_precision)

    def round_qty(self, qty: float, *, down: bool = True) -> float:
        if self.step_size <= 0:
            return qty
        import math

        steps = qty / self.step_size
        steps = math.floor(steps + 1e-9) if down else round(steps)
        return round(steps * self.step_size, self.qty_precision)

    def leverage_for_notional(self, notional: float) -> int:
        """Maximum leverage Binance allows for a position of this notional size."""
        if not self.brackets:
            return self.max_leverage
        for cap, lev, _mmr, _amt in self.brackets:
            if notional <= cap:
                return lev
        return self.brackets[-1][1]

    def maintenance_margin(self, notional: float) -> tuple[float, float]:
        """``(maintenance margin rate, maintenance amount)`` for the bracket the notional falls in."""
        if not self.brackets:
            return (0.004, 0.0)
        for cap, _lev, mmr, amt in self.brackets:
            if notional <= cap:
                return (mmr, amt)
        _, _, mmr, amt = self.brackets[-1]
        return (mmr, amt)

    @classmethod
    def from_exchange_info(cls, info: dict) -> "SymbolFilters":
        f = cls(symbol=info["symbol"])
        f.price_precision = int(info.get("pricePrecision", f.price_precision))
        f.qty_precision = int(info.get("quantityPrecision", f.qty_precision))
        f.contract_type = str(info.get("contractType", f.contract_type))
        f.underlying_type = str(info.get("underlyingType", f.underlying_type))
        f.status = str(info.get("status", f.status))
        for flt in info.get("filters", []):
            t = flt.get("filterType")
            if t == "PRICE_FILTER":
                f.tick_size = float(flt.get("tickSize", f.tick_size))
            elif t == "LOT_SIZE":
                f.step_size = float(flt.get("stepSize", f.step_size))
                f.min_qty = float(flt.get("minQty", f.min_qty))
                f.max_qty = float(flt.get("maxQty", f.max_qty))
            elif t == "MIN_NOTIONAL":
                f.min_notional = float(flt.get("notional", f.min_notional))
        return f

    def apply_brackets(self, brackets: list[dict]) -> None:
        rows = []
        for b in brackets:
            rows.append((float(b.get("notionalCap", 0)), int(b.get("initialLeverage", 1)),
                         float(b.get("maintMarginRatio", 0.004)), float(b.get("cum", 0.0))))
        rows.sort(key=lambda r: r[0])
        if rows:
            self.brackets = rows
            self.max_leverage = max(r[1] for r in rows)
