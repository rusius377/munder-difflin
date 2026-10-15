"""Risk guardrails and the hold policy.

:class:`RiskManager` is the last gate before an order plan reaches a broker. It
can approve, shrink or veto a plan and always says why. :class:`HoldPolicy`
decides for an open position whether to bank profit quickly or let the runner
breathe with a trailing stop — the "짧게 익절할지, 더 크게 먹으려 길게 들고갈지"
question — using trend continuation, tape/book pressure and exhaustion evidence.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from ..config import RiskSettings
from ..symbols import meta_for
from ..util import clamp
from .plan import AccountState, OrderPlan, Position


@dataclass
class RiskVerdict:
    allowed: bool
    plan: OrderPlan | None
    reasons: list[str] = field(default_factory=list)
    severity: str = "ok"   # ok | reduced | blocked | paused


class RiskManager:
    def __init__(self, settings: RiskSettings, *, kill_switch_file: str | Path | None = None) -> None:
        self.s = settings
        self.kill_switch = Path(kill_switch_file or settings.kill_switch_file)
        self.paused_until: float = 0.0
        self.pause_reason: str = ""
        self._day: str = ""
        self._day_start_equity: float = 0.0

    # ------------------------------------------------------------------ state
    def roll_day(self, equity: float, now: datetime | None = None) -> None:
        now = now or datetime.now(timezone.utc)
        key = now.strftime("%Y-%m-%d")
        if key != self._day:
            self._day = key
            self._day_start_equity = equity

    def daily_pnl_pct(self, equity: float) -> float:
        if self._day_start_equity <= 0:
            return 0.0
        return (equity - self._day_start_equity) / self._day_start_equity * 100.0

    def pause(self, minutes: int, reason: str) -> None:
        self.paused_until = time.time() + minutes * 60
        self.pause_reason = reason

    @property
    def is_paused(self) -> bool:
        return time.time() < self.paused_until

    def kill_switch_active(self) -> bool:
        return self.kill_switch.exists()

    # ------------------------------------------------------------------ gate
    def check(self, plan: OrderPlan, account: AccountState, *, funding_rate: float = 0.0,
              session_liquidity: float = 1.0, agent_agreement: float = 1.0) -> RiskVerdict:
        reasons: list[str] = []
        if self.kill_switch_active():
            return RiskVerdict(False, None, [f"kill switch file present ({self.kill_switch}) → trading halted"], "blocked")
        if self.is_paused:
            mins = int((self.paused_until - time.time()) / 60)
            return RiskVerdict(False, None, [f"paused for {mins} more minutes: {self.pause_reason}"], "paused")
        self.roll_day(account.equity)
        dpnl = self.daily_pnl_pct(account.equity)
        if dpnl <= -self.s.daily_loss_limit_pct:
            self.pause(self.s.pause_minutes_after_limit, f"daily loss {dpnl:.2f}% hit the {self.s.daily_loss_limit_pct}% limit")
            return RiskVerdict(False, None, [self.pause_reason], "paused")
        if account.peak_equity > 0:
            dd = (account.peak_equity - account.equity) / account.peak_equity * 100.0
            if dd >= self.s.max_drawdown_pause_pct:
                self.pause(self.s.pause_minutes_after_limit * 2, f"drawdown {dd:.1f}% ≥ {self.s.max_drawdown_pause_pct}%")
                return RiskVerdict(False, None, [self.pause_reason], "paused")
        if plan.symbol in account.positions:
            return RiskVerdict(False, None, [f"already in a {account.positions[plan.symbol].side} position on {plan.symbol}"], "blocked")
        if len(account.positions) >= self.s.max_concurrent_positions:
            return RiskVerdict(False, None, [f"{len(account.positions)} open positions ≥ max {self.s.max_concurrent_positions}"], "blocked")
        # correlation cluster: at most two same-direction positions per group
        group = meta_for(plan.symbol).correlation_group
        same = [p for p in account.positions.values()
                if meta_for(p.symbol).correlation_group == group and p.side == plan.side]
        if len(same) >= 2:
            return RiskVerdict(False, None, [f"two {plan.side} positions already open in the {group} cluster"], "blocked")
        scale = 1.0
        severity = "ok"
        if same:
            scale *= 0.6
            reasons.append(f"correlated {plan.side} exposure in {group} ({same[0].symbol}) → size ×0.6")
        if account.consecutive_losses >= self.s.consecutive_loss_cut:
            scale *= 0.5
            reasons.append(f"{account.consecutive_losses} consecutive losses → size ×0.5 until a win")
        if abs(funding_rate) >= self.s.funding_rate_warn:
            against = (funding_rate > 0 and plan.side == "LONG") or (funding_rate < 0 and plan.side == "SHORT")
            if against and plan.mode == "swing":
                scale *= 0.7
                reasons.append(f"funding {funding_rate*100:.3f}%/8h paid by this side → size ×0.7")
        if session_liquidity < 1.0:
            scale *= session_liquidity
            reasons.append(f"thin session liquidity → size ×{session_liquidity:.2f}")
        if agent_agreement < 0.5:
            scale *= 0.7
            reasons.append(f"committee agreement only {agent_agreement:.0%} → size ×0.7")
        if plan.margin * scale + account.used_margin > account.equity * self.s.max_margin_fraction:
            room = account.equity * self.s.max_margin_fraction - account.used_margin
            if room <= 0:
                return RiskVerdict(False, None, ["margin cap exhausted"], "blocked")
            scale = min(scale, room / plan.margin)
            reasons.append("size reduced to stay inside the margin cap")
        if plan.liquidation_est is not None and plan.risk_per_unit > 0:
            liq_dist = abs(plan.entry_ref - plan.liquidation_est)
            if liq_dist < self.s.liquidation_buffer_multiple * plan.risk_per_unit * 0.95:
                return RiskVerdict(False, None, [f"liquidation {plan.liquidation_est:.6g} too close to the stop → plan rejected"], "blocked")
        if scale < 0.999:
            severity = "reduced"
            for t in plan.tranches:
                t.qty = round(t.qty * scale, 10)
            plan.total_qty = sum(t.qty for t in plan.tranches)
            plan.notional = plan.total_qty * plan.entry_ref
            plan.margin = plan.notional / plan.leverage
            plan.risk_amount *= scale
            plan.risk_pct *= scale
        plan.reasons.extend(reasons)
        return RiskVerdict(True, plan, reasons or ["all guardrails clear"], severity)

    def session_liquidity(self, symbol: str, now: datetime | None = None) -> float:
        """Equity/gold-linked perps trade thin outside US hours; shrink size there."""
        meta = meta_for(symbol)
        if not meta.session_aware:
            return 1.0
        now = now or datetime.now(timezone.utc)
        h = now.hour + now.minute / 60.0
        weekday = now.weekday()
        if weekday >= 5:
            return 0.4 if meta.asset_class == "gold" else 0.3
        if 13.5 <= h <= 20.0:      # 09:30–16:00 New York (UTC-4/-5 approx)
            return 1.0
        if 7.0 <= h < 13.5 or 20.0 < h <= 22.0:
            return 0.7
        return 0.45


@dataclass
class HoldDecision:
    action: str                  # keep | take_quick | extend | tighten | exit
    continuation: float          # 0..1
    reasons: list[str]
    new_stop: float | None = None
    close_fraction: float = 0.0


class HoldPolicy:
    """Decide between banking quickly and holding for a larger move."""

    def evaluate(self, pos: Position, price: float, *, adx: float = 0.0, ema_slope_pct: float = 0.0, rsi: float = 50.0,
                 book_pressure: float = 0.0, tape_pressure: float = 0.0, atr: float = 0.0, regime: str = "range",
                 opposing_wall: bool = False, bars_since_entry: int = 0) -> HoldDecision:
        d = pos.direction
        r = pos.r_multiple(price)
        reasons: list[str] = []
        # continuation evidence
        trend = clamp((adx - 18) / 25.0, 0.0, 1.0)
        slope_align = clamp(ema_slope_pct * d * 25, -1.0, 1.0)
        flow = clamp(0.5 * book_pressure + 0.5 * tape_pressure, -1.0, 1.0) * d
        exhaustion = 0.0
        if (d > 0 and rsi >= 78) or (d < 0 and rsi <= 22):
            exhaustion += 0.35
            reasons.append(f"RSI {rsi:.0f} extreme → exhaustion risk")
        if opposing_wall:
            exhaustion += 0.25
            reasons.append("liquidity wall ahead of price")
        if regime in ("range", "volatile") and pos.mode == "swing":
            exhaustion += 0.15
        cont = clamp(0.4 * trend + 0.3 * (slope_align + 1) / 2 + 0.3 * (flow + 1) / 2 - exhaustion, 0.0, 1.0)
        reasons.append(f"continuation score {cont:.2f} (trend {trend:.2f}, slope {slope_align:+.2f}, flow {flow:+.2f}, exhaustion {exhaustion:.2f})")
        # time stop
        if pos.time_stop_bars and bars_since_entry >= pos.time_stop_bars and r < 0.3:
            reasons.append(f"time stop: {bars_since_entry} bars without progress (R={r:.2f})")
            return HoldDecision("exit", cont, reasons, close_fraction=1.0)
        # breakeven once the trade has paid for itself
        new_stop = None
        if r >= pos.breakeven_after_r:
            be = pos.entry_price + d * max(atr * 0.1, pos.entry_price * 0.0003)
            if (d > 0 and be > pos.stop) or (d < 0 and be < pos.stop):
                new_stop = be
                reasons.append(f"R={r:.2f} ≥ {pos.breakeven_after_r:g} → stop to breakeven")
        if r >= 1.0 and cont >= 0.6 and atr > 0:
            trail = price - d * pos.trail_atr * atr
            if new_stop is None or (d > 0 and trail > new_stop) or (d < 0 and trail < new_stop):
                new_stop = trail if (d > 0 and trail > pos.stop) or (d < 0 and trail < pos.stop) else new_stop
            reasons.append("strong continuation → extend: trail the runner instead of taking TP2")
            return HoldDecision("extend", cont, reasons, new_stop=new_stop)
        if r >= 0.8 and cont < 0.25:
            reasons.append("weak continuation while in profit → take the quick profit")
            return HoldDecision("take_quick", cont, reasons, new_stop=new_stop, close_fraction=1.0)
        if r >= 0.5 and exhaustion >= 0.35:
            reasons.append("exhaustion while in profit → tighten")
            tight = price - d * max(atr * 0.6, pos.entry_price * 0.0005)
            if (d > 0 and tight > (new_stop or pos.stop)) or (d < 0 and tight < (new_stop or pos.stop)):
                new_stop = tight
            return HoldDecision("tighten", cont, reasons, new_stop=new_stop)
        return HoldDecision("keep", cont, reasons, new_stop=new_stop)
