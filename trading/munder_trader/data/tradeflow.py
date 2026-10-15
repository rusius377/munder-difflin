"""Trade-flow ("tape") analytics from aggregated trades.

Feed :class:`TradeFlow` with Binance ``aggTrade`` events (or REST ``/aggTrades``
rows) and ask it for :class:`TapeFeatures`: cumulative volume delta (CVD) over
several windows, aggressor ratio, trade intensity versus baseline, whale prints,
absorption (heavy selling the price refuses to follow) and sweep detection.
These are the scalp desk's "체결 흐름" evidence.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from statistics import mean, pstdev


@dataclass(frozen=True)
class Trade:
    ts: int          # ms
    price: float
    qty: float
    buyer_is_maker: bool   # Binance ``m``: True → aggressor was a SELLER

    @property
    def aggressor_buy(self) -> bool:
        return not self.buyer_is_maker

    @property
    def signed_qty(self) -> float:
        return self.qty if self.aggressor_buy else -self.qty

    @classmethod
    def from_agg(cls, ev: dict) -> "Trade":
        return cls(ts=int(ev["T"]), price=float(ev["p"]), qty=float(ev["q"]), buyer_is_maker=bool(ev["m"]))


@dataclass
class TapeFeatures:
    symbol: str
    ts: int
    last_price: float
    vwap: float
    cvd_short: float        # signed base volume over short window
    cvd_long: float
    buy_ratio_short: float  # aggressor buy share 0..1
    buy_ratio_long: float
    intensity: float        # trades/sec short vs long baseline (1.0 = normal)
    volume_z: float         # short-window volume z-score vs long window buckets
    whale_bias: float       # signed share of large prints in [-1, 1]
    absorption: float       # >0: sells absorbed (price held), <0: buys absorbed
    sweep: int              # +1 buy sweep, -1 sell sweep, 0 none
    price_change_bps: float # over the long window
    n_short: int
    n_long: int

    def pressure(self) -> float:
        """Signed tape pressure in [-1, 1]."""
        p = 0.45 * (2 * self.buy_ratio_short - 1) + 0.25 * (2 * self.buy_ratio_long - 1)
        p += 0.2 * max(-1.0, min(1.0, self.whale_bias)) + 0.1 * max(-1.0, min(1.0, self.sweep))
        return max(-1.0, min(1.0, p))

    def to_dict(self) -> dict:
        d = self.__dict__.copy()
        d["pressure"] = self.pressure()
        return d


class TradeFlow:
    def __init__(self, symbol: str, short_s: int = 30, long_s: int = 300, max_trades: int = 50_000) -> None:
        self.symbol = symbol.upper()
        self.short_ms = short_s * 1000
        self.long_ms = long_s * 1000
        self.trades: deque[Trade] = deque(maxlen=max_trades)
        self.ts = 0

    def add(self, trade: Trade) -> None:
        self.trades.append(trade)
        self.ts = max(self.ts, trade.ts)
        cutoff = self.ts - self.long_ms
        while self.trades and self.trades[0].ts < cutoff:
            self.trades.popleft()

    def add_agg(self, ev: dict) -> None:
        self.add(Trade.from_agg(ev))

    def extend_rest(self, rows: list[dict]) -> None:
        for r in rows:
            self.add(Trade.from_agg(r))

    def features(self, now_ts: int | None = None) -> TapeFeatures | None:
        if not self.trades:
            return None
        now_ts = now_ts if now_ts is not None else self.ts
        long_cut = now_ts - self.long_ms
        short_cut = now_ts - self.short_ms
        long_trades = [t for t in self.trades if t.ts >= long_cut]
        if not long_trades:
            return None
        short_trades = [t for t in long_trades if t.ts >= short_cut]
        last = long_trades[-1]
        vol_l = sum(t.qty for t in long_trades)
        vwap = sum(t.price * t.qty for t in long_trades) / vol_l if vol_l > 0 else last.price
        cvd_l = sum(t.signed_qty for t in long_trades)
        cvd_s = sum(t.signed_qty for t in short_trades)
        buy_l = sum(t.qty for t in long_trades if t.aggressor_buy)
        buy_s = sum(t.qty for t in short_trades if t.aggressor_buy)
        vol_s = sum(t.qty for t in short_trades)
        br_l = buy_l / vol_l if vol_l > 0 else 0.5
        br_s = buy_s / vol_s if vol_s > 0 else 0.5
        # intensity: short-window trade rate vs long-window rate
        span_l = max(1.0, (long_trades[-1].ts - long_trades[0].ts) / 1000.0)
        rate_l = len(long_trades) / span_l
        rate_s = len(short_trades) / max(1.0, self.short_ms / 1000.0)
        intensity = rate_s / rate_l if rate_l > 0 else 1.0
        # volume z-score: bucket long window into short-sized buckets
        n_buckets = max(2, int(self.long_ms // self.short_ms))
        buckets = [0.0] * n_buckets
        for t in long_trades:
            idx = min(n_buckets - 1, int((t.ts - long_cut) // self.short_ms))
            buckets[idx] += t.qty
        hist = buckets[:-1] if len(buckets) > 1 else buckets
        mu = mean(hist) if hist else 0.0
        sd = pstdev(hist) if len(hist) > 1 else 0.0
        vol_z = (vol_s - mu) / sd if sd > 0 else 0.0
        # whales: prints above the 95th percentile of long-window sizes
        sizes = sorted(t.qty for t in long_trades)
        p95 = sizes[int(0.95 * (len(sizes) - 1))] if sizes else 0.0
        whales = [t for t in short_trades if p95 > 0 and t.qty >= p95]
        wq = sum(t.qty for t in whales)
        whale_bias = (sum(t.signed_qty for t in whales) / wq) if wq > 0 else 0.0
        # absorption: net aggressive flow vs price response over the short window
        if short_trades:
            p0 = short_trades[0].price
            chg_s = (last.price - p0) / p0 * 10_000 if p0 > 0 else 0.0
            flow = cvd_s / vol_s if vol_s > 0 else 0.0
            # heavy sell flow (flow<0) but price flat/up → positive absorption (bullish)
            absorption = -flow if abs(flow) > 0.25 and abs(chg_s) < 2.0 else 0.0
        else:
            chg_s, absorption = 0.0, 0.0
        # sweep: last ~1s one-sided burst with large volume
        burst = [t for t in short_trades if t.ts >= now_ts - 1500]
        sweep = 0
        if len(burst) >= 5:
            bq = sum(t.qty for t in burst if t.aggressor_buy)
            sq = sum(t.qty for t in burst if not t.aggressor_buy)
            tot = bq + sq
            if tot > 0 and tot >= 2.5 * (vol_l / max(1.0, span_l)) * 1.5:
                if bq / tot > 0.8:
                    sweep = 1
                elif sq / tot > 0.8:
                    sweep = -1
        p_first = long_trades[0].price
        chg_l = (last.price - p_first) / p_first * 10_000 if p_first > 0 else 0.0
        return TapeFeatures(
            symbol=self.symbol, ts=now_ts, last_price=last.price, vwap=vwap, cvd_short=cvd_s, cvd_long=cvd_l,
            buy_ratio_short=br_s, buy_ratio_long=br_l, intensity=intensity, volume_z=vol_z,
            whale_bias=whale_bias, absorption=absorption, sweep=sweep, price_change_bps=chg_l,
            n_short=len(short_trades), n_long=len(long_trades),
        )


def synthetic_trades(n: int, start_ts: int, price: float, *, buy_bias: float = 0.5, seed: int = 1,
                     spacing_ms: int = 150) -> list[Trade]:
    import random

    rng = random.Random(seed)
    out: list[Trade] = []
    p = price
    for i in range(n):
        is_buy = rng.random() < buy_bias
        qty = rng.lognormvariate(0, 0.9)
        p *= 1 + (0.00005 if is_buy else -0.00005) * rng.uniform(0, 2)
        out.append(Trade(ts=start_ts + i * spacing_ms, price=p, qty=qty, buyer_is_maker=not is_buy))
    return out
