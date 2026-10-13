/**
 * Trading desk — shared types, defaults and config normalisation.
 *
 * The trading desk ports the TradingAgents multi-agent algorithm
 * (TauricResearch/TradingAgents, Apache-2.0 — see NOTICE) to Binance USDⓈ-M
 * perpetual futures and runs it inside Munder Difflin. Two modes:
 *
 *   - `agents`   — the TradingAgents pipeline: four analysts in parallel, a
 *                  bull/bear research debate, research manager, trader, a
 *                  three-way risk debate and the portfolio manager's final call.
 *   - `scalping` — a fast rule-based entry/exit loop on 1m/5m candles and the
 *                  order book, optionally gated by a periodic agent "bias desk".
 *
 * Every team can be staffed by several agents with different specialties
 * (`TeamSettings`): analyst and trader teams are merged by a lead, the
 * portfolio committee and the bias panel vote and code tallies the votes.
 *
 * This file is imported by BOTH the main process and the renderer, so it holds
 * no Node or DOM APIs: plain data, defaults and pure validation only.
 *
 * SAFETY CONTRACT: `normalizeTradingConfig` is the single gate every config
 * passes on load and on save. Every number is clamped to a sane range, and the
 * live venue additionally requires `liveAcknowledged`. Nothing an LLM outputs
 * can widen these limits — the risk engine reads them, not the model.
 */

export const TRADING_SYMBOLS = ['BTCUSDT', 'ETHUSDT'] as const;
export type TradingSymbol = (typeof TRADING_SYMBOLS)[number];

export type TradingMode = 'agents' | 'scalping';
export const TRADING_MODES: readonly TradingMode[] = ['agents', 'scalping'];

/** paper = local simulation on live prices · demo = Binance demo futures · live = real money. */
export type ExecutionVenue = 'paper' | 'demo' | 'live';
export const EXECUTION_VENUES: readonly ExecutionVenue[] = ['paper', 'demo', 'live'];

export type LlmProvider = 'claude-subscription' | 'anthropic' | 'openai' | 'openai-compatible';
export const LLM_PROVIDERS: readonly LlmProvider[] = ['claude-subscription', 'anthropic', 'openai', 'openai-compatible'];

/** The four analysts. `derivatives` replaces TradingAgents' fundamentals analyst:
 *  a perpetual future has no balance sheet, but it has funding, open interest
 *  and crowd positioning, which play the same "what is under the price" role. */
export type AnalystKey = 'technical' | 'derivatives' | 'news' | 'sentiment';
export const ANALYST_KEYS: readonly AnalystKey[] = ['technical', 'derivatives', 'news', 'sentiment'];

export type AgentRole =
  | AnalystKey
  | 'bull' | 'bear' | 'researchManager' | 'trader'
  | 'aggressive' | 'conservative' | 'neutral' | 'portfolioManager'
  | 'riskEngine' | 'execution' | 'biasDesk' | 'reflection';

/** Pipeline order for display. */
export const AGENT_PIPELINE: readonly AgentRole[] = [
  'technical', 'derivatives', 'news', 'sentiment',
  'bull', 'bear', 'researchManager', 'trader',
  'aggressive', 'conservative', 'neutral', 'portfolioManager',
  'riskEngine', 'execution'
];

export type ScalpTimeframe = '1m' | '3m' | '5m';
export type TrendTimeframe = '5m' | '15m' | '1h';

export interface LlmSettings {
  provider: LlmProvider;
  /** Analysts, researchers, debaters, trader. */
  quickModel: string;
  /** Research manager and portfolio manager. */
  deepModel: string;
  /** Only for `openai-compatible` (Ollama, LM Studio, vLLM, OpenRouter …). */
  baseUrl: string;
  /** Per-call timeout. */
  timeoutSec: number;
}

export interface RiskSettings {
  /** Starting balance of the paper account (USDT). */
  paperBalanceUsdt: number;
  /** Max loss per trade if the stop is hit, as % of equity. */
  riskPerTradePct: number;
  /** Hard leverage ceiling. A model asking for more is clamped. */
  maxLeverage: number;
  /** Position notional ceiling as % of equity (300 = 3× equity). */
  maxNotionalPct: number;
  /** Realised + unrealised loss for the day (UTC) that halts new entries. */
  dailyLossLimitPct: number;
  /** Consecutive losing trades that halt new entries for the day. */
  maxConsecutiveLosses: number;
  marginType: 'ISOLATED' | 'CROSSED';
  /** Taker fee used by the paper broker and by R:R checks (percent). */
  takerFeePct: number;
  /** Paper fill slippage (basis points). */
  slippageBps: number;
}

export interface AgentModeSettings {
  /** Minutes between full pipeline runs per symbol. */
  intervalMinutes: number;
  analysts: AnalystKey[];
  /** Bull/bear rounds (TradingAgents `max_debate_rounds`). */
  debateRounds: number;
  /** Aggressive/conservative/neutral rounds (`max_risk_discuss_rounds`). */
  riskRounds: number;
  /** Below this portfolio-manager confidence, a new entry is skipped. */
  minConfidence: number;
  /** Minimum reward:risk (TP distance / SL distance) for a new entry. */
  minRewardRisk: number;
  /** Default leverage when the model does not name one (still capped by risk.maxLeverage). */
  defaultLeverage: number;
  /** A LIMIT entry not reached within this many minutes is dropped. */
  limitEntryTtlMinutes: number;
  /** RSS feeds for the news analyst. */
  newsFeeds: string[];
  /** Reflect on closed trades and feed the lessons to the portfolio manager. */
  reflect: boolean;
}

export interface ScalpingSettings {
  pollSeconds: number;
  timeframe: ScalpTimeframe;
  trendTimeframe: TrendTimeframe;
  leverage: number;
  emaFast: number;
  emaSlow: number;
  trendEma: number;
  rsiPeriod: number;
  atrPeriod: number;
  /** Stop distance in ATRs of the entry timeframe. */
  slAtr: number;
  /** Target distance in ATRs. */
  tpAtr: number;
  /** 0–100; entry needs at least this score on one side. */
  minScore: number;
  maxHoldMinutes: number;
  cooldownMinutes: number;
  maxTradesPerHour: number;
  /** Move the stop to break-even once price has gone this many R in favour (0 = off). */
  breakevenAtR: number;
  /** Skip entries when the book spread is wider than this (bps). */
  maxSpreadBps: number;
  /** Skip dead markets: ATR as % of price below this. */
  minAtrPct: number;
  /** Skip chaotic markets: ATR as % of price above this. */
  maxAtrPct: number;
  /** Ask the agent bias desk for a direction filter. */
  agentBias: boolean;
  biasRefreshMinutes: number;
}

/**
 * How a set of independent votes becomes one call (the portfolio committee
 * and the scalping bias panel). Shares are taken over the members who
 * answered; a quorum (more than half the seats) must answer at all.
 *   majority      — more than half
 *   supermajority — at least two thirds
 *   unanimous     — every member who answered
 */
export type ConsensusRule = 'majority' | 'supermajority' | 'unanimous';
export const CONSENSUS_RULES: readonly ConsensusRule[] = ['majority', 'supermajority', 'unanimous'];

/** Roles the desk can staff with several agents (each with its own specialty). */
export type TeamRole =
  | AnalystKey
  | 'bull' | 'bear' | 'trader'
  | 'aggressive' | 'conservative' | 'neutral'
  | 'portfolioManager' | 'biasDesk';

/**
 * Headcount per team. With 1 everywhere the desk is the original TradingAgents
 * graph (one agent per role). Above 1:
 *   - analysts      N specialists per analyst role → the role's team lead merges them
 *   - researchers   N bulls and N bears debate in turn → research manager judges
 *   - traders       N independent proposals → head trader merges them (with the tally)
 *   - risk          N debaters per stance (aggressive / conservative / neutral)
 *   - portfolio     N committee members vote independently → code tallies (consensus rule)
 *   - bias panel    N scalping-direction judges vote → code tallies (approval per side)
 */
export interface TeamSettings {
  analystsPerRole: number;
  researchersPerSide: number;
  traders: number;
  riskPerStance: number;
  portfolioCommittee: number;
  biasPanel: number;
  consensus: ConsensusRule;
  /** Concurrent LLM calls (each Claude-subscription call is its own hidden session). */
  maxParallel: number;
}

export const TEAM_LIMITS = {
  analystsPerRole: 3,
  researchersPerSide: 3,
  traders: 5,
  riskPerStance: 2,
  portfolioCommittee: 5,
  biasPanel: 5,
  maxParallel: 8
} as const;

/**
 * Specialty of each seat, in seat order (seat 1 = first key). The Korean
 * persona text the agents read lives in main/trading/teams.ts; the UI shows
 * `trading.personas.<role>.<key>`.
 */
export const TEAM_PERSONA_KEYS: Record<TeamRole, readonly string[]> = {
  technical: ['trend', 'reversion', 'structure'],
  derivatives: ['funding', 'positioning', 'flow'],
  news: ['crypto', 'macro', 'event'],
  sentiment: ['contrarian', 'momentum', 'crowd'],
  bull: ['momentum', 'structural', 'catalyst'],
  bear: ['momentum', 'structural', 'catalyst'],
  trader: ['swing', 'breakout', 'reversion', 'quant', 'flow'],
  aggressive: ['opportunity', 'momentum'],
  conservative: ['preservation', 'tail'],
  neutral: ['balance', 'scenario'],
  portfolioManager: ['cio', 'risk', 'quant', 'macro', 'execution'],
  biasDesk: ['trend', 'flow', 'risk', 'sentiment', 'structure']
};

export type TeamPreset = 'solo' | 'standard' | 'full';
export const TEAM_PRESETS: Record<TeamPreset, Omit<TeamSettings, 'consensus' | 'maxParallel'>> = {
  /** The original TradingAgents graph: one agent per role. */
  solo: { analystsPerRole: 1, researchersPerSide: 1, traders: 1, riskPerStance: 1, portfolioCommittee: 1, biasPanel: 1 },
  standard: { analystsPerRole: 2, researchersPerSide: 2, traders: 3, riskPerStance: 1, portfolioCommittee: 3, biasPanel: 3 },
  full: { analystsPerRole: 3, researchersPerSide: 3, traders: 5, riskPerStance: 2, portfolioCommittee: 5, biasPanel: 5 }
};

/** Which preset these numbers are, if any. */
export function teamPresetOf(t: TeamSettings): TeamPreset | null {
  for (const [name, p] of Object.entries(TEAM_PRESETS) as Array<[TeamPreset, (typeof TEAM_PRESETS)[TeamPreset]]>) {
    if ((Object.keys(p) as Array<keyof typeof p>).every((k) => p[k] === t[k])) return name;
  }
  return null;
}

/** Hands-off operation: what the app does on its own around the desk. */
export interface AutomationSettings {
  /** Start the desk automatically when the app launches (with the saved mode/venue). */
  autoStart: boolean;
  /** Keep the computer from suspending the app while the desk runs. */
  keepAwake: boolean;
  /** Desktop notifications for entries, exits, halts and errors. */
  notify: boolean;
}

export interface TradingConfig {
  version: 1;
  mode: TradingMode;
  symbols: TradingSymbol[];
  venue: ExecutionVenue;
  /** The user ticked "I understand this trades real money" in the UI. */
  liveAcknowledged: boolean;
  llm: LlmSettings;
  risk: RiskSettings;
  agents: AgentModeSettings;
  scalping: ScalpingSettings;
  teams: TeamSettings;
  automation: AutomationSettings;
}

export const DEFAULT_NEWS_FEEDS: readonly string[] = [
  'https://www.coindesk.com/arc/outboundfeeds/rss/',
  'https://cointelegraph.com/rss',
  'https://decrypt.co/feed',
  'https://bitcoinmagazine.com/.rss/full/'
];

export const DEFAULT_LLM_MODELS: Record<LlmProvider, { quick: string; deep: string }> = {
  // Claude Code CLI aliases — resolved by the CLI to the current models.
  'claude-subscription': { quick: 'sonnet', deep: 'opus' },
  anthropic: { quick: 'claude-sonnet-5-5', deep: 'claude-opus-5-5' },
  openai: { quick: 'gpt-6-luna', deep: 'gpt-6-sol' },
  'openai-compatible': { quick: 'qwen3:14b', deep: 'qwen3:32b' }
};

export function defaultTradingConfig(): TradingConfig {
  return {
    version: 1,
    mode: 'agents',
    symbols: ['BTCUSDT', 'ETHUSDT'],
    venue: 'paper',
    liveAcknowledged: false,
    llm: {
      provider: 'claude-subscription',
      quickModel: DEFAULT_LLM_MODELS['claude-subscription'].quick,
      deepModel: DEFAULT_LLM_MODELS['claude-subscription'].deep,
      baseUrl: 'http://localhost:11434/v1',
      timeoutSec: 240
    },
    risk: {
      paperBalanceUsdt: 10_000,
      riskPerTradePct: 1,
      maxLeverage: 10,
      maxNotionalPct: 300,
      dailyLossLimitPct: 4,
      maxConsecutiveLosses: 4,
      marginType: 'ISOLATED',
      takerFeePct: 0.05,
      slippageBps: 2
    },
    agents: {
      intervalMinutes: 60,
      analysts: ['technical', 'derivatives', 'news', 'sentiment'],
      debateRounds: 1,
      riskRounds: 1,
      minConfidence: 0.55,
      minRewardRisk: 1.5,
      defaultLeverage: 3,
      limitEntryTtlMinutes: 120,
      newsFeeds: [...DEFAULT_NEWS_FEEDS],
      reflect: true
    },
    scalping: {
      pollSeconds: 5,
      timeframe: '1m',
      trendTimeframe: '5m',
      leverage: 10,
      emaFast: 9,
      emaSlow: 21,
      trendEma: 50,
      rsiPeriod: 7,
      atrPeriod: 14,
      slAtr: 1.2,
      tpAtr: 1.8,
      minScore: 65,
      maxHoldMinutes: 20,
      cooldownMinutes: 3,
      maxTradesPerHour: 6,
      breakevenAtR: 1,
      maxSpreadBps: 3,
      minAtrPct: 0.03,
      maxAtrPct: 1.2,
      agentBias: true,
      biasRefreshMinutes: 15
    },
    teams: {
      ...TEAM_PRESETS.standard,
      consensus: 'majority',
      maxParallel: 4
    },
    automation: {
      autoStart: false,
      keepAwake: true,
      notify: true
    }
  };
}

// ─── normalisation ───────────────────────────────────────────────────────────

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** A finite number clamped to [min, max], or the fallback. */
export function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  return Math.round(clampNum(v, min, max, fallback));
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function str(v: unknown, max: number, fallback: string): string {
  if (typeof v !== 'string') return fallback;
  const t = v.trim();
  return t ? t.slice(0, max) : fallback;
}

function isHttpUrl(v: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(v);
}

/**
 * Coerce anything (a saved file, an IPC payload) into a valid TradingConfig.
 * Unknown keys are dropped, every number is clamped, and the live venue falls
 * back to paper unless the user acknowledged the risk.
 */
export function normalizeTradingConfig(input: unknown): TradingConfig {
  const d = defaultTradingConfig();
  const i = obj(input);
  const llm = obj(i.llm);
  const risk = obj(i.risk);
  const ag = obj(i.agents);
  const sc = obj(i.scalping);
  const tm = obj(i.teams);
  const au = obj(i.automation);
  const bool = (v: unknown, fb: boolean) => (typeof v === 'boolean' ? v : fb);

  const symbols = Array.isArray(i.symbols)
    ? TRADING_SYMBOLS.filter((s) => (i.symbols as unknown[]).includes(s))
    : d.symbols;

  const provider = oneOf(llm.provider, LLM_PROVIDERS, d.llm.provider);
  const models = DEFAULT_LLM_MODELS[provider];
  // A model name is passed as a CLI argument or a JSON field, never through a
  // shell — but keep it to a conservative charset anyway.
  const modelOk = (m: unknown, fb: string) => {
    const s = str(m, 100, fb);
    return /^[A-Za-z0-9._:/@+-]+$/.test(s) ? s : fb;
  };
  const baseUrl = str(llm.baseUrl, 300, d.llm.baseUrl);

  const liveAcknowledged = i.liveAcknowledged === true;
  let venue = oneOf(i.venue, EXECUTION_VENUES, d.venue);
  if (venue === 'live' && !liveAcknowledged) venue = 'paper';

  const analysts = Array.isArray(ag.analysts)
    ? ANALYST_KEYS.filter((k) => (ag.analysts as unknown[]).includes(k))
    : d.agents.analysts;

  const feeds = Array.isArray(ag.newsFeeds)
    ? (ag.newsFeeds as unknown[])
        .filter((f): f is string => typeof f === 'string')
        .map((f) => f.trim())
        .filter((f) => isHttpUrl(f) && f.length <= 300)
        .slice(0, 12)
    : d.agents.newsFeeds;

  const maxLeverage = clampInt(risk.maxLeverage, 1, 50, d.risk.maxLeverage);

  const slAtr = clampNum(sc.slAtr, 0.3, 5, d.scalping.slAtr);
  const scalping: ScalpingSettings = {
    pollSeconds: clampInt(sc.pollSeconds, 2, 60, d.scalping.pollSeconds),
    timeframe: oneOf(sc.timeframe, ['1m', '3m', '5m'] as const, d.scalping.timeframe),
    trendTimeframe: oneOf(sc.trendTimeframe, ['5m', '15m', '1h'] as const, d.scalping.trendTimeframe),
    leverage: Math.min(maxLeverage, clampInt(sc.leverage, 1, 50, d.scalping.leverage)),
    emaFast: clampInt(sc.emaFast, 2, 50, d.scalping.emaFast),
    emaSlow: clampInt(sc.emaSlow, 3, 100, d.scalping.emaSlow),
    trendEma: clampInt(sc.trendEma, 10, 200, d.scalping.trendEma),
    rsiPeriod: clampInt(sc.rsiPeriod, 2, 30, d.scalping.rsiPeriod),
    atrPeriod: clampInt(sc.atrPeriod, 3, 50, d.scalping.atrPeriod),
    slAtr,
    tpAtr: clampNum(sc.tpAtr, 0.3, 10, d.scalping.tpAtr),
    minScore: clampInt(sc.minScore, 40, 100, d.scalping.minScore),
    maxHoldMinutes: clampInt(sc.maxHoldMinutes, 1, 240, d.scalping.maxHoldMinutes),
    cooldownMinutes: clampInt(sc.cooldownMinutes, 0, 120, d.scalping.cooldownMinutes),
    maxTradesPerHour: clampInt(sc.maxTradesPerHour, 1, 60, d.scalping.maxTradesPerHour),
    breakevenAtR: clampNum(sc.breakevenAtR, 0, 5, d.scalping.breakevenAtR),
    maxSpreadBps: clampNum(sc.maxSpreadBps, 0.5, 50, d.scalping.maxSpreadBps),
    minAtrPct: clampNum(sc.minAtrPct, 0, 2, d.scalping.minAtrPct),
    maxAtrPct: clampNum(sc.maxAtrPct, 0.05, 10, d.scalping.maxAtrPct),
    agentBias: typeof sc.agentBias === 'boolean' ? sc.agentBias : d.scalping.agentBias,
    biasRefreshMinutes: clampInt(sc.biasRefreshMinutes, 5, 240, d.scalping.biasRefreshMinutes)
  };
  if (scalping.emaSlow <= scalping.emaFast) scalping.emaSlow = scalping.emaFast + 1;
  if (scalping.maxAtrPct <= scalping.minAtrPct) scalping.maxAtrPct = scalping.minAtrPct + 0.05;

  return {
    version: 1,
    mode: oneOf(i.mode, TRADING_MODES, d.mode),
    symbols: symbols.length ? symbols : d.symbols,
    venue,
    liveAcknowledged,
    llm: {
      provider,
      quickModel: modelOk(llm.quickModel, models.quick),
      deepModel: modelOk(llm.deepModel, models.deep),
      baseUrl: isHttpUrl(baseUrl) ? baseUrl : d.llm.baseUrl,
      timeoutSec: clampInt(llm.timeoutSec, 30, 900, d.llm.timeoutSec)
    },
    risk: {
      paperBalanceUsdt: clampNum(risk.paperBalanceUsdt, 10, 10_000_000, d.risk.paperBalanceUsdt),
      riskPerTradePct: clampNum(risk.riskPerTradePct, 0.05, 5, d.risk.riskPerTradePct),
      maxLeverage,
      maxNotionalPct: clampNum(risk.maxNotionalPct, 10, 2000, d.risk.maxNotionalPct),
      dailyLossLimitPct: clampNum(risk.dailyLossLimitPct, 0.5, 30, d.risk.dailyLossLimitPct),
      maxConsecutiveLosses: clampInt(risk.maxConsecutiveLosses, 1, 50, d.risk.maxConsecutiveLosses),
      marginType: oneOf(risk.marginType, ['ISOLATED', 'CROSSED'] as const, d.risk.marginType),
      takerFeePct: clampNum(risk.takerFeePct, 0, 0.5, d.risk.takerFeePct),
      slippageBps: clampNum(risk.slippageBps, 0, 100, d.risk.slippageBps)
    },
    agents: {
      intervalMinutes: clampInt(ag.intervalMinutes, 15, 1440, d.agents.intervalMinutes),
      analysts: analysts.length ? analysts : d.agents.analysts,
      debateRounds: clampInt(ag.debateRounds, 1, 5, d.agents.debateRounds),
      riskRounds: clampInt(ag.riskRounds, 1, 5, d.agents.riskRounds),
      minConfidence: clampNum(ag.minConfidence, 0, 1, d.agents.minConfidence),
      minRewardRisk: clampNum(ag.minRewardRisk, 0.5, 10, d.agents.minRewardRisk),
      defaultLeverage: Math.min(maxLeverage, clampInt(ag.defaultLeverage, 1, 50, d.agents.defaultLeverage)),
      limitEntryTtlMinutes: clampInt(ag.limitEntryTtlMinutes, 5, 1440, d.agents.limitEntryTtlMinutes),
      newsFeeds: feeds,
      reflect: typeof ag.reflect === 'boolean' ? ag.reflect : d.agents.reflect
    },
    scalping,
    teams: {
      analystsPerRole: clampInt(tm.analystsPerRole, 1, TEAM_LIMITS.analystsPerRole, d.teams.analystsPerRole),
      researchersPerSide: clampInt(tm.researchersPerSide, 1, TEAM_LIMITS.researchersPerSide, d.teams.researchersPerSide),
      traders: clampInt(tm.traders, 1, TEAM_LIMITS.traders, d.teams.traders),
      riskPerStance: clampInt(tm.riskPerStance, 1, TEAM_LIMITS.riskPerStance, d.teams.riskPerStance),
      portfolioCommittee: clampInt(tm.portfolioCommittee, 1, TEAM_LIMITS.portfolioCommittee, d.teams.portfolioCommittee),
      biasPanel: clampInt(tm.biasPanel, 1, TEAM_LIMITS.biasPanel, d.teams.biasPanel),
      consensus: oneOf(tm.consensus, CONSENSUS_RULES, d.teams.consensus),
      maxParallel: clampInt(tm.maxParallel, 1, TEAM_LIMITS.maxParallel, d.teams.maxParallel)
    },
    automation: {
      autoStart: bool(au.autoStart, d.automation.autoStart),
      keepAwake: bool(au.keepAwake, d.automation.keepAwake),
      notify: bool(au.notify, d.automation.notify)
    }
  };
}

// ─── decisions ───────────────────────────────────────────────────────────────

/** TradingAgents' five-tier scale, kept in English as the machine-read label. */
export type Rating = 'Buy' | 'Overweight' | 'Hold' | 'Underweight' | 'Sell';
export const RATINGS: readonly Rating[] = ['Buy', 'Overweight', 'Hold', 'Underweight', 'Sell'];

export type TradeAction = 'LONG' | 'SHORT' | 'CLOSE' | 'HOLD';
export const TRADE_ACTIONS: readonly TradeAction[] = ['LONG', 'SHORT', 'CLOSE', 'HOLD'];

export type Side = 'LONG' | 'SHORT';

/** The portfolio manager's final, machine-readable call. */
export interface FinalDecision {
  rating: Rating;
  action: TradeAction;
  entryType: 'MARKET' | 'LIMIT';
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  leverage: number | null;
  /** % of equity at risk if the stop is hit (capped by risk.riskPerTradePct). */
  riskPct: number | null;
  /** 0–1. */
  confidence: number;
  horizonHours: number | null;
  /** One-paragraph Korean summary. */
  summary: string;
}

/** What the risk engine turned a decision or a signal into. */
export interface OrderPlan {
  symbol: TradingSymbol;
  side: Side;
  entryType: 'MARKET' | 'LIMIT';
  /** Reference entry price (current price for MARKET). */
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  leverage: number;
  quantity: number;
  notional: number;
  /** USDT lost if the stop fills at its price (fees included). */
  riskUsdt: number;
  rewardRisk: number;
}

export interface RiskVerdict {
  approved: boolean;
  /** Korean, user-facing. */
  reason: string;
  plan?: OrderPlan;
  /** Adjustments the engine made (clamped leverage, risk …), Korean. */
  adjustments: string[];
}

// ─── snapshot (main → renderer) ──────────────────────────────────────────────

export type EngineStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'halted' | 'error';

export interface MarketView {
  symbol: TradingSymbol;
  price: number;
  markPrice: number;
  fundingRate: number;
  nextFundingTime: number;
  change24hPct: number | null;
  updatedAt: number;
}

export interface PositionView {
  symbol: TradingSymbol;
  side: Side;
  quantity: number;
  entryPrice: number;
  markPrice: number;
  leverage: number;
  unrealizedPnl: number;
  stopLoss: number | null;
  takeProfit: number | null;
  openedAt: number;
  source: TradingMode | 'manual';
}

export interface AccountView {
  venue: ExecutionVenue;
  equity: number;
  walletBalance: number;
  available: number;
  unrealizedPnl: number;
  /** UTC day the counters below belong to (YYYY-MM-DD). */
  dayKey: string;
  dayStartEquity: number;
  realizedPnlToday: number;
  tradesToday: number;
  winsToday: number;
  lossesToday: number;
  consecutiveLosses: number;
}

export interface AgentStepView {
  role: AgentRole;
  /** Unique within a run: the role itself, or `role#n` for seat n of a staffed team. Absent = role. */
  id?: string;
  /** 1-based seat when the role is staffed by several agents. */
  member?: number;
  /** That seat's specialty (a TEAM_PERSONA_KEYS key). */
  persona?: string;
  /** The team's merge step: team lead, head trader, or the committee/panel tally. */
  lead?: boolean;
  /** A member's machine-read vote: Bullish/Bearish/Neutral, LONG/SHORT/HOLD/CLOSE, or a bias direction. */
  vote?: string;
  /** The member's own confidence, 0–1, when it gave one. */
  confidence?: number;
  state: 'pending' | 'running' | 'done' | 'error' | 'skipped';
  startedAt?: number;
  finishedAt?: number;
  /** Markdown report / argument (Korean). */
  content?: string;
  error?: string;
}

/** One seat's vote on the portfolio committee or the bias panel. */
export interface CommitteeVote {
  member: number;
  persona: string;
  /** LONG/SHORT/HOLD/CLOSE (committee) or a BiasDirection (panel); null = did not answer. */
  vote: string | null;
  rating?: Rating | null;
  confidence: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
}

/** How a committee or panel reached (or missed) its call. */
export interface CommitteeView {
  kind: 'portfolio' | 'bias';
  rule: ConsensusRule;
  seats: number;
  responded: number;
  votes: CommitteeVote[];
  /** The call: a TradeAction (committee) or a BiasDirection (panel). */
  outcome: string;
  /** Members whose vote is the outcome (or, for the panel, allows it). */
  agree: number;
  /** False when no direction reached the rule, so the call fell back to HOLD / NO_TRADE. */
  reached: boolean;
  /** Committee only: position size multiplier = share of answering members who agreed. */
  sizeScale?: number;
  /** Korean, one line. */
  note: string;
}

export interface AgentRunView {
  id: string;
  symbol: TradingSymbol;
  kind: 'pipeline' | 'bias';
  startedAt: number;
  finishedAt?: number;
  steps: AgentStepView[];
  decision?: FinalDecision;
  /** Present when a committee (portfolio) or panel (bias) voted. */
  committee?: CommitteeView;
  verdict?: RiskVerdict;
  error?: string;
  reportPath?: string;
}

export function stepId(role: AgentRole, member?: number): string {
  return member ? `${role}#${member}` : role;
}

export function stepKey(s: Pick<AgentStepView, 'id' | 'role'>): string {
  return s.id ?? s.role;
}

function seats(role: TeamRole, n: number, opts: { lead: boolean }): AgentStepView[] {
  if (n <= 1) return [{ role, id: role, state: 'pending' }];
  const out: AgentStepView[] = opts.lead ? [{ role, id: role, lead: true, state: 'pending' }] : [];
  for (let m = 1; m <= n; m++) out.push({ role, id: stepId(role, m), member: m, persona: TEAM_PERSONA_KEYS[role][m - 1], state: 'pending' });
  return out;
}

/** Every step of a pipeline run with these teams, in display order. */
export function pipelineSkeleton(selected: readonly AnalystKey[], t: TeamSettings): AgentStepView[] {
  const steps: AgentStepView[] = [];
  for (const k of ANALYST_KEYS) {
    if (!selected.includes(k)) steps.push({ role: k, id: k, state: 'skipped' });
    else steps.push(...seats(k, t.analystsPerRole, { lead: true }));
  }
  steps.push(...seats('bull', t.researchersPerSide, { lead: false }), ...seats('bear', t.researchersPerSide, { lead: false }));
  steps.push({ role: 'researchManager', id: 'researchManager', state: 'pending' });
  steps.push(...seats('trader', t.traders, { lead: true }));
  for (const r of ['aggressive', 'conservative', 'neutral'] as const) steps.push(...seats(r, t.riskPerStance, { lead: false }));
  steps.push(...seats('portfolioManager', t.portfolioCommittee, { lead: true }));
  steps.push({ role: 'riskEngine', id: 'riskEngine', state: 'pending' }, { role: 'execution', id: 'execution', state: 'pending' });
  return steps;
}

export function biasSkeleton(t: TeamSettings): AgentStepView[] {
  return seats('biasDesk', t.biasPanel, { lead: true });
}

// ─── agent projects ──────────────────────────────────────────────────────────

/** One LLM agent on the desk: a role, optionally one seat's specialty or the team's lead. */
export interface AgentRef {
  /** Stable id = the agent's project folder name (see agentIdOf). */
  id: string;
  role: AgentRole;
  persona?: string;
  lead?: boolean;
}

/**
 * "technical" (one-agent role), "technical-trend" (a seat), "technical-lead"
 * (the team lead). Seat k always has the k-th persona, so an agent keeps its
 * folder, instructions and record when the team grows or shrinks.
 */
export function agentIdOf(role: AgentRole, opts: { persona?: string; lead?: boolean } = {}): string {
  if (opts.lead) return `${role}-lead`;
  if (opts.persona) return `${role}-${opts.persona}`;
  return role;
}

export function agentRef(role: AgentRole, opts: { persona?: string; lead?: boolean } = {}): AgentRef {
  return { id: agentIdOf(role, opts), role, ...(opts.persona ? { persona: opts.persona } : {}), ...(opts.lead ? { lead: true } : {}) };
}

/** Steps that are code, not an LLM agent (the risk engine, execution, the committee/panel tallies). */
export function isAgentStep(s: Pick<AgentStepView, 'role' | 'lead'>): boolean {
  if (s.role === 'riskEngine' || s.role === 'execution') return false;
  if (s.lead && (s.role === 'portfolioManager' || s.role === 'biasDesk')) return false;
  return true;
}

/** Every LLM agent the desk uses with this config (each gets a project folder). */
export function teamAgents(cfg: TradingConfig): AgentRef[] {
  const steps = [...pipelineSkeleton(cfg.agents.analysts, cfg.teams), ...biasSkeleton(cfg.teams)];
  const out = new Map<string, AgentRef>();
  for (const s of steps) {
    if (s.state === 'skipped' || !isAgentStep(s)) continue;
    const r = agentRef(s.role, { persona: s.persona, lead: s.lead });
    out.set(r.id, r);
  }
  out.set('reflection', agentRef('reflection'));
  return [...out.values()];
}

/** Roles whose output is an argument, not a call: kept, never scored. */
export const UNSCORED_ROLES: readonly AgentRole[] = ['bull', 'bear', 'aggressive', 'conservative', 'neutral', 'reflection'];

/** +1 for a bullish call, −1 bearish, 0 for anything that is not a direction. */
export function voteDirection(vote: string | null | undefined): 1 | -1 | 0 {
  switch (vote) {
    case 'Bullish': case 'LONG': case 'LONG_ONLY': case 'Buy': case 'Overweight': return 1;
    case 'Bearish': case 'SHORT': case 'SHORT_ONLY': case 'Sell': case 'Underweight': return -1;
    default: return 0;
  }
}

/** One agent's folder and track record, for the roster tab. */
export interface AgentProjectView {
  id: string;
  role: AgentRole;
  persona?: string;
  lead?: boolean;
  folder: string;
  /** Opinions recorded (every run the agent answered in with a vote). */
  opinions: number;
  /** Reports / debate turns kept in its outputs folder (debaters have outputs but no votes). */
  outputs: number;
  /** Directional calls whose horizon has passed and were checked against the price. */
  scored: number;
  hits: number;
  /** hits / scored, null before the first scored call. */
  hitRate: number | null;
  /** Mean price move in the called direction, basis points (positive = the calls made money on average). */
  avgEdgeBps: number | null;
  /** Directional calls still waiting for their horizon. */
  pending: number;
  lastAt?: number;
  lastVote?: string;
  lastSymbol?: TradingSymbol;
  /** The user wrote something under "내 지침" in the agent's CLAUDE.md. */
  customized: boolean;
  /** Part of the current team settings (else: a former seat whose folder is kept). */
  active: boolean;
}

/** LLM calls one run makes with these settings (JSON repair turns not counted). */
export function estimateLlmCalls(cfg: TradingConfig): { pipeline: number; pipelinePerHour: number; bias: number; biasPerHour: number } {
  const t = cfg.teams;
  const a = cfg.agents.analysts.length;
  const pipeline =
    a * t.analystsPerRole + (t.analystsPerRole > 1 ? a : 0) +
    2 * t.researchersPerSide * cfg.agents.debateRounds + 1 +
    t.traders + (t.traders > 1 ? 1 : 0) +
    3 * t.riskPerStance * cfg.agents.riskRounds +
    t.portfolioCommittee;
  const n = cfg.symbols.length;
  return {
    pipeline,
    pipelinePerHour: Math.round(pipeline * n * (60 / cfg.agents.intervalMinutes) * 10) / 10,
    bias: t.biasPanel,
    biasPerHour: cfg.scalping.agentBias ? Math.round(t.biasPanel * n * (60 / cfg.scalping.biasRefreshMinutes) * 10) / 10 : 0
  };
}

export type BiasDirection = 'LONG_ONLY' | 'SHORT_ONLY' | 'BOTH' | 'NO_TRADE';

export interface BiasView {
  bias: BiasDirection;
  confidence: number;
  note: string;
  updatedAt: number;
}

export interface ScalpView {
  symbol: TradingSymbol;
  longScore: number;
  shortScore: number;
  trend: 'up' | 'down' | 'flat';
  atrPct: number;
  spreadBps: number;
  /** Korean reason fragments behind the scores. */
  reasons: string[];
  /** Why an entry was NOT taken right now, if any (Korean). */
  blocked?: string;
  evaluatedAt: number;
}

export interface TradeView {
  id: string;
  symbol: TradingSymbol;
  side: Side;
  source: TradingMode | 'manual';
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  openedAt: number;
  closedAt: number;
  pnl: number;
  fees: number;
  /** Korean, e.g. "손절", "익절", "시간 청산". */
  exitReason: string;
}

export interface LogLine {
  ts: number;
  level: 'info' | 'warn' | 'error' | 'trade';
  symbol?: TradingSymbol;
  message: string;
}

export interface PendingEntryView {
  symbol: TradingSymbol;
  side: Side;
  limitPrice: number;
  expiresAt: number;
}

export interface TradingSnapshot {
  status: EngineStatus;
  statusMessage?: string;
  mode: TradingMode;
  venue: ExecutionVenue;
  symbols: TradingSymbol[];
  startedAt?: number;
  account: AccountView | null;
  markets: Partial<Record<TradingSymbol, MarketView>>;
  positions: PositionView[];
  pendingEntries: PendingEntryView[];
  scalp: Partial<Record<TradingSymbol, ScalpView>>;
  biases: Partial<Record<TradingSymbol, BiasView>>;
  runs: AgentRunView[];
  trades: TradeView[];
  logs: LogLine[];
  nextRunAt: Partial<Record<TradingSymbol, number>>;
}

export function emptySnapshot(cfg: TradingConfig): TradingSnapshot {
  return {
    status: 'stopped',
    mode: cfg.mode,
    venue: cfg.venue,
    symbols: [...cfg.symbols],
    account: null,
    markets: {},
    positions: [],
    pendingEntries: [],
    scalp: {},
    biases: {},
    runs: [],
    trades: [],
    logs: [],
    nextRunAt: {}
  };
}

/** Names of the secrets the desk keeps (values never cross IPC back to the renderer). */
export type TradingSecretKey =
  | 'binance.live.key' | 'binance.live.secret'
  | 'binance.demo.key' | 'binance.demo.secret'
  | 'anthropic.key' | 'openai.key' | 'compat.key';

export const TRADING_SECRET_KEYS: readonly TradingSecretKey[] = [
  'binance.live.key', 'binance.live.secret',
  'binance.demo.key', 'binance.demo.secret',
  'anthropic.key', 'openai.key', 'compat.key'
];

export type TradingSecretPresence = Record<TradingSecretKey, boolean>;

/** What Binance says a key may do (GET /sapi/v1/account/apiRestrictions). */
export interface ApiKeyPermissions {
  ipRestrict: boolean;
  enableReading: boolean;
  enableFutures: boolean;
  enableWithdrawals: boolean;
  enableInternalTransfer: boolean;
  permitsUniversalTransfer: boolean;
}

/**
 * Can this key run the live desk? Refuses keys that cannot trade futures and
 * keys that can WITHDRAW — a trading bot never needs that, and a leaked key
 * with it can empty the account. A missing IP allowlist is a warning only.
 * Messages are Korean (they reach the user verbatim).
 */
export function assessLiveKey(p: ApiKeyPermissions): { ok: boolean; problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!p.enableFutures) problems.push('이 API 키에 선물 거래 권한(Enable Futures)이 없습니다');
  if (p.enableWithdrawals) problems.push('이 API 키에 출금 권한(Enable Withdrawals)이 켜져 있습니다 — 자동매매 키는 출금 권한을 꺼야 합니다');
  if (p.enableInternalTransfer || p.permitsUniversalTransfer) warnings.push('내부 이체/유니버설 이체 권한이 켜져 있습니다 — 필요 없다면 끄는 것을 권장합니다');
  if (!p.ipRestrict) warnings.push('IP 접근 제한이 없습니다 — 바이낸스 API 관리에서 내 IP만 허용하도록 설정하는 것을 권장합니다');
  return { ok: problems.length === 0, problems, warnings };
}

/** UTC day key. */
export function dayKeyOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}
