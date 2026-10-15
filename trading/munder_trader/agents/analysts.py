"""Analyst team.

Each analyst reads one slice of the market context and returns a report with a
stance, a score, a confidence and the evidence that produced it. Rule-based by
default; :class:`LLMEnhancer` lets a model rewrite the reasoning and nudge the
score inside a bounded band.
"""

from __future__ import annotations

import logging
from typing import Any

from ..util import clamp
from .base import AgentReport, Evidence, MarketContext, stance_ko, stance_of, t
from .llm import LLMClient, extract_json

log = logging.getLogger(__name__)


class Analyst:
    name = "analyst"
    role = "analyst"
    modes: tuple[str, ...] = ("swing", "scalp")

    def analyze(self, ctx: MarketContext) -> AgentReport:  # pragma: no cover - abstract
        raise NotImplementedError

    @staticmethod
    def _finish(name: str, role: str, ctx: MarketContext, evidence: list[Evidence], confidence: float,
                headline: str) -> AgentReport:
        num = sum(e.direction * e.weight for e in evidence)
        den = sum(e.weight for e in evidence) or 1.0
        score = clamp(num / den, -1.0, 1.0)
        stance = stance_of(score)
        bull = [e for e in evidence if e.direction > 0]
        bear = [e for e in evidence if e.direction < 0]
        lines = [headline, t(f"판단: {stance_ko(stance)} (점수 {score:+.2f}, 확신도 {confidence:.0%})",
                             f"Verdict: {stance} (score {score:+.2f}, confidence {confidence:.0%})")]
        if bull:
            lines.append(t("강세 근거: ", "Bullish evidence: ") + "; ".join(e.interpretation for e in sorted(bull, key=lambda e: -e.weight)[:4]))
        if bear:
            lines.append(t("약세 근거: ", "Bearish evidence: ") + "; ".join(e.interpretation for e in sorted(bear, key=lambda e: -e.weight)[:4]))
        neutral = [e for e in evidence if e.direction == 0]
        if neutral:
            lines.append(t("참고: ", "Context: ") + "; ".join(e.interpretation for e in neutral[:3]))
        return AgentReport(agent=name, role=role, mode=ctx.mode, symbol=ctx.symbol, stance=stance, score=score,
                           confidence=clamp(confidence, 0.05, 1.0), evidence=evidence, reasoning="\n".join(lines))


# --------------------------------------------------------------------------------
# Technical analysts
# --------------------------------------------------------------------------------

class MarketAnalyst(Analyst):
    """Trend / momentum / structure on the desk's base timeframe (TradingAgents' Market Analyst)."""

    name = "market_analyst"
    role = "analyst"

    def analyze(self, ctx: MarketContext) -> AgentReport:
        v = ctx.value
        ev: list[Evidence] = []
        close, ema_f, ema_s, ema_t = v("close"), v("ema_fast"), v("ema_slow"), v("ema_trend")
        adx, rsi, slope_, vol_ratio = v("adx"), v("rsi", 50.0), v("ema_fast_slope"), v("vol_ratio", 1.0)
        regime = str(ctx.last.get("regime", "range"))
        if ema_f > ema_s:
            ev.append(Evidence("ema_alignment", f"{ema_f:.6g}>{ema_s:.6g}", t("단기 EMA가 장기 EMA 위 → 상승 추세 정렬", "fast EMA above slow EMA → bullish alignment"), 1, 1.0))
        elif ema_f < ema_s:
            ev.append(Evidence("ema_alignment", f"{ema_f:.6g}<{ema_s:.6g}", t("단기 EMA가 장기 EMA 아래 → 하락 추세 정렬", "fast EMA below slow EMA → bearish alignment"), -1, 1.0))
        if ema_t:
            if close > ema_t:
                ev.append(Evidence("trend_filter", f"{close:.6g}>{ema_t:.6g}", t("가격이 추세 EMA 위", "price above trend EMA"), 1, 0.8))
            else:
                ev.append(Evidence("trend_filter", f"{close:.6g}<{ema_t:.6g}", t("가격이 추세 EMA 아래", "price below trend EMA"), -1, 0.8))
        trend_dir = 1 if ema_f > ema_s else -1
        if adx >= 25:
            ev.append(Evidence("adx", round(adx, 1), t(f"ADX {adx:.0f} → 추세 강함", f"ADX {adx:.0f} → strong trend"), trend_dir, 0.9))
        elif adx < 18:
            ev.append(Evidence("adx", round(adx, 1), t(f"ADX {adx:.0f} → 추세 약함/횡보", f"ADX {adx:.0f} → weak trend / range"), 0, 0.5))
        if rsi >= 70:
            ev.append(Evidence("rsi", round(rsi, 1), t(f"RSI {rsi:.0f} 과매수 → 추격매수 위험", f"RSI {rsi:.0f} overbought → chasing risk"), -1, 0.6))
        elif rsi <= 30:
            ev.append(Evidence("rsi", round(rsi, 1), t(f"RSI {rsi:.0f} 과매도 → 반등 여지", f"RSI {rsi:.0f} oversold → bounce potential"), 1, 0.6))
        elif trend_dir > 0 and rsi < 48:
            ev.append(Evidence("rsi_pullback", round(rsi, 1), t(f"상승추세 속 RSI {rsi:.0f} 눌림 → 재진입 구간", f"RSI {rsi:.0f} pullback inside uptrend → re-entry zone"), 1, 0.8))
        elif trend_dir < 0 and rsi > 52:
            ev.append(Evidence("rsi_pullback", round(rsi, 1), t(f"하락추세 속 RSI {rsi:.0f} 반등 → 매도 재진입 구간", f"RSI {rsi:.0f} bounce inside downtrend → short re-entry zone"), -1, 0.8))
        if abs(slope_) > 0.05:
            ev.append(Evidence("ema_slope", round(slope_, 3), t(f"EMA 기울기 {slope_:+.2f}%", f"EMA slope {slope_:+.2f}%"), 1 if slope_ > 0 else -1, 0.5))
        if vol_ratio >= 1.5:
            ev.append(Evidence("volume", round(vol_ratio, 2), t(f"거래량 평균 대비 {vol_ratio:.1f}배 → 움직임에 참여 있음", f"volume {vol_ratio:.1f}× average → participation"), trend_dir if ctx.signal.direction == 0 else ctx.signal.direction, 0.6))
        sig = ctx.signal
        if sig.direction != 0:
            ev.append(Evidence("quant_setup", sig.setup, t(f"퀀트 셋업 '{sig.setup}' {('롱' if sig.direction > 0 else '숏')} (강도 {sig.strength:.2f}, 손절 {sig.stop_pct:.2f}%, 손익비 {sig.reward_risk:.1f})",
                                                            f"quant setup '{sig.setup}' {('long' if sig.direction > 0 else 'short')} (strength {sig.strength:.2f}, stop {sig.stop_pct:.2f}%, R:R {sig.reward_risk:.1f})"),
                               sig.direction, 1.2 + sig.strength))
        headline = t(f"[시장 분석] {ctx.symbol} {ctx.mode} — 레짐 {regime}, 종가 {close:.6g}",
                     f"[Market] {ctx.symbol} {ctx.mode} — regime {regime}, close {close:.6g}")
        conf = clamp(0.4 + 0.3 * min(1.0, adx / 30) + (0.2 if sig.direction != 0 else 0.0), 0.2, 0.95)
        return self._finish(self.name, self.role, ctx, ev, conf, headline)


class VolatilityAnalyst(Analyst):
    """Regime, ATR, spread and session liquidity — tells the desk *how* to trade, not which way."""

    name = "volatility_analyst"
    role = "analyst"

    def analyze(self, ctx: MarketContext) -> AgentReport:
        v = ctx.value
        ev: list[Evidence] = []
        atr_pct, rv = v("atr_pct"), v("rv")
        regime = str(ctx.last.get("regime", "range"))
        ev.append(Evidence("regime", regime, t(f"레짐 {regime}", f"regime {regime}"), 0, 0.5))
        ev.append(Evidence("atr_pct", round(atr_pct, 3), t(f"ATR {atr_pct:.2f}% → 손절 폭/레버리지 기준", f"ATR {atr_pct:.2f}% → stop width / leverage anchor"), 0, 0.5))
        if ctx.book is not None:
            s = ctx.book.spread_bps
            d = -1 if s > 5 else 0
            ev.append(Evidence("spread_bps", round(s, 2), t(f"스프레드 {s:.1f}bp", f"spread {s:.1f}bp") + (t(" → 넓음, 스캘핑 비용 ↑", " → wide, scalping costly") if s > 5 else ""), 0, 0.4))
            if d:
                ev[-1].direction = -ctx.signal.direction if ctx.signal.direction else 0
        if ctx.session_liquidity < 1.0:
            ev.append(Evidence("session", ctx.session_liquidity, t(f"세션 유동성 {ctx.session_liquidity:.0%} → 사이즈 축소", f"session liquidity {ctx.session_liquidity:.0%} → reduce size"), 0, 0.4))
        if regime == "volatile":
            ev.append(Evidence("volatile", rv, t("변동성 급증 → 손절 넓히고 사이즈 축소", "volatility spike → wider stop, smaller size"), 0, 0.5))
        headline = t(f"[변동성/레짐] {ctx.symbol} {ctx.mode}", f"[Volatility/Regime] {ctx.symbol} {ctx.mode}")
        return self._finish(self.name, self.role, ctx, ev, 0.5, headline)


# --------------------------------------------------------------------------------
# Derivatives fundamentals / sentiment / news (swing desk)
# --------------------------------------------------------------------------------

class FundamentalsAnalyst(Analyst):
    """Crypto-derivatives fundamentals: funding, open interest, basis, long/short positioning."""

    name = "fundamentals_analyst"
    role = "analyst"
    modes = ("swing", "scalp")

    def analyze(self, ctx: MarketContext) -> AgentReport:
        d = ctx.derivatives or {}
        ev: list[Evidence] = []
        funding = float(d.get("funding_rate", 0.0) or 0.0)
        if abs(funding) >= 0.0005:
            crowd = t("롱 과밀(펀딩 양수)", "crowded longs (positive funding)") if funding > 0 else t("숏 과밀(펀딩 음수)", "crowded shorts (negative funding)")
            ev.append(Evidence("funding", f"{funding*100:.3f}%/8h", t(f"펀딩 {funding*100:.3f}% → {crowd}, 역방향 압력", f"funding {funding*100:.3f}% → {crowd}, contrarian pressure"), -1 if funding > 0 else 1, 0.8))
        elif abs(funding) > 0:
            ev.append(Evidence("funding", f"{funding*100:.3f}%/8h", t("펀딩 중립", "funding neutral"), 0, 0.3))
        oi_chg = d.get("oi_change_pct")
        px_chg = d.get("price_change_pct")
        if oi_chg is not None and px_chg is not None:
            oi_chg, px_chg = float(oi_chg), float(px_chg)
            if oi_chg > 2 and px_chg > 0.3:
                ev.append(Evidence("oi_price", f"OI {oi_chg:+.1f}% / px {px_chg:+.1f}%", t("OI↑ 가격↑ → 신규 롱 유입, 추세 지속", "OI up with price up → new longs, trend continuation"), 1, 0.9))
            elif oi_chg > 2 and px_chg < -0.3:
                ev.append(Evidence("oi_price", f"OI {oi_chg:+.1f}% / px {px_chg:+.1f}%", t("OI↑ 가격↓ → 신규 숏 유입, 하락 지속", "OI up with price down → new shorts, continuation down"), -1, 0.9))
            elif oi_chg < -2 and px_chg > 0.3:
                ev.append(Evidence("oi_price", f"OI {oi_chg:+.1f}% / px {px_chg:+.1f}%", t("OI↓ 가격↑ → 숏 커버링 랠리, 지속성 약함", "OI down with price up → short covering, weak continuation"), 0, 0.6))
            elif oi_chg < -2 and px_chg < -0.3:
                ev.append(Evidence("oi_price", f"OI {oi_chg:+.1f}% / px {px_chg:+.1f}%", t("OI↓ 가격↓ → 롱 청산, 바닥 근접 가능", "OI down with price down → long liquidation, washout"), 1, 0.5))
        ls = d.get("long_short_ratio")
        if ls is not None:
            ls = float(ls)
            if ls >= 2.0:
                ev.append(Evidence("long_short", ls, t(f"롱/숏 계정비 {ls:.2f} → 롱 과밀, 역추세 리스크", f"long/short accounts {ls:.2f} → crowded longs"), -1, 0.6))
            elif ls <= 0.6:
                ev.append(Evidence("long_short", ls, t(f"롱/숏 계정비 {ls:.2f} → 숏 과밀, 스퀴즈 가능", f"long/short accounts {ls:.2f} → crowded shorts, squeeze potential"), 1, 0.6))
        taker = d.get("taker_buy_sell_ratio")
        if taker is not None:
            taker = float(taker)
            if taker >= 1.2:
                ev.append(Evidence("taker_ratio", taker, t(f"테이커 매수/매도 {taker:.2f} → 공격적 매수 우위", f"taker buy/sell {taker:.2f} → aggressive buying"), 1, 0.7))
            elif taker <= 0.83:
                ev.append(Evidence("taker_ratio", taker, t(f"테이커 매수/매도 {taker:.2f} → 공격적 매도 우위", f"taker buy/sell {taker:.2f} → aggressive selling"), -1, 0.7))
        basis = d.get("basis_bps")
        if basis is not None:
            basis = float(basis)
            if basis > 15:
                ev.append(Evidence("basis", round(basis, 1), t(f"마크-인덱스 베이시스 {basis:.0f}bp 프리미엄 → 과열", f"mark-index basis {basis:.0f}bp premium → overheated"), -1, 0.5))
            elif basis < -15:
                ev.append(Evidence("basis", round(basis, 1), t(f"베이시스 {basis:.0f}bp 디스카운트 → 공포", f"basis {basis:.0f}bp discount → fear"), 1, 0.5))
        nxt = d.get("minutes_to_funding")
        if nxt is not None and float(nxt) <= 20 and abs(funding) >= 0.0003:
            side_pays = t("롱이 지불", "longs pay") if funding > 0 else t("숏이 지불", "shorts pay")
            ev.append(Evidence("funding_soon", nxt, t(f"{float(nxt):.0f}분 후 펀딩 정산({side_pays}) → 정산 전후 변동 주의", f"funding in {float(nxt):.0f} min ({side_pays}) → expect positioning flows"), 0, 0.4))
        if not ev:
            ev.append(Evidence("no_data", None, t("파생 데이터 없음 → 중립", "no derivatives data → neutral"), 0, 0.3))
        headline = t(f"[파생 펀더멘털] {ctx.symbol}", f"[Derivatives fundamentals] {ctx.symbol}")
        conf = 0.55 if len(ev) >= 3 else 0.35
        return self._finish(self.name, self.role, ctx, ev, conf, headline)


class SentimentAnalyst(Analyst):
    """Fear & greed plus crowd positioning proxies (TradingAgents' Sentiment Analyst)."""

    name = "sentiment_analyst"
    role = "analyst"
    modes = ("swing",)

    def analyze(self, ctx: MarketContext) -> AgentReport:
        s = ctx.sentiment or {}
        ev: list[Evidence] = []
        fg = s.get("fear_greed")
        if fg is not None:
            fg = float(fg)
            if fg <= 25:
                ev.append(Evidence("fear_greed", fg, t(f"공포탐욕 {fg:.0f} 극단적 공포 → 역발상 매수 여지", f"fear & greed {fg:.0f} extreme fear → contrarian long"), 1, 0.7))
            elif fg >= 75:
                ev.append(Evidence("fear_greed", fg, t(f"공포탐욕 {fg:.0f} 극단적 탐욕 → 과열 경계", f"fear & greed {fg:.0f} extreme greed → caution"), -1, 0.7))
            else:
                ev.append(Evidence("fear_greed", fg, t(f"공포탐욕 {fg:.0f} 중립권", f"fear & greed {fg:.0f} neutral"), 0, 0.3))
        for key, label in (("social_score", t("소셜 심리", "social sentiment")), ("news_score", t("뉴스 심리", "news sentiment"))):
            val = s.get(key)
            if val is not None:
                val = float(val)
                if abs(val) >= 0.2:
                    ev.append(Evidence(key, round(val, 2), f"{label} {val:+.2f}", 1 if val > 0 else -1, 0.5))
        if not ev:
            ev.append(Evidence("no_data", None, t("심리 데이터 없음 → 중립", "no sentiment data → neutral"), 0, 0.2))
        headline = t(f"[심리] {ctx.symbol}", f"[Sentiment] {ctx.symbol}")
        return self._finish(self.name, self.role, ctx, ev, 0.4 if len(ev) > 1 else 0.25, headline)


_POS_WORDS = ("surge", "rally", "approve", "approval", "adopt", "partnership", "etf", "record", "breakout", "upgrade",
              "bullish", "inflow", "상승", "급등", "승인", "호재", "유입")
_NEG_WORDS = ("hack", "exploit", "ban", "lawsuit", "sec sues", "crash", "plunge", "outage", "liquidat", "bearish",
              "outflow", "delist", "하락", "급락", "해킹", "규제", "악재", "유출")


class NewsAnalyst(Analyst):
    """Headline scoring (TradingAgents' News Analyst). Headlines come from ``ctx.news``."""

    name = "news_analyst"
    role = "analyst"
    modes = ("swing",)

    def analyze(self, ctx: MarketContext) -> AgentReport:
        ev: list[Evidence] = []
        for item in (ctx.news or [])[:12]:
            title = str(item.get("title", ""))
            low = title.lower()
            sc = item.get("sentiment")
            if sc is None:
                sc = sum(1 for w in _POS_WORDS if w in low) - sum(1 for w in _NEG_WORDS if w in low)
                sc = clamp(sc / 2.0, -1.0, 1.0)
            sc = float(sc)
            if abs(sc) >= 0.3:
                ev.append(Evidence("headline", title[:80], (t("호재: ", "positive: ") if sc > 0 else t("악재: ", "negative: ")) + title[:80],
                                   1 if sc > 0 else -1, 0.4 + 0.4 * abs(sc)))
        if not ev:
            ev.append(Evidence("no_news", None, t("유의미한 뉴스 없음 → 중립", "no material news → neutral"), 0, 0.2))
        headline = t(f"[뉴스] {ctx.symbol} 헤드라인 {len(ctx.news or [])}건", f"[News] {ctx.symbol} {len(ctx.news or [])} headlines")
        return self._finish(self.name, self.role, ctx, ev, 0.45 if len(ev) > 1 else 0.2, headline)


# --------------------------------------------------------------------------------
# Microstructure analysts (scalp desk)
# --------------------------------------------------------------------------------

class MicrostructureAnalyst(Analyst):
    """Order-book analyst: imbalance, micro-price, walls, depth slope."""

    name = "orderbook_analyst"
    role = "analyst"
    modes = ("scalp",)

    def analyze(self, ctx: MarketContext) -> AgentReport:
        b = ctx.book
        ev: list[Evidence] = []
        if b is None or not b.synced:
            ev.append(Evidence("no_book", None, t("호가 데이터 없음/동기화 전 → 중립", "no synced order book → neutral"), 0, 0.2))
            return self._finish(self.name, self.role, ctx, ev, 0.2, t(f"[호가] {ctx.symbol}", f"[Order book] {ctx.symbol}"))
        imb1, imbn = b.imbalance_1, b.imbalance_n
        if abs(imbn) >= 0.12:
            ev.append(Evidence("imbalance_n", round(imbn, 3), t(f"{b.levels}호가 불균형 {imbn:+.2f} → {'매수벽 우위' if imbn > 0 else '매도벽 우위'}", f"{b.levels}-level imbalance {imbn:+.2f} → {'bid-heavy' if imbn > 0 else 'ask-heavy'}"), 1 if imbn > 0 else -1, 0.6 + abs(imbn)))
        if abs(imb1) >= 0.3:
            ev.append(Evidence("imbalance_top", round(imb1, 3), t(f"최우선호가 불균형 {imb1:+.2f}", f"top-of-book imbalance {imb1:+.2f}"), 1 if imb1 > 0 else -1, 0.5))
        micro_bps = (b.microprice - b.mid) / b.mid * 10_000 if b.mid else 0.0
        if abs(micro_bps) >= 0.3:
            ev.append(Evidence("microprice", round(micro_bps, 2), t(f"마이크로프라이스 {micro_bps:+.2f}bp → 다음 틱 {'상승' if micro_bps > 0 else '하락'} 기대", f"microprice {micro_bps:+.2f}bp → next tick likely {'up' if micro_bps > 0 else 'down'}"), 1 if micro_bps > 0 else -1, 0.5))
        if b.bid_wall:
            ev.append(Evidence("bid_wall", b.bid_wall, t(f"매수벽 {b.bid_wall[0]:.6g} ({b.bid_wall[1]:.4g}) → 지지", f"bid wall {b.bid_wall[0]:.6g} ({b.bid_wall[1]:.4g}) → support"), 1, 0.5))
        if b.ask_wall:
            ev.append(Evidence("ask_wall", b.ask_wall, t(f"매도벽 {b.ask_wall[0]:.6g} ({b.ask_wall[1]:.4g}) → 저항", f"ask wall {b.ask_wall[0]:.6g} ({b.ask_wall[1]:.4g}) → resistance"), -1, 0.5))
        slope_ratio = b.bid_slope / b.ask_slope if b.ask_slope > 0 else 1.0
        if slope_ratio >= 1.4:
            ev.append(Evidence("depth_slope", round(slope_ratio, 2), t(f"매수 호가 밀도 {slope_ratio:.1f}배 두터움", f"bid depth {slope_ratio:.1f}× thicker"), 1, 0.4))
        elif slope_ratio <= 0.71:
            ev.append(Evidence("depth_slope", round(slope_ratio, 2), t(f"매도 호가 밀도 {1/slope_ratio:.1f}배 두터움", f"ask depth {1/slope_ratio:.1f}× thicker"), -1, 0.4))
        ev.append(Evidence("spread", round(b.spread_bps, 2), t(f"스프레드 {b.spread_bps:.1f}bp", f"spread {b.spread_bps:.1f}bp"), 0, 0.2))
        headline = t(f"[호가] {ctx.symbol} 중간가 {b.mid:.6g}, 압력 {b.pressure():+.2f}", f"[Order book] {ctx.symbol} mid {b.mid:.6g}, pressure {b.pressure():+.2f}")
        conf = clamp(0.35 + abs(b.pressure()), 0.3, 0.9)
        return self._finish(self.name, self.role, ctx, ev, conf, headline)


class TapeAnalyst(Analyst):
    """Trade-flow analyst: CVD, aggressor ratio, whales, absorption, sweeps."""

    name = "tape_analyst"
    role = "analyst"
    modes = ("scalp",)

    def analyze(self, ctx: MarketContext) -> AgentReport:
        tp = ctx.tape
        ev: list[Evidence] = []
        if tp is None or tp.n_long < 20:
            ev.append(Evidence("no_tape", None, t("체결 데이터 부족 → 중립", "not enough trades → neutral"), 0, 0.2))
            return self._finish(self.name, self.role, ctx, ev, 0.2, t(f"[체결] {ctx.symbol}", f"[Tape] {ctx.symbol}"))
        br_s, br_l = tp.buy_ratio_short, tp.buy_ratio_long
        if abs(br_s - 0.5) >= 0.1:
            ev.append(Evidence("buy_ratio_short", round(br_s, 3), t(f"최근 체결 매수비중 {br_s:.0%}", f"short-window aggressor buy share {br_s:.0%}"), 1 if br_s > 0.5 else -1, 0.5 + 2 * abs(br_s - 0.5)))
        if abs(br_l - 0.5) >= 0.06:
            ev.append(Evidence("buy_ratio_long", round(br_l, 3), t(f"5분 체결 매수비중 {br_l:.0%}", f"long-window buy share {br_l:.0%}"), 1 if br_l > 0.5 else -1, 0.4))
        if abs(tp.cvd_short) > 0 and tp.n_short >= 5:
            ev.append(Evidence("cvd_short", round(tp.cvd_short, 4), t(f"단기 CVD {tp.cvd_short:+.4g}", f"short CVD {tp.cvd_short:+.4g}"), 1 if tp.cvd_short > 0 else -1, 0.4))
        if tp.intensity >= 1.6:
            ev.append(Evidence("intensity", round(tp.intensity, 2), t(f"체결 빈도 {tp.intensity:.1f}배 급증 → 변동성 임박", f"trade intensity {tp.intensity:.1f}× → move imminent"), 0, 0.4))
        if tp.volume_z >= 2.0:
            ev.append(Evidence("volume_z", round(tp.volume_z, 2), t(f"거래량 z={tp.volume_z:.1f} 급증", f"volume burst z={tp.volume_z:.1f}"), 1 if tp.cvd_short > 0 else -1, 0.4))
        if abs(tp.whale_bias) >= 0.4:
            ev.append(Evidence("whales", round(tp.whale_bias, 2), t(f"대형 체결 편향 {tp.whale_bias:+.2f} → {'큰손 매수' if tp.whale_bias > 0 else '큰손 매도'}", f"whale prints {tp.whale_bias:+.2f} → {'large buyers' if tp.whale_bias > 0 else 'large sellers'}"), 1 if tp.whale_bias > 0 else -1, 0.7))
        if abs(tp.absorption) >= 0.25:
            ev.append(Evidence("absorption", round(tp.absorption, 2), t(f"{'매도 흡수(가격 유지)' if tp.absorption > 0 else '매수 흡수(가격 못 올림)'}", f"{'sell absorption (price held)' if tp.absorption > 0 else 'buy absorption (price capped)'}"), 1 if tp.absorption > 0 else -1, 0.7))
        if tp.sweep:
            ev.append(Evidence("sweep", tp.sweep, t(f"{'매수' if tp.sweep > 0 else '매도'} 스윕 발생", f"{'buy' if tp.sweep > 0 else 'sell'} sweep"), tp.sweep, 0.8))
        px_vs_vwap = (tp.last_price - tp.vwap) / tp.vwap * 10_000 if tp.vwap else 0.0
        ev.append(Evidence("vwap_dist", round(px_vs_vwap, 1), t(f"체결 VWAP 대비 {px_vs_vwap:+.1f}bp", f"{px_vs_vwap:+.1f}bp vs trade VWAP"), 0, 0.2))
        headline = t(f"[체결 흐름] {ctx.symbol} 압력 {tp.pressure():+.2f}, 체결 {tp.n_short}/{tp.n_long}", f"[Tape] {ctx.symbol} pressure {tp.pressure():+.2f}, trades {tp.n_short}/{tp.n_long}")
        conf = clamp(0.35 + abs(tp.pressure()) + 0.1 * min(1.0, tp.n_short / 50), 0.3, 0.9)
        return self._finish(self.name, self.role, ctx, ev, conf, headline)


class MomentumAnalyst(Analyst):
    """1m/5m momentum: VWAP stretch, EMA ribbon, squeeze, bursts (scalp counterpart of the Market Analyst)."""

    name = "momentum_analyst"
    role = "analyst"
    modes = ("scalp",)

    def analyze(self, ctx: MarketContext) -> AgentReport:
        v = ctx.value
        ev: list[Evidence] = []
        z, slope_, vol_ratio, ctx_dir, ctx_adx = v("vwap_z"), v("ema_fast_slope"), v("vol_ratio", 1.0), v("ctx_dir"), v("ctx_adx")
        regime = str(ctx.last.get("regime", "range"))
        if ctx_dir != 0:
            ev.append(Evidence("ctx_trend", ctx_dir, t(f"5분봉 EMA 방향 {'상승' if ctx_dir > 0 else '하락'} (ADX {ctx_adx:.0f})", f"5m EMA direction {'up' if ctx_dir > 0 else 'down'} (ADX {ctx_adx:.0f})"), int(ctx_dir), 0.6 + min(0.4, ctx_adx / 60)))
        if abs(z) >= 1.5:
            if regime == "range":
                ev.append(Evidence("vwap_z", round(z, 2), t(f"VWAP 대비 z={z:+.1f} 과도 이탈 → 평균회귀 기대", f"z={z:+.1f} from VWAP in range → mean reversion"), -1 if z > 0 else 1, 0.8))
            else:
                ev.append(Evidence("vwap_z", round(z, 2), t(f"추세 중 VWAP 이탈 z={z:+.1f} → 추격 위험", f"z={z:+.1f} from VWAP in trend → chase risk"), -1 if z > 0 else 1, 0.3))
        if abs(slope_) >= 0.03:
            ev.append(Evidence("ema_slope", round(slope_, 3), t(f"1분 EMA 기울기 {slope_:+.2f}%", f"1m EMA slope {slope_:+.2f}%"), 1 if slope_ > 0 else -1, 0.5))
        if vol_ratio >= 1.6:
            d = 1 if v("close") >= v("open") else -1
            ev.append(Evidence("burst", round(vol_ratio, 2), t(f"거래량 {vol_ratio:.1f}배 버스트, 캔들 {'양봉' if d > 0 else '음봉'}", f"volume burst {vol_ratio:.1f}×, {'up' if d > 0 else 'down'} candle"), d, 0.6))
        sig = ctx.signal
        if sig.direction != 0:
            ev.append(Evidence("quant_setup", sig.setup, t(f"스캘프 셋업 '{sig.setup}' {('롱' if sig.direction > 0 else '숏')} 강도 {sig.strength:.2f}, 손절 {sig.stop_pct:.2f}%", f"scalp setup '{sig.setup}' {('long' if sig.direction > 0 else 'short')} strength {sig.strength:.2f}, stop {sig.stop_pct:.2f}%"), sig.direction, 1.2 + sig.strength))
        headline = t(f"[모멘텀] {ctx.symbol} 1m/5m, 레짐 {regime}", f"[Momentum] {ctx.symbol} 1m/5m, regime {regime}")
        conf = clamp(0.4 + (0.3 if sig.direction != 0 else 0.0) + 0.1 * min(1.0, abs(z)), 0.25, 0.9)
        return self._finish(self.name, self.role, ctx, ev, conf, headline)


# --------------------------------------------------------------------------------
# LLM enhancement
# --------------------------------------------------------------------------------

_ANALYST_SYSTEM = (
    "You are a {role} on a crypto perpetual-futures trading desk ({mode} desk). You receive quantitative evidence "
    "already computed by the desk. Argue like a professional analyst: cite the evidence, weigh it, flag what would "
    "invalidate the view. Reply ONLY with JSON: {{\"score\": number in [-1,1], \"confidence\": number in [0,1], "
    "\"reasoning\": string in {lang}}}. Keep reasoning under 160 words."
)


class LLMEnhancer:
    """Let a model rewrite an analyst's reasoning and nudge its score within ``max_adjustment``."""

    def __init__(self, client: LLMClient, max_adjustment: float = 0.35, language: str = "ko") -> None:
        self.client = client
        self.max_adjustment = max_adjustment
        self.language = "Korean" if language.startswith("ko") else "English"

    def enhance(self, report: AgentReport, ctx: MarketContext, *, deep: bool = False) -> AgentReport:
        if not self.client.enabled:
            return report
        system = _ANALYST_SYSTEM.format(role=report.agent.replace("_", " "), mode=ctx.mode, lang=self.language)
        payload: dict[str, Any] = {
            "symbol": ctx.symbol, "price": ctx.price, "mode": ctx.mode,
            "rule_based_score": report.score, "rule_based_confidence": report.confidence,
            "evidence": [e.to_dict() for e in report.evidence],
            "quant_signal": {"direction": ctx.signal.direction, "setup": ctx.signal.setup, "strength": ctx.signal.strength,
                             "stop_pct": ctx.signal.stop_pct, "reward_risk": ctx.signal.reward_risk, "regime": ctx.signal.regime},
            "lessons_from_memory": ctx.lessons[:5],
        }
        import json as _json

        text = self.client.complete(system, _json.dumps(payload, ensure_ascii=False, default=str), deep=deep)
        data = extract_json(text)
        if not data:
            return report
        try:
            new_score = float(data.get("score", report.score))
            new_conf = float(data.get("confidence", report.confidence))
        except (TypeError, ValueError):
            return report
        new_score = clamp(new_score, report.score - self.max_adjustment, report.score + self.max_adjustment)
        report.score = clamp(new_score, -1.0, 1.0)
        report.confidence = clamp(new_conf, 0.05, 1.0)
        report.stance = stance_of(report.score)
        reasoning = str(data.get("reasoning", "")).strip()
        if reasoning:
            report.reasoning = reasoning + "\n" + t("(규칙 기반 근거 요약) ", "(rule-based evidence) ") + report.reasoning.split("\n", 1)[-1]
        report.llm_used = True
        report.raw_llm = text
        return report


ANALYSTS: dict[str, type[Analyst]] = {
    cls.name: cls for cls in (MarketAnalyst, VolatilityAnalyst, FundamentalsAnalyst, SentimentAnalyst, NewsAnalyst,
                              MicrostructureAnalyst, TapeAnalyst, MomentumAnalyst)
}

SWING_ANALYSTS = ("market_analyst", "fundamentals_analyst", "news_analyst", "sentiment_analyst", "volatility_analyst")
SCALP_ANALYSTS = ("momentum_analyst", "orderbook_analyst", "tape_analyst", "volatility_analyst", "fundamentals_analyst")
