'use strict';

/**
 * Trading desk — the TradingAgents pipeline and the engine end-to-end, on the
 * paper venue, with Binance and the LLM both replaced by fixtures. Pins:
 *   - the debate runs in TradingAgents order with the configured round counts;
 *   - every agent sees the verified snapshot and is told to answer in Korean;
 *   - the portfolio manager's JSON reaches the risk engine and opens a paper
 *     position with a stop and a target;
 *   - analysis-only runs never place orders;
 *   - scalping mode evaluates signals and consults the bias desk.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { makeFetch } = require('./fixtures/trading-fixtures.cjs');

const { runPipeline } = loadTs('src/main/trading/agents.ts');
const { TradingEngine } = loadTs('src/main/trading/engine.ts');
const { MarketData } = loadTs('src/main/trading/marketData.ts');
const shared = loadTs('src/shared/trading.ts');

const FLAT = { start: 64000, drift: 0.00005, vol: 0.0008 };
const fixtureFetch = () => makeFetch({ klines: { '1m': FLAT, '3m': FLAT, '5m': FLAT, '15m': FLAT, '1h': FLAT, '4h': FLAT, '1d': FLAT } });

const PM_JSON = (sl, tp) => `**Rating**: Overweight\n\n요약: 롱 우위.\n\n투자 논리: 추세 지속.\n\n\`\`\`json\n{"rating":"Overweight","action":"LONG","entryType":"MARKET","entryPrice":null,"stopLoss":${sl},"takeProfit":${tp},"leverage":4,"riskPct":0.8,"confidence":0.7,"horizonHours":24,"summary":"상승 추세와 펀딩 중립으로 롱 우위"}\n\`\`\``;

function mockLlm(opts = {}) {
  const calls = [];
  return {
    calls,
    label: 'mock',
    async complete(call) {
      calls.push(call);
      // "trader_2-BTCUSDT" → "trader": staffed seats and team leads answer like their role.
      const role = call.role.split('-')[0].replace(/_(\d+|lead)$/, '');
      if (opts.fail && opts.fail(role)) throw new Error(`mock failure for ${role}`);
      switch (role) {
        case 'researchManager': return '**Rating**: Overweight\n\n**근거**: 강세 측이 우세.\n\n**전략적 실행 방안**: 소규모 롱.';
        case 'trader': return '**Action**: LONG\n\n근거...\n\nFINAL TRANSACTION PROPOSAL: **LONG**';
        case 'portfolioManager': return opts.pm ?? PM_JSON(63000, 66500);
        case 'biasDesk': return '근거: 단기 상승.\n```json\n{"bias":"LONG_ONLY","confidence":0.66,"note":"상승 추세 유지"}\n```';
        case 'reflection': return '교훈: 손절 폭이 적절했다.';
        default: return `${role} 보고서 내용\n\n| 항목 | 값 |\n|---|---|\n| 결론 | 중립 |`;
      }
    }
  };
}

async function snapshotFor(symbol = 'BTCUSDT') {
  const md = new MarketData(fixtureFetch());
  return md.analysisSnapshot(symbol, ['https://feeds.example.com/rss'], { news: true, sentiment: true });
}

test('market snapshot builds Korean blocks from Binance-shaped fixtures', async () => {
  const s = await snapshotFor();
  assert.equal(s.price, 64000);
  assert.match(s.verified, /검증된 시세 스냅샷/);
  assert.match(s.technical, /다중 시간대 지표/);
  assert.match(s.derivatives, /미결제약정/);
  assert.match(s.news, /Bitcoin ETF inflows/);
  assert.match(s.sentiment, /공포·탐욕/);
  assert.ok(s.tf['1h'] && s.tf['4h'] && s.tf['1d'] && s.tf['15m']);
  assert.ok(s.deriv.fundingRate > 0);
  assert.deepEqual(s.notes, []);
});

test('pipeline runs analysts in parallel, then 2 bull/bear rounds and 2 risk rounds in TradingAgents order', async () => {
  const snapshot = await snapshotFor();
  const llm = mockLlm();
  const steps = [];
  const ctx = { symbol: 'BTCUSDT', snapshot, portfolio: '- 현재 BTCUSDT 포지션: 없음', lessons: '- 지난번 손절이 너무 좁았다', constraints: { maxLeverage: 10, riskPerTradePct: 1, minRewardRisk: 1.5, minConfidence: 0.55, defaultLeverage: 3, venueLabel: '모의투자' } };
  const r = await runPipeline({ ctx, analysts: ['technical', 'derivatives', 'news', 'sentiment'], debateRounds: 2, riskRounds: 2 }, { llm, onStep: (s) => steps.push(s) });
  const order = llm.calls.map((c) => c.role.split('-')[0]);
  assert.deepEqual(new Set(order.slice(0, 4)), new Set(['technical', 'derivatives', 'news', 'sentiment']));
  assert.deepEqual(order.slice(4), ['bull', 'bear', 'bull', 'bear', 'researchManager', 'trader',
    'aggressive', 'conservative', 'neutral', 'aggressive', 'conservative', 'neutral', 'portfolioManager']);
  // Tiers: managers deep, everyone else quick.
  for (const c of llm.calls) assert.equal(c.tier, /researchManager|portfolioManager/.test(c.role) ? 'deep' : 'quick', c.role);
  // Every prompt is Korean-language and grounded.
  for (const c of llm.calls) assert.match(c.system + c.prompt, /한국어/, `${c.role} lacks the language rule`);
  for (const c of llm.calls.filter((x) => /^(technical|derivatives|bull|bear|trader|portfolioManager)/.test(x.role))) {
    assert.match(c.prompt, /검증된 시세 스냅샷/, `${c.role} lacks the verified snapshot`);
  }
  // The bear sees the bull's argument; the PM sees the lessons.
  const bear = llm.calls.find((c) => c.role.startsWith('bear'));
  assert.match(bear.prompt, /강세 연구원: bull 보고서 내용/);
  assert.match(llm.calls.find((c) => c.role.startsWith('portfolioManager')).prompt, /지난번 손절이 너무 좁았다/);
  assert.equal(r.researchRating, 'Overweight');
  assert.equal(r.traderAction, 'LONG');
  assert.equal(r.decision.action, 'LONG');
  assert.equal(r.decision.stopLoss, 63000);
  assert.equal(r.parsedJson, true);
  assert.ok(steps.some((s) => s.role === 'portfolioManager' && s.state === 'done'));
});

test('a failed analyst does not sink the run; a PM without JSON gets one repair turn', async () => {
  const snapshot = await snapshotFor();
  let repairCalls = 0;
  const llm = mockLlm({ fail: (role) => role === 'news', pm: '**Rating**: Hold\n\n관망.' });
  const orig = llm.complete;
  llm.complete = async (call) => {
    if (call.role.startsWith('portfolioManager') && call.tier === 'quick') { repairCalls++; return '```json\n{"rating":"Hold","action":"HOLD","confidence":0.4,"summary":"관망"}\n```'; }
    return orig.call(llm, call);
  };
  const steps = [];
  const ctx = { symbol: 'BTCUSDT', snapshot, portfolio: '-', lessons: '', constraints: { maxLeverage: 10, riskPerTradePct: 1, minRewardRisk: 1.5, minConfidence: 0.55, defaultLeverage: 3, venueLabel: '모의투자' } };
  const r = await runPipeline({ ctx, analysts: ['technical', 'news'], debateRounds: 1, riskRounds: 1 }, { llm, onStep: (s) => steps.push(s) });
  assert.ok(steps.some((s) => s.role === 'news' && s.state === 'error'));
  assert.ok(steps.some((s) => s.role === 'sentiment' && s.state === 'skipped'));
  assert.match(llm.calls.find((c) => c.role.startsWith('bull')).prompt, /뉴스 보고서 없음/);
  assert.equal(repairCalls, 1);
  assert.equal(r.parsedJson, true);
  assert.equal(r.decision.action, 'HOLD');
});

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'md-trade-')); }

async function waitFor(fn, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out');
}

test('engine (paper, agents mode): pipeline decision opens a protected paper position and writes the report', async () => {
  const dir = tmpDir();
  const llm = mockLlm();
  const cfg = shared.normalizeTradingConfig({ mode: 'agents', venue: 'paper', symbols: ['BTCUSDT'] });
  let last = null;
  const eng = new TradingEngine(cfg, { fetch: fixtureFetch(), dataDir: dir, getSecret: () => undefined, createLlm: () => llm, emit: (s) => { last = s; } });
  await eng.start();
  try {
    const run = await waitFor(() => { const s = eng.getSnapshot(); return s.runs[0] && s.runs[0].finishedAt ? s.runs[0] : null; });
    assert.equal(run.error, undefined, run.error);
    assert.equal(run.decision.action, 'LONG');
    assert.equal(run.verdict.approved, true, run.verdict.reason);
    await eng.tick();
    const s = eng.getSnapshot();
    assert.equal(s.positions.length, 1);
    const p = s.positions[0];
    assert.equal(p.side, 'LONG');
    assert.equal(p.source, 'agents');
    assert.ok(p.stopLoss > 0 && p.stopLoss < p.entryPrice && p.takeProfit > p.entryPrice);
    assert.ok(p.leverage <= cfg.risk.maxLeverage);
    assert.ok(fs.existsSync(run.reportPath), 'report written');
    const report = fs.readFileSync(run.reportPath, 'utf8');
    assert.match(report, /트레이딩 에이전트 보고서/);
    // Default teams: a 3-seat portfolio committee voted (all LONG → unanimous, full size).
    assert.match(report, /포트폴리오 위원회 결정/);
    assert.match(report, /팀 구성: 분석가 역할당 2명/);
    assert.equal(run.committee.outcome, 'LONG');
    assert.equal(run.committee.agree, 3);
    const journal = fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8');
    assert.match(journal, /"type":"decision"/);
    assert.match(journal, /"type":"entry"/);
    assert.ok(s.account && s.account.equity > 0);
    await waitFor(() => last, 2000);
    assert.equal(last.positions.length, 1, 'emitted snapshot carries the position');
    assert.ok(s.nextRunAt.BTCUSDT > Date.now());
  } finally {
    await eng.stop();
    eng.dispose();
  }
});

test('engine: analysis-only run (engine stopped) never places an order', async () => {
  const dir = tmpDir();
  const eng = new TradingEngine(shared.normalizeTradingConfig({ mode: 'agents', venue: 'paper', symbols: ['ETHUSDT'] }), {
    fetch: fixtureFetch(), dataDir: dir, getSecret: () => undefined, createLlm: () => mockLlm(), emit: () => {}
  });
  await eng.runNow('ETHUSDT');
  const s = eng.getSnapshot();
  assert.equal(s.runs[0].decision.action, 'LONG');
  assert.equal(s.positions.length, 0);
  const exec = s.runs[0].steps.find((x) => x.role === 'execution');
  assert.match(exec.content, /분석 전용/);
  assert.ok(!fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8').includes('"type":"entry"'));
  eng.dispose();
});

test('engine: demo/live without keys refuses to start; live needs acknowledgement', async () => {
  const dir = tmpDir();
  const eng = new TradingEngine(shared.normalizeTradingConfig({ venue: 'demo' }), { fetch: fixtureFetch(), dataDir: dir, getSecret: () => undefined, createLlm: () => mockLlm(), emit: () => {} });
  await assert.rejects(eng.start(), /API 키/);
  assert.equal(eng.getSnapshot().status, 'error');
  eng.dispose();
  assert.equal(shared.normalizeTradingConfig({ venue: 'live' }).venue, 'paper');
});

test('engine (paper, scalping mode): evaluates signals and gets a direction filter from the bias desk', async () => {
  const dir = tmpDir();
  const llm = mockLlm();
  const cfg = shared.normalizeTradingConfig({ mode: 'scalping', venue: 'paper', symbols: ['BTCUSDT'], scalping: { pollSeconds: 60, agentBias: true } });
  const eng = new TradingEngine(cfg, { fetch: fixtureFetch(), dataDir: dir, getSecret: () => undefined, createLlm: () => llm, emit: () => {} });
  await eng.start();
  try {
    await waitFor(() => eng.getSnapshot().scalp.BTCUSDT);
    const b = await waitFor(() => eng.getSnapshot().biases.BTCUSDT);
    assert.equal(b.bias, 'LONG_ONLY');
    const sc = eng.getSnapshot().scalp.BTCUSDT;
    assert.ok(sc.longScore >= 0 && sc.shortScore >= 0);
    assert.ok(['up', 'down', 'flat'].includes(sc.trend));
    const biasCall = llm.calls.find((c) => c.role.startsWith('biasDesk'));
    assert.match(biasCall.prompt, /1분/);
    assert.match(biasCall.prompt, /파생상품 데이터/);
  } finally {
    await eng.stop();
    eng.dispose();
  }
});

test('engine: manual close books the trade and the daily counters', async () => {
  const dir = tmpDir();
  const llm = mockLlm();
  const cfg = shared.normalizeTradingConfig({ mode: 'agents', venue: 'paper', symbols: ['BTCUSDT'] });
  const eng = new TradingEngine(cfg, { fetch: fixtureFetch(), dataDir: dir, getSecret: () => undefined, createLlm: () => llm, emit: () => {} });
  await eng.start();
  try {
    await waitFor(() => eng.getSnapshot().runs[0]?.finishedAt);
    await eng.tick();
    assert.equal(eng.getSnapshot().positions.length, 1);
    await eng.closePosition('BTCUSDT');
    const s = eng.getSnapshot();
    assert.equal(s.positions.length, 0);
    assert.equal(s.trades[0].exitReason, '수동 청산');
    assert.equal(s.account.tradesToday, 1);
    // Reflection runs for agent trades and lands in the lessons file.
    await waitFor(() => fs.existsSync(path.join(dir, 'lessons', 'BTCUSDT.jsonl')));
  } finally {
    await eng.stop();
    eng.dispose();
  }
});

test('engine: notifications fire on entry and exit, and are silenced when turned off', async () => {
  const dir = tmpDir();
  const notes = [];
  const cfg = shared.normalizeTradingConfig({ mode: 'agents', venue: 'paper', symbols: ['BTCUSDT'] });
  const eng = new TradingEngine(cfg, { fetch: fixtureFetch(), dataDir: dir, getSecret: () => undefined, createLlm: () => mockLlm(), emit: () => {}, notify: (t, b) => notes.push([t, b]) });
  await eng.start();
  try {
    await waitFor(() => eng.getSnapshot().runs[0]?.finishedAt);
    assert.ok(notes.some(([t]) => /BTCUSDT 롱 진입 \(모의투자\)/.test(t)), JSON.stringify(notes));
    await eng.closePosition('BTCUSDT');
    assert.ok(notes.some(([t, b]) => /수동 청산/.test(t) && /손익/.test(b)));
    const n = notes.length;
    eng.updateConfig({ ...cfg, automation: { ...cfg.automation, notify: false } });
    eng.log('테스트 오류', 'error');
    assert.equal(notes.length, n, 'notify=false silences notifications');
  } finally {
    await eng.stop();
    eng.dispose();
  }
});

function liveFetch(perms) {
  return makeFetch({
    override: (u) => {
      const ok = (b) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) });
      if (u.hostname === 'api.binance.com') {
        if (u.pathname === '/api/v3/time') return ok({ serverTime: Date.now() });
        if (u.pathname === '/sapi/v1/account/apiRestrictions') return ok(perms);
      }
      if (u.hostname === 'fapi.binance.com') {
        if (u.pathname === '/fapi/v1/positionSide/dual') return ok({ dualSidePosition: false });
        if (u.pathname === '/fapi/v1/marginType') return { ok: false, status: 400, text: async () => '{"code":-4046,"msg":"No need to change margin type."}' };
        if (u.pathname === '/fapi/v3/account') return ok({ totalWalletBalance: '1000', totalUnrealizedProfit: '0', totalMarginBalance: '1000', availableBalance: '1000' });
        if (u.pathname === '/fapi/v3/positionRisk') return ok([]);
      }
      return null;
    }
  });
}

const PERMS_OK = { ipRestrict: true, enableReading: true, enableFutures: true, enableWithdrawals: false, enableInternalTransfer: false, permitsUniversalTransfer: false };

test('engine (live): a withdraw-capable key is refused before any order path starts', async () => {
  const dir = tmpDir();
  const keys = { 'binance.live.key': 'k', 'binance.live.secret': 's' };
  const cfg = shared.normalizeTradingConfig({ venue: 'live', liveAcknowledged: true, symbols: ['BTCUSDT'] });
  const eng = new TradingEngine(cfg, { fetch: liveFetch({ ...PERMS_OK, enableWithdrawals: true }), dataDir: dir, getSecret: (k) => keys[k], createLlm: () => mockLlm(), emit: () => {} });
  await assert.rejects(eng.start(), /출금 권한/);
  assert.equal(eng.getSnapshot().status, 'error');
  eng.dispose();
});

test('engine (live): a futures-only key with an IP allowlist starts and reports the live account', async () => {
  const dir = tmpDir();
  const keys = { 'binance.live.key': 'k', 'binance.live.secret': 's' };
  const cfg = shared.normalizeTradingConfig({ venue: 'live', liveAcknowledged: true, symbols: ['BTCUSDT'], mode: 'scalping', scalping: { pollSeconds: 60, agentBias: false } });
  const eng = new TradingEngine(cfg, { fetch: liveFetch(PERMS_OK), dataDir: dir, getSecret: (k) => keys[k], createLlm: () => mockLlm(), emit: () => {} });
  await eng.start();
  try {
    await waitFor(() => eng.getSnapshot().account);
    const s = eng.getSnapshot();
    assert.equal(s.account.venue, 'live');
    assert.equal(s.account.equity, 1000);
    assert.ok(s.logs.some((l) => /키 권한 확인/.test(l.message)));
  } finally {
    await eng.stop();
    eng.dispose();
  }
});
