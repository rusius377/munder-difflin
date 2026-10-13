'use strict';

/**
 * Synthetic Binance USDⓈ-M responses for the trading-desk tests. Shapes follow
 * the official REST docs (klines arrays of strings, premiumIndex object, …) so
 * the parsers are exercised on the real wire format, without network access.
 */

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const INTERVAL_MS = { '1m': 60e3, '3m': 180e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 };

/** Klines as Binance returns them: arrays of strings. `drift` per bar (fraction). */
function makeKlines({ n = 200, start = 60000, drift = 0.0005, vol = 0.002, interval = '1m', endTime = Date.UTC(2026, 9, 13, 9, 0), seed = 7, takerBias = 0.5 } = {}) {
  const r = rng(seed);
  const step = INTERVAL_MS[interval] || 60e3;
  const rows = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    const open = price;
    const change = drift + (r() - 0.5) * 2 * vol;
    const close = open * (1 + change);
    const high = Math.max(open, close) * (1 + r() * vol * 0.5);
    const low = Math.min(open, close) * (1 - r() * vol * 0.5);
    const volume = 100 + r() * 50;
    const t = endTime - (n - i) * step;
    const takerBuy = volume * Math.min(0.95, Math.max(0.05, takerBias + (r() - 0.5) * 0.1));
    rows.push([t, open.toFixed(2), high.toFixed(2), low.toFixed(2), close.toFixed(2), volume.toFixed(3), t + step - 1,
      (volume * close).toFixed(2), 1000, takerBuy.toFixed(3), (takerBuy * close).toFixed(2), '0']);
    price = close;
  }
  return rows;
}

const EXCHANGE_INFO = {
  symbols: [
    { symbol: 'BTCUSDT', filters: [
      { filterType: 'PRICE_FILTER', tickSize: '0.10', minPrice: '261.10', maxPrice: '809484' },
      { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '1000' },
      { filterType: 'MARKET_LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '120' },
      { filterType: 'MIN_NOTIONAL', notional: '100' }
    ] },
    { symbol: 'ETHUSDT', filters: [
      { filterType: 'PRICE_FILTER', tickSize: '0.01' },
      { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '10000' },
      { filterType: 'MARKET_LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '2000' },
      { filterType: 'MIN_NOTIONAL', notional: '20' }
    ] }
  ]
};

const RSS = `<?xml version="1.0"?><rss><channel>
<item><title><![CDATA[Bitcoin ETF inflows hit $1.2B as BTC tests $64K]]></title><link>https://example.com/a</link><pubDate>Tue, 13 Oct 2026 08:00:00 GMT</pubDate><description>&lt;p&gt;Spot bitcoin ETFs saw strong inflows.&lt;/p&gt;</description></item>
<item><title>Ethereum upgrade date set</title><link>https://example.com/b</link><pubDate>Tue, 13 Oct 2026 07:00:00 GMT</pubDate><description>ETH devs agree.</description></item>
<item><title>Fed's Powell signals patience on rate cuts</title><link>https://example.com/c</link><pubDate>Tue, 13 Oct 2026 06:00:00 GMT</pubDate></item>
<item><title>Celebrity launches NFT shoe line</title><link>https://example.com/d</link><pubDate>Tue, 13 Oct 2026 05:00:00 GMT</pubDate></item>
<item><title>Old bitcoin story</title><link>https://example.com/e</link><pubDate>Tue, 01 Sep 2026 05:00:00 GMT</pubDate></item>
</channel></rss>`;

function ratioRows(n, base) {
  const now = Date.UTC(2026, 9, 13, 9, 0);
  return Array.from({ length: n }, (_, i) => ({
    symbol: 'BTCUSDT', longShortRatio: String(base + i * 0.01), longAccount: '0.6', shortAccount: '0.4',
    buySellRatio: String(1 + (i % 3) * 0.05), buyVol: '10', sellVol: '9', timestamp: now - (n - i) * 3600e3
  }));
}

/**
 * A fetch() stand-in: routes Binance/feeds URLs to fixtures. `opts.klines`
 * lets a test choose the candle generator per interval.
 */
function makeFetch(opts = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const u = new URL(url);
    const p = u.pathname;
    const q = Object.fromEntries(u.searchParams);
    const ok = (body) => ({ ok: true, status: 200, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
    if (opts.override) {
      const r = opts.override(u, init);
      if (r) return r;
    }
    if (u.hostname === 'api.alternative.me') return ok({ data: [{ value: '72', value_classification: 'Greed', timestamp: '1760313600' }, { value: '65', value_classification: 'Greed', timestamp: '1760227200' }] });
    if (!u.hostname.includes('binance')) return ok(RSS);
    switch (p) {
      case '/fapi/v1/time': return ok({ serverTime: Date.now() });
      case '/fapi/v1/klines': {
        const gen = (opts.klines && opts.klines[q.interval]) || {};
        return ok(makeKlines({ n: Number(q.limit) || 200, interval: q.interval, ...gen }));
      }
      case '/fapi/v1/premiumIndex': return ok({ symbol: q.symbol, markPrice: opts.mark || '64000.00', indexPrice: '63990.00', lastFundingRate: '0.00010000', nextFundingTime: Date.UTC(2026, 9, 13, 16, 0), time: Date.now() });
      case '/fapi/v1/ticker/24hr': return ok({ symbol: q.symbol, lastPrice: opts.last || '64000.00', priceChangePercent: '2.150', highPrice: '64500', lowPrice: '62000', quoteVolume: '12000000000' });
      case '/fapi/v1/fundingRate': return ok(Array.from({ length: 9 }, (_, i) => ({ symbol: q.symbol, fundingTime: i, fundingRate: '0.0001' })));
      case '/futures/data/openInterestHist': return ok(Array.from({ length: 48 }, (_, i) => ({ symbol: q.symbol, sumOpenInterest: String(80000 + i * 100), sumOpenInterestValue: String(5e9 + i * 1e7), timestamp: i })));
      case '/futures/data/globalLongShortAccountRatio':
      case '/futures/data/topLongShortPositionRatio':
      case '/futures/data/takerlongshortRatio': return ok(ratioRows(48, 1.2));
      case '/fapi/v1/depth': return ok({ bids: Array.from({ length: 20 }, (_, i) => [String(63999.9 - i * 0.1), opts.bidQty || '3']), asks: Array.from({ length: 20 }, (_, i) => [String(64000 + i * 0.1), '2']) });
      case '/fapi/v1/exchangeInfo': return ok(EXCHANGE_INFO);
      default: return { ok: false, status: 404, text: async () => JSON.stringify({ code: -1, msg: `no fixture for ${p}` }) };
    }
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

module.exports = { makeKlines, makeFetch, EXCHANGE_INFO, RSS, rng };
