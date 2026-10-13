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
  state: 'pending' | 'running' | 'done' | 'error' | 'skipped';
  startedAt?: number;
  finishedAt?: number;
  /** Markdown report / argument (Korean). */
  content?: string;
  error?: string;
}

export interface AgentRunView {
  id: string;
  symbol: TradingSymbol;
  kind: 'pipeline' | 'bias';
  startedAt: number;
  finishedAt?: number;
  steps: AgentStepView[];
  decision?: FinalDecision;
  verdict?: RiskVerdict;
  error?: string;
  reportPath?: string;
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
