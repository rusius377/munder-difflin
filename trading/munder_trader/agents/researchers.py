"""Research team: bull vs bear debate adjudicated by the Research Manager."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from ..util import clamp
from .base import AgentReport, Evidence, MarketContext, stance_ko, t, weighted_score
from .llm import LLMClient, extract_json

RATINGS = ("Buy", "Overweight", "Hold", "Underweight", "Sell")


def rating_from_score(score: float) -> str:
    if score >= 0.45:
        return "Buy"
    if score >= 0.18:
        return "Overweight"
    if score > -0.18:
        return "Hold"
    if score > -0.45:
        return "Underweight"
    return "Sell"


def rating_direction(rating: str) -> int:
    return {"Buy": 1, "Overweight": 1, "Hold": 0, "Underweight": -1, "Sell": -1}.get(rating, 0)


@dataclass
class DebateTurn:
    speaker: str
    text: str
    points: list[str] = field(default_factory=list)


@dataclass
class ResearchPlan:
    recommendation: str          # five-tier rating
    rationale: str
    strategic_actions: str
    composite: float
    agreement: float
    debate: list[DebateTurn] = field(default_factory=list)
    llm_used: bool = False

    def to_dict(self) -> dict:
        return {"recommendation": self.recommendation, "rationale": self.rationale,
                "strategic_actions": self.strategic_actions, "composite": round(self.composite, 4),
                "agreement": round(self.agreement, 3), "debate": [tn.__dict__ for tn in self.debate],
                "llm_used": self.llm_used}


def _collect(reports: list[AgentReport], direction: int) -> list[tuple[AgentReport, Evidence]]:
    rows = []
    for r in reports:
        for e in r.evidence:
            if e.direction == direction:
                rows.append((r, e))
    rows.sort(key=lambda re: -(re[1].weight * max(0.2, re[0].confidence)))
    return rows


class Researcher:
    def __init__(self, side: str) -> None:
        self.side = side  # bull | bear
        self.direction = 1 if side == "bull" else -1

    def argue(self, reports: list[AgentReport], ctx: MarketContext, round_no: int, opponent: DebateTurn | None) -> DebateTurn:
        mine = _collect(reports, self.direction)
        theirs = _collect(reports, -self.direction)
        label = t("강세 연구원" if self.side == "bull" else "약세 연구원", "Bull researcher" if self.side == "bull" else "Bear researcher")
        points = [f"{e.interpretation} ({r.agent})" for r, e in mine[: 4 if round_no == 1 else 2]]
        lines = [t(f"[{label} / {round_no}라운드]", f"[{label} / round {round_no}]")]
        if points:
            lines.append(t("핵심 논거: ", "Key arguments: ") + "; ".join(points))
        else:
            lines.append(t("이 방향을 지지하는 근거가 약함을 인정", "Concedes there is little evidence for this side"))
        if opponent is not None and theirs:
            rebut = theirs[0][1]
            if ctx.signal.direction == self.direction:
                anchor = t(f"퀀트 셋업({ctx.signal.setup}, 강도 {ctx.signal.strength:.2f})과 레짐({ctx.signal.regime})이 우리 편",
                           f"the quant setup ({ctx.signal.setup}, strength {ctx.signal.strength:.2f}) and regime ({ctx.signal.regime}) are on our side")
            elif ctx.signal.direction == 0:
                anchor = t(f"레짐({ctx.signal.regime})과 근거의 가중치 합을 보면 설득력이 떨어짐",
                           f"the regime ({ctx.signal.regime}) and the total weight of evidence do not support it")
            else:
                anchor = t(f"퀀트 셋업({ctx.signal.setup})은 상대 편이지만 단일 근거이며 레짐({ctx.signal.regime})에서 자주 실패",
                           f"the quant setup ({ctx.signal.setup}) favours them but is a single signal that often fails in {ctx.signal.regime}")
            lines.append(t(f"반박: 상대의 '{rebut.interpretation}'은(는) 가중치 {rebut.weight:.1f}로 제한적이며, {anchor}",
                           f"Rebuttal: the opponent's '{rebut.interpretation}' carries weight {rebut.weight:.1f}; {anchor}"))
        if ctx.lessons:
            lines.append(t("과거 교훈 참고: ", "Lesson from memory: ") + ctx.lessons[0][:160])
        return DebateTurn(speaker=self.side, text="\n".join(lines), points=points)


_MANAGER_SYSTEM = (
    "You are the Research Manager of a crypto futures desk ({mode} desk). You judge a bull/bear debate and write an "
    "investment plan. Conflicting arguments alone are not a reason to Hold; commit to the stronger side sized by how "
    "decisively it wins. Reply ONLY with JSON: {{\"recommendation\": one of Buy/Overweight/Hold/Underweight/Sell, "
    "\"rationale\": string in {lang}, \"strategic_actions\": string in {lang}, \"composite_adjustment\": number in [-0.3,0.3]}}."
)


class ResearchManager:
    def __init__(self, llm: LLMClient | None = None, language: str = "ko", max_adjustment: float = 0.3) -> None:
        self.llm = llm
        self.language = "Korean" if language.startswith("ko") else "English"
        self.max_adjustment = max_adjustment

    def run(self, reports: list[AgentReport], ctx: MarketContext, *, rounds: int = 2,
            weights: dict[str, float] | None = None) -> ResearchPlan:
        bull, bear = Researcher("bull"), Researcher("bear")
        debate: list[DebateTurn] = []
        last: DebateTurn | None = None
        for rnd in range(1, max(1, rounds) + 1):
            tb = bull.argue(reports, ctx, rnd, last)
            debate.append(tb)
            te = bear.argue(reports, ctx, rnd, tb)
            debate.append(te)
            last = te
        composite, agreement = weighted_score(reports, weights)
        # the quant signal is itself a (weighted) vote so the plan never ignores a live setup
        if ctx.signal.direction != 0:
            composite = clamp(0.75 * composite + 0.25 * ctx.signal.direction * ctx.signal.strength, -1.0, 1.0)
        llm_used = False
        rec = rating_from_score(composite)
        rationale = self._rationale(reports, ctx, composite, agreement, rec)
        actions = self._actions(ctx, rec, composite)
        if self.llm is not None and self.llm.enabled:
            data = self._ask_llm(reports, ctx, debate, composite, agreement, rec)
            if data:
                adj = clamp(float(data.get("composite_adjustment", 0.0) or 0.0), -self.max_adjustment, self.max_adjustment)
                composite = clamp(composite + adj, -1.0, 1.0)
                rec_llm = str(data.get("recommendation", rec))
                rec = rec_llm if rec_llm in RATINGS else rating_from_score(composite)
                rationale = str(data.get("rationale") or rationale)
                actions = str(data.get("strategic_actions") or actions)
                llm_used = True
        return ResearchPlan(rec, rationale, actions, composite, agreement, debate, llm_used)

    def _rationale(self, reports: list[AgentReport], ctx: MarketContext, composite: float, agreement: float, rec: str) -> str:
        bulls = [r for r in reports if r.score >= 0.15]
        bears = [r for r in reports if r.score <= -0.15]
        parts = [t(f"[리서치 매니저] 종합 점수 {composite:+.2f}, 위원 합의도 {agreement:.0%} → 등급 {rec}",
                   f"[Research Manager] composite {composite:+.2f}, agreement {agreement:.0%} → rating {rec}")]
        if bulls:
            parts.append(t("강세 측: ", "Bullish side: ") + ", ".join(f"{r.agent}({r.score:+.2f})" for r in bulls))
        if bears:
            parts.append(t("약세 측: ", "Bearish side: ") + ", ".join(f"{r.agent}({r.score:+.2f})" for r in bears))
        if ctx.signal.direction != 0:
            parts.append(t(f"퀀트 셋업 {ctx.signal.setup} {'롱' if ctx.signal.direction > 0 else '숏'} (강도 {ctx.signal.strength:.2f})이 {'종합 판단과 일치' if ctx.signal.direction * composite > 0 else '종합 판단과 충돌'}",
                           f"quant setup {ctx.signal.setup} {'long' if ctx.signal.direction > 0 else 'short'} (strength {ctx.signal.strength:.2f}) {'agrees' if ctx.signal.direction * composite > 0 else 'conflicts'} with the composite"))
        else:
            parts.append(t("현재 퀀트 셋업 없음 → 위원회 확신이 매우 높을 때만 진입", "no quant setup → enter only on very high committee conviction"))
        return "\n".join(parts)

    def _actions(self, ctx: MarketContext, rec: str, composite: float) -> str:
        d = rating_direction(rec)
        if d == 0:
            return t("관망. 새 셋업이 나오거나 합의도가 올라오면 재평가.", "Stand aside; re-evaluate on a fresh setup or higher agreement.")
        side = t("롱" if d > 0 else "숏", "long" if d > 0 else "short")
        size = t("표준 대비 큰 비중" if abs(composite) >= 0.5 else "표준 비중" if abs(composite) >= 0.3 else "축소 비중",
                 "above-standard size" if abs(composite) >= 0.5 else "standard size" if abs(composite) >= 0.3 else "reduced size")
        sig = ctx.signal
        if sig.direction == d:
            return t(f"{side} 진입, {size}. 손절 {sig.stop:.6g} (ATR {sig.atr:.4g}), TP1 {sig.tp1:.6g}, TP2 {sig.tp2:.6g}. 셋업 {sig.setup}에 맞춰 {'분할' if sig.setup in ('pullback','mean_revert','vwap_revert') else '시장가'} 진입.",
                     f"Enter {side}, {size}. Stop {sig.stop:.6g} (ATR {sig.atr:.4g}), TP1 {sig.tp1:.6g}, TP2 {sig.tp2:.6g}. {'Scale in' if sig.setup in ('pullback','mean_revert','vwap_revert') else 'Market entry'} per setup {sig.setup}.")
        return t(f"{side} 편향이나 퀀트 셋업이 없거나 반대 → 축소 비중, ATR 기반 손절, 확인 캔들 후 진입.",
                 f"{side} bias without a confirming quant setup → reduced size, ATR stop, wait for a confirming bar.")

    def _ask_llm(self, reports, ctx, debate, composite, agreement, rec) -> dict | None:
        payload: dict[str, Any] = {
            "symbol": ctx.symbol, "mode": ctx.mode, "price": ctx.price,
            "analyst_reports": [{"agent": r.agent, "stance": r.stance, "score": r.score, "confidence": r.confidence,
                                 "reasoning": r.reasoning[:600]} for r in reports],
            "debate": [{"speaker": d.speaker, "text": d.text[:600]} for d in debate],
            "rule_based_composite": composite, "agreement": agreement, "rule_based_rating": rec,
            "quant_signal": ctx.signal.to_dict(), "lessons": ctx.lessons[:5],
        }
        text = self.llm.complete(_MANAGER_SYSTEM.format(mode=ctx.mode, lang=self.language),
                                 json.dumps(payload, ensure_ascii=False, default=str), deep=True)
        return extract_json(text)
