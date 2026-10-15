"""Per-trade feedback: grade the committee, write a lesson, update sizing stats.

Called by the live engine (and the paper engine) whenever a position closes.
Three things happen:

1. **credit assignment** — each analyst's stance is compared with the trade
   outcome and the :class:`AgentWeights` table is updated;
2. **reflection** — a lesson is written (templated, or by the LLM when one is
   configured) and stored in :class:`LessonMemory` for retrieval;
3. **performance stats** — the rolling win rate / payoff per (mode, symbol)
   that the sizer's fractional-Kelly scaling reads.
"""

from __future__ import annotations

import json
import logging
from collections import defaultdict, deque
from dataclasses import dataclass
from typing import Any

from ..agents.base import t
from ..agents.llm import LLMClient, extract_json
from ..agents.weights import AgentWeights
from ..strategy.position_sizing import PerformanceStats
from ..util import now_ms
from .memory import Lesson, LessonMemory

log = logging.getLogger(__name__)


@dataclass
class ClosedTrade:
    symbol: str
    mode: str
    side: str
    entry_price: float
    exit_price: float
    qty: float
    leverage: int
    pnl: float
    r_multiple: float
    bars_held: int
    exit_reason: str
    mfe_r: float
    mae_r: float
    opened_ts: int
    closed_ts: int
    decision: dict[str, Any] | None = None   # DeskDecision.to_dict() captured at entry
    plan: dict[str, Any] | None = None

    @property
    def won(self) -> bool:
        return self.pnl > 0


_REFLECT_SYSTEM = (
    "You are the desk's post-trade reviewer. Given the decision reasoning and the realised outcome, write ONE concrete, "
    "reusable lesson (what to repeat or avoid next time in a similar situation). Reply ONLY with JSON: "
    "{{\"lesson\": string in {lang}, \"blame\": [agent names that were wrong], \"credit\": [agent names that were right]}}."
)


class TradeReflector:
    def __init__(self, memory: LessonMemory, weights: AgentWeights, llm: LLMClient | None = None,
                 language: str = "ko", window: int = 60) -> None:
        self.memory = memory
        self.weights = weights
        self.llm = llm
        self.language = "Korean" if language.startswith("ko") else "English"
        self.window = window
        self._recent: dict[str, deque[tuple[bool, float]]] = defaultdict(lambda: deque(maxlen=window))

    # ------------------------------------------------------------------ stats
    def stats_for(self, mode: str, symbol: str) -> PerformanceStats:
        rows = list(self._recent[f"{mode}:{symbol}"])
        if not rows:
            return PerformanceStats()
        wins = [r for w, r in rows if w]
        losses = [abs(r) for w, r in rows if not w]
        return PerformanceStats(
            trades=len(rows), win_rate=len(wins) / len(rows),
            avg_win_r=(sum(wins) / len(wins)) if wins else 1.0,
            avg_loss_r=(sum(losses) / len(losses)) if losses else 1.0,
        )

    def seed_stats(self, mode: str, symbol: str, rows: list[tuple[bool, float]]) -> None:
        dq = self._recent[f"{mode}:{symbol}"]
        for w, r in rows[-self.window:]:
            dq.append((w, r))

    # ------------------------------------------------------------------ reflection
    def reflect(self, trade: ClosedTrade) -> Lesson:
        self._recent[f"{trade.mode}:{trade.symbol}"].append((trade.won, trade.r_multiple))
        direction = 1 if trade.side == "LONG" else -1
        credit, blame = [], []
        dec = trade.decision or {}
        for rep in dec.get("reports", []):
            score = float(rep.get("score", 0.0))
            stance_dir = 1 if score >= 0.15 else -1 if score <= -0.15 else 0
            if stance_dir == 0:
                continue
            self.weights.update(trade.mode, rep["agent"], stance_direction=stance_dir, trade_direction=direction,
                                won=trade.won, r_multiple=trade.r_multiple)
            right = (stance_dir == direction) == trade.won
            (credit if right else blame).append(rep["agent"])
        situation = self._situation(trade)
        lesson_text = self._template_lesson(trade, credit, blame)
        if self.llm is not None and self.llm.enabled:
            payload = {"trade": {k: v for k, v in trade.__dict__.items() if k not in ("decision", "plan")},
                       "decision_summary": dec.get("summary"), "portfolio_reasoning": (dec.get("portfolio") or {}).get("reasoning"),
                       "research_rationale": (dec.get("research") or {}).get("rationale"),
                       "analysts": [{"agent": r["agent"], "stance": r["stance"], "score": r["score"]} for r in dec.get("reports", [])],
                       "rule_based_lesson": lesson_text}
            data = extract_json(self.llm.complete(_REFLECT_SYSTEM.format(lang=self.language),
                                                  json.dumps(payload, ensure_ascii=False, default=str)))
            if data and data.get("lesson"):
                lesson_text = str(data["lesson"])
        lesson = Lesson(ts=trade.closed_ts or now_ms(), mode=trade.mode, symbol=trade.symbol, situation=situation,
                        outcome=f"{trade.exit_reason} {trade.r_multiple:+.2f}R pnl {trade.pnl:+.2f}", lesson=lesson_text,
                        r_multiple=trade.r_multiple, won=trade.won,
                        tags={"credit": credit, "blame": blame, "setup": dec.get("setup"), "regime": dec.get("regime"),
                              "conviction": dec.get("conviction"), "hold_bias": dec.get("hold_bias"), "leverage": trade.leverage})
        self.memory.add(lesson)
        return lesson

    @staticmethod
    def _situation(trade: ClosedTrade) -> str:
        dec = trade.decision or {}
        bits = [trade.mode, trade.symbol, trade.side.lower(), str(dec.get("setup", "")), str(dec.get("regime", "")),
                f"conviction {dec.get('conviction', 0):.1f}" if dec.get("conviction") is not None else "", str(dec.get("hold_bias", ""))]
        for rep in dec.get("reports", []):
            for ev in rep.get("evidence", [])[:3]:
                bits.append(str(ev.get("name", "")))
        return " ".join(b for b in bits if b)

    @staticmethod
    def _template_lesson(trade: ClosedTrade, credit: list[str], blame: list[str]) -> str:
        dec = trade.decision or {}
        setup, regime = dec.get("setup", "?"), dec.get("regime", "?")
        side = t("롱" if trade.side == "LONG" else "숏", trade.side.lower())
        if trade.won:
            if trade.mfe_r > 0 and trade.r_multiple / max(trade.mfe_r, 1e-9) < 0.5:
                how = t(f"최대 {trade.mfe_r:.1f}R까지 갔으나 {trade.r_multiple:.1f}R만 실현 → 이런 {regime} 레짐에서는 러너를 더 길게(트레일 완화) 가져갈 것",
                        f"ran to {trade.mfe_r:.1f}R but banked only {trade.r_multiple:.1f}R → in {regime} regimes let the runner breathe (looser trail)")
            else:
                how = t(f"{trade.r_multiple:.1f}R 실현, 익절 포착 양호 → 같은 셋업 {setup}에서 비중을 유지/확대",
                        f"banked {trade.r_multiple:.1f}R with good capture → keep or raise size on setup {setup}")
        else:
            if trade.mae_r >= 1.0 and trade.exit_reason in ("stop", "liquidation"):
                how = t(f"손절 {trade.exit_reason}. 진입 직후 역행 → {setup} 셋업은 확인 캔들/호가 압력 일치 후 진입하거나 손절을 더 넓게",
                        f"stopped ({trade.exit_reason}) right after entry → require a confirming bar / aligned book pressure for {setup}, or widen the stop")
            elif trade.exit_reason == "time_stop":
                how = t(f"시간 손절: {trade.bars_held}봉 동안 진전 없음 → 이 레짐({regime})에서는 셋업 {setup}의 기대 모멘텀이 약함, 비중 축소",
                        f"time stop after {trade.bars_held} bars → setup {setup} lacks follow-through in {regime}; cut size")
            else:
                how = t(f"{trade.exit_reason}로 {trade.r_multiple:.1f}R 손실 → 같은 조건에서는 확신도 기준을 높일 것",
                        f"lost {trade.r_multiple:.1f}R via {trade.exit_reason} → raise the conviction bar in this situation")
        who = ""
        if blame:
            who = t(f" (틀린 의견: {', '.join(blame)}", f" (wrong: {', '.join(blame)}")
            who += (t(f"; 맞은 의견: {', '.join(credit)})", f"; right: {', '.join(credit)})") if credit else ")")
        elif credit:
            who = t(f" (맞은 의견: {', '.join(credit)})", f" (right: {', '.join(credit)})")
        return f"{trade.symbol} {side} {setup}@{regime}: {how}{who}"
