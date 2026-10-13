/**
 * Market data for the desk: fetches from Binance (always the LIVE public
 * market — analysis should see the real tape even when orders go to the demo
 * venue), computes indicators, and renders compact Korean markdown blocks the
 * agents read.
 *
 * This is the TradingAgents "verified market snapshot" idea taken all the way:
 * every number an agent may quote is computed here, deterministically, and
 * handed to the model. The models never fetch data themselves, which is what
 * lets the desk run on a CLI subscription that has no tool-calling API.
 */
import type { FlowFeatures } from './orderFlow';
import {
  BinanceFuturesClient, type Depth, type FetchLike, type FundingPoint, type OiPoint,
  type PremiumIndex, type RatioPoint, type Ticker24h
} from './binance';
import {
  atr, bollinger, ema, fmtNum, fmtPrice, lastValue, macd, pct, percentileRank, rsi,
  sma, swingLevels, valueAt, vwma, avgVolume, type Kline
} from './indicators';
import { fetchFearGreed, fetchNews, fngKo, type FearGreedPoint, type NewsBundle } from './news';
import type { TradingSymbol } from '../../shared/trading';

export interface TfSummary {
  interval: string;
  close: number;
  changePct: number;          // over the whole window
  high: number;
  low: number;
  sma50: number | null;
  sma200: number | null;
  ema10: number | null;
  ema20: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHist: number | null;
  macdHistPrev: number | null;
  rsi14: number | null;
  bollUpper: number | null;
  bollMid: number | null;
  bollLower: number | null;
  bollWidthPctile: number | null;
  atr14: number | null;
  atrPct: number | null;
  vwma20: number | null;
  volumeVsAvg: number | null;
  supports: number[];
  resistances: number[];
  bars: number;
}

export function summarizeTimeframe(interval: string, k: Kline[]): TfSummary {
  const closes = k.map((c) => c.close);
  const m = macd(closes);
  const bb = bollinger(closes, 20, 2);
  const a = atr(k, 14);
  const close = closes[closes.length - 1] ?? 0;
  const atrV = lastValue(a);
  const avgVol = avgVolume(k, 20, 1);
  const lastVol = k[k.length - 1]?.volume ?? 0;
  const lv = swingLevels(k, 3, 3);
  return {
    interval,
    close,
    changePct: k.length ? pct(k[0].open, close) : 0,
    high: k.length ? Math.max(...k.map((c) => c.high)) : 0,
    low: k.length ? Math.min(...k.map((c) => c.low)) : 0,
    sma50: lastValue(sma(closes, 50)),
    sma200: lastValue(sma(closes, 200)),
    ema10: lastValue(ema(closes, 10)),
    ema20: lastValue(ema(closes, 20)),
    macd: lastValue(m.macd),
    macdSignal: lastValue(m.signal),
    macdHist: lastValue(m.hist),
    macdHistPrev: valueAt(m.hist, 1),
    rsi14: lastValue(rsi(closes, 14)),
    bollUpper: lastValue(bb.upper),
    bollMid: lastValue(bb.mid),
    bollLower: lastValue(bb.lower),
    bollWidthPctile: percentileRank(bb.width, 120),
    atr14: atrV,
    atrPct: atrV !== null && close ? (atrV / close) * 100 : null,
    vwma20: lastValue(vwma(k, 20)),
    volumeVsAvg: avgVol > 0 ? lastVol / avgVol : null,
    supports: lv.supports,
    resistances: lv.resistances,
    bars: k.length
  };
}

const TF_KO: Record<string, string> = { '1m': '1분', '3m': '3분', '5m': '5분', '15m': '15분', '1h': '1시간', '4h': '4시간', '1d': '일봉' };
export const tfKo = (tf: string) => TF_KO[tf] ?? tf;

function ts(t: number): string {
  // KST, since the desk speaks Korean and its user reads Korean time.
  return new Date(t + 9 * 3_600_000).toISOString().replace('T', ' ').slice(0, 16) + ' KST';
}

export function formatTechnicalBlock(symbol: TradingSymbol, tfs: TfSummary[], recent: Kline[], recentTf: string): string {
  const rows = tfs.map((s) => [
    tfKo(s.interval), fmtPrice(s.close), `${fmtNum(s.changePct)}%`, fmtPrice(s.ema20), fmtPrice(s.sma50), fmtPrice(s.sma200),
    fmtNum(s.rsi14, 1), `${fmtNum(s.macd, 2)} / ${fmtNum(s.macdSignal, 2)} / ${fmtNum(s.macdHist, 2)}`,
    `${fmtPrice(s.bollLower)} ~ ${fmtPrice(s.bollUpper)}`, s.bollWidthPctile === null ? '-' : `${fmtNum(s.bollWidthPctile, 0)}%ile`,
    `${fmtPrice(s.atr14)} (${fmtNum(s.atrPct)}%)`, fmtPrice(s.vwma20), s.volumeVsAvg === null ? '-' : `${fmtNum(s.volumeVsAvg)}x`
  ].join(' | '));
  const lv = tfs.map((s) => `- ${tfKo(s.interval)}: 지지 ${s.supports.map(fmtPrice).join(', ') || '-'} / 저항 ${s.resistances.map(fmtPrice).join(', ') || '-'} (구간 고가 ${fmtPrice(s.high)}, 저가 ${fmtPrice(s.low)}, ${s.bars}봉)`);
  const candles = recent.map((c) => `| ${ts(c.openTime)} | ${fmtPrice(c.open)} | ${fmtPrice(c.high)} | ${fmtPrice(c.low)} | ${fmtPrice(c.close)} | ${fmtNum(c.volume, 1)} | ${c.volume > 0 ? fmtNum((c.takerBuyBase / c.volume) * 100, 0) : '-'}% |`);
  return [
    `### ${symbol} 다중 시간대 지표 (바이낸스 USDⓈ-M 선물, 종가 기준)`,
    '| 시간대 | 종가 | 구간 등락 | EMA20 | SMA50 | SMA200 | RSI14 | MACD/시그널/히스토 | 볼린저(하~상) | 밴드폭 백분위 | ATR14(%) | VWMA20 | 거래량/평균 |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r} |`),
    '',
    '#### 스윙 지지/저항 (피벗)',
    ...lv,
    '',
    `#### 최근 ${tfKo(recentTf)} 캔들`,
    '| 시각 | 시가 | 고가 | 저가 | 종가 | 거래량 | 테이커 매수비중 |',
    '|---|---|---|---|---|---|---|',
    ...candles
  ].join('\n');
}

export interface DerivativesInput {
  premium: PremiumIndex | null;
  ticker: Ticker24h | null;
  funding: FundingPoint[];
  oiHist: OiPoint[];
  globalLsr: RatioPoint[];
  topLsr: RatioPoint[];
  taker: RatioPoint[];
  depth: Depth | null;
}

export interface DerivativesSummary {
  markPrice: number | null;
  indexPrice: number | null;
  basisPct: number | null;
  fundingRate: number | null;
  fundingAvg: number | null;
  fundingAnnualPct: number | null;
  nextFundingTime: number | null;
  oiValueNow: number | null;
  oiChange24hPct: number | null;
  oiChange4hPct: number | null;
  globalLsrNow: number | null;
  globalLsr24h: number | null;
  topLsrNow: number | null;
  topLsr24h: number | null;
  takerRatio6h: number | null;
  takerRatio24h: number | null;
  depthImbalance: number | null;
  spreadBps: number | null;
  change24hPct: number | null;
  quoteVolume24h: number | null;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Bid notional / ask notional across the given book levels. >1 = bids heavier. */
export function depthImbalance(d: Depth | null, levels = 20): number | null {
  if (!d || !d.bids.length || !d.asks.length) return null;
  const b = d.bids.slice(0, levels).reduce((a, [p, q]) => a + p * q, 0);
  const s = d.asks.slice(0, levels).reduce((a, [p, q]) => a + p * q, 0);
  return s > 0 ? b / s : null;
}

export function spreadBps(d: Depth | null): number | null {
  if (!d || !d.bids.length || !d.asks.length) return null;
  const bid = d.bids[0][0];
  const ask = d.asks[0][0];
  const mid = (bid + ask) / 2;
  return mid > 0 ? ((ask - bid) / mid) * 10_000 : null;
}

export function summarizeDerivatives(i: DerivativesInput): DerivativesSummary {
  const oi = i.oiHist;
  const oiNow = oi.length ? oi[oi.length - 1].openInterestValue : null;
  const oiAt = (hoursBack: number) => (oi.length > hoursBack ? oi[oi.length - 1 - hoursBack].openInterestValue : null);
  const oi24 = oiAt(24);
  const oi4 = oiAt(4);
  const lastOf = (r: RatioPoint[]) => (r.length ? r[r.length - 1].value : null);
  const backOf = (r: RatioPoint[], n: number) => (r.length > n ? r[r.length - 1 - n].value : null);
  const fundingRates = i.funding.slice(-9).map((f) => f.fundingRate);
  const fundingAvg = avg(fundingRates);
  return {
    markPrice: i.premium?.markPrice ?? null,
    indexPrice: i.premium?.indexPrice ?? null,
    basisPct: i.premium && i.premium.indexPrice ? pct(i.premium.indexPrice, i.premium.markPrice) : null,
    fundingRate: i.premium?.lastFundingRate ?? null,
    fundingAvg,
    // 3 settlements a day × 365.
    fundingAnnualPct: fundingAvg !== null ? fundingAvg * 3 * 365 * 100 : null,
    nextFundingTime: i.premium?.nextFundingTime ?? null,
    oiValueNow: oiNow,
    oiChange24hPct: oiNow !== null && oi24 ? pct(oi24, oiNow) : null,
    oiChange4hPct: oiNow !== null && oi4 ? pct(oi4, oiNow) : null,
    globalLsrNow: lastOf(i.globalLsr),
    globalLsr24h: backOf(i.globalLsr, 24),
    topLsrNow: lastOf(i.topLsr),
    topLsr24h: backOf(i.topLsr, 24),
    takerRatio6h: avg(i.taker.slice(-6).map((r) => r.value)),
    takerRatio24h: avg(i.taker.slice(-24).map((r) => r.value)),
    depthImbalance: depthImbalance(i.depth, 20),
    spreadBps: spreadBps(i.depth),
    change24hPct: i.ticker?.priceChangePercent ?? null,
    quoteVolume24h: i.ticker?.quoteVolume ?? null
  };
}

const usdM = (v: number | null) => (v === null ? '-' : `${fmtNum(v / 1e6, 1)}M USDT`);
const pctS = (v: number | null, dp = 2) => (v === null ? '-' : `${v >= 0 ? '+' : ''}${fmtNum(v, dp)}%`);

export function formatDerivativesBlock(symbol: TradingSymbol, s: DerivativesSummary): string {
  return [
    `### ${symbol} 파생상품 데이터 (바이낸스 USDⓈ-M)`,
    '| 항목 | 값 | 비고 |',
    '|---|---|---|',
    `| 마크가격 / 인덱스가격 | ${fmtPrice(s.markPrice)} / ${fmtPrice(s.indexPrice)} | 베이시스 ${pctS(s.basisPct, 3)} |`,
    `| 현재 펀딩비 | ${s.fundingRate === null ? '-' : `${fmtNum(s.fundingRate * 100, 4)}%`} | 최근 9회 평균 ${s.fundingAvg === null ? '-' : `${fmtNum(s.fundingAvg * 100, 4)}%`}, 연환산 ${pctS(s.fundingAnnualPct, 1)} |`,
    `| 다음 펀딩 시각 | ${s.nextFundingTime ? ts(s.nextFundingTime) : '-'} | 양수=롱이 숏에게 지급 |`,
    `| 미결제약정(OI) | ${usdM(s.oiValueNow)} | 4시간 ${pctS(s.oiChange4hPct)}, 24시간 ${pctS(s.oiChange24hPct)} |`,
    `| 전체 계정 롱/숏 비율 | ${fmtNum(s.globalLsrNow, 2)} | 24시간 전 ${fmtNum(s.globalLsr24h, 2)} |`,
    `| 상위 트레이더 포지션 롱/숏 | ${fmtNum(s.topLsrNow, 2)} | 24시간 전 ${fmtNum(s.topLsr24h, 2)} |`,
    `| 테이커 매수/매도 비율 | 6시간 평균 ${fmtNum(s.takerRatio6h, 3)} | 24시간 평균 ${fmtNum(s.takerRatio24h, 3)} (>1 = 공격적 매수 우위) |`,
    `| 호가 불균형(상위 20호가) | ${fmtNum(s.depthImbalance, 2)} | 매수잔량/매도잔량, 스프레드 ${fmtNum(s.spreadBps, 2)}bp |`,
    `| 24시간 등락 / 거래대금 | ${pctS(s.change24hPct)} | ${usdM(s.quoteVolume24h)} |`
  ].join('\n');
}

export function formatNewsBlock(symbol: TradingSymbol, n: NewsBundle): string {
  const line = (it: NewsBundle['coin'][number]) =>
    `- [${it.publishedAt ? ts(it.publishedAt) : '시각 미상'}] (${it.source}) ${it.title}${it.summary ? ` — ${it.summary.slice(0, 160)}` : ''}`;
  return [
    `### ${symbol.replace('USDT', '')} 관련 헤드라인 (최근 48시간, ${n.coin.length}건)`,
    ...(n.coin.length ? n.coin.map(line) : ['- (해당 기간 관련 헤드라인 없음)']),
    '',
    `### 거시·시장 전반 헤드라인 (${n.macro.length}건)`,
    ...(n.macro.length ? n.macro.map(line) : ['- (해당 기간 관련 헤드라인 없음)']),
    ...(n.errors.length ? ['', `(수집 실패한 피드: ${n.errors.join('; ')})`] : [])
  ].join('\n');
}

export function formatSentimentBlock(symbol: TradingSymbol, fng: FearGreedPoint[], s: DerivativesSummary, news: NewsBundle): string {
  const fngRows = fng.slice(0, 7).map((f) => `| ${ts(f.timestamp).slice(0, 10)} | ${f.value} | ${fngKo(f.classification)} |`);
  return [
    `### 암호화폐 공포·탐욕 지수 (alternative.me)`,
    ...(fngRows.length ? ['| 날짜 | 지수 | 구간 |', '|---|---|---|', ...fngRows] : ['- (지수 수집 실패)']),
    '',
    `### ${symbol} 군중 포지셔닝`,
    `- 전체 계정 롱/숏 비율 ${fmtNum(s.globalLsrNow, 2)} (24시간 전 ${fmtNum(s.globalLsr24h, 2)}), 상위 트레이더 ${fmtNum(s.topLsrNow, 2)} (24시간 전 ${fmtNum(s.topLsr24h, 2)})`,
    `- 펀딩비 ${s.fundingRate === null ? '-' : `${fmtNum(s.fundingRate * 100, 4)}%`}, OI 24시간 ${pctS(s.oiChange24hPct)}, 테이커 비율 6시간 ${fmtNum(s.takerRatio6h, 3)}`,
    '',
    `### 헤드라인 표본 (뉴스 톤 판단용)`,
    ...[...news.coin.slice(0, 10), ...news.macro.slice(0, 5)].map((it) => `- ${it.title}`)
  ].join('\n');
}

export interface AnalysisSnapshot {
  symbol: TradingSymbol;
  takenAt: number;
  price: number;
  markPrice: number;
  fundingRate: number;
  change24hPct: number | null;
  /** Verified numbers every agent must treat as ground truth. */
  verified: string;
  technical: string;
  derivatives: string;
  news: string;
  sentiment: string;
  tf: Record<string, TfSummary>;
  deriv: DerivativesSummary;
  /** Korean notes on data that could not be fetched. */
  notes: string[];
}

export function formatVerifiedBlock(symbol: TradingSymbol, takenAt: number, price: number, s: DerivativesSummary, tf: Record<string, TfSummary>): string {
  return [
    `## 검증된 시세 스냅샷 — ${symbol} @ ${ts(takenAt)}`,
    `- 최종 체결가 ${fmtPrice(price)}, 마크가격 ${fmtPrice(s.markPrice)}, 24시간 ${pctS(s.change24hPct)}`,
    `- ATR14: 1시간 ${fmtPrice(tf['1h']?.atr14)} (${fmtNum(tf['1h']?.atrPct)}%), 4시간 ${fmtPrice(tf['4h']?.atr14)} (${fmtNum(tf['4h']?.atrPct)}%)`,
    `- 펀딩비 ${s.fundingRate === null ? '-' : `${fmtNum(s.fundingRate * 100, 4)}%`} · OI 24시간 ${pctS(s.oiChange24hPct)}`,
    '이 스냅샷의 숫자가 정답이다. 다른 수치와 충돌하면 스냅샷을 따르고 불일치를 명시하라. 주어지지 않은 가격·수치를 지어내지 마라.'
  ].join('\n');
}

export interface ScalpInputs {
  k: Kline[];
  trend: Kline[];
  depth: Depth | null;
  premium: PremiumIndex | null;
  /** Tape and book features (live streams, REST fallback, or a replay). */
  flow?: FlowFeatures | null;
}

/** All market data the desk reads, with small caches so the scalping loop stays light on API weight. */
export class MarketData {
  readonly client: BinanceFuturesClient;
  private readonly fetchImpl: FetchLike;
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  private readonly now: () => number;

  constructor(fetchImpl: FetchLike, opts: { baseUrl?: string; now?: () => number } = {}) {
    this.fetchImpl = fetchImpl;
    this.now = opts.now ?? Date.now;
    this.client = new BinanceFuturesClient({ baseUrl: opts.baseUrl ?? 'https://fapi.binance.com', fetch: fetchImpl, now: this.now });
  }

  private async cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < ttlMs) return hit.value as T;
    const value = await load();
    this.cache.set(key, { at: this.now(), value });
    return value;
  }

  premium(symbol: TradingSymbol, ttlMs = 3000): Promise<PremiumIndex> {
    return this.cached(`prem:${symbol}`, ttlMs, () => this.client.premiumIndex(symbol));
  }

  ticker(symbol: TradingSymbol, ttlMs = 15_000): Promise<Ticker24h> {
    return this.cached(`t24:${symbol}`, ttlMs, () => this.client.ticker24h(symbol));
  }

  klines(symbol: TradingSymbol, interval: string, limit: number, ttlMs = 0): Promise<Kline[]> {
    if (ttlMs <= 0) return this.client.klines(symbol, interval, limit);
    return this.cached(`k:${symbol}:${interval}:${limit}`, ttlMs, () => this.client.klines(symbol, interval, limit));
  }

  async scalpInputs(symbol: TradingSymbol, tf: string, trendTf: string): Promise<ScalpInputs> {
    const [k, trend, depth, premium] = await Promise.all([
      this.client.klines(symbol, tf, 150),
      this.klines(symbol, trendTf, 150, 20_000),
      this.client.depth(symbol, 20).catch(() => null),
      this.premium(symbol).catch(() => null)
    ]);
    return { k, trend, depth, premium };
  }

  /** Everything the four analysts read, fetched in parallel; partial failure degrades to notes. */
  async analysisSnapshot(symbol: TradingSymbol, feeds: readonly string[], want: { news: boolean; sentiment: boolean }): Promise<AnalysisSnapshot> {
    const c = this.client;
    const notes: string[] = [];
    const settle = async <T>(label: string, p: Promise<T>, fallback: T): Promise<T> => {
      try { return await p; } catch (e) {
        notes.push(`${label} 수집 실패: ${e instanceof Error ? e.message : String(e)}`);
        return fallback;
      }
    };
    const [k15, k1h, k4h, k1d, premium, ticker, funding, oiHist, globalLsr, topLsr, taker, depth, news, fng] = await Promise.all([
      settle('15분봉', c.klines(symbol, '15m', 200), []),
      settle('1시간봉', c.klines(symbol, '1h', 300), []),
      settle('4시간봉', c.klines(symbol, '4h', 300), []),
      settle('일봉', c.klines(symbol, '1d', 250), []),
      settle('프리미엄 인덱스', c.premiumIndex(symbol), null),
      settle('24시간 티커', c.ticker24h(symbol), null),
      settle('펀딩비 이력', c.fundingRateHistory(symbol, 30), []),
      settle('OI 이력', c.openInterestHist(symbol, '1h', 48), []),
      settle('롱숏 비율', c.globalLongShortAccountRatio(symbol, '1h', 48), []),
      settle('상위 트레이더 롱숏', c.topLongShortPositionRatio(symbol, '1h', 48), []),
      settle('테이커 비율', c.takerBuySellRatio(symbol, '1h', 48), []),
      settle('호가', c.depth(symbol, 100), null),
      want.news || want.sentiment
        ? settle('뉴스', fetchNews(this.fetchImpl, feeds, symbol, { now: this.now() }), { coin: [], macro: [], errors: [] } as NewsBundle)
        : Promise.resolve({ coin: [], macro: [], errors: [] } as NewsBundle),
      want.sentiment ? settle('공포탐욕지수', fetchFearGreed(this.fetchImpl, 7), [] as FearGreedPoint[]) : Promise.resolve([] as FearGreedPoint[])
    ]);
    if (!k1h.length && !k4h.length) throw new Error(`${symbol} 캔들 데이터를 가져오지 못했습니다 (${notes.join('; ')})`);
    return buildAnalysisSnapshot(symbol, this.now(), { k15, k1h, k4h, k1d, premium, ticker, funding, oiHist, globalLsr, topLsr, taker, depth, news, fng }, notes);
  }
}

export interface SnapshotInputs {
  k15: Kline[];
  k1h: Kline[];
  k4h: Kline[];
  k1d: Kline[];
  premium: PremiumIndex | null;
  ticker: Ticker24h | null;
  funding: FundingPoint[];
  oiHist: OiPoint[];
  globalLsr: RatioPoint[];
  topLsr: RatioPoint[];
  taker: RatioPoint[];
  depth: Depth | null;
  news: NewsBundle;
  fng: FearGreedPoint[];
}

/** The analysts' text blocks from raw market inputs (live fetch or a historical replay). */
export function buildAnalysisSnapshot(symbol: TradingSymbol, takenAt: number, i: SnapshotInputs, notes: string[]): AnalysisSnapshot {
  const { k15, k1h, k4h, k1d, premium, ticker, funding, oiHist, globalLsr, topLsr, taker, depth, news, fng } = i;
  const tf: Record<string, TfSummary> = {};
  for (const [interval, k] of [['15m', k15], ['1h', k1h], ['4h', k4h], ['1d', k1d]] as const) {
    if (k.length) tf[interval] = summarizeTimeframe(interval, k);
  }
  const deriv = summarizeDerivatives({ premium, ticker, funding, oiHist, globalLsr, topLsr, taker, depth });
  const price = ticker?.lastPrice || k1h[k1h.length - 1]?.close || premium?.markPrice || 0;
  const tfs = ['15m', '1h', '4h', '1d'].map((x) => tf[x]).filter(Boolean);
  return {
    symbol,
    takenAt,
    price,
    markPrice: premium?.markPrice ?? price,
    fundingRate: premium?.lastFundingRate ?? 0,
    change24hPct: ticker?.priceChangePercent ?? null,
    verified: formatVerifiedBlock(symbol, takenAt, price, deriv, tf),
    technical: formatTechnicalBlock(symbol, tfs, k1h.slice(-12), '1h'),
    derivatives: formatDerivativesBlock(symbol, deriv),
    news: formatNewsBlock(symbol, news),
    sentiment: formatSentimentBlock(symbol, fng, deriv, news),
    tf,
    deriv,
    notes
  };
}

