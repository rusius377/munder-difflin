/**
 * Agents-mode replay ("에이전트 리플레이 훈련"): the whole TradingAgents team
 * decides at moments in the past, and the market's actual path grades them.
 *
 * For each episode (a past moment t, oldest first):
 *   1. the analysts' snapshot is rebuilt as of t — candles closed before t,
 *      funding up to t, positioning series up to t (Binance keeps 30 days),
 *      fear & greed on that day; no news (there is no archive of it);
 *   2. with masking on, every timestamp is shifted by whole weeks and every
 *      price is scaled by one factor, so the models cannot recall what came
 *      next; their prices are scaled back before anything is simulated;
 *   3. the pipeline runs with every agent's project folder — each agent sees
 *      only its own record from before t;
 *   4. the decision is walked forward on real 1-minute candles: market entry
 *      a minute later, stop and target (stop first when one candle touches
 *      both), at most `horizonHours`;
 *   5. every directional call is scored against the price 4 hours after t and
 *      saved in that agent's record (marked as replay); with `learn`, trade
 *      outcomes go into the voters' lessons and the desk's lesson book.
 */
import { buildAnalysisSnapshot, type AnalysisSnapshot } from './marketData';
import { runPipeline, renderReport, PipelineAborted, type AgentHooks } from './agents';
import { OPINION_HORIZON_MS, opinionSummary, voteKo, type AgentProjects } from './agentProjects';
import { sizeOrder } from './risk';
import { FALLBACK_FILTERS } from './broker';
import { FALLBACK_BRACKETS } from './leverage';
import { fetchFearGreed } from './news';
import { fmtPrice, type Kline } from './indicators';
import type { BinanceFuturesClient, FetchLike, FundingPoint, OiPoint, RatioPoint } from './binance';
import type { DeskConstraints } from './prompts';
import type { HistoryStore } from './histData';
import type { LlmClient } from './llm';
import {
  voteDirection,
  type AgentEpisodeView, type AgentRef, type BacktestRequest, type BacktestTrade, type FinalDecision,
  type TradingConfig, type TradingSymbol
} from '../../shared/trading';

const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;
const TF_MS: Record<string, number> = { '15m': 15 * 60_000, '1h': HOUR, '4h': 4 * HOUR, '1d': 24 * HOUR };

export interface Mask {
  /** Added to every timestamp the agents see (whole weeks, so weekday and hour survive). */
  shiftMs: number;
  /** Every price the agents see is multiplied by this. */
  scale: number;
}

export const NO_MASK: Mask = { shiftMs: 0, scale: 1 };

/** A shift that lands "now" in 2031 and a price scale well away from 1. */
export function makeMask(t: number, rand: () => number = Math.random): Mask {
  const target = Date.UTC(2031, 0, 6);
  const shiftMs = Math.round((target - t) / WEEK) * WEEK;
  const r = rand();
  const scale = r < 0.5 ? 0.55 + r * 0.6 : 1.25 + (r - 0.5) * 0.9; // [0.55, 0.85) ∪ [1.25, 1.70)
  return { shiftMs, scale: Math.round(scale * 1000) / 1000 };
}

export function maskKlines(k: readonly Kline[], m: Mask): Kline[] {
  return k.map((c) => ({
    ...c,
    openTime: c.openTime + m.shiftMs, closeTime: c.closeTime + m.shiftMs,
    open: c.open * m.scale, high: c.high * m.scale, low: c.low * m.scale, close: c.close * m.scale,
    quoteVolume: c.quoteVolume * m.scale, takerBuyQuote: c.takerBuyQuote * m.scale
  }));
}

/** Prices in a decision back from the masked scale. */
export function unmaskDecision(d: FinalDecision, m: Mask): FinalDecision {
  const u = (v: number | null) => (v === null ? null : v / m.scale);
  return { ...d, entryPrice: u(d.entryPrice), stopLoss: u(d.stopLoss), takeProfit: u(d.takeProfit) };
}

export interface ReplayMarket {
  klinesBefore(symbol: TradingSymbol, interval: string, t: number, count: number): Promise<Kline[]>;
  fundingBefore(symbol: TradingSymbol, t: number): Promise<FundingPoint[]>;
  oiBefore(symbol: TradingSymbol, t: number): Promise<OiPoint[]>;
  ratioBefore(kind: 'global' | 'top' | 'taker', symbol: TradingSymbol, t: number): Promise<RatioPoint[]>;
  fearGreedBefore(t: number): Promise<Array<{ value: number; classification: string; timestamp: number }>>;
}

/** Binance REST (and alternative.me) as of a past moment. */
export function restReplayMarket(client: BinanceFuturesClient, fetchImpl: FetchLike, now: () => number = Date.now): ReplayMarket {
  const within30d = (t: number) => now() - t < 29 * 24 * HOUR;
  let fng: Promise<Array<{ value: number; classification: string; timestamp: number }>> | null = null;
  return {
    klinesBefore: (symbol, interval, t, count) => client.klinesRange(symbol, interval, t - (count + 1) * TF_MS[interval], t - 1, Math.min(1500, count + 1)),
    fundingBefore: (symbol, t) => client.fundingRateHistory(symbol, 30, t),
    oiBefore: (symbol, t) => (within30d(t) ? client.openInterestHist(symbol, '1h', 48, t) : Promise.resolve([])),
    ratioBefore: (kind, symbol, t) => {
      if (!within30d(t)) return Promise.resolve([]);
      if (kind === 'global') return client.globalLongShortAccountRatio(symbol, '1h', 48, t);
      if (kind === 'top') return client.topLongShortPositionRatio(symbol, '1h', 48, t);
      return client.takerBuySellRatio(symbol, '1h', 48, t);
    },
    fearGreedBefore: async (t) => {
      fng ??= fetchFearGreed(fetchImpl, Math.min(2000, Math.ceil((now() - t) / (24 * HOUR)) + 400)).catch(() => []);
      return (await fng).filter((p) => p.timestamp <= t);
    }
  };
}

/** The analysts' snapshot as it would have looked at `t`, masked. */
export async function historicalSnapshot(market: ReplayMarket, symbol: TradingSymbol, t: number, m: Mask): Promise<AnalysisSnapshot> {
  const notes: string[] = [];
  const settle = async <T>(label: string, p: Promise<T>, fb: T): Promise<T> => {
    try { return await p; } catch (e) { notes.push(`${label} 수집 실패: ${e instanceof Error ? e.message : e}`); return fb; }
  };
  const [k15, k1h, k4h, k1d, funding, oiHist, globalLsr, topLsr, taker, fng] = await Promise.all([
    settle('15분봉', market.klinesBefore(symbol, '15m', t, 200), []),
    settle('1시간봉', market.klinesBefore(symbol, '1h', t, 300), []),
    settle('4시간봉', market.klinesBefore(symbol, '4h', t, 300), []),
    settle('일봉', market.klinesBefore(symbol, '1d', t, 250), []),
    settle('펀딩비 이력', market.fundingBefore(symbol, t), []),
    settle('OI 이력', market.oiBefore(symbol, t), []),
    settle('롱숏 비율', market.ratioBefore('global', symbol, t), []),
    settle('상위 트레이더 롱숏', market.ratioBefore('top', symbol, t), []),
    settle('테이커 비율', market.ratioBefore('taker', symbol, t), []),
    settle('공포탐욕지수', market.fearGreedBefore(t), [])
  ]);
  const closed = (k: Kline[]) => k.filter((c) => c.closeTime < t);
  const c15 = closed(k15), c1h = closed(k1h), c4h = closed(k4h), c1d = closed(k1d);
  if (!c1h.length) throw new Error(`${new Date(t).toISOString()} 이전 캔들을 가져오지 못했습니다`);
  if (!oiHist.length) notes.push('미결제약정·롱숏 비율은 바이낸스가 최근 30일만 제공해 이 시점에는 없습니다');
  const last = c1h[c1h.length - 1];
  const dayAgo = c1h[Math.max(0, c1h.length - 25)];
  const lastFunding = funding.filter((f) => f.fundingTime <= t).slice(-1)[0];
  const day = c1h.slice(-24);
  const snapshot = buildAnalysisSnapshot(symbol, t + m.shiftMs, {
    k15: maskKlines(c15, m), k1h: maskKlines(c1h, m), k4h: maskKlines(c4h, m), k1d: maskKlines(c1d, m),
    premium: {
      symbol, markPrice: last.close * m.scale, indexPrice: last.close * m.scale,
      lastFundingRate: lastFunding?.fundingRate ?? 0,
      nextFundingTime: t - (t % (8 * HOUR)) + 8 * HOUR + m.shiftMs, time: t + m.shiftMs
    },
    ticker: {
      symbol, lastPrice: last.close * m.scale,
      priceChangePercent: dayAgo ? ((last.close - dayAgo.open) / dayAgo.open) * 100 : 0,
      highPrice: Math.max(...day.map((c) => c.high)) * m.scale, lowPrice: Math.min(...day.map((c) => c.low)) * m.scale,
      quoteVolume: day.reduce((a, c) => a + c.quoteVolume, 0) * m.scale
    },
    funding: funding.filter((f) => f.fundingTime <= t).map((f) => ({ ...f, fundingTime: f.fundingTime + m.shiftMs })),
    oiHist: oiHist.filter((o) => o.timestamp <= t).map((o) => ({ ...o, timestamp: o.timestamp + m.shiftMs, openInterestValue: o.openInterestValue * m.scale })),
    globalLsr: globalLsr.filter((r) => r.timestamp <= t).map((r) => ({ ...r, timestamp: r.timestamp + m.shiftMs })),
    topLsr: topLsr.filter((r) => r.timestamp <= t).map((r) => ({ ...r, timestamp: r.timestamp + m.shiftMs })),
    taker: taker.filter((r) => r.timestamp <= t).map((r) => ({ ...r, timestamp: r.timestamp + m.shiftMs })),
    depth: null,
    news: { coin: [], macro: [], errors: [] },
    fng: fng.slice(0, 7).map((p) => ({ ...p, timestamp: p.timestamp + m.shiftMs }))
  }, notes);
  return snapshot;
}

export interface WalkResult { exitTime: number; exitPrice: number; reason: string }

/** A trade walked forward on 1-minute candles: stop first when a candle touches both. */
export function walkTrade(side: 'LONG' | 'SHORT', stop: number, target: number | null, path: readonly Kline[], endTime: number): WalkResult | null {
  for (const k of path) {
    if (k.openTime >= endTime) break;
    const slHit = side === 'LONG' ? k.low <= stop : k.high >= stop;
    const tpHit = target !== null && (side === 'LONG' ? k.high >= target : k.low <= target);
    if (slHit) return { exitTime: k.closeTime, exitPrice: stop, reason: '손절' };
    if (tpHit) return { exitTime: k.closeTime, exitPrice: target as number, reason: '익절' };
  }
  const last = [...path].reverse().find((k) => k.openTime < endTime);
  return last ? { exitTime: last.closeTime, exitPrice: last.close, reason: '보유 기간 종료' } : null;
}

/** Evenly spread moments (on the hour), oldest first, at least `minGapMs` apart. */
export function episodeTimes(from: number, to: number, n: number, minGapMs: number): number[] {
  const span = to - from;
  const count = Math.max(1, Math.min(n, Math.floor(span / Math.max(minGapMs, HOUR)) || 1));
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = from + Math.floor(((i + 0.5) * span) / count);
    out.push(t - (t % HOUR));
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

export interface AgentReplayDeps {
  llm: LlmClient;
  market: ReplayMarket;
  history: Pick<HistoryStore, 'klines1m'>;
  cfg: TradingConfig;
  projects: AgentProjects | null;
  addDeskLesson: (symbol: TradingSymbol, lesson: string) => void;
  writeReport?: (symbol: TradingSymbol, runId: string, takenAt: number, text: string) => string | undefined;
  onProgress: (pct: number, phase: string) => void;
  aborted: () => boolean;
  rand?: () => number;
  now?: () => number;
}

export async function runAgentReplay(req: BacktestRequest, deps: AgentReplayDeps): Promise<{ episodes: AgentEpisodeView[]; trades: BacktestTrade[]; notes: string[] }> {
  const { cfg } = deps;
  const symbol = req.symbol;
  const from = Date.parse(`${req.fromDay}T00:00:00Z`);
  const to = Math.min(Date.parse(`${req.toDay}T00:00:00Z`) + 24 * HOUR, (deps.now ?? Date.now)()) - req.horizonHours * HOUR;
  if (to <= from) throw new Error('기간이 보유 시간보다 짧습니다 — 기간을 늘리거나 보유 시간을 줄이세요');
  const scoreHorizon = OPINION_HORIZON_MS.pipeline;
  const times = episodeTimes(from, to, req.episodes, Math.max(scoreHorizon, req.horizonHours * HOUR));
  const episodes: AgentEpisodeView[] = [];
  const trades: BacktestTrade[] = [];
  const notes = [
    '뉴스 분석가는 제외했습니다 (과거 뉴스 기록 없음)',
    '데스크 교훈과 각 에이전트의 t 이후 기록은 보여 주지 않았습니다 (미래 정보 차단)',
    req.maskHistory ? '에이전트에게는 날짜를 주 단위로 옮기고 가격을 한 비율로 바꿔 보여 줬습니다 (결과 기억 방지)' : '날짜·가격을 가리지 않았습니다 — 모델이 이 시기를 기억하면 결과가 낙관적으로 나올 수 있습니다'
  ];
  let equity = req.startEquity;
  const fee = cfg.risk.takerFeePct / 100;
  const slip = cfg.risk.slippageBps / 10_000;

  for (const [i, t] of times.entries()) {
    if (deps.aborted()) { notes.push('사용자가 중간에 멈췄습니다'); break; }
    const base = i / times.length;
    deps.onProgress(base, `${i + 1}/${times.length} 시점 자료 준비 (${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC)`);
    const mask = req.maskHistory ? makeMask(t, deps.rand) : NO_MASK;
    const ep: AgentEpisodeView = { t, rating: 'Hold', action: 'HOLD', confidence: 0, entryPrice: null, stopLoss: null, takeProfit: null, outcome: null, horizonMovePct: null, calls: 0, hits: 0 };
    try {
      const snapshot = await historicalSnapshot(deps.market, symbol, t, mask);
      const priceT = snapshot.price / mask.scale;
      const pathEnd = t + Math.max(req.horizonHours * HOUR, scoreHorizon) + 2 * 60_000;
      const { k: path } = await deps.history.klines1m(symbol, t, pathEnd);
      const outputs: Array<{ agent: AgentRef; vote: string | null; confidence: number | null; text: string }> = [];
      const hooks: AgentHooks | undefined = deps.projects ? {
        context: (agent) => {
          const pr = deps.projects as AgentProjects;
          const workdir = pr.ensure(agent);
          const memory = pr.memoryBlock(agent.id, symbol, { before: t, relative: req.maskHistory });
          const instructions = pr.instructionsForApi(agent.id);
          return { workdir, instructions: instructions || undefined, memory: memory || undefined };
        },
        onOutput: (agent, out) => { outputs.push({ agent, ...out }); }
      } : undefined;
      const constraints: DeskConstraints = {
        maxLeverage: Math.min(cfg.risk.maxLeverage, cfg.agents.maxLeverage),
        riskPerTradePct: cfg.risk.riskPerTradePct,
        minRewardRisk: cfg.agents.minRewardRisk,
        minConfidence: cfg.agents.minConfidence,
        defaultLeverage: cfg.agents.defaultLeverage,
        venueLabel: '과거 리플레이 훈련'
      };
      // No desk lessons: they were written later than t (or at real price levels) and would leak the future.
      const lessons = '';
      deps.onProgress(base + 0.1 / times.length, `${i + 1}/${times.length} 에이전트 팀 분석 중`);
      const result = await runPipeline({
        ctx: {
          symbol, snapshot, lessons, constraints,
          portfolio: [
            '- 계좌: 과거 차트 리플레이 훈련 (현재 포지션 없음)',
            req.maskHistory ? '- 이것은 과거 시점을 다시 보는 훈련이다. 날짜와 가격 수준은 가려져 있으니 실제 날짜나 가격에 대한 기억에 기대지 말고, 주어진 자료만으로 판단하라.' : '- 이것은 과거 시점을 다시 보는 훈련이다. 그 뒤에 일어난 일에 대한 기억에 기대지 말고, 주어진 자료만으로 판단하라.'
          ].join('\n')
        },
        analysts: cfg.agents.analysts.filter((a) => a !== 'news'),
        debateRounds: cfg.agents.debateRounds,
        riskRounds: cfg.agents.riskRounds,
        teams: cfg.teams,
        sessionKey: `replay-${symbol}`
      }, { llm: deps.llm, agents: hooks, onStep: () => {}, aborted: deps.aborted });

      const d = unmaskDecision(result.decision, mask);
      Object.assign(ep, { rating: d.rating, action: d.action, confidence: d.confidence, entryPrice: d.entryPrice, stopLoss: d.stopLoss, takeProfit: d.takeProfit });
      const after = path.find((k) => k.openTime >= t + scoreHorizon);
      const priceAfter = after?.open ?? null;
      ep.horizonMovePct = priceAfter ? ((priceAfter - priceT) / priceT) * 100 : null;

      // Grade every directional call against the price 4 hours later.
      for (const o of outputs) {
        const dir = voteDirection(o.vote);
        if (dir === 0) continue;
        ep.calls++;
        if (priceAfter && Math.sign(priceAfter - priceT) === dir) ep.hits++;
        if (req.learn && deps.projects && o.vote && priceAfter) {
          try {
            const op = deps.projects.recordOpinion(o.agent, {
              ts: t, symbol, runId: `replay-${t.toString(36)}`, kind: 'pipeline', vote: o.vote, confidence: o.confidence,
              price: priceT, horizonMs: scoreHorizon, summary: opinionSummary(o.text), replay: true
            });
            deps.projects.score(o.agent.id, op.id, priceAfter);
          } catch { /* records are best-effort */ }
        }
      }

      // Walk the trade the decision would have made.
      const entryBar = path.find((k) => k.openTime >= t + 60_000);
      if ((d.action === 'LONG' || d.action === 'SHORT') && d.stopLoss && entryBar) {
        const side = d.action;
        const entry = side === 'LONG' ? entryBar.open * (1 + slip) : entryBar.open * (1 - slip);
        const valid = side === 'LONG' ? d.stopLoss < entry : d.stopLoss > entry;
        if (valid) {
          const v = sizeOrder({
            side, entryType: 'MARKET', entryPrice: entry, stopLoss: d.stopLoss, takeProfit: d.takeProfit ?? 0,
            leverage: d.leverage ?? cfg.agents.defaultLeverage, riskPct: d.riskPct ?? cfg.risk.riskPerTradePct
          }, {
            symbol, price: entry, equity, available: equity, filters: FALLBACK_FILTERS[symbol],
            risk: { ...cfg.risk, maxLeverage: Math.min(cfg.risk.maxLeverage, cfg.agents.maxLeverage) },
            minRewardRisk: 0, defaultLeverage: cfg.agents.defaultLeverage, brackets: FALLBACK_BRACKETS[symbol]
          });
          const w = walkTrade(side, v.plan?.stopLoss ?? d.stopLoss, v.plan?.takeProfit ?? d.takeProfit, path.filter((k) => k.openTime >= entryBar.openTime), t + req.horizonHours * HOUR);
          if (w) {
            const dir = side === 'LONG' ? 1 : -1;
            const exit = side === 'LONG' ? w.exitPrice * (1 - slip) : w.exitPrice * (1 + slip);
            const stopDist = Math.abs(entry - (v.plan?.stopLoss ?? d.stopLoss));
            const r = stopDist > 0 ? (dir * (exit - entry) - (entry + exit) * fee) / (stopDist + (entry + (v.plan?.stopLoss ?? d.stopLoss)) * fee) : null;
            ep.outcome = { exitTime: w.exitTime, exitPrice: exit, reason: w.reason, movePct: (dir * (exit - entry) / entry) * 100, r };
            if (v.plan) {
              const q = v.plan.quantity;
              const fees = (entry + exit) * q * fee;
              const pnl = dir * (exit - entry) * q - fees;
              equity += pnl;
              trades.push({
                side, entryTime: entryBar.openTime, exitTime: w.exitTime, entryPrice: entry, exitPrice: exit,
                stopLoss: v.plan.stopLoss, takeProfit: v.plan.takeProfit, quantity: q, leverage: v.plan.leverage,
                liquidationPrice: v.plan.liquidationPrice ?? 0, margin: v.plan.margin ?? (entry * q) / v.plan.leverage,
                pnl, pnlR: v.plan.riskUsdt > 0 ? pnl / v.plan.riskUsdt : 0, roe: v.plan.margin ? (pnl / v.plan.margin) * 100 : 0,
                fees, exitReason: w.reason,
                features: { trendAligned: 'flat', score: Math.round(d.confidence * 100), atrPct: 0, flow: 'none', hourUtc: new Date(t).getUTCHours() }
              });
            }
            if (req.learn) {
              const when = new Date(t + 9 * HOUR).toISOString().slice(5, 16).replace('T', ' ');
              const line = `[과거 리플레이] ${when} KST ${symbol} ${d.rating}/${side === 'LONG' ? '롱' : '숏'} 진입 ${fmtPrice(entry)} 손절 ${fmtPrice(d.stopLoss)} 목표 ${fmtPrice(d.takeProfit)} → ${w.reason} ${fmtPrice(exit)} (${ep.outcome.movePct >= 0 ? '+' : ''}${ep.outcome.movePct.toFixed(2)}%${r !== null ? `, ${r >= 0 ? '+' : ''}${r.toFixed(2)}R` : ''})`;
              try { deps.addDeskLesson(symbol, line); } catch { /* best-effort */ }
              if (deps.projects) {
                const won = ep.outcome.movePct > 0;
                for (const o of outputs) {
                  const vd = voteDirection(o.vote);
                  if (vd === 0) continue;
                  const aligned = vd === dir;
                  try { deps.projects.addLesson(o.agent, `${line} — 너의 판단 ${voteKo(o.vote)}: 거래 방향과 ${aligned ? '같음' : '반대'}, ${aligned === won ? '판단이 맞았음' : '판단이 틀렸음'}`); } catch { /* best-effort */ }
                }
              }
            }
          } else {
            ep.error = '이후 캔들이 부족해 거래를 끝까지 따라가지 못했습니다';
          }
        } else {
          ep.error = `손절가 ${fmtPrice(d.stopLoss)}가 진입가 ${fmtPrice(entry)}의 잘못된 쪽이라 거래하지 않음`;
        }
      }
      if (deps.writeReport) {
        try {
          ep.reportPath = deps.writeReport(symbol, `replay-${t.toString(36)}`, t, renderReport({
            symbol, takenAt: snapshot.takenAt, llmLabel: deps.llm.label, venueLabel: `과거 리플레이 (실제 시점 ${new Date(t).toISOString().slice(0, 16)} UTC${req.maskHistory ? `, 가격 배율 ${mask.scale}` : ''})`,
            snapshotVerified: snapshot.verified, result,
            verdictText: ep.outcome ? `${ep.outcome.reason} ${ep.outcome.movePct.toFixed(2)}%` : '거래 없음', notes: snapshot.notes
          }));
        } catch { /* best-effort */ }
      }
    } catch (e) {
      if (e instanceof PipelineAborted || deps.aborted()) { notes.push('사용자가 중간에 멈췄습니다'); break; }
      ep.error = e instanceof Error ? e.message : String(e);
    }
    episodes.push(ep);
    deps.onProgress((i + 1) / times.length, `${i + 1}/${times.length} 완료`);
  }
  return { episodes, trades, notes };
}
