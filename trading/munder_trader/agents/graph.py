"""DeskGraph — orchestrates one committee run for one (symbol, mode).

Pipeline (mirrors TradingAgents' graph): analysts → bull/bear debate →
Research Manager plan → Trader proposal → aggressive/neutral/conservative risk
debate → Portfolio Manager decision. The result, :class:`DeskDecision`, keeps
every intermediate report so the journal / UI can show each desk's judgment,
evidence and reasoning side by side.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..config import LLMSettings, RiskSettings
from ..util import now_ms
from .analysts import ANALYSTS, SCALP_ANALYSTS, SWING_ANALYSTS, LLMEnhancer
from .base import AgentReport, MarketContext, set_language, t
from .llm import LLMClient
from .researchers import ResearchManager, ResearchPlan
from .risk_team import PortfolioDecision, PortfolioManager
from .trader import TradeProposal, Trader
from .weights import AgentWeights

MODE_SPECS: dict[str, dict[str, Any]] = {
    "swing": {
        "label_ko": "스윙(원래 모드)", "label_en": "swing (original mode)",
        "analysts": SWING_ANALYSTS, "debate_rounds": 2, "risk_rounds": 1,
        "horizon": "hours–days", "timeframes": ("1h", "4h", "1d"),
    },
    "scalp": {
        "label_ko": "스캘핑 모드", "label_en": "scalp mode",
        "analysts": SCALP_ANALYSTS, "debate_rounds": 1, "risk_rounds": 1,
        "horizon": "seconds–minutes", "timeframes": ("1m", "5m"),
    },
}


@dataclass
class DeskDecision:
    symbol: str
    mode: str
    ts: int
    price: float
    rating: str
    action: str                    # Buy | Sell | Hold
    direction: int
    conviction: float
    size_multiplier: float
    leverage_cap: int
    hold_bias: str
    approve: bool
    agreement: float
    composite: float
    reports: list[AgentReport]
    research: ResearchPlan
    proposal: TradeProposal
    portfolio: PortfolioDecision
    stop: float
    tp1: float
    tp2: float
    setup: str
    regime: str
    summary: str = ""
    llm_calls: int = 0
    tags: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "symbol": self.symbol, "mode": self.mode, "ts": self.ts, "price": self.price, "rating": self.rating,
            "action": self.action, "direction": self.direction, "conviction": round(self.conviction, 4),
            "size_multiplier": round(self.size_multiplier, 4), "leverage_cap": self.leverage_cap, "hold_bias": self.hold_bias,
            "approve": self.approve, "agreement": round(self.agreement, 3), "composite": round(self.composite, 4),
            "reports": [r.to_dict() for r in self.reports], "research": self.research.to_dict(),
            "proposal": self.proposal.to_dict(), "portfolio": self.portfolio.to_dict(),
            "stop": self.stop, "tp1": self.tp1, "tp2": self.tp2, "setup": self.setup, "regime": self.regime,
            "summary": self.summary, "llm_calls": self.llm_calls, "tags": self.tags,
        }

    def explain(self) -> str:
        """Human-readable judgment / evidence / reasoning block for this desk."""
        spec = MODE_SPECS[self.mode]
        lines = [t(f"=== {spec['label_ko']} · {self.symbol} @ {self.price:.6g} ===", f"=== {spec['label_en']} · {self.symbol} @ {self.price:.6g} ==="),
                 t(f"판단: {self.action} ({self.rating}), 확신도 {self.conviction:.2f}, 합의도 {self.agreement:.0%}, 비중 ×{self.size_multiplier:.2f}, 레버리지 한도 {self.leverage_cap}x, 보유성향 {self.hold_bias}",
                   f"Verdict: {self.action} ({self.rating}), conviction {self.conviction:.2f}, agreement {self.agreement:.0%}, size ×{self.size_multiplier:.2f}, leverage cap {self.leverage_cap}x, hold {self.hold_bias}")]
        if self.direction:
            lines.append(t(f"구조: 손절 {self.stop:.6g} / TP1 {self.tp1:.6g} / TP2 {self.tp2:.6g} (셋업 {self.setup}, 레짐 {self.regime})",
                           f"Structure: stop {self.stop:.6g} / TP1 {self.tp1:.6g} / TP2 {self.tp2:.6g} (setup {self.setup}, regime {self.regime})"))
        lines.append(t("-- 애널리스트 근거 --", "-- Analyst evidence --"))
        for r in self.reports:
            lines.append(f"• {r.agent}: {r.stance} ({r.score:+.2f}, conf {r.confidence:.0%})")
            for ln in r.reasoning.split("\n")[1:4]:
                lines.append("    " + ln)
        lines.append(t("-- 리서치 토론 --", "-- Research debate --"))
        for turn in self.research.debate:
            lines.append("  " + turn.text.replace("\n", "\n  "))
        lines.append("  " + self.research.rationale.replace("\n", "\n  "))
        lines.append("  " + t("실행안: ", "Actions: ") + self.research.strategic_actions)
        lines.append(t("-- 트레이더 --", "-- Trader --"))
        lines.append("  " + self.proposal.rationale.replace("\n", "\n  "))
        lines.append(t("-- 리스크 토론 --", "-- Risk debate --"))
        for o in self.portfolio.opinions:
            lines.append("  " + o.text)
        lines.append("  " + self.portfolio.reasoning.replace("\n", "\n  "))
        return "\n".join(lines)


class DeskGraph:
    def __init__(self, risk: RiskSettings, llm_settings: LLMSettings | None = None, *, weights: AgentWeights | None = None,
                 llm_client: LLMClient | None = None) -> None:
        self.risk = risk
        self.llm_settings = llm_settings or LLMSettings()
        set_language(self.llm_settings.output_language)
        self.llm = llm_client or LLMClient(self.llm_settings)
        self.weights = weights or AgentWeights()
        lang = self.llm_settings.output_language
        self.enhancer = LLMEnhancer(self.llm, self.llm_settings.max_adjustment, lang)
        self.research_manager = ResearchManager(self.llm, lang, self.llm_settings.max_adjustment)
        self.trader = Trader(self.llm, lang, self.llm_settings.max_adjustment)
        self.portfolio_manager = PortfolioManager(risk, self.llm, lang, self.llm_settings.max_adjustment)
        self.analysts = {name: cls() for name, cls in ANALYSTS.items()}

    def run(self, ctx: MarketContext, *, use_llm: bool = True, debate_rounds: int | None = None) -> DeskDecision:
        spec = MODE_SPECS[ctx.mode]
        calls_before = self.llm.calls
        reports: list[AgentReport] = []
        for name in spec["analysts"]:
            rep = self.analysts[name].analyze(ctx)
            if use_llm:
                rep = self.enhancer.enhance(rep, ctx)
            reports.append(rep)
        weights = self.weights.weights_for(ctx.mode, list(spec["analysts"]))
        rm = self.research_manager if use_llm else ResearchManager(None, self.llm_settings.output_language)
        plan = rm.run(reports, ctx, rounds=debate_rounds or spec["debate_rounds"], weights=weights)
        tr = self.trader if use_llm else Trader(None, self.llm_settings.output_language)
        proposal = tr.propose(plan, ctx)
        pm = self.portfolio_manager if use_llm else PortfolioManager(self.risk, None, self.llm_settings.output_language)
        decision = pm.decide(plan, proposal, ctx, rounds=spec["risk_rounds"])
        action = "Buy" if decision.direction > 0 else "Sell" if decision.direction < 0 else "Hold"
        out = DeskDecision(
            symbol=ctx.symbol, mode=ctx.mode, ts=ctx.ts or now_ms(), price=ctx.price, rating=decision.rating, action=action,
            direction=decision.direction, conviction=decision.conviction, size_multiplier=decision.size_multiplier,
            leverage_cap=decision.leverage_cap, hold_bias=decision.hold_bias, approve=decision.approve,
            agreement=plan.agreement, composite=plan.composite, reports=reports, research=plan, proposal=proposal,
            portfolio=decision, stop=proposal.stop, tp1=proposal.tp1, tp2=proposal.tp2,
            setup=ctx.signal.setup if proposal.source != "committee" else "committee", regime=ctx.signal.regime,
            llm_calls=self.llm.calls - calls_before,
            tags={"agent_weights": weights, "quant_direction": ctx.signal.direction, "quant_strength": ctx.signal.strength},
        )
        out.summary = t(
            f"{spec['label_ko']}: {action} {('롱' if out.direction > 0 else '숏' if out.direction < 0 else '')} 확신 {out.conviction:.2f} 합의 {out.agreement:.0%} — {plan.rationale.split(chr(10))[0]}",
            f"{spec['label_en']}: {action} conviction {out.conviction:.2f} agreement {out.agreement:.0%} — {plan.rationale.split(chr(10))[0]}",
        )
        return out
