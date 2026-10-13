/**
 * Backtest jobs ("백테스트"): one at a time, in the background, with progress.
 *
 *   scalping · builtin   — replay.ts runs the live scalper over the period
 *   scalping · nautilus  — replay.ts exports the scalper's signals, then
 *                          NautilusTrader executes them on the tape (nautilus.ts)
 *   agents               — agentReplay.ts runs the whole agent team at past moments
 *
 * Results are saved under <userData>/trading/backtests/<id>.json. With
 * `learn`, scalping trades become the scalper's experience (experience.ts) and
 * agent replays go into every agent's record and lessons.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runScalpReplay, computeStats, type ReplayResult } from './replay';
import { TF_MINUTES, type HistoryStore } from './histData';
import { FALLBACK_FILTERS } from './broker';
import { FALLBACK_BRACKETS, bracketFor } from './leverage';
import type { ExperienceStore } from './experience';
import type { NautilusEnv } from './nautilus';
import {
  normalizeBacktestRequest,
  type AgentEpisodeView, type BacktestJobView, type BacktestRequest, type BacktestResultView, type BacktestTrade,
  type TradingConfig
} from '../../shared/trading';

const DAY = 86_400_000;

export interface BacktestDeps {
  dataDir: string;
  history: HistoryStore;
  experience: ExperienceStore;
  nautilus: NautilusEnv | null;
  getConfig: () => TradingConfig;
  /** Agents-mode replay, supplied by the engine (it owns the LLM and the agent folders). */
  agentReplay?: (req: BacktestRequest, ctl: { onProgress: (pct: number, phase: string) => void; aborted: () => boolean }) =>
    Promise<{ episodes: AgentEpisodeView[]; trades: BacktestTrade[]; notes: string[] }>;
  emit: (jobs: BacktestJobView[]) => void;
  now?: () => number;
}

export function rangeOf(req: BacktestRequest, now: number): { from: number; to: number } {
  const from = Date.parse(`${req.fromDay}T00:00:00Z`);
  const to = Math.min(Date.parse(`${req.toDay}T00:00:00Z`) + DAY, now - 60_000);
  if (!(to > from)) throw new Error('기간에 지난 데이터가 없습니다 (오늘 이전 날짜를 고르세요)');
  return { from, to };
}

export class BacktestRunner {
  private jobs: BacktestJobView[] = [];
  private queue: Array<{ job: BacktestJobView; req: BacktestRequest }> = [];
  private busy = false;
  private cancelled = new Set<string>();

  constructor(private readonly deps: BacktestDeps) {}

  private now(): number { return (this.deps.now ?? Date.now)(); }
  private dir(): string {
    const d = path.join(this.deps.dataDir, 'backtests');
    mkdirSync(d, { recursive: true });
    return d;
  }

  list(): BacktestJobView[] { return this.jobs.map((j) => ({ ...j })); }

  private update(job: BacktestJobView, patch: Partial<BacktestJobView>): void {
    Object.assign(job, patch);
    try { this.deps.emit(this.list()); } catch { /* window gone */ }
  }

  start(input: unknown): BacktestJobView {
    const req = normalizeBacktestRequest(input, this.deps.getConfig());
    if (req.mode === 'agents' && !this.deps.agentReplay) throw new Error('에이전트 리플레이를 실행할 수 없습니다');
    const job: BacktestJobView = {
      id: `${this.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`,
      request: req, state: 'queued', phase: '대기 중', pct: 0, startedAt: this.now()
    };
    this.jobs.unshift(job);
    if (this.jobs.length > 20) this.jobs.length = 20;
    this.queue.push({ job, req });
    this.update(job, {});
    void this.drain();
    return { ...job };
  }

  cancel(id: string): void {
    this.cancelled.add(id);
    const q = this.queue.findIndex((x) => x.job.id === id);
    if (q >= 0) {
      const [{ job }] = this.queue.splice(q, 1);
      this.update(job, { state: 'cancelled', phase: '취소됨', finishedAt: this.now() });
    }
  }

  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const { job, req } = this.queue.shift()!;
        try {
          const result = await this.run(job, req);
          this.save(result);
          this.update(job, {
            state: this.cancelled.has(job.id) ? 'cancelled' : 'done',
            phase: this.cancelled.has(job.id) ? '중간에 멈춤 (여기까지 저장)' : '완료',
            pct: 1, finishedAt: this.now(),
            summary: { trades: result.stats.trades, winRate: result.stats.winRate, returnPct: result.stats.returnPct, avgR: result.stats.avgR }
          });
        } catch (e) {
          if (this.cancelled.has(job.id)) this.update(job, { state: 'cancelled', phase: '취소됨', finishedAt: this.now() });
          else this.update(job, { state: 'error', phase: '실패', error: e instanceof Error ? e.message : String(e), finishedAt: this.now() });
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private async run(job: BacktestJobView, req: BacktestRequest): Promise<BacktestResultView> {
    const aborted = () => this.cancelled.has(job.id);
    const progress = (pct: number, phase: string) => this.update(job, { pct: Math.max(0, Math.min(1, pct)), phase });
    const cfg = this.deps.getConfig();
    const { from, to } = rangeOf(req, this.now());

    if (req.mode === 'agents') {
      this.update(job, { state: 'running', phase: '에이전트 리플레이 준비' });
      const r = await this.deps.agentReplay!(req, { onProgress: progress, aborted });
      const equity: Array<[number, number]> = [[from, req.startEquity]];
      let e = req.startEquity;
      for (const t of r.trades) { e += t.pnl; equity.push([t.exitTime, e]); }
      return {
        id: job.id, createdAt: this.now(), request: req, engine: 'builtin', dataLevel: 'agents',
        stats: computeStats(r.trades, req.startEquity, equity), trades: r.trades, equity, episodes: r.episodes,
        notes: r.notes, learned: req.learn
      };
    }

    // ── scalping: data ───────────────────────────────────────────────────
    const scalping = { ...cfg.scalping, leverage: req.leverage };
    const risk = { ...cfg.risk, maxLeverage: Math.max(cfg.risk.maxLeverage, req.leverage) };
    const warmMin = Math.max(TF_MINUTES[scalping.trendTimeframe] ?? 5, TF_MINUTES[scalping.timeframe] ?? 1) * 170;
    this.update(job, { state: 'loading', phase: '1분봉 내려받는 중' });
    const load = (label: string, base: number, span: number) => (_kind: string, done: number, total: number) =>
      progress(base + (total ? (done / total) * span : 0), `${label} 내려받는 중 (${done}/${total}일)`);
    const { k: k1m, fromRest } = await this.deps.history.klines1m(req.symbol, from - warmMin * 60_000, to, load('1분봉', 0, 0.1));
    if (aborted()) throw new Error('취소됨');
    let seconds;
    let depth;
    const notes: string[] = [];
    if (fromRest.length) notes.push(`바이낸스 아카이브에 아직 없는 ${fromRest.join(', ')} 1분봉은 REST로 받았습니다`);
    if (req.useTape || req.engine === 'nautilus') {
      const s = await this.deps.history.seconds(req.symbol, from, to, scalping.bigTradeUsdt, load('체결(aggTrades)', 0.1, 0.25));
      seconds = s.s;
      if (s.missing.length) notes.push(`체결 자료가 없는 날(${s.missing.join(', ')})은 1분봉으로 리플레이했습니다`);
      if (aborted()) throw new Error('취소됨');
      const d = await this.deps.history.depth(req.symbol, from, to, load('호가 깊이', 0.35, 0.05));
      depth = d.d;
      if (d.missing.length) notes.push(`호가 깊이 자료가 없는 날: ${d.missing.join(', ')}`);
    }

    // ── scalping: the desk's replay ──────────────────────────────────────
    this.update(job, { state: 'running', phase: '스캘퍼 리플레이 중' });
    const replay = await runScalpReplay({
      symbol: req.symbol, from, to, scalping, risk, startEquity: req.startEquity, evalEverySec: req.evalEverySec,
      collectSignals: req.engine === 'nautilus'
    }, { k1m, seconds, depth }, {
      progress: (pct, n) => {
        progress(0.4 + pct * (req.engine === 'nautilus' ? 0.15 : 0.6), `리플레이 ${Math.round(pct * 100)}% · 거래 ${n}건`);
        return aborted();
      }
    });
    notes.push(...replay.notes);

    let trades = replay.trades;
    let equity = replay.equity;
    let stats = replay.stats;
    let engine: BacktestResultView['engine'] = 'builtin';
    if (req.engine === 'nautilus' && !aborted()) {
      const out = await this.runNautilus(job, req, replay, from, to, scalping, risk, progress);
      trades = out.trades;
      equity = [[from, req.startEquity]];
      let e = req.startEquity;
      for (const t of trades) { e += t.pnl; equity.push([t.exitTime, e]); }
      stats = computeStats(trades, req.startEquity, equity);
      notes.push(...out.notes, `같은 신호의 앱 내장 리플레이: 거래 ${replay.stats.trades}건, 수익률 ${replay.stats.returnPct.toFixed(2)}%, 평균 ${(replay.stats.avgR ?? 0).toFixed(2)}R`);
      engine = 'nautilus';
    }

    const learned = req.learn && !aborted() && trades.length > 0;
    if (learned) {
      try {
        this.deps.experience.addRun(req.symbol, { id: job.id, from, to, engine, trades });
        notes.push(`이 결과의 거래 ${trades.length}건을 스캘퍼 경험에 반영했습니다`);
      } catch (e) {
        notes.push(`경험 저장 실패: ${e instanceof Error ? e.message : e}`);
      }
    }
    return { id: job.id, createdAt: this.now(), request: req, engine, dataLevel: replay.dataLevel, stats, trades, equity, notes, learned };
  }

  private async runNautilus(
    job: BacktestJobView, req: BacktestRequest, replay: ReplayResult, from: number, to: number,
    scalping: TradingConfig['scalping'], risk: TradingConfig['risk'], progress: (pct: number, phase: string) => void
  ): Promise<{ trades: BacktestTrade[]; notes: string[] }> {
    const env = this.deps.nautilus;
    if (!env) throw new Error('노틸러스 엔진을 사용할 수 없습니다');
    const st = await env.status();
    if (st.state !== 'ready') throw new Error(st.state === 'missing-python'
      ? 'Python 3.12 이상이 필요합니다 — 설치한 뒤 백테스트 화면에서 "노틸러스 설치"를 누르세요'
      : '노틸러스가 아직 설치되지 않았습니다 — 백테스트 화면에서 "노틸러스 설치"를 누르세요');
    const days: string[] = [];
    for (let d = from - (from % DAY); d < to; d += DAY) days.push(new Date(d).toISOString().slice(0, 10));
    const tapeFiles = days.map((day) => this.deps.history.zipPath('aggTrades', req.symbol, day)).filter((f) => existsSync(f));
    if (!tapeFiles.length) throw new Error('노틸러스는 체결 자료(aggTrades)가 필요합니다 — 이 기간의 아카이브 파일이 없습니다');
    const jobDir = path.join(this.dir(), 'tmp', job.id);
    mkdirSync(jobDir, { recursive: true });
    const signalsPath = path.join(jobDir, 'signals.json');
    writeFileSync(signalsPath, JSON.stringify(replay.signals ?? []), 'utf8');
    const f = FALLBACK_FILTERS[req.symbol];
    const tier = bracketFor(FALLBACK_BRACKETS[req.symbol], req.startEquity * (risk.maxNotionalPct / 100));
    const params = {
      leverage: Math.min(req.leverage, tier.initialLeverage), takerFeePct: risk.takerFeePct, makerFeePct: 0.02,
      slippageBps: risk.slippageBps, startEquity: req.startEquity, riskPerTradePct: risk.riskPerTradePct,
      maxNotionalPct: risk.maxNotionalPct, maxHoldMinutes: scalping.maxHoldMinutes, cooldownMinutes: scalping.cooldownMinutes,
      maxTradesPerHour: scalping.maxTradesPerHour, breakevenAtR: scalping.breakevenAtR, minScore: scalping.minScore,
      dailyLossLimitPct: risk.dailyLossLimitPct, maxConsecutiveLosses: risk.maxConsecutiveLosses, evalEverySec: req.evalEverySec,
      mmr: tier.maintMarginRatio, cum: tier.cum, tickSize: f.tickSize, stepSize: f.marketStepSize, minQty: f.marketMinQty,
      minNotional: f.minNotional, latencyMs: 50
    };
    this.update(job, { phase: '노틸러스 엔진 실행 중' });
    try {
      const out = await env.runJob(jobDir, { symbol: req.symbol, from, to, tapeFiles, signalsPath, params }, (pct, msg) => progress(0.55 + pct * 0.45, msg));
      const trades = (Array.isArray(out.trades) ? out.trades : []) as BacktestTrade[];
      const notes = Array.isArray(out.notes) ? (out.notes as string[]) : [];
      if (typeof out.nautilusVersion === 'string') notes.unshift(`NautilusTrader ${out.nautilusVersion} · 체결 ${Number(out.ticks ?? 0).toLocaleString('en-US')}건`);
      return { trades, notes };
    } finally {
      try { rmSync(jobDir, { recursive: true, force: true }); } catch { /* temp */ }
    }
  }

  // ─── saved results ─────────────────────────────────────────────────────

  private save(r: BacktestResultView): void {
    writeFileSync(path.join(this.dir(), `${r.id}.json`), JSON.stringify(r), 'utf8');
  }

  /** Saved results, newest first, without trade lists. */
  results(): Array<Omit<BacktestResultView, 'trades' | 'equity' | 'episodes'> & { tradeCount: number }> {
    const out: Array<Omit<BacktestResultView, 'trades' | 'equity' | 'episodes'> & { tradeCount: number }> = [];
    let files: string[] = [];
    try { files = readdirSync(this.dir()).filter((f) => f.endsWith('.json')); } catch { return out; }
    for (const f of files) {
      try {
        const r = JSON.parse(readFileSync(path.join(this.dir(), f), 'utf8')) as BacktestResultView;
        const { trades, equity: _e, episodes: _ep, ...rest } = r;
        out.push({ ...rest, tradeCount: trades.length });
      } catch { /* skip a broken file */ }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
  }

  result(id: string): BacktestResultView | null {
    if (!/^[a-z0-9]+$/.test(id)) return null;
    try { return JSON.parse(readFileSync(path.join(this.dir(), `${id}.json`), 'utf8')) as BacktestResultView; } catch { return null; }
  }

  remove(id: string): void {
    if (!/^[a-z0-9]+$/.test(id)) return;
    const r = this.result(id);
    try { unlinkSync(path.join(this.dir(), `${id}.json`)); } catch { /* gone */ }
    if (r?.learned && r.request.mode === 'scalping') {
      try { this.deps.experience.removeRun(r.request.symbol, id); } catch { /* best-effort */ }
    }
  }
}
