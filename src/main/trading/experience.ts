/**
 * The scalper's experience ("경험"): what past replays say about a setup.
 *
 * Every replayed trade (stop, target, time stop, liquidation — the full trade)
 * lands in a bucket keyed by the conditions it was taken in:
 *
 *   side · trend (with / flat / against) · score band · volatility band · tape (with / against / neutral / none)
 *
 * Before a live entry the scalper looks up its bucket. With enough samples and
 * a negative average R, the entry is skipped and the reason shown. When the
 * exact bucket is thin, a coarser one (side · volatility band) decides, with
 * twice the sample requirement.
 *
 * Runs are stored per symbol; a new replay replaces any earlier run whose
 * period it fully covers, so re-testing the same days does not double count.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BacktestTrade, TradeFeatures } from './replay';
import type { ExperienceBucketView, ExperienceView, Side, TradingSymbol } from '../../shared/trading';

export interface Bucket { n: number; wins: number; sumR: number }

interface ExperienceRun {
  id: string;
  from: number;
  to: number;
  createdAt: number;
  engine: string;
  trades: number;
  buckets: Record<string, Bucket>;
}

interface ExperienceFile { version: 1; symbol: TradingSymbol; runs: ExperienceRun[] }

const MAX_RUNS = 60;

export function scoreBand(score: number): string {
  return score >= 85 ? '85+' : score >= 75 ? '75-84' : '<75';
}

export function atrBand(atrPct: number): string {
  return atrPct < 0.06 ? 'xs' : atrPct < 0.12 ? 's' : atrPct < 0.25 ? 'm' : 'l';
}

export function bucketKey(side: Side, f: TradeFeatures): string {
  return [side, f.trendAligned, scoreBand(f.score), atrBand(f.atrPct), f.flow].join('|');
}

export function coarseKey(side: Side, f: TradeFeatures): string {
  return [side, '*', '*', atrBand(f.atrPct), '*'].join('|');
}

export function bucketize(trades: readonly BacktestTrade[]): Record<string, Bucket> {
  const out: Record<string, Bucket> = {};
  const add = (key: string, t: BacktestTrade) => {
    const b = (out[key] ??= { n: 0, wins: 0, sumR: 0 });
    b.n++;
    if (t.pnl > 0) b.wins++;
    b.sumR += t.pnlR;
  };
  for (const t of trades) {
    add(bucketKey(t.side, t.features), t);
    add(coarseKey(t.side, t.features), t);
  }
  return out;
}

export interface ExperienceVerdict {
  block: boolean;
  key: string;
  n: number;
  winRate: number | null;
  avgR: number | null;
  /** Korean, for the UI and the log. */
  note: string;
}

const SIDE_KO: Record<Side, string> = { LONG: '롱', SHORT: '숏' };
const TREND_KO: Record<TradeFeatures['trendAligned'], string> = { with: '추세 순방향', flat: '추세 횡보', against: '추세 역방향' };
const ATR_KO: Record<string, string> = { xs: '변동성 아주 낮음', s: '변동성 낮음', m: '변동성 보통', l: '변동성 높음' };
const FLOW_KO: Record<TradeFeatures['flow'], string> = { with: '체결 흐름 동조', against: '체결 흐름 역행', neutral: '체결 흐름 중립', none: '체결 자료 없음' };

export function describeKey(key: string): string {
  const [side, trend, score, atr, flow] = key.split('|');
  const parts = [SIDE_KO[side as Side] ?? side];
  if (trend !== '*') parts.push(TREND_KO[trend as TradeFeatures['trendAligned']] ?? trend);
  if (score !== '*') parts.push(`점수 ${score}`);
  parts.push(ATR_KO[atr] ?? atr);
  if (flow !== '*') parts.push(FLOW_KO[flow as TradeFeatures['flow']] ?? flow);
  return parts.join(' · ');
}

export class ExperienceStore {
  private cache = new Map<TradingSymbol, { at: number; merged: Record<string, Bucket>; file: ExperienceFile }>();

  constructor(private readonly root: string, private readonly now: () => number = Date.now) {}

  private file(symbol: TradingSymbol): string {
    return path.join(this.root, `scalp-${symbol}.json`);
  }

  load(symbol: TradingSymbol): ExperienceFile {
    try {
      const f = this.file(symbol);
      if (existsSync(f)) {
        const j = JSON.parse(readFileSync(f, 'utf8')) as ExperienceFile;
        if (j && Array.isArray(j.runs)) return j;
      }
    } catch { /* start over */ }
    return { version: 1, symbol, runs: [] };
  }

  private save(f: ExperienceFile): void {
    mkdirSync(this.root, { recursive: true });
    const tmp = `${this.file(f.symbol)}.tmp`;
    writeFileSync(tmp, JSON.stringify(f), 'utf8');
    renameSync(tmp, this.file(f.symbol));
    this.cache.delete(f.symbol);
  }

  /** Add a replay's trades; earlier runs inside the same period are replaced. */
  addRun(symbol: TradingSymbol, run: { id: string; from: number; to: number; engine: string; trades: readonly BacktestTrade[] }): void {
    const f = this.load(symbol);
    f.runs = f.runs.filter((r) => !(r.from >= run.from && r.to <= run.to));
    f.runs.push({ id: run.id, from: run.from, to: run.to, createdAt: this.now(), engine: run.engine, trades: run.trades.length, buckets: bucketize(run.trades) });
    if (f.runs.length > MAX_RUNS) f.runs = f.runs.slice(-MAX_RUNS);
    this.save(f);
  }

  removeRun(symbol: TradingSymbol, id: string): void {
    const f = this.load(symbol);
    f.runs = f.runs.filter((r) => r.id !== id);
    this.save(f);
  }

  clear(symbol: TradingSymbol): void {
    this.save({ version: 1, symbol, runs: [] });
  }

  merged(symbol: TradingSymbol): Record<string, Bucket> {
    const hit = this.cache.get(symbol);
    if (hit && this.now() - hit.at < 60_000) return hit.merged;
    const file = this.load(symbol);
    const merged: Record<string, Bucket> = {};
    for (const r of file.runs) {
      for (const [k, b] of Object.entries(r.buckets)) {
        const m = (merged[k] ??= { n: 0, wins: 0, sumR: 0 });
        m.n += b.n;
        m.wins += b.wins;
        m.sumR += b.sumR;
      }
    }
    this.cache.set(symbol, { at: this.now(), merged, file });
    return merged;
  }

  verdict(symbol: TradingSymbol, side: Side, f: TradeFeatures, minSamples: number): ExperienceVerdict {
    const m = this.merged(symbol);
    const exact = bucketKey(side, f);
    const coarse = coarseKey(side, f);
    const pick = (m[exact]?.n ?? 0) >= minSamples ? exact : (m[coarse]?.n ?? 0) >= minSamples * 2 ? coarse : null;
    if (!pick) {
      const n = m[exact]?.n ?? 0;
      return { block: false, key: exact, n, winRate: null, avgR: null, note: `백테스트 경험 부족 (${describeKey(exact)}: ${n}건)` };
    }
    const b = m[pick];
    const avgR = b.sumR / b.n;
    const winRate = b.wins / b.n;
    const block = avgR < 0;
    return {
      block, key: pick, n: b.n, winRate, avgR,
      note: `백테스트 경험 — ${describeKey(pick)}: ${b.n}건, 승률 ${(winRate * 100).toFixed(0)}%, 평균 ${avgR >= 0 ? '+' : ''}${avgR.toFixed(2)}R${block ? ' → 진입 안 함' : ''}`
    };
  }

  view(symbol: TradingSymbol): ExperienceView {
    const file = this.load(symbol);
    const merged = this.merged(symbol);
    // Exact setups and the coarse (side · volatility) ones — both can veto.
    const buckets: ExperienceBucketView[] = Object.entries(merged)
      .map(([key, b]) => ({ key, label: describeKey(key), n: b.n, winRate: b.wins / b.n, avgR: b.sumR / b.n }))
      .sort((a, b) => b.n - a.n);
    return {
      symbol,
      runs: file.runs.map((r) => ({ id: r.id, from: r.from, to: r.to, createdAt: r.createdAt, engine: r.engine, trades: r.trades })),
      trades: file.runs.reduce((a, r) => a + r.trades, 0),
      buckets
    };
  }
}
