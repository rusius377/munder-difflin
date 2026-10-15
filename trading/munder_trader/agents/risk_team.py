"""Risk management team: aggressive / neutral / conservative debate judged by the Portfolio Manager."""

from __future__ import annotations

import json
from dataclasses import dataclass, field

from ..config import RiskSettings
from ..util import clamp
from .base import MarketContext, t
from .llm import LLMClient, extract_json
from .researchers import RATINGS, ResearchPlan, rating_from_score
from .trader import TradeProposal


@dataclass
class RiskOpinion:
    speaker: str
    size_multiplier: float
    leverage_cap: int
    hold_bias: str        # quick | balanced | extend
    text: str


@dataclass
class PortfolioDecision:
    rating: str
    approve: bool
    direction: int
    conviction: float
    size_multiplier: float
    leverage_cap: int
    hold_bias: str
    reasoning: str
    opinions: list[RiskOpinion] = field(default_factory=list)
    llm_used: bool = False

    def to_dict(self) -> dict:
        d = self.__dict__.copy()
        d["opinions"] = [o.__dict__ for o in self.opinions]
        return d


class RiskDebator:
    def __init__(self, style: str) -> None:
        self.style = style  # aggressive | neutral | conservative

    def opine(self, prop: TradeProposal, ctx: MarketContext, risk: RiskSettings) -> RiskOpinion:
        sig = ctx.signal
        stop_pct = max(abs(prop.stop - ctx.price) / ctx.price * 100.0, 0.01)
        rr = abs(prop.tp2 - ctx.price) / abs(prop.stop - ctx.price) if prop.stop != ctx.price else 0.0
        regime = sig.regime
        if self.style == "aggressive":
            mult = clamp(1.0 + 0.6 * prop.conviction + (0.2 if rr >= 2 else 0.0), 0.8, 1.8)
            lev = risk.max_leverage
            hold = "extend" if regime.startswith("trend") else "balanced"
            text = t(f"[공격적] 손익비 {rr:.1f}, 확신 {prop.conviction:.2f} → 비중 ×{mult:.2f}, 레버리지 한도 {lev}x, 추세면 길게 보유. 기대값이 양수일 때 소극적인 비중은 기회비용이다.",
                     f"[Aggressive] R:R {rr:.1f}, conviction {prop.conviction:.2f} → size ×{mult:.2f}, leverage cap {lev}x, extend in trends. Under-sizing a positive-expectancy trade is the real risk.")
        elif self.style == "conservative":
            mult = clamp(0.5 + 0.3 * prop.conviction - (0.2 if regime == "volatile" else 0.0), 0.3, 0.9)
            lev = max(3, min(risk.max_leverage, int(20 / max(stop_pct, 0.2))))
            hold = "quick"
            text = t(f"[보수적] 손절폭 {stop_pct:.2f}%에서 청산 완충을 고려하면 레버리지는 {lev}x 이하, 비중 ×{mult:.2f}. 1차 목표에서 대부분 익절하고 본전 스탑으로 보호.",
                     f"[Conservative] with a {stop_pct:.2f}% stop the liquidation buffer caps leverage near {lev}x; size ×{mult:.2f}. Bank most at TP1 and protect with breakeven.")
        else:
            mult = clamp(0.8 + 0.4 * prop.conviction, 0.6, 1.2)
            lev = max(5, min(risk.max_leverage, int(40 / max(stop_pct, 0.2))))
            hold = "balanced"
            text = t(f"[중립] 비중 ×{mult:.2f}, 레버리지 {lev}x 내, TP1 부분익절 후 추세 지속 증거에 따라 러너 보유 여부 결정.",
                     f"[Neutral] size ×{mult:.2f}, leverage within {lev}x; partial at TP1, keep the runner only with continuation evidence.")
        if ctx.lessons and self.style != "neutral":
            text += t(" 과거 교훈: ", " Lesson: ") + ctx.lessons[0][:140]
        return RiskOpinion(self.style, mult, lev, hold, text)


_PM_SYSTEM = (
    "You are the Portfolio Manager and risk judge of a crypto perpetual-futures desk ({mode} desk). Three risk "
    "analysts argued; the trader proposed a transaction. Decide. Reply ONLY with JSON: {{\"rating\": one of "
    "Buy/Overweight/Hold/Underweight/Sell, \"approve\": boolean, \"conviction\": number in [0,1], \"size_multiplier\": "
    "number in [0.3,1.6], \"leverage_cap\": integer, \"hold_bias\": \"quick\"|\"balanced\"|\"extend\", "
    "\"reasoning\": string in {lang}}}. Never exceed the hard leverage cap given in the input."
)


class PortfolioManager:
    def __init__(self, risk: RiskSettings, llm: LLMClient | None = None, language: str = "ko", max_adjustment: float = 0.3) -> None:
        self.risk = risk
        self.llm = llm
        self.language = "Korean" if language.startswith("ko") else "English"
        self.max_adjustment = max_adjustment

    def decide(self, plan: ResearchPlan, prop: TradeProposal, ctx: MarketContext, *, rounds: int = 1) -> PortfolioDecision:
        if prop.direction == 0:
            note = RiskOpinion("neutral", 0.0, self.risk.max_leverage, "balanced",
                               t("[리스크팀] 실행 제안이 없어 토론 생략 — 다음 셋업/합의 변화 시 재소집",
                                 "[Risk team] nothing to size — debate skipped until a setup or the consensus changes"))
            dec = PortfolioDecision(plan.recommendation if plan.recommendation == "Hold" else "Hold", False, 0, prop.conviction, 0.0,
                                    self.risk.max_leverage, "balanced",
                                    t("[포트폴리오 매니저] 트레이더 제안이 관망 → 거래 없음. " + plan.rationale.split("\n")[0],
                                      "[Portfolio Manager] trader proposes Hold → no trade. " + plan.rationale.split("\n")[0]),
                                    [note])
            return dec
        opinions = [RiskDebator(s).opine(prop, ctx, self.risk) for s in ("aggressive", "neutral", "conservative")]
        # weight the three opinions by regime and conviction: trends favour the aggressive view, volatility the conservative
        w_aggr = 0.25 + 0.35 * prop.conviction + (0.15 if ctx.signal.regime.startswith("trend") else 0.0)
        w_cons = 0.25 + (0.3 if ctx.signal.regime == "volatile" else 0.0) + (0.2 if plan.agreement < 0.6 else 0.0)
        w_neut = 0.4
        tot = w_aggr + w_cons + w_neut
        size = (opinions[0].size_multiplier * w_aggr + opinions[1].size_multiplier * w_neut + opinions[2].size_multiplier * w_cons) / tot
        size = clamp(size * prop.size_multiplier, 0.3, 1.6)
        lev_cap = int(round((opinions[0].leverage_cap * w_aggr + opinions[1].leverage_cap * w_neut + opinions[2].leverage_cap * w_cons) / tot))
        lev_cap = max(1, min(self.risk.max_leverage, lev_cap))
        if w_aggr >= max(w_cons, w_neut) and prop.conviction >= 0.65:
            hold = "extend"
        elif w_cons >= max(w_aggr, w_neut):
            hold = "quick"
        else:
            hold = "balanced"
        conviction = clamp(prop.conviction * (0.85 + 0.3 * plan.agreement), 0.0, 1.0)
        approve = conviction >= 0.3
        rating = plan.recommendation if approve else "Hold"
        if approve and rating == "Hold":
            rating = rating_from_score(plan.composite if plan.composite != 0 else 0.25 * prop.direction)
        reasoning = t(
            f"[포트폴리오 매니저] 등급 {rating}, {'승인' if approve else '거부'}. 확신도 {conviction:.2f}, 비중 ×{size:.2f}, 레버리지 한도 {lev_cap}x (하드캡 {self.risk.max_leverage}x), 보유 성향 {hold}. "
            f"가중치: 공격 {w_aggr/tot:.0%} / 중립 {w_neut/tot:.0%} / 보수 {w_cons/tot:.0%} (레짐 {ctx.signal.regime}, 합의 {plan.agreement:.0%}).",
            f"[Portfolio Manager] rating {rating}, {'approved' if approve else 'rejected'}. Conviction {conviction:.2f}, size ×{size:.2f}, leverage cap {lev_cap}x (hard cap {self.risk.max_leverage}x), hold bias {hold}. "
            f"Weights: aggressive {w_aggr/tot:.0%} / neutral {w_neut/tot:.0%} / conservative {w_cons/tot:.0%} (regime {ctx.signal.regime}, agreement {plan.agreement:.0%}).",
        )
        dec = PortfolioDecision(rating, approve, prop.direction if approve else 0, conviction, size if approve else 0.0, lev_cap, hold, reasoning, opinions)
        if self.llm is not None and self.llm.enabled:
            payload = {"mode": ctx.mode, "symbol": ctx.symbol, "price": ctx.price, "hard_leverage_cap": self.risk.max_leverage,
                       "research_plan": plan.to_dict(), "trade_proposal": prop.to_dict(),
                       "risk_opinions": [o.__dict__ for o in opinions], "rule_based_decision": dec.to_dict(),
                       "account_position": ctx.position.to_dict() if ctx.position else None, "lessons": ctx.lessons[:5]}
            data = extract_json(self.llm.complete(_PM_SYSTEM.format(mode=ctx.mode, lang=self.language),
                                                  json.dumps(payload, ensure_ascii=False, default=str), deep=True))
            if data:
                try:
                    if data.get("approve") is False:
                        dec.approve, dec.direction, dec.size_multiplier, dec.rating = False, 0, 0.0, "Hold"
                    r = str(data.get("rating", dec.rating))
                    if r in RATINGS:
                        dec.rating = r
                    dec.conviction = clamp(float(data.get("conviction", dec.conviction)), dec.conviction - self.max_adjustment,
                                           dec.conviction + self.max_adjustment)
                    if dec.approve:
                        dec.size_multiplier = clamp(float(data.get("size_multiplier", dec.size_multiplier)), 0.3, 1.6)
                    dec.leverage_cap = max(1, min(self.risk.max_leverage, int(data.get("leverage_cap", dec.leverage_cap))))
                    hb = str(data.get("hold_bias", dec.hold_bias))
                    if hb in ("quick", "balanced", "extend"):
                        dec.hold_bias = hb
                    if data.get("reasoning"):
                        dec.reasoning = str(data["reasoning"]) + "\n" + dec.reasoning
                    dec.llm_used = True
                except (TypeError, ValueError):
                    pass
        return dec
