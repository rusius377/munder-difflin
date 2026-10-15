"""Shared agent types: evidence, reports, market context, bilingual text helpers."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pandas as pd

from ..data.orderbook import BookFeatures
from ..data.tradeflow import TapeFeatures
from ..strategy.plan import Position
from ..strategy.position_sizing import PerformanceStats
from ..strategy.signals import Signal

LANG = {"lang": "ko"}


def set_language(lang: str) -> None:
    LANG["lang"] = "en" if str(lang).lower().startswith("en") else "ko"


def t(ko: str, en: str) -> str:
    return en if LANG["lang"] == "en" else ko


def stance_of(score: float, band: float = 0.15) -> str:
    if score >= band:
        return "bullish"
    if score <= -band:
        return "bearish"
    return "neutral"


def stance_ko(stance: str) -> str:
    return {"bullish": "강세(매수 우위)", "bearish": "약세(매도 우위)", "neutral": "중립"}.get(stance, stance)


@dataclass
class Evidence:
    name: str
    value: Any
    interpretation: str
    direction: int = 0        # +1 bullish, -1 bearish, 0 neutral
    weight: float = 1.0

    def to_dict(self) -> dict:
        return {"name": self.name, "value": self.value, "interpretation": self.interpretation,
                "direction": self.direction, "weight": self.weight}


@dataclass
class AgentReport:
    agent: str
    role: str
    mode: str
    symbol: str
    stance: str
    score: float                  # -1..1
    confidence: float             # 0..1
    evidence: list[Evidence] = field(default_factory=list)
    reasoning: str = ""
    llm_used: bool = False
    raw_llm: str | None = None

    def top_evidence(self, direction: int, n: int = 3) -> list[Evidence]:
        rows = [e for e in self.evidence if e.direction == direction]
        rows.sort(key=lambda e: -e.weight)
        return rows[:n]

    def to_dict(self) -> dict:
        return {
            "agent": self.agent, "role": self.role, "mode": self.mode, "symbol": self.symbol, "stance": self.stance,
            "score": round(self.score, 4), "confidence": round(self.confidence, 4),
            "evidence": [e.to_dict() for e in self.evidence], "reasoning": self.reasoning, "llm_used": self.llm_used,
        }


@dataclass
class MarketContext:
    """Everything an analyst may look at for one (symbol, mode) decision."""

    symbol: str
    mode: str
    ts: int
    price: float
    frame: pd.DataFrame                       # enriched base-timeframe frame with signal columns
    signal: Signal
    context_frames: dict[str, pd.DataFrame] = field(default_factory=dict)
    book: BookFeatures | None = None
    tape: TapeFeatures | None = None
    derivatives: dict[str, Any] = field(default_factory=dict)   # funding, OI, ratios, mark/index
    news: list[dict] = field(default_factory=list)              # {title, source, ts, sentiment?}
    sentiment: dict[str, Any] = field(default_factory=dict)     # fear & greed etc.
    lessons: list[str] = field(default_factory=list)            # retrieved reflections
    position: Position | None = None
    stats: PerformanceStats | None = None
    session_liquidity: float = 1.0
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def last(self) -> pd.Series:
        return self.frame.iloc[-1]

    def value(self, col: str, default: float = 0.0) -> float:
        try:
            v = self.frame[col].iloc[-1]
            return float(v) if pd.notna(v) else default
        except Exception:
            return default


def weighted_score(reports: list[AgentReport], weights: dict[str, float] | None = None) -> tuple[float, float]:
    """Confidence- and reliability-weighted composite score and the agreement ratio."""
    weights = weights or {}
    num = den = 0.0
    signs: list[int] = []
    for r in reports:
        if r.score == 0 and r.confidence <= 0.35:
            continue  # "no data" neutrals must not dilute the committee
        w = weights.get(r.agent, 1.0) * max(0.05, r.confidence)
        num += w * r.score
        den += w
        if abs(r.score) >= 0.15:
            signs.append(1 if r.score > 0 else -1)
    composite = num / den if den > 0 else 0.0
    if signs:
        majority = 1 if composite >= 0 else -1
        agreement = sum(1 for s in signs if s == majority) / len(signs)
    else:
        agreement = 0.0
    return composite, agreement
