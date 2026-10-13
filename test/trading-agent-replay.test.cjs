'use strict';

/**
 * Trading desk — agent-team replay training ("에이전트 리플레이 훈련"). Pins:
 *   - masking shifts every date by whole weeks into 2031 and scales every
 *     price, so no real year or real price level reaches a prompt, and the
 *     decision's prices are scaled back before the trade is walked;
 *   - the news analyst sits out, replay sessions use their own folders, and an
 *     agent sees only the record it had before the replayed moment;
 *   - trades walk forward on 1-minute candles (stop first on a two-sided bar);
 *   - with "learn", every directional call is scored and marked as replay, and
 *     outcomes land in the agents' and the desk's lessons.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { makeKlines } = require('./fixtures/trading-fixtures.cjs');

const ar = loadTs('src/main/trading/agentReplay.ts');
const { AgentProjects } = loadTs('src/main/trading/agentProjects.ts');
const { aggregateKlines } = loadTs('src/main/trading/histData.ts');
const { parseKlines } = loadTs('src/main/trading/binance.ts');
const { fmtPrice } = loadTs('src/main/trading/indicators.ts');
const shared = loadTs('src/shared/trading.ts');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'desk-ar-'));

test('masking: whole-week shift into 2031, price scale away from 1, decisions scale back', () => {
  const t = Date.UTC(2026, 8, 10, 16);
  for (const r of [0, 0.1, 0.49, 0.5, 0.9, 0.999]) {
    const m = ar.makeMask(t, () => r);
    assert.equal(m.shiftMs % (7 * DAY), 0);
    assert.equal(new Date(t + m.shiftMs).getUTCFullYear(), 2031);
    assert.equal(new Date(t + m.shiftMs).getUTCDay(), new Date(t).getUTCDay(), 'weekday survives');
    assert.ok((m.scale >= 0.55 && m.scale < 0.85) || (m.scale >= 1.25 && m.scale <= 1.7), `scale ${m.scale}`);
  }
  const m = { shiftMs: 7 * DAY, scale: 0.5 };
  const k = ar.maskKlines([{ openTime: 0, closeTime: 59_999, open: 100, high: 110, low: 90, close: 105, volume: 3, quoteVolume: 300, trades: 1, takerBuyBase: 1, takerBuyQuote: 100 }], m);
  assert.deepEqual([k[0].openTime, k[0].open, k[0].high, k[0].close, k[0].volume, k[0].quoteVolume], [7 * DAY, 50, 55, 52.5, 3, 150]);
  const d = ar.unmaskDecision({ rating: 'Buy', action: 'LONG', entryPrice: 50, stopLoss: 49, takeProfit: 52, confidence: 0.6 }, m);
  assert.deepEqual([d.entryPrice, d.stopLoss, d.takeProfit], [100, 98, 104]);
});

test('walkTrade: stop first when a candle touches both; holds until the horizon', () => {
  const c = (i, o, h, l, cl) => ({ openTime: i * 60_000, closeTime: i * 60_000 + 59_999, open: o, high: h, low: l, close: cl });
  const pathK = [c(0, 100, 101, 99.5, 100.5), c(1, 100.5, 103, 98, 101), c(2, 101, 104, 100, 103)];
  assert.deepEqual(ar.walkTrade('LONG', 99, 102, pathK, 10 * 60_000), { exitTime: 119_999, exitPrice: 99, reason: '손절' });
  assert.deepEqual(ar.walkTrade('SHORT', 105, 99.6, pathK, 10 * 60_000), { exitTime: 59_999, exitPrice: 99.6, reason: '익절' });
  assert.deepEqual(ar.walkTrade('LONG', 90, 200, pathK, 2 * 60_000), { exitTime: 119_999, exitPrice: 101, reason: '보유 기간 종료' });
  const times = ar.episodeTimes(0, 66 * HOUR, 2, 6 * HOUR);
  assert.deepEqual(times, [16 * HOUR, 49 * HOUR]);
  assert.equal(ar.episodeTimes(0, 10 * HOUR, 30, 4 * HOUR).length, 2, 'never closer than the scoring horizon');
});

// ─── a full masked run with the mock team ────────────────────────────────────

const FROM = Date.UTC(2026, 8, 10);
const NOW = Date.UTC(2026, 8, 20);
const SERIES_START = Date.UTC(2026, 7, 25);
const series = parseKlines(makeKlines({ n: (Date.UTC(2026, 8, 14) - SERIES_START) / 60_000, start: 61000, drift: 0.000004, vol: 0.0009, interval: '1m', endTime: Date.UTC(2026, 8, 14), seed: 21 }));
const TF = { '15m': 15, '1h': 60, '4h': 240, '1d': 1440 };

function market() {
  return {
    async klinesBefore(symbol, interval, t, count) {
      if (interval === '4h' || interval === '1d') {
        const step = TF[interval] * 60_000;
        const last = series.filter((k) => k.openTime < t).slice(-1)[0];
        return parseKlines(makeKlines({ n: count, start: last.close * 0.8, drift: 0.0008, vol: 0.004, interval, endTime: t - (t % step), seed: 5 }));
      }
      return aggregateKlines(series.filter((k) => k.openTime < t - (t % (TF[interval] * 60_000))), TF[interval]).slice(-count);
    },
    async fundingBefore(symbol, t) { return Array.from({ length: 6 }, (_, i) => ({ fundingTime: t - t % (8 * HOUR) - i * 8 * HOUR, fundingRate: 0.0001 })).reverse(); },
    async oiBefore() { return []; },
    async ratioBefore() { return []; },
    async fearGreedBefore(t) { return [{ value: 55, classification: 'Greed', timestamp: t - (t % DAY) }]; }
  };
}

test('agent replay: masked prompts, memory only from before t, trades walked and learned', async () => {
  const dir = tmpDir();
  const cfg = shared.normalizeTradingConfig({
    mode: 'agents', symbols: ['BTCUSDT'],
    teams: { analystsPerRole: 1, researchersPerSide: 1, traders: 1, riskPerStance: 1, portfolioCommittee: 1, biasPanel: 1 }
  });
  const projects = new AgentProjects(path.join(dir, 'agents'), () => NOW);
  const req = shared.normalizeBacktestRequest({ mode: 'agents', symbol: 'BTCUSDT', fromDay: '2026-09-10', toDay: '2026-09-12', episodes: 2, horizonHours: 6, maskHistory: true, learn: true }, cfg);
  const times = ar.episodeTimes(FROM, Date.UTC(2026, 8, 13) - 6 * HOUR, 2, 6 * HOUR);
  assert.equal(times.length, 2);
  const rand = () => 0.1;
  const masks = times.map((t) => ar.makeMask(t, rand));
  const entryOpen = times.map((t) => series.find((k) => k.openTime >= t + 60_000).open);
  const realClose = times.map((t) => series.filter((k) => k.closeTime < t).slice(-1)[0].close);

  // The trader's record: one call before the first moment, one after the last.
  const trader = shared.agentRef('trader');
  projects.recordOpinion(trader, { ts: times[0] - 10 * HOUR, symbol: 'BTCUSDT', runId: 'old', kind: 'pipeline', vote: 'LONG', confidence: 0.6, price: 60000, horizonMs: 4 * HOUR, summary: 'past' });
  const fut = projects.recordOpinion(trader, { ts: times[1] + HOUR, symbol: 'BTCUSDT', runId: 'new', kind: 'pipeline', vote: 'SHORT', confidence: 0.7, price: 60000, horizonMs: 4 * HOUR, summary: 'future' });
  projects.score('trader', fut.id, 59000);
  const expectedMemory = projects.memoryBlock('trader', 'BTCUSDT', { before: times[0], relative: true });
  assert.ok(expectedMemory.includes('롱') && !/시간 전 숏/.test(expectedMemory));

  let pmCalls = 0;
  const calls = [];
  const llm = {
    label: 'mock',
    async complete(call) {
      calls.push(call);
      const role = call.role.split('-')[0].replace(/_(\d+|lead)$/, '');
      switch (role) {
        case 'researchManager': return '**Rating**: Overweight\n\n강세 우위.';
        case 'trader': return '**Action**: LONG\n\nFINAL TRANSACTION PROPOSAL: **LONG**';
        case 'portfolioManager': {
          const i = Math.min(pmCalls++, times.length - 1);
          const s = masks[i].scale;
          const sl = +(entryOpen[i] * 0.99 * s).toFixed(1);
          const tp = +(entryOpen[i] * 1.015 * s).toFixed(1);
          return `**Rating**: Overweight\n\n\`\`\`json\n{"rating":"Overweight","action":"LONG","entryType":"MARKET","entryPrice":null,"stopLoss":${sl},"takeProfit":${tp},"leverage":5,"riskPct":0.5,"confidence":0.65,"horizonHours":6,"summary":"롱"}\n\`\`\``;
        }
        default: return `${role} 보고서\n\n**판단**: 강세`;
      }
    }
  };
  const deskLessons = [];
  const progress = [];
  const out = await ar.runAgentReplay(req, {
    llm, market: market(), cfg, projects,
    history: { klines1m: async (symbol, from, to) => ({ k: series.filter((k) => k.openTime >= from && k.openTime < to), fromRest: [] }) },
    addDeskLesson: (symbol, line) => deskLessons.push(line),
    onProgress: (p, m) => progress.push([p, m]), aborted: () => false, rand, now: () => NOW
  });

  // Prompts: no news analyst, replay sessions, no real year or price level.
  assert.ok(!calls.some((c) => c.role.startsWith('news')), 'the news analyst sits out');
  assert.ok(calls.every((c) => c.role.endsWith('-replay-BTCUSDT')), 'replay sessions are separate');
  for (const c of calls) {
    const text = `${c.system}\n${c.prompt}`;
    assert.ok(!/2026/.test(text), `${c.role} saw the real year`);
    for (const p of realClose) assert.ok(!text.includes(fmtPrice(p)), `${c.role} saw a real price ${fmtPrice(p)}`);
  }
  assert.ok(calls.some((c) => /2031/.test(c.prompt)), 'dates are shown in the masked year');
  const firstTrader = calls.find((c) => c.role.startsWith('trader'));
  assert.ok(firstTrader.system.includes(expectedMemory), 'the trader is reminded of its record before t');
  assert.ok(!/시간 전 숏/.test(firstTrader.system), 'and not of a call made after t');

  // Decisions scaled back and walked on real candles.
  assert.equal(out.episodes.length, 2);
  out.episodes.forEach((ep, i) => {
    assert.equal(ep.error, undefined, ep.error);
    assert.equal(ep.action, 'LONG');
    assert.ok(Math.abs(ep.stopLoss - entryOpen[i] * 0.99) < 1, `stop ${ep.stopLoss} vs ${entryOpen[i] * 0.99}`);
    assert.ok(ep.outcome && ['손절', '익절', '보유 기간 종료'].includes(ep.outcome.reason));
    assert.ok(ep.calls >= 2, 'trader and portfolio manager made directional calls');
    assert.ok(typeof ep.horizonMovePct === 'number');
  });
  assert.equal(out.trades.length, 2);
  for (const t of out.trades) assert.ok(t.leverage <= cfg.agents.maxLeverage);
  assert.ok(out.notes.some((n) => /뉴스 분석가/.test(n)));
  assert.ok(progress.length >= 4 && progress[progress.length - 1][0] === 1);

  // Learned: replay calls scored in the agents' records, lessons written.
  const rec = JSON.parse(fs.readFileSync(path.join(dir, 'agents', 'trader', 'record.json'), 'utf8'));
  const replays = rec.opinions.filter((o) => o.replay);
  assert.equal(replays.length, 2);
  assert.ok(replays.every((o) => o.scoredAt !== undefined && o.priceAfter > 0 && typeof o.hit === 'boolean'));
  assert.ok(replays.every((o) => Math.abs(o.price - realClose[times.indexOf(o.ts)]) < 1e-6), 'scored at real prices');
  assert.match(fs.readFileSync(path.join(dir, 'agents', 'trader', 'scorecard.md'), 'utf8'), /리플레이/);
  assert.match(fs.readFileSync(path.join(dir, 'agents', 'trader', 'lessons.md'), 'utf8'), /\[과거 리플레이\]/);
  assert.equal(deskLessons.length, 2);
  assert.match(deskLessons[0], /^\[과거 리플레이\] .* KST BTCUSDT .*진입/);
});

test('agent replay: a period shorter than the hold is refused; abort stops between moments', async () => {
  const cfg = shared.normalizeTradingConfig({ mode: 'agents' });
  const base = {
    llm: { label: 'x', complete: async () => '' }, market: market(), cfg, projects: null,
    history: { klines1m: async () => ({ k: [], fromRest: [] }) }, addDeskLesson: () => {}, onProgress: () => {}, now: () => NOW
  };
  const short = shared.normalizeBacktestRequest({ mode: 'agents', fromDay: '2026-09-10', toDay: '2026-09-10', horizonHours: 48 }, cfg);
  await assert.rejects(ar.runAgentReplay(short, { ...base, aborted: () => false }), /보유 시간/);
  const req = shared.normalizeBacktestRequest({ mode: 'agents', fromDay: '2026-09-10', toDay: '2026-09-12', episodes: 3, horizonHours: 6 }, cfg);
  const out = await ar.runAgentReplay(req, { ...base, aborted: () => true });
  assert.equal(out.episodes.length, 0);
  assert.ok(out.notes.some((n) => /멈췄/.test(n)));
});
