"""Trader: turns the research plan into a concrete transaction proposal."""

from __future__ import annotations

import json
from dataclasses import dataclass, field

from ..util import clamp
from .base import MarketContext, t
from .llm import LLMClient, extract_json
from .researchers import ResearchPlan, rating_direction


@dataclass
class TradeProposal:
    action: str                 # Buy | Sell | Hold
    direction: int              # +1 / -1 / 0
    conviction: float           # 0..1
    size_multiplier: float      # relative to the sizer's standard
    entry_style: str            # market | scale_in | wait_confirmation
    stop: float
    tp1: float
    tp2: float
    horizon: str
    rationale: str
    source: str = "quant+committee"
    llm_used: bool = False
    tags: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return self.__dict__.copy()


_TRADER_SYSTEM = (
    "You are the Trader on a crypto perpetual-futures desk ({mode} desk). Translate the research plan into a "
    "transaction proposal grounded in the current price and the quant stop/targets. Reply ONLY with JSON: "
    "{{\"action\": \"Buy\"|\"Sell\"|\"Hold\", \"conviction\": number in [0,1], \"size_multiplier\": number in [0.3,1.6], "
    "\"entry_style\": \"market\"|\"scale_in\"|\"wait_confirmation\", \"rationale\": string in {lang}}}."
)


class Trader:
    def __init__(self, llm: LLMClient | None = None, language: str = "ko", max_adjustment: float = 0.3) -> None:
        self.llm = llm
        self.language = "Korean" if language.startswith("ko") else "English"
        self.max_adjustment = max_adjustment

    def propose(self, plan: ResearchPlan, ctx: MarketContext) -> TradeProposal:
        sig = ctx.signal
        d = rating_direction(plan.recommendation)
        strength = abs(plan.composite)
        if d == 0 or (sig.direction != 0 and sig.direction != d and strength < 0.6):
            prop = TradeProposal("Hold", 0, clamp(0.3 * strength, 0, 1), 0.0, "wait_confirmation", sig.entry, sig.entry, sig.entry,
                                 "intraday" if ctx.mode == "scalp" else "swing",
                                 t(f"[트레이더] 등급 {plan.recommendation}, 합의 {plan.agreement:.0%}: 실행 근거 부족 → 관망",
                                   f"[Trader] rating {plan.recommendation}, agreement {plan.agreement:.0%}: insufficient edge → Hold"))
            return prop
        if sig.direction == d:
            conviction = clamp(0.5 * sig.strength + 0.5 * strength, 0.0, 1.0)
            stop, tp1, tp2 = sig.stop, sig.tp1, sig.tp2
            style = "scale_in" if sig.setup in ("pullback", "mean_revert", "vwap_revert") else "market"
            source = "quant+committee"
            why = t(f"퀀트 셋업 {sig.setup}과 위원회 판단이 일치", f"quant setup {sig.setup} agrees with the committee")
        else:
            # committee-initiated: no quant setup (or a weak opposing one); use ATR structure, smaller size
            if strength < 0.5 or plan.agreement < 0.6:
                return TradeProposal("Hold", 0, clamp(0.3 * strength, 0, 1), 0.0, "wait_confirmation", sig.entry, sig.entry, sig.entry,
                                     "swing", t(f"[트레이더] 셋업 없이 위원회 편향만 존재(점수 {plan.composite:+.2f}) → 관망",
                                                f"[Trader] committee bias only (score {plan.composite:+.2f}) without a setup → Hold"))
            conviction = clamp(0.6 * strength, 0.0, 0.75)
            atr = sig.atr if sig.atr > 0 else ctx.price * 0.005
            k = 1.2 if ctx.mode == "scalp" else 2.0
            stop = ctx.price - d * k * atr
            tp1 = ctx.price + d * k * atr
            tp2 = ctx.price + d * 2.2 * k * atr
            style = "wait_confirmation"
            source = "committee"
            why = t("퀀트 셋업 없이 위원회 확신으로 제안(축소 비중)", "committee-initiated without a quant setup (reduced size)")
        size_mult = clamp(0.6 + 0.9 * conviction, 0.4, 1.5) * (0.6 if source == "committee" else 1.0)
        action = "Buy" if d > 0 else "Sell"
        horizon = t("수분~수십분", "minutes") if ctx.mode == "scalp" else t("수시간~수일", "hours to days")
        rationale = t(
            f"[트레이더] {action} 제안: {why}. 확신도 {conviction:.2f}, 비중 ×{size_mult:.2f}, 진입 {style}, 손절 {stop:.6g}, TP1 {tp1:.6g}, TP2 {tp2:.6g}, 보유 {horizon}.",
            f"[Trader] {action}: {why}. Conviction {conviction:.2f}, size ×{size_mult:.2f}, entry {style}, stop {stop:.6g}, TP1 {tp1:.6g}, TP2 {tp2:.6g}, horizon {horizon}.",
        )
        prop = TradeProposal(action, d, conviction, size_mult, style, stop, tp1, tp2, horizon, rationale, source)
        if self.llm is not None and self.llm.enabled:
            data = extract_json(self.llm.complete(
                _TRADER_SYSTEM.format(mode=ctx.mode, lang=self.language),
                json.dumps({"research_plan": plan.to_dict(), "proposal_rule_based": prop.to_dict(), "price": ctx.price,
                            "quant_signal": sig.to_dict(), "position": ctx.position.to_dict() if ctx.position else None},
                           ensure_ascii=False, default=str)))
            if data:
                act = str(data.get("action", prop.action))
                if act == "Hold":
                    prop.action, prop.direction, prop.size_multiplier = "Hold", 0, 0.0
                try:
                    prop.conviction = clamp(float(data.get("conviction", prop.conviction)), prop.conviction - self.max_adjustment,
                                            prop.conviction + self.max_adjustment)
                    prop.size_multiplier = clamp(float(data.get("size_multiplier", prop.size_multiplier)), 0.3, 1.6) if prop.direction else 0.0
                except (TypeError, ValueError):
                    pass
                st = str(data.get("entry_style", prop.entry_style))
                if st in ("market", "scale_in", "wait_confirmation"):
                    prop.entry_style = st
                if data.get("rationale"):
                    prop.rationale = str(data["rationale"]) + "\n" + prop.rationale
                prop.llm_used = True
        return prop
