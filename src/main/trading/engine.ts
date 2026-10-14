/**
 * TradingEngine — runs the desk.
 *
 * One loop ("tick") drives everything:
 *   1. prices → broker.sync()   (paper stops/targets fill here; live closures are detected)
 *   2. account + day counters    (daily-loss / losing-streak halt)
 *   3. pending LIMIT entries     (agents mode)
 *   4. the mode:
 *        agents   — when a symbol is due, queue a TradingAgents pipeline run
 *                   (runs are sequential, in the background, never blocking the tick)
 *        scalping — evaluate the 1m signal, manage the open scalp, maybe enter;
 *                   refresh the agent bias desk in the background
 *   5. snapshot → renderer (throttled)
 *
 * The engine is constructed with injected I/O (fetch, LLM, clock, data dir),
 * so it runs in tests without Electron.
 */
import path from 'node:path';
import { BinanceFuturesClient, BINANCE_REST, liveKeyPermissions, type FetchLike } from './binance';
import { BinanceBroker, PaperBroker, type Broker, type PriceTick } from './broker';
import { MarketData, formatTechnicalBlock, summarizeTimeframe } from './marketData';
import { runPipeline, renderReport, PipelineAborted, type AgentHooks } from './agents';
import { AgentProjects, OPINION_HORIZON_MS, opinionSummary, voteKo } from './agentProjects';
import { biasDeskPrompt, reflectionPrompt, type DeskConstraints } from './prompts';
import { parseBias } from './decision';
import { aggregateBias, biasPanelClosing, committeeMinutes, memberRule, personaKey, withMember } from './teams';
import { planFromDecision, sizeOrder, type RiskContext } from './risk';
import { evaluateScalp, manageScalp, biasKo, scalpPlan } from './scalper';
import { Journal, type DayState } from './journal';
import { fmtPrice } from './indicators';
import { limitConcurrency, type LlmCall, type LlmClient } from './llm';
import { FlowTracker, LiveFlowFeed, parseRestAggTrades } from './orderFlow';
import { ExperienceStore } from './experience';
import { HistoryStore, type BinaryFetch } from './histData';
import { featuresAt } from './replay';
import { restReplayMarket, runAgentReplay } from './agentReplay';
import type { ScalpInputs } from './marketData';
import type { WsFactory } from './wsClient';
import {
  agentRef, assessLiveKey, biasSkeleton, dayKeyOf, emptySnapshot, normalizeTradingConfig, pipelineSkeleton, stepId, stepKey,
  teamAgents, voteDirection,
  type AgentProjectView, type AgentRef, type AgentRunView, type AgentStepView, type BiasDirection, type ExecutionVenue, type FinalDecision, type OrderPlan,
  type PositionView, type RiskVerdict, type TradeView, type TradingConfig, type TradingSecretKey,
  type TradingSnapshot, type TradingSymbol, type LogLine
} from '../../shared/trading';

export interface EngineDeps {
  fetch: FetchLike;
  dataDir: string;
  getSecret: (key: TradingSecretKey) => string | undefined;
  createLlm: (cfg: TradingConfig, sessionRoot: string) => LlmClient;
  emit: (snapshot: TradingSnapshot) => void;
  /** Desktop notification (entries, exits, halts, errors). Gated by automation.notify. */
  notify?: (title: string, body: string) => void;
  /** WebSocket opener for the live order-flow streams; without it scalping reads flow from REST. */
  wsFactory?: WsFactory;
  /** Binary downloads (Binance's data archive) for replays; defaults to the global fetch. */
  fetchBinary?: BinaryFetch;
  now?: () => number;
}

export const VENUE_KO: Record<ExecutionVenue, string> = { paper: '모의투자', demo: '바이낸스 데모', live: '실거래' };

const MAX_LOGS = 300;
const MAX_RUNS = 12;
const MAX_TRADES = 100;
const FULL_TEXT_RUNS = 3;
const EMIT_THROTTLE_MS = 400;

/** An agent that made a directional call in the run that opened a position. */
interface Voter {
  agent: AgentRef;
  vote: string;
  confidence: number | null;
}

interface PendingEntry {
  symbol: TradingSymbol;
  decision: FinalDecision;
  limitPrice: number;
  expiresAt: number;
  runId: string;
  voters: Voter[];
}

export class TradingEngine {
  private cfg: TradingConfig;
  private readonly snap: TradingSnapshot;
  private readonly journal: Journal;
  private readonly market: MarketData;
  private broker: Broker | null = null;
  private llm: LlmClient | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private ticking = false;
  private stopping = false;
  private day: DayState | null = null;
  private pending: PendingEntry[] = [];
  private runQueue: TradingSymbol[] = [];
  private pipelineBusy = false;
  private biasBusy = new Set<TradingSymbol>();
  private lastExitAt: Partial<Record<TradingSymbol, number>> = {};
  private entryTimes: Partial<Record<TradingSymbol, number[]>> = {};
  /** Decision that opened an agents-mode position, for reflection when it closes. */
  private openDecision: Partial<Record<TradingSymbol, { runId: string; summary: string; voters: Voter[] }>> = {};
  private lastErrorNotice = 0;
  /** Live trade/book streams (scalping with order flow on). */
  private feed: LiveFlowFeed | null = null;
  /** REST-fed trackers when there is no live feed. */
  private restTrackers: Partial<Record<TradingSymbol, FlowTracker>> = {};
  /** What past replays taught the scalper (experience.ts). */
  readonly experience: ExperienceStore;
  /** Binance's data archive, cached (replays). */
  readonly history: HistoryStore;
  /** One project folder per agent: instructions, track record, outputs (agentProjects.ts). */
  readonly projects: AgentProjects;
  private scoring = false;
  private lastScoreAt = 0;
  private projectWarned = false;

  constructor(cfg: TradingConfig, private readonly deps: EngineDeps) {
    this.cfg = normalizeTradingConfig(cfg);
    this.snap = emptySnapshot(this.cfg);
    this.journal = new Journal(deps.dataDir);
    this.market = new MarketData(deps.fetch, { now: deps.now });
    this.snap.trades = this.journal.recentTrades(MAX_TRADES, this.cfg.venue).reverse();
    this.projects = new AgentProjects(path.join(deps.dataDir, 'agents'), () => this.now());
    this.experience = new ExperienceStore(path.join(deps.dataDir, 'experience'), () => this.now());
    // Archive downloads are a few to tens of MB; a stalled one must not hang a backtest forever.
    const fetchBinary = deps.fetchBinary ?? ((url: string) =>
      (globalThis as unknown as { fetch: (u: string, i?: { signal?: AbortSignal }) => ReturnType<BinaryFetch> }).fetch(url, { signal: AbortSignal.timeout(300_000) }));
    this.history = new HistoryStore(path.join(deps.dataDir, 'history'), fetchBinary, this.market.client, { now: deps.now });
    this.ensureTeam();
  }

  // ─── agent projects ────────────────────────────────────────────────────

  /** Give every agent of the current team its folder (and CLAUDE.md), so the user can see and edit them before a run. */
  private ensureTeam(): void {
    for (const a of teamAgents(this.cfg)) {
      try { this.projects.ensure(a); } catch (e) { this.projectError(e); }
    }
  }

  private projectError(e: unknown): void {
    if (this.projectWarned) return;
    this.projectWarned = true;
    this.log(`에이전트 폴더 기록 실패 (거래에는 영향 없음): ${e instanceof Error ? e.message : e}`, 'warn');
  }

  /** The roster: every agent folder with its track record. Also checks due calls in the background. */
  listAgents(): AgentProjectView[] {
    void this.scoreAgents(true);
    return this.projects.list(new Set(teamAgents(this.cfg).map((a) => a.id)));
  }

  /** Folder, CLAUDE.md text (for API providers) and track record for one call. */
  private agentCall(agent: AgentRef, symbol: TradingSymbol, call: LlmCall): LlmCall {
    try {
      const workdir = this.projects.ensure(agent);
      const memory = this.projects.memoryBlock(agent.id, symbol);
      const instructions = this.projects.instructionsForApi(agent.id);
      return {
        ...call,
        system: memory ? `${call.system}\n\n${memory}` : call.system,
        workdir, sessionKey: symbol,
        ...(instructions ? { instructions } : {})
      };
    } catch (e) {
      this.projectError(e);
      return call;
    }
  }

  /** Save what an agent wrote; record its call (if it made one) for scoring. */
  private agentOutput(agent: AgentRef, o: {
    symbol: TradingSymbol; runId: string; kind: 'pipeline' | 'bias'; price: number;
    text: string; vote: string | null; confidence: number | null; voters?: Voter[];
  }): void {
    try {
      const ts = this.now();
      this.projects.writeOutput(agent, o.symbol, ts, o.runId, o.text, o.vote);
      if (o.vote === null) return;
      this.projects.recordOpinion(agent, {
        ts, symbol: o.symbol, runId: o.runId, kind: o.kind, vote: o.vote, confidence: o.confidence,
        price: o.price, horizonMs: OPINION_HORIZON_MS[o.kind], summary: opinionSummary(o.text)
      });
      if (o.voters && voteDirection(o.vote) !== 0) o.voters.push({ agent, vote: o.vote, confidence: o.confidence });
    } catch (e) {
      this.projectError(e);
    }
  }

  private pipelineHooks(symbol: TradingSymbol, runId: string, price: number, voters: Voter[]): AgentHooks {
    return {
      context: (agent) => {
        const c = this.agentCall(agent, symbol, { role: agent.id, tier: 'quick', system: '', prompt: '' });
        return { workdir: c.workdir, instructions: c.instructions, memory: c.system.trim() || undefined };
      },
      onOutput: (agent, out) => this.agentOutput(agent, { symbol, runId, kind: 'pipeline', price, ...out, voters })
    };
  }

  /** A past price: the live one when it is that moment, else the 1-minute candle that opened then. */
  private async priceAt(symbol: TradingSymbol, ts: number): Promise<number | null> {
    const m = this.snap.markets[symbol];
    if (m && Math.abs(m.updatedAt - ts) < 90_000) return m.price;
    const k = await this.market.client.klinesFrom(symbol, '1m', ts, 1);
    return k[0] && k[0].openTime - ts < 5 * 60_000 ? k[0].open : null;
  }

  /** Check every call whose horizon has passed against the price then (at most once a minute). */
  async scoreAgents(force = false): Promise<number> {
    if (this.scoring || (!force && this.now() - this.lastScoreAt < 60_000)) return 0;
    this.scoring = true;
    this.lastScoreAt = this.now();
    let n = 0;
    try {
      const due = this.projects.due(this.now()).slice(0, 300);
      const prices = new Map<string, number | null>();
      for (const d of due) {
        const target = d.opinion.ts + d.opinion.horizonMs;
        const key = `${d.opinion.symbol}:${Math.floor(target / 60_000)}`;
        if (!prices.has(key)) prices.set(key, await this.priceAt(d.opinion.symbol, target).catch(() => null));
        const p = prices.get(key);
        if (p && this.projects.score(d.id, d.opinion.id, p)) n++;
      }
    } catch (e) {
      this.projectError(e);
    } finally {
      this.scoring = false;
    }
    if (n) this.emitSoon();
    return n;
  }

  /** A closed agents-mode trade goes into the lessons file of every agent that made a directional call on it. */
  private agentLessons(t: TradeView): void {
    const origin = this.openDecision[t.symbol];
    if (!origin?.voters.length) return;
    const side = t.side === 'LONG' ? 1 : -1;
    const won = t.pnl > 0;
    const day = new Date(t.closedAt + 9 * 3_600_000).toISOString().slice(5, 16).replace('T', ' ');
    for (const v of origin.voters) {
      const aligned = voteDirection(v.vote) === side;
      const right = aligned === won;
      const conf = v.confidence !== null ? ` ${v.confidence.toFixed(2)}` : '';
      try {
        this.projects.addLesson(v.agent, `${day} KST ${t.symbol} ${t.side === 'LONG' ? '롱' : '숏'} 거래 종료(${t.exitReason}) 손익 ${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)} USDT — 너의 판단 ${voteKo(v.vote)}${conf}: 거래 방향과 ${aligned ? '같음' : '반대'}, ${right ? '판단이 맞았음' : '판단이 틀렸음'}`);
      } catch (e) { this.projectError(e); }
    }
  }

  private now(): number { return (this.deps.now ?? Date.now)(); }

  get config(): TradingConfig { return this.cfg; }
  get running(): boolean { return this.timer !== null; }

  /**
   * A copy for the renderer. Agent reports can run to tens of KB each, so only
   * the newest runs carry their full text; older ones are trimmed (the saved
   * report file always has everything).
   */
  getSnapshot(): TradingSnapshot {
    const copy = JSON.parse(JSON.stringify(this.snap)) as TradingSnapshot;
    copy.runs.forEach((run, i) => {
      if (i < FULL_TEXT_RUNS) return;
      for (const s of run.steps) {
        if (s.content && s.content.length > 1200) s.content = `${s.content.slice(0, 1200)}\n\n… (전체 내용은 저장된 보고서 파일에 있습니다)`;
      }
    });
    return copy;
  }

  // ─── logging & emission ────────────────────────────────────────────────

  log(message: string, level: LogLine['level'] = 'info', symbol?: TradingSymbol): void {
    this.snap.logs.push({ ts: this.now(), level, symbol, message });
    if (this.snap.logs.length > MAX_LOGS) this.snap.logs.splice(0, this.snap.logs.length - MAX_LOGS);
    // Errors reach the desktop too (at most one a minute, so an outage is not a flood).
    if (level === 'error' && this.now() - this.lastErrorNotice > 60_000) {
      this.lastErrorNotice = this.now();
      this.notify('트레이딩 데스크 오류', message);
    }
    this.emitSoon();
  }

  private notify(title: string, body: string): void {
    if (!this.cfg.automation.notify) return;
    try { this.deps.notify?.(title, body.slice(0, 240)); } catch { /* notifications are best-effort */ }
  }

  /**
   * Live venue only: read the key's permissions from Binance and refuse to
   * trade with a key that can withdraw or cannot trade futures. If the check
   * itself cannot run, trading continues with a warning (the futures API will
   * refuse an unauthorised key on its own).
   */
  private async checkLiveKey(): Promise<void> {
    const key = this.deps.getSecret('binance.live.key');
    const secret = this.deps.getSecret('binance.live.secret');
    if (!key || !secret) return;
    let perms;
    try {
      perms = await liveKeyPermissions(key, secret, this.deps.fetch, this.deps.now);
    } catch (e) {
      this.log(`API 키 권한을 확인하지 못했습니다 (계속 진행): ${e instanceof Error ? e.message : e}`, 'warn');
      return;
    }
    const verdict = assessLiveKey(perms);
    for (const w of verdict.warnings) this.log(w, 'warn');
    if (!verdict.ok) throw new Error(verdict.problems.join(' / '));
    this.log('실거래 API 키 권한 확인: 선물 거래 가능, 출금 권한 없음');
  }

  private emitSoon(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      try { this.deps.emit(this.getSnapshot()); } catch { /* window gone */ }
    }, EMIT_THROTTLE_MS);
  }

  private setStatus(status: TradingSnapshot['status'], message?: string): void {
    this.snap.status = status;
    this.snap.statusMessage = message;
    this.emitSoon();
  }

  private safeJournal(entry: Record<string, unknown>): void {
    try { this.journal.append({ venue: this.cfg.venue, ...entry }); } catch (e) {
      this.log(`저널 기록 실패: ${e instanceof Error ? e.message : e}`, 'warn');
    }
  }

  // ─── config ────────────────────────────────────────────────────────────

  /** Apply a new config. Mode/venue/symbol changes need a restart while running. */
  updateConfig(next: TradingConfig): { restartRequired: boolean } {
    const n = normalizeTradingConfig(next);
    const structural = n.mode !== this.cfg.mode || n.venue !== this.cfg.venue ||
      n.symbols.join() !== this.cfg.symbols.join() || n.llm.provider !== this.cfg.llm.provider;
    const venueChanged = n.venue !== this.cfg.venue;
    this.cfg = n;
    this.llm = null; // rebuilt lazily with the new settings
    this.ensureTeam();
    if (!this.running) {
      if (venueChanged) {
        // The previous venue's broker, positions and account must not be acted on.
        this.broker = null;
        this.snap.positions = [];
        this.snap.account = null;
        this.pending = [];
      }
      this.snap.mode = n.mode;
      this.snap.venue = n.venue;
      this.snap.symbols = [...n.symbols];
      this.snap.trades = this.journal.recentTrades(MAX_TRADES, n.venue).reverse();
      this.emitSoon();
    }
    return { restartRequired: this.running && structural };
  }

  /** One client per config, shared by every run, so `teams.maxParallel` caps the whole desk. */
  private getLlm(): LlmClient {
    if (!this.llm) this.llm = limitConcurrency(this.deps.createLlm(this.cfg, this.journal.sessionRoot), this.cfg.teams.maxParallel);
    return this.llm;
  }

  // ─── lifecycle ─────────────────────────────────────────────────────────

  private makeBroker(): Broker {
    const c = this.cfg;
    if (c.venue === 'paper') {
      return new PaperBroker({
        startBalance: c.risk.paperBalanceUsdt,
        takerFeePct: c.risk.takerFeePct,
        slippageBps: c.risk.slippageBps,
        persist: this.journal.store('paper.json'),
        now: this.deps.now,
        loadFilters: (symbols) => this.market.client.exchangeFilters(symbols)
      });
    }
    if (c.venue === 'live' && !c.liveAcknowledged) throw new Error('실거래는 설정에서 위험 고지에 동의해야 켤 수 있습니다');
    const key = this.deps.getSecret(c.venue === 'live' ? 'binance.live.key' : 'binance.demo.key');
    const secret = this.deps.getSecret(c.venue === 'live' ? 'binance.live.secret' : 'binance.demo.secret');
    if (!key || !secret) throw new Error(`${VENUE_KO[c.venue]} API 키/시크릿이 설정되지 않았습니다`);
    const client = new BinanceFuturesClient({
      baseUrl: c.venue === 'live' ? BINANCE_REST.live : BINANCE_REST.demo,
      apiKey: key, apiSecret: secret, fetch: this.deps.fetch, now: this.deps.now
    });
    return new BinanceBroker(c.venue, client, {
      marginType: c.risk.marginType,
      defaultLeverage: c.agents.defaultLeverage,
      persist: this.journal.store(`meta-${c.venue}.json`),
      now: this.deps.now,
      log: (m, l) => this.log(m, l ?? 'info')
    });
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.stopping = false;
    this.snap.mode = this.cfg.mode;
    this.snap.venue = this.cfg.venue;
    this.snap.symbols = [...this.cfg.symbols];
    this.snap.trades = this.journal.recentTrades(MAX_TRADES, this.cfg.venue).reverse();
    this.setStatus('starting', `${VENUE_KO[this.cfg.venue]} 연결 중…`);
    try {
      const broker = this.makeBroker();
      if (this.cfg.venue === 'live') await this.checkLiveKey();
      await broker.init(this.cfg.symbols);
      this.broker = broker;
      this.llm = null;
      this.loadDay();
      this.snap.startedAt = this.now();
      this.snap.nextRunAt = {};
      this.runQueue = [];
      if (this.cfg.mode === 'agents') for (const s of this.cfg.symbols) this.snap.nextRunAt[s] = this.now();
      if (this.cfg.mode === 'scalping' && this.cfg.scalping.orderFlow && this.deps.wsFactory) {
        this.feed = new LiveFlowFeed(this.cfg.symbols, {
          bigTradeUsdt: this.cfg.scalping.bigTradeUsdt,
          factory: this.deps.wsFactory,
          now: this.deps.now,
          log: (m, l) => this.log(m, l ?? 'info')
        });
        this.feed.start();
      }
      const tickMs = this.cfg.mode === 'scalping' ? this.cfg.scalping.pollSeconds * 1000 : 10_000;
      this.timer = setInterval(() => { void this.tick(); }, tickMs);
      this.setStatus('running');
      this.log(`트레이딩 데스크 시작 — ${this.cfg.mode === 'agents' ? '에이전트 알고리즘 모드' : '스캘핑 모드'}, ${VENUE_KO[this.cfg.venue]}, ${this.cfg.symbols.join(', ')}`);
      if (this.cfg.venue === 'live') this.log('⚠ 실거래 모드입니다. 실제 자금으로 주문이 나갑니다.', 'warn');
      void this.tick();
    } catch (e) {
      this.broker = null;
      const msg = e instanceof Error ? e.message : String(e);
      this.setStatus('error', msg);
      this.log(`시작 실패: ${msg}`, 'error');
      throw e;
    }
  }

  private stopFeed(): void {
    this.feed?.stop();
    this.feed = null;
    this.restTrackers = {};
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopFeed();
    this.stopping = true;
    this.runQueue = [];
    this.setStatus('stopped');
    this.log('트레이딩 데스크 정지 — 열린 포지션은 그대로 유지됩니다' + (this.cfg.venue === 'paper' ? ' (모의 포지션의 손절/익절은 재시작 시 다시 감시됩니다)' : ' (거래소에 걸린 손절/익절 주문은 유지)'));
  }

  // ─── day counters ──────────────────────────────────────────────────────

  private dayStore() { return this.journal.store(`day-${this.cfg.venue}.json`); }

  private loadDay(): void {
    const d = this.dayStore().load() as DayState | undefined;
    this.day = d && d.dayKey === dayKeyOf(this.now()) ? d : null;
  }

  private saveDay(): void {
    if (!this.day) return;
    try { this.dayStore().save(this.day); } catch { /* best-effort */ }
  }

  private haltedReason(): string | null {
    const d = this.day;
    const a = this.snap.account;
    if (!d || !a) return null;
    const lossPct = d.startEquity > 0 ? ((a.equity - d.startEquity) / d.startEquity) * 100 : 0;
    if (lossPct <= -this.cfg.risk.dailyLossLimitPct) return `일일 손실 한도 도달 (${lossPct.toFixed(2)}% / -${this.cfg.risk.dailyLossLimitPct}%)`;
    if (d.consecutiveLosses >= this.cfg.risk.maxConsecutiveLosses) return `연속 손실 ${d.consecutiveLosses}회`;
    return null;
  }

  private recordTrade(t: TradeView): void {
    const d = this.day;
    if (d) {
      d.realized += t.pnl;
      d.trades += 1;
      if (t.pnl > 0) { d.wins += 1; d.consecutiveLosses = 0; } else { d.losses += 1; d.consecutiveLosses += 1; }
      this.saveDay();
    }
    this.snap.trades.unshift(t);
    if (this.snap.trades.length > MAX_TRADES) this.snap.trades.length = MAX_TRADES;
    this.lastExitAt[t.symbol] = t.closedAt;
    this.safeJournal({ type: 'trade', trade: t });
    if (t.source === 'agents') this.agentLessons(t);
    const sign = t.pnl >= 0 ? '+' : '';
    this.log(`${t.symbol} ${t.side === 'LONG' ? '롱' : '숏'} 종료(${t.exitReason}) ${fmtPrice(t.entryPrice)} → ${fmtPrice(t.exitPrice)} · 손익 ${sign}${t.pnl.toFixed(2)} USDT`, 'trade', t.symbol);
    this.notify(`${t.symbol} ${t.exitReason} (${VENUE_KO[this.cfg.venue]})`,
      `${t.side === 'LONG' ? '롱' : '숏'} ${fmtPrice(t.entryPrice)} → ${fmtPrice(t.exitPrice)} · 손익 ${sign}${t.pnl.toFixed(2)} USDT`);
    if (t.source === 'agents' && this.cfg.agents.reflect) void this.reflect(t);
  }

  // ─── tick ──────────────────────────────────────────────────────────────

  private async prices(): Promise<Partial<Record<TradingSymbol, PriceTick>>> {
    const out: Partial<Record<TradingSymbol, PriceTick>> = {};
    await Promise.all(this.cfg.symbols.map(async (s) => {
      try {
        const [prem, k] = await Promise.all([this.market.premium(s, 2000), this.market.klines(s, '1m', 2)]);
        const last = k[k.length - 1]?.close ?? prem.markPrice;
        out[s] = {
          last,
          mark: prem.markPrice,
          high: Math.max(...k.map((c) => c.high), last),
          low: Math.min(...k.map((c) => c.low), last),
          fundingRate: prem.lastFundingRate,
          nextFundingTime: prem.nextFundingTime
        };
        let change: number | null = this.snap.markets[s]?.change24hPct ?? null;
        try { change = (await this.market.ticker(s)).priceChangePercent; } catch { /* keep */ }
        this.snap.markets[s] = {
          symbol: s, price: last, markPrice: prem.markPrice, fundingRate: prem.lastFundingRate,
          nextFundingTime: prem.nextFundingTime, change24hPct: change, updatedAt: this.now()
        };
      } catch (e) {
        this.log(`${s} 시세 조회 실패: ${e instanceof Error ? e.message : e}`, 'warn', s);
      }
    }));
    return out;
  }

  private async refreshAccount(): Promise<void> {
    const b = this.broker;
    if (!b) return;
    const [acct, positions] = await Promise.all([b.account(), b.positions()]);
    this.snap.positions = positions;
    const key = dayKeyOf(this.now());
    if (!this.day || this.day.dayKey !== key) {
      this.day = { dayKey: key, startEquity: acct.equity, realized: 0, trades: 0, wins: 0, losses: 0, consecutiveLosses: 0 };
      this.saveDay();
    }
    this.snap.account = {
      venue: this.cfg.venue,
      equity: acct.equity,
      walletBalance: acct.walletBalance,
      available: acct.available,
      unrealizedPnl: acct.unrealizedPnl,
      dayKey: this.day.dayKey,
      dayStartEquity: this.day.startEquity,
      realizedPnlToday: this.day.realized,
      tradesToday: this.day.trades,
      winsToday: this.day.wins,
      lossesToday: this.day.losses,
      consecutiveLosses: this.day.consecutiveLosses
    };
  }

  async tick(): Promise<void> {
    if (this.ticking || !this.broker || this.stopping) return;
    this.ticking = true;
    try {
      const prices = await this.prices();
      const closed = await this.broker.sync(prices);
      for (const t of closed) this.recordTrade(t);
      await this.refreshAccount();

      const halted = this.haltedReason();
      if (halted && this.snap.status === 'running') {
        this.setStatus('halted', halted);
        this.log(`신규 진입 중단: ${halted} (포지션 관리는 계속)`, 'warn');
        this.notify('신규 진입 중단', `${halted} — 오늘은 새 포지션을 열지 않습니다`);
      } else if (!halted && this.snap.status === 'halted') {
        this.setStatus('running');
      }

      await this.processPending(prices);

      if (this.cfg.mode === 'agents') {
        for (const s of this.cfg.symbols) {
          const due = this.snap.nextRunAt[s] ?? 0;
          if (this.now() >= due && !this.runQueue.includes(s)) {
            this.runQueue.push(s);
            this.snap.nextRunAt[s] = this.now() + this.cfg.agents.intervalMinutes * 60_000;
          }
        }
        void this.drainQueue();
      } else {
        for (const s of this.cfg.symbols) await this.scalpStep(s);
      }
      void this.scoreAgents();
    } catch (e) {
      this.log(`루프 오류: ${e instanceof Error ? e.message : e}`, 'error');
    } finally {
      this.ticking = false;
      this.emitSoon();
    }
  }

  /** `maxLeverage`: the mode's ceiling (agents: agents.maxLeverage; scalping: the global one). */
  private riskContext(symbol: TradingSymbol, price: number, minRewardRisk: number, defaultLeverage: number, maxLeverage = this.cfg.risk.maxLeverage): RiskContext {
    const a = this.snap.account;
    return {
      symbol,
      price,
      equity: a?.equity ?? this.cfg.risk.paperBalanceUsdt,
      available: a?.available ?? this.cfg.risk.paperBalanceUsdt,
      filters: this.broker?.filters(symbol) ?? null,
      risk: { ...this.cfg.risk, maxLeverage: Math.min(this.cfg.risk.maxLeverage, maxLeverage) },
      minRewardRisk,
      defaultLeverage,
      haltedReason: this.haltedReason(),
      brackets: this.broker?.brackets(symbol) ?? null
    };
  }

  private async openPlan(plan: OrderPlan, source: 'agents' | 'scalping'): Promise<PositionView | null> {
    if (!this.broker) return null;
    try {
      const pos = await this.broker.open(plan, source);
      const times = this.entryTimes[plan.symbol] ?? [];
      times.push(this.now());
      this.entryTimes[plan.symbol] = times.filter((t) => this.now() - t < 3_600_000);
      this.log(`${plan.symbol} ${plan.side === 'LONG' ? '롱' : '숏'} 진입 ${pos.quantity} @ ${fmtPrice(pos.entryPrice)} · 손절 ${fmtPrice(pos.stopLoss)} · 익절 ${fmtPrice(pos.takeProfit)} · ${plan.leverage}배`, 'trade', plan.symbol);
      this.notify(`${plan.symbol} ${plan.side === 'LONG' ? '롱' : '숏'} 진입 (${VENUE_KO[this.cfg.venue]})`,
        `${pos.quantity} @ ${fmtPrice(pos.entryPrice)} · 손절 ${fmtPrice(pos.stopLoss)} · 익절 ${fmtPrice(pos.takeProfit)} · ${plan.leverage}배`);
      this.safeJournal({ type: 'entry', source, plan, fill: pos });
      await this.refreshAccount();
      return pos;
    } catch (e) {
      this.log(`${plan.symbol} 주문 실패: ${e instanceof Error ? e.message : e}`, 'error', plan.symbol);
      return null;
    }
  }

  private async processPending(prices: Partial<Record<TradingSymbol, PriceTick>>): Promise<void> {
    if (!this.pending.length) return;
    const keep: PendingEntry[] = [];
    for (const p of this.pending) {
      const t = prices[p.symbol];
      if (this.now() > p.expiresAt) {
        this.log(`${p.symbol} 지정가 진입 대기 만료 (${fmtPrice(p.limitPrice)})`, 'info', p.symbol);
        continue;
      }
      const side = p.decision.action === 'LONG' ? 'LONG' : 'SHORT';
      const reached = t && (side === 'LONG' ? t.low <= p.limitPrice : t.high >= p.limitPrice);
      if (!reached || !t) { keep.push(p); continue; }
      if (this.snap.positions.some((x) => x.symbol === p.symbol)) continue;
      const verdict = sizeOrder({
        side, entryType: 'MARKET', entryPrice: t.last, stopLoss: p.decision.stopLoss ?? 0,
        takeProfit: p.decision.takeProfit ?? 0, leverage: p.decision.leverage ?? this.cfg.agents.defaultLeverage,
        riskPct: p.decision.riskPct ?? this.cfg.risk.riskPerTradePct
      }, this.riskContext(p.symbol, t.last, this.cfg.agents.minRewardRisk, this.cfg.agents.defaultLeverage, this.cfg.agents.maxLeverage));
      if (verdict.approved && verdict.plan) {
        this.log(`${p.symbol} 지정가 ${fmtPrice(p.limitPrice)} 도달 — 진입`, 'info', p.symbol);
        const pos = await this.openPlan(verdict.plan, 'agents');
        if (pos) this.openDecision[p.symbol] = { runId: p.runId, summary: p.decision.summary, voters: p.voters };
      } else {
        this.log(`${p.symbol} 지정가 도달했으나 리스크 엔진 거부: ${verdict.reason}`, 'warn', p.symbol);
      }
    }
    this.pending = keep;
    this.snap.pendingEntries = this.pending.map((p) => ({
      symbol: p.symbol, side: p.decision.action === 'LONG' ? 'LONG' : 'SHORT', limitPrice: p.limitPrice, expiresAt: p.expiresAt
    }));
  }

  // ─── agents mode ───────────────────────────────────────────────────────

  private async drainQueue(): Promise<void> {
    if (this.pipelineBusy) return;
    this.pipelineBusy = true;
    try {
      while (this.runQueue.length && !this.stopping) {
        const s = this.runQueue.shift() as TradingSymbol;
        await this.runAgents(s, true);
      }
    } finally {
      this.pipelineBusy = false;
    }
  }

  /** Run the pipeline once now. When the engine is stopped this is analysis only (no orders). */
  async runNow(symbol: TradingSymbol): Promise<void> {
    if (this.cfg.mode === 'scalping') {
      await this.refreshBias(symbol);
      return;
    }
    if (this.running) {
      if (!this.runQueue.includes(symbol)) this.runQueue.push(symbol);
      this.snap.nextRunAt[symbol] = this.now() + this.cfg.agents.intervalMinutes * 60_000;
      void this.drainQueue();
      return;
    }
    if (this.pipelineBusy) throw new Error('이미 분석이 진행 중입니다');
    this.pipelineBusy = true;
    this.stopping = false;
    try { await this.runAgents(symbol, false); } finally { this.pipelineBusy = false; }
  }

  private portfolioText(symbol: TradingSymbol): string {
    const a = this.snap.account;
    const pos = this.snap.positions.find((p) => p.symbol === symbol);
    const others = this.snap.positions.filter((p) => p.symbol !== symbol);
    const lines: string[] = [];
    if (a) {
      lines.push(`- 계좌(${VENUE_KO[this.cfg.venue]}): 자본 ${a.equity.toFixed(2)} USDT, 가용 ${a.available.toFixed(2)} USDT, 오늘 실현손익 ${a.realizedPnlToday.toFixed(2)} USDT (${a.tradesToday}건)`);
    } else {
      lines.push(`- 계좌: 분석 전용 실행 (기준 자본 ${this.cfg.risk.paperBalanceUsdt} USDT)`);
    }
    if (pos) {
      const held = Math.round((this.now() - pos.openedAt) / 60_000);
      lines.push(`- 현재 ${symbol} 포지션: ${pos.side === 'LONG' ? '롱' : '숏'} ${pos.quantity} @ ${fmtPrice(pos.entryPrice)}, 미실현 ${pos.unrealizedPnl.toFixed(2)} USDT, 손절 ${fmtPrice(pos.stopLoss)}, 익절 ${fmtPrice(pos.takeProfit)}, ${pos.leverage}배, 보유 ${held}분`);
    } else {
      lines.push(`- 현재 ${symbol} 포지션: 없음`);
    }
    for (const o of others) lines.push(`- 다른 포지션: ${o.symbol} ${o.side === 'LONG' ? '롱' : '숏'} ${o.quantity} @ ${fmtPrice(o.entryPrice)}`);
    return lines.join('\n');
  }

  private constraints(): DeskConstraints {
    return {
      maxLeverage: Math.min(this.cfg.risk.maxLeverage, this.cfg.agents.maxLeverage),
      riskPerTradePct: this.cfg.risk.riskPerTradePct,
      minRewardRisk: this.cfg.agents.minRewardRisk,
      minConfidence: this.cfg.agents.minConfidence,
      defaultLeverage: this.cfg.agents.defaultLeverage,
      venueLabel: VENUE_KO[this.cfg.venue]
    };
  }

  private newRun(symbol: TradingSymbol, kind: AgentRunView['kind']): AgentRunView {
    const id = `${this.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
    const run: AgentRunView = {
      id, symbol, kind, startedAt: this.now(),
      steps: kind === 'pipeline' ? pipelineSkeleton(this.cfg.agents.analysts, this.cfg.teams) : biasSkeleton(this.cfg.teams)
    };
    this.snap.runs.unshift(run);
    if (this.snap.runs.length > MAX_RUNS) this.snap.runs.length = MAX_RUNS;
    this.emitSoon();
    return run;
  }

  private setStep(run: AgentRunView, step: AgentStepView): void {
    const key = stepKey(step);
    const i = run.steps.findIndex((s) => stepKey(s) === key);
    if (i >= 0) run.steps[i] = { ...run.steps[i], ...step };
    else run.steps.push(step);
    this.emitSoon();
  }

  private async runAgents(symbol: TradingSymbol, execute: boolean): Promise<void> {
    const run = this.newRun(symbol, 'pipeline');
    this.log(`${symbol} 에이전트 분석 시작${execute ? '' : ' (분석 전용 — 주문 없음)'}`, 'info', symbol);
    try {
      const want = new Set(this.cfg.agents.analysts);
      const snapshot = await this.market.analysisSnapshot(symbol, this.cfg.agents.newsFeeds, { news: want.has('news'), sentiment: want.has('sentiment') });
      for (const n of snapshot.notes) this.log(`${symbol} ${n}`, 'warn', symbol);
      const lessons = this.journal.lessons(symbol, 5).map((l) => `- ${l.lesson}`).join('\n');
      const ctx = { symbol, snapshot, portfolio: this.portfolioText(symbol), lessons, constraints: this.constraints() };
      const llm = this.getLlm();
      const voters: Voter[] = [];
      const result = await runPipeline({
        ctx,
        analysts: this.cfg.agents.analysts,
        debateRounds: this.cfg.agents.debateRounds,
        riskRounds: this.cfg.agents.riskRounds,
        teams: this.cfg.teams
      }, {
        llm,
        agents: this.pipelineHooks(symbol, run.id, snapshot.price, voters),
        onStep: (s) => this.setStep(run, s),
        aborted: () => this.stopping && execute,
        now: this.deps.now
      });
      run.decision = result.decision;
      run.committee = result.committee;
      if (result.committee) this.log(`${symbol} 포트폴리오 위원회: ${result.committee.note}`, 'info', symbol);
      if (!result.parsedJson) {
        this.log(result.committee
          ? `${symbol} 일부 위원의 JSON을 읽지 못해 그 위원은 등급만으로 투표했습니다`
          : `${symbol} 포트폴리오 매니저 JSON을 읽지 못해 등급(${result.decision.rating})만으로 판단합니다`, 'warn', symbol);
      }

      // ── risk engine + execution ─────────────────────────────────────
      // The desk may have been stopped while the managers were thinking.
      if (execute && this.stopping) throw new PipelineAborted();
      this.setStep(run, { role: 'riskEngine', state: 'running', startedAt: this.now() });
      // Live price from the tick loop when fresh; an analysis-only run (desk
      // stopped) has no loop, so it uses the snapshot it just took.
      const m = this.snap.markets[symbol];
      const price = m && this.now() - m.updatedAt < 60_000 ? m.price : snapshot.price;
      const verdict = await this.applyDecision(symbol, result.decision, price, execute, run.id, voters);
      run.verdict = verdict;
      this.setStep(run, {
        role: 'riskEngine', state: 'done', finishedAt: this.now(),
        content: [`**${verdict.approved ? '승인' : '보류/거부'}** — ${verdict.reason}`, ...verdict.adjustments.map((a) => `- ${a}`)].join('\n')
      });

      const verdictText = `${verdict.approved ? '승인' : '보류/거부'} — ${verdict.reason}`;
      try {
        run.reportPath = this.journal.writeReport(symbol, run.id, snapshot.takenAt, renderReport({
          symbol, takenAt: snapshot.takenAt, llmLabel: llm.label, venueLabel: execute ? VENUE_KO[this.cfg.venue] : '분석 전용',
          snapshotVerified: snapshot.verified, result, verdictText, notes: snapshot.notes
        }));
      } catch (e) {
        this.log(`보고서 저장 실패: ${e instanceof Error ? e.message : e}`, 'warn', symbol);
      }
      this.safeJournal({ type: 'decision', symbol, runId: run.id, execute, decision: result.decision, committee: result.committee, verdict, report: run.reportPath });
      this.log(`${symbol} 최종 결정: ${result.decision.rating} / ${result.decision.action} (확신도 ${(result.decision.confidence * 100).toFixed(0)}%) — ${verdictText}`, 'info', symbol);
    } catch (e) {
      const msg = e instanceof PipelineAborted ? '정지로 중단됨' : e instanceof Error ? e.message : String(e);
      run.error = msg;
      // The step that was running when it failed carries the reason (shown when it is selected).
      for (const s of run.steps) {
        if (s.state === 'running') { s.state = 'error'; s.error ??= msg; }
        else if (s.state === 'pending') s.state = 'skipped';
      }
      this.log(`${symbol} 에이전트 분석 실패: ${msg}`, e instanceof PipelineAborted ? 'info' : 'error', symbol);
    } finally {
      run.finishedAt = this.now();
      this.emitSoon();
    }
  }

  /** Turn the PM's decision into broker actions. Returns the verdict shown in the UI. */
  private async applyDecision(symbol: TradingSymbol, d: FinalDecision, price: number, execute: boolean, runId: string, voters: Voter[] = []): Promise<RiskVerdict> {
    const pos = this.snap.positions.find((p) => p.symbol === symbol);
    const exec = (step: string) => this.setStep(this.snap.runs.find((r) => r.id === runId)!, { role: 'execution', state: 'done', finishedAt: this.now(), content: step });
    const noExec = (v: RiskVerdict): RiskVerdict => {
      exec(execute ? '주문 없음' : '분석 전용 실행 — 주문을 내지 않았습니다');
      return v;
    };

    if (d.action === 'HOLD') {
      return noExec({ approved: false, reason: pos ? '관망 — 기존 포지션 유지' : '관망 — 신규 진입 없음', adjustments: [] });
    }
    if (d.action === 'CLOSE') {
      if (!pos) return noExec({ approved: false, reason: '청산 결정이지만 열린 포지션이 없습니다', adjustments: [] });
      if (!execute || !this.broker) return noExec({ approved: true, reason: '포지션 청산 (분석 전용이라 실행 안 함)', adjustments: [] });
      const t = await this.broker.close(symbol, '에이전트 청산 결정');
      if (t) this.recordTrade(t);
      exec('포지션 청산 완료');
      return { approved: true, reason: '포지션 청산', adjustments: [] };
    }

    // LONG / SHORT
    if (pos && pos.side === d.action) {
      const valid = (sl: number | null, tp: number | null) => ({
        sl: sl !== null && (pos.side === 'LONG' ? sl < price : sl > price) ? sl : null,
        tp: tp !== null && (pos.side === 'LONG' ? tp > price : tp < price) ? tp : null
      });
      const v = valid(d.stopLoss, d.takeProfit);
      if (execute && this.broker && pos.source !== 'manual' && (v.sl !== null || v.tp !== null)) {
        try {
          await this.broker.updateStops(symbol, v.sl, v.tp);
          exec(`기존 포지션 유지, 손절 ${fmtPrice(v.sl ?? pos.stopLoss)} / 익절 ${fmtPrice(v.tp ?? pos.takeProfit)}로 갱신`);
        } catch (e) {
          exec(`손절/익절 갱신 실패: ${e instanceof Error ? e.message : e}`);
        }
        return { approved: true, reason: '같은 방향 포지션 유지, 손절/익절 갱신', adjustments: [] };
      }
      return noExec({ approved: false, reason: '같은 방향 포지션 보유 중 — 유지', adjustments: [] });
    }

    const verdict = planFromDecision(d, this.riskContext(symbol, price, this.cfg.agents.minRewardRisk, this.cfg.agents.defaultLeverage, this.cfg.agents.maxLeverage), this.cfg.agents.minConfidence);
    if (pos && pos.side !== d.action) {
      // Reversal: flatten first (even if the new entry is then refused — the
      // portfolio manager's call is that the old side is wrong).
      if (execute && this.broker) {
        if (pos.source === 'manual') {
          return noExec({ approved: false, reason: '반대 방향의 수동 포지션이 있어 건드리지 않습니다', adjustments: [] });
        }
        const t = await this.broker.close(symbol, '반대 방향 결정으로 청산');
        if (t) this.recordTrade(t);
        await this.refreshAccount();
      }
    }
    if (!verdict.approved || !verdict.plan) return noExec(verdict);
    if (!execute || !this.broker) return noExec(verdict);

    if (verdict.plan.entryType === 'LIMIT') {
      this.pending = this.pending.filter((p) => p.symbol !== symbol);
      this.pending.push({ symbol, decision: d, limitPrice: verdict.plan.entryPrice, expiresAt: this.now() + this.cfg.agents.limitEntryTtlMinutes * 60_000, runId, voters });
      exec(`지정가 ${fmtPrice(verdict.plan.entryPrice)} 도달 시 진입 대기 (${this.cfg.agents.limitEntryTtlMinutes}분)`);
      return verdict;
    }
    const opened = await this.openPlan(verdict.plan, 'agents');
    if (opened) {
      this.openDecision[symbol] = { runId, summary: d.summary, voters };
      exec(`체결: ${opened.side === 'LONG' ? '롱' : '숏'} ${opened.quantity} @ ${fmtPrice(opened.entryPrice)}`);
      return verdict;
    }
    exec('주문 실패 — 로그 확인');
    return { ...verdict, approved: false, reason: `주문 실패: ${verdict.reason}` };
  }

  private async reflect(t: TradeView): Promise<void> {
    const origin = this.openDecision[t.symbol];
    delete this.openDecision[t.symbol];
    const holdMin = Math.round((t.closedAt - t.openedAt) / 60_000);
    const outcome = `${t.side === 'LONG' ? '롱' : '숏'} ${fmtPrice(t.entryPrice)} → ${fmtPrice(t.exitPrice)}, ${t.exitReason}, 보유 ${holdMin}분, 손익 ${t.pnl.toFixed(2)} USDT`;
    let lesson = `${t.side === 'LONG' ? '롱' : '숏'} 결과: ${outcome}.`;
    try {
      const p = reflectionPrompt(t.symbol, origin?.summary ?? '(결정 요약 없음)', outcome);
      const agent = agentRef('reflection');
      const text = await this.getLlm().complete(this.agentCall(agent, t.symbol, { role: `reflection-${t.symbol}`, tier: 'quick', system: p.system, prompt: p.prompt, maxTokens: 600 }));
      lesson = text.trim().replace(/\s+/g, ' ').slice(0, 600);
      this.agentOutput(agent, { symbol: t.symbol, runId: origin?.runId ?? 'trade', kind: 'pipeline', price: t.exitPrice, text: `${outcome}\n\n${text.trim()}`, vote: null, confidence: null });
    } catch (e) {
      this.log(`회고 생성 실패(결과만 기록): ${e instanceof Error ? e.message : e}`, 'warn', t.symbol);
    }
    try { this.journal.addLesson(t.symbol, lesson); } catch { /* best-effort */ }
  }

  // ─── scalping mode ─────────────────────────────────────────────────────

  private biasFresh(symbol: TradingSymbol): boolean {
    const b = this.snap.biases[symbol];
    return !!b && this.now() - b.updatedAt < this.cfg.scalping.biasRefreshMinutes * 60_000;
  }

  private async scalpStep(symbol: TradingSymbol): Promise<void> {
    const p = this.cfg.scalping;
    if (p.agentBias && !this.biasFresh(symbol)) void this.refreshBias(symbol);
    let inputs;
    try {
      inputs = await this.market.scalpInputs(symbol, p.timeframe, p.trendTimeframe);
    } catch (e) {
      this.log(`${symbol} 스캘핑 데이터 실패: ${e instanceof Error ? e.message : e}`, 'warn', symbol);
      return;
    }
    if (p.orderFlow) await this.attachFlow(symbol, inputs);
    // A bias older than two refresh periods is stale: fall back to both sides.
    const b = this.snap.biases[symbol];
    const bias = p.agentBias && b && this.now() - b.updatedAt < 2 * p.biasRefreshMinutes * 60_000 ? b.bias : undefined;
    let ev = evaluateScalp(inputs, p, bias);
    // Experience: what past replays say about this very setup. A losing record vetoes the entry.
    let experience: string | undefined;
    if (p.experienceFilter && ev.atr > 0) {
      const side = ev.entry?.side ?? (ev.longScore >= ev.shortScore ? 'LONG' : 'SHORT');
      try {
        const v = this.experience.verdict(symbol, side, featuresAt(ev, side, inputs.flow, this.now()), p.experienceMinSamples);
        experience = v.note;
        if (v.block && ev.entry) ev = { ...ev, entry: undefined, blocked: v.note };
      } catch { /* no experience yet */ }
    }
    this.snap.scalp[symbol] = {
      symbol, longScore: ev.longScore, shortScore: ev.shortScore, trend: ev.trend, atrPct: ev.atrPct,
      spreadBps: ev.spreadBps, reasons: ev.reasons, blocked: ev.blocked, evaluatedAt: this.now(), experience,
      plan: scalpPlan(ev, this.riskContext(symbol, ev.price, 0, p.leverage), p, !this.broker?.brackets(symbol))
    };
    if (!this.broker) return;

    const pos = this.snap.positions.find((x) => x.symbol === symbol);
    if (pos) {
      if (pos.source !== 'scalping') { this.snap.scalp[symbol]!.blocked = '다른 출처의 포지션 보유 중'; return; }
      const m = manageScalp(pos, ev, p, this.now(), this.cfg.risk.takerFeePct);
      if (m.action === 'close') {
        const t = await this.broker.close(symbol, m.reason);
        if (t) this.recordTrade(t);
        await this.refreshAccount();
      } else if (m.action === 'moveStop') {
        const better = pos.stopLoss === null || (pos.side === 'LONG' ? m.stopLoss > pos.stopLoss : m.stopLoss < pos.stopLoss);
        const safe = pos.side === 'LONG' ? m.stopLoss < ev.price : m.stopLoss > ev.price;
        if (better && safe) {
          try {
            await this.broker.updateStops(symbol, m.stopLoss, null);
            this.log(`${symbol} ${m.reason} (${fmtPrice(m.stopLoss)})`, 'info', symbol);
            await this.refreshAccount();
          } catch (e) {
            this.log(`${symbol} 손절 이동 실패: ${e instanceof Error ? e.message : e}`, 'warn', symbol);
          }
        }
      }
      return;
    }

    if (!ev.entry) return;
    const halted = this.haltedReason();
    if (halted) { this.snap.scalp[symbol]!.blocked = halted; return; }
    const lastExit = this.lastExitAt[symbol] ?? 0;
    if (this.now() - lastExit < p.cooldownMinutes * 60_000) {
      this.snap.scalp[symbol]!.blocked = `쿨다운 중 (${Math.ceil((p.cooldownMinutes * 60_000 - (this.now() - lastExit)) / 1000)}초)`;
      return;
    }
    const recent = (this.entryTimes[symbol] ?? []).filter((t) => this.now() - t < 3_600_000);
    if (recent.length >= p.maxTradesPerHour) { this.snap.scalp[symbol]!.blocked = `시간당 최대 진입 ${p.maxTradesPerHour}회 도달`; return; }

    const verdict = sizeOrder({
      side: ev.entry.side, entryType: 'MARKET', entryPrice: ev.price, stopLoss: ev.entry.stopLoss,
      takeProfit: ev.entry.takeProfit, leverage: p.leverage, riskPct: this.cfg.risk.riskPerTradePct
    }, this.riskContext(symbol, ev.price, 0, p.leverage));
    if (!verdict.approved || !verdict.plan) {
      this.snap.scalp[symbol]!.blocked = verdict.reason;
      return;
    }
    this.log(`${symbol} 스캘핑 신호 ${ev.entry.side === 'LONG' ? '롱' : '숏'} ${ev.entry.score}점 — ${ev.reasons.slice(0, 4).join(', ')}`, 'info', symbol);
    await this.openPlan(verdict.plan, 'scalping');
  }

  /**
   * Order flow for the scalper: the live tracker when the streams deliver;
   * otherwise the same tracker fed from REST (recent aggTrades + the depth
   * snapshot the scalper already read).
   */
  private async attachFlow(symbol: TradingSymbol, inputs: ScalpInputs): Promise<void> {
    const tracker = this.feed?.trackers[symbol]
      ?? (this.restTrackers[symbol] ??= new FlowTracker(symbol, { bigTradeUsdt: this.cfg.scalping.bigTradeUsdt }));
    const liveTrades = !!this.feed?.live('market');
    const liveBook = !!this.feed?.live('public');
    if (!liveTrades) {
      try {
        for (const tr of parseRestAggTrades(await this.market.client.aggTradesRaw(symbol, 500))) tracker.addTrade(tr);
      } catch { /* the candles' taker volume still scores the flow */ }
    }
    if (!liveBook && inputs.depth) tracker.setBook({ bids: inputs.depth.bids, asks: inputs.depth.asks, at: this.now() });
    const source = liveTrades ? 'live' : 'rest';
    inputs.flow = tracker.features(this.now(), source);
    this.snap.flow[symbol] = tracker.view(this.now(), source, liveTrades && liveBook);
  }

  private async refreshBias(symbol: TradingSymbol): Promise<void> {
    if (this.biasBusy.has(symbol)) return;
    this.biasBusy.add(symbol);
    const run = this.newRun(symbol, 'bias');
    const n = this.cfg.teams.biasPanel;
    const rule = this.cfg.teams.consensus;
    this.setStep(run, { role: 'biasDesk', id: 'biasDesk', state: n > 1 ? 'pending' : 'running', startedAt: n > 1 ? undefined : this.now() });
    try {
      const p = this.cfg.scalping;
      const [snapshot, k, trend] = await Promise.all([
        this.market.analysisSnapshot(symbol, this.cfg.agents.newsFeeds, { news: false, sentiment: true }),
        this.market.klines(symbol, p.timeframe, 200),
        this.market.klines(symbol, p.trendTimeframe, 200)
      ]);
      const scalpTech = formatTechnicalBlock(symbol, [summarizeTimeframe(p.timeframe, k), summarizeTimeframe(p.trendTimeframe, trend)], k.slice(-10), p.timeframe);
      const prompt = biasDeskPrompt(symbol, `${scalpTech}\n\n${snapshot.technical}`, snapshot.derivatives, snapshot.sentiment);
      const llm = this.getLlm();
      let parsed: { bias: BiasDirection; confidence: number; note: string };
      let content: string;
      if (n === 1) {
        const agent = agentRef('biasDesk');
        const text = await llm.complete(this.agentCall(agent, symbol, { role: `biasDesk-${symbol}`, tier: 'quick', system: prompt.system, prompt: prompt.prompt, maxTokens: 900 }));
        const one = parseBias(text);
        this.agentOutput(agent, { symbol, runId: run.id, kind: 'bias', price: snapshot.price, text: text.trim(), vote: one?.bias ?? null, confidence: one?.confidence ?? null });
        if (!one) throw new Error('방향 필터 JSON을 읽지 못했습니다');
        parsed = one;
        content = text.trim();
      } else {
        // The panel: n judges with different specialties vote independently; code tallies.
        const seats = await Promise.all(Array.from({ length: n }, (_, i) => i + 1).map(async (member) => {
          const persona = personaKey('biasDesk', member);
          const id = stepId('biasDesk', member);
          this.setStep(run, { role: 'biasDesk', id, member, persona, state: 'running', startedAt: this.now() });
          try {
            const mp = withMember(prompt, memberRule('biasDesk', member, n, biasPanelClosing(rule)));
            const agent = agentRef('biasDesk', { persona });
            const text = await llm.complete(this.agentCall(agent, symbol, { role: `biasDesk_${member}-${symbol}`, tier: 'quick', system: mp.system, prompt: mp.prompt, maxTokens: 900 }));
            const result = parseBias(text);
            this.agentOutput(agent, { symbol, runId: run.id, kind: 'bias', price: snapshot.price, text: text.trim(), vote: result?.bias ?? null, confidence: result?.confidence ?? null });
            if (!result) throw new Error('JSON을 읽지 못했습니다');
            this.setStep(run, { role: 'biasDesk', id, state: 'done', finishedAt: this.now(), content: text.trim(), vote: result.bias, confidence: result.confidence });
            return { member, persona, result, text: text.trim(), error: undefined as string | undefined };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.setStep(run, { role: 'biasDesk', id, state: 'error', finishedAt: this.now(), error: msg });
            return { member, persona, result: null, text: '', error: msg };
          }
        }));
        this.setStep(run, { role: 'biasDesk', id: 'biasDesk', state: 'running', startedAt: this.now() });
        const agg = aggregateBias(seats, rule);
        run.committee = agg.view;
        parsed = agg.bias;
        content = committeeMinutes(agg.view, seats);
      }
      this.snap.biases[symbol] = { ...parsed, updatedAt: this.now() };
      this.setStep(run, { role: 'biasDesk', id: 'biasDesk', state: 'done', finishedAt: this.now(), content, vote: parsed.bias, confidence: parsed.confidence });
      this.safeJournal({ type: 'bias', symbol, ...parsed, ...(run.committee ? { panel: run.committee } : {}) });
      this.log(`${symbol} 에이전트 방향 필터: ${biasKo(parsed.bias)} (확신도 ${(parsed.confidence * 100).toFixed(0)}%) — ${parsed.note}`, 'info', symbol);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      run.error = msg;
      this.setStep(run, { role: 'biasDesk', id: 'biasDesk', state: 'error', finishedAt: this.now(), error: msg });
      this.log(`${symbol} 방향 필터 실패 (양방향 허용으로 계속): ${msg}`, 'warn', symbol);
    } finally {
      run.finishedAt = this.now();
      this.biasBusy.delete(symbol);
      this.emitSoon();
    }
  }

  // ─── replays ────────────────────────────────────────────────────────────

  /** Agents-mode replay (agentReplay.ts) with this desk's LLM, agent folders and lesson book. */
  runAgentReplay(req: import('../../shared/trading').BacktestRequest, ctl: { onProgress: (pct: number, phase: string) => void; aborted: () => boolean }) {
    return runAgentReplay(req, {
      llm: this.getLlm(),
      market: restReplayMarket(this.market.client, this.deps.fetch, () => this.now()),
      history: this.history,
      cfg: this.cfg,
      projects: this.projects,
      addDeskLesson: (symbol, lesson) => this.journal.addLesson(symbol, lesson),
      writeReport: (symbol, runId, takenAt, text) => this.journal.writeReport(symbol, runId, takenAt, text),
      onProgress: ctl.onProgress,
      aborted: ctl.aborted,
      now: () => this.now()
    });
  }

  // ─── manual actions ────────────────────────────────────────────────────

  async closePosition(symbol: TradingSymbol): Promise<void> {
    let broker = this.broker;
    let temp = false;
    if (!broker) {
      broker = this.makeBroker();
      await broker.init(this.cfg.symbols);
      temp = true;
    }
    const t = await broker.close(symbol, '수동 청산');
    this.pending = this.pending.filter((p) => p.symbol !== symbol);
    if (t) {
      if (temp) this.loadDay();
      this.recordTrade(t);
    } else {
      this.log(`${symbol} 청산할 포지션이 없습니다`, 'info', symbol);
    }
    if (!temp) await this.refreshAccount();
    else this.snap.positions = await broker.positions();
    this.emitSoon();
  }

  /** Reset the paper account (only when stopped). */
  resetPaper(): void {
    if (this.running && this.cfg.venue === 'paper') throw new Error('정지한 뒤 모의 계좌를 초기화하세요');
    const b = new PaperBroker({
      startBalance: this.cfg.risk.paperBalanceUsdt,
      takerFeePct: this.cfg.risk.takerFeePct,
      slippageBps: this.cfg.risk.slippageBps,
      persist: this.journal.store('paper.json')
    });
    b.reset(this.cfg.risk.paperBalanceUsdt);
    try { this.journal.store('day-paper.json').save({}); } catch { /* best-effort */ }
    if (this.cfg.venue === 'paper') {
      this.snap.positions = [];
      this.snap.account = null;
    }
    this.log(`모의 계좌를 ${this.cfg.risk.paperBalanceUsdt} USDT로 초기화했습니다`);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopFeed();
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
    this.stopping = true;
  }
}
