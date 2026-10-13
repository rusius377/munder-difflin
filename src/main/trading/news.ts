/**
 * News + sentiment inputs for the news and sentiment analysts.
 *
 * TradingAgents' news analyst calls Yahoo/Alpha Vantage tools; a crypto perp
 * desk reads crypto media instead. We pull a handful of public RSS feeds and the
 * alternative.me Crypto Fear & Greed index, then hand the analysts the raw
 * headlines — the model reports on data it was given rather than inventing it.
 *
 * Parsing is a tolerant regex reader for RSS 2.0 <item> and Atom <entry>; it
 * never executes or follows anything in the feed.
 */
import type { FetchLike } from './binance';
import type { TradingSymbol } from '../../shared/trading';

export interface NewsItem {
  title: string;
  link: string;
  source: string;
  publishedAt: number | null;
  summary: string;
}

export interface FearGreedPoint {
  value: number;
  classification: string;
  timestamp: number;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' '
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&[a-z]+;|&#39;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
}

export function stripHtml(s: string): string {
  // Feeds often entity-encode their HTML (&lt;p&gt;), so strip tags both before
  // and after decoding; the text never reaches a renderer as HTML either way.
  const once = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ');
  return decodeEntities(once).replace(/<\/?[a-z][^>]*>/gi, ' ').replace(/\s+/g, ' ').trim();
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
}

function atomLink(block: string): string {
  const m = block.match(/<link[^>]*href="([^"]+)"/i);
  return m ? m[1] : '';
}

export function parseFeed(xml: string, source: string): NewsItem[] {
  const items: NewsItem[] = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  for (const b of blocks) {
    const title = stripHtml(tag(b, 'title'));
    if (!title) continue;
    const link = stripHtml(tag(b, 'link')) || atomLink(b);
    const dateRaw = stripHtml(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date'));
    const t = dateRaw ? Date.parse(dateRaw) : NaN;
    const summary = stripHtml(tag(b, 'description') || tag(b, 'summary')).slice(0, 280);
    items.push({ title: title.slice(0, 240), link: link.slice(0, 400), source, publishedAt: Number.isFinite(t) ? t : null, summary });
  }
  return items;
}

const SYMBOL_KEYWORDS: Record<TradingSymbol, RegExp> = {
  BTCUSDT: /\b(bitcoin|btc)\b/i,
  ETHUSDT: /\b(ethereum|ether|eth)\b/i
};

/** Market-wide drivers worth keeping even when the coin is not named. */
const MACRO_KEYWORDS = /\b(fed|fomc|powell|cpi|pce|inflation|rate (cut|hike)|treasury|yields?|dollar|dxy|etfs?|sec|cftc|regulat\w*|tariffs?|stablecoins?|liquidat\w*|crypto market|risk[- ]off|recession|jobs report|payrolls|geopolit\w*)\b/i;

export function classifyNews(items: NewsItem[], symbol: TradingSymbol): { coin: NewsItem[]; macro: NewsItem[] } {
  const coin: NewsItem[] = [];
  const macro: NewsItem[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const key = it.title.toLowerCase().replace(/\W+/g, ' ').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    const text = `${it.title} ${it.summary}`;
    if (SYMBOL_KEYWORDS[symbol].test(text)) coin.push(it);
    else if (MACRO_KEYWORDS.test(text)) macro.push(it);
  }
  const byTime = (a: NewsItem, b: NewsItem) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0);
  return { coin: coin.sort(byTime), macro: macro.sort(byTime) };
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

async function getText(fetchImpl: FetchLike, url: string, timeoutMs = 10_000): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': 'MunderDifflin-TradingDesk/1.0 (+https://munderdiffl.in)', Accept: 'application/rss+xml, application/xml, text/xml, application/json' },
      signal: ctl.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

export interface NewsBundle {
  coin: NewsItem[];
  macro: NewsItem[];
  /** Korean notes about feeds that failed. */
  errors: string[];
}

/** Fetch every feed (in parallel), keep the last `lookbackHours`, split coin vs macro. */
export async function fetchNews(
  fetchImpl: FetchLike,
  feeds: readonly string[],
  symbol: TradingSymbol,
  opts: { lookbackHours?: number; now?: number; coinLimit?: number; macroLimit?: number } = {}
): Promise<NewsBundle> {
  const now = opts.now ?? Date.now();
  const cutoff = now - (opts.lookbackHours ?? 48) * 3_600_000;
  const errors: string[] = [];
  const all: NewsItem[] = [];
  const results = await Promise.allSettled(feeds.map((u) => getText(fetchImpl, u)));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') all.push(...parseFeed(r.value, hostOf(feeds[i])));
    else errors.push(`${hostOf(feeds[i])}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
  });
  // Undated items are kept (some feeds omit dates) but sort last.
  const recent = all.filter((it) => it.publishedAt === null || (it.publishedAt >= cutoff && it.publishedAt <= now + 3_600_000));
  const { coin, macro } = classifyNews(recent, symbol);
  return { coin: coin.slice(0, opts.coinLimit ?? 15), macro: macro.slice(0, opts.macroLimit ?? 10), errors };
}

export async function fetchFearGreed(fetchImpl: FetchLike, days = 7): Promise<FearGreedPoint[]> {
  const text = await getText(fetchImpl, `https://api.alternative.me/fng/?limit=${days}`);
  const j = JSON.parse(text) as { data?: Array<{ value?: string; value_classification?: string; timestamp?: string }> };
  return (j.data ?? []).map((d) => ({
    value: Number(d.value ?? NaN),
    classification: String(d.value_classification ?? ''),
    timestamp: Number(d.timestamp ?? 0) * 1000
  })).filter((d) => Number.isFinite(d.value));
}

const FNG_KO: Record<string, string> = {
  'Extreme Fear': '극단적 공포',
  Fear: '공포',
  Neutral: '중립',
  Greed: '탐욕',
  'Extreme Greed': '극단적 탐욕'
};

export function fngKo(classification: string): string {
  return FNG_KO[classification] ?? classification;
}
