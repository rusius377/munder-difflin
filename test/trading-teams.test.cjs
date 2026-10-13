'use strict';

/**
 * Trading desk — staffed teams (several agents per role) and how their
 * opinions become one call. Pins:
 *   - team settings normalise, presets round-trip, and the call estimate is exact;
 *   - committee and panel tallies follow the consensus rule, the quorum and the
 *     documented price/size merge (medians, size × agreeing share);
 *   - a staffed pipeline seats every member with its own persona and its own
 *     LLM session key, interleaves debate speakers, merges analysts and traders
 *     through a lead that sees the tally, and lets code tally the committee;
 *   - one failed seat never sinks a staffed team;
 *   - the engine's bias panel votes and the concurrency cap holds.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { makeFetch } = require('./fixtures/trading-fixtures.cjs');

const shared = loadTs('src/shared/trading.ts');
const teams = loadTs('src/main/trading/teams.ts');
const { runPipeline, renderReport } = loadTs('src/main/trading/agents.ts');
const { limitConcurrency } = loadTs('src/main/trading/llm.ts');
const { TradingEngine } = loadTs('src/main/trading/engine.ts');
const { MarketData } = loadTs('src/main/trading/marketData.ts');

const FLAT = { start: 64000, drift: 0.00005, vol: 0.0008 };
const fixtureFetch = () => makeFetch({ klines: { '1m': FLAT, '3m': FLAT, '5m': FLAT, '15m': FLAT, '1h': FLAT, '4h': FLAT, '1d': FLAT } });

// ─── settings ────────────────────────────────────────────────────────────────

test('team settings default to the standard committee and clamp to their limits', () => {
  const d = shared.normalizeTradingConfig({});
  assert.deepEqual(d.teams, { ...shared.TEAM_PRESETS.standard, consensus: 'majority', maxParallel: 4 });
  assert.equal(shared.teamPresetOf(d.teams), 'standard');
  const n = shared.normalizeTradingConfig({ teams: { analystsPerRole: 9, researchersPerSide: 0, traders: '4', riskPerStance: 5, portfolioCommittee: 2.6, biasPanel: -1, consensus: 'dictator', maxParallel: 99 } });
  assert.deepEqual(n.teams, { analystsPerRole: 3, researchersPerSide: 1, traders: 4, riskPerStance: 2, portfolioCommittee: 3, biasPanel: 1, consensus: 'majority', maxParallel: 8 });
  assert.equal(shared.teamPresetOf(n.teams), null);
  assert.equal(shared.teamPresetOf({ ...shared.TEAM_PRESETS.solo, consensus: 'unanimous', maxParallel: 2 }), 'solo');
  // Every seat a limit allows has a persona.
  const limits = { analystsPerRole: ['technical', 'derivatives', 'news', 'sentiment'], researchersPerSide: ['bull', 'bear'], traders: ['trader'], riskPerStance: ['aggressive', 'conservative', 'neutral'], portfolioCommittee: ['portfolioManager'], biasPanel: ['biasDesk'] };
  for (const [k, roles] of Object.entries(limits)) {
    for (const r of roles) {
      assert.equal(shared.TEAM_PERSONA_KEYS[r].length, shared.TEAM_LIMITS[k], `${r} personas`);
      for (const key of shared.TEAM_PERSONA_KEYS[r]) assert.ok(teams.PERSONAS[r][key]?.name, `${r}.${key} has Korean persona text`);
    }
  }
});

test('every seat, vote and lead label the agents view builds is translated in every locale', () => {
  for (const code of ['en', 'zh-CN', 'ar', 'ko']) {
    const l = JSON.parse(fs.readFileSync(path.join(__dirname, '..', `src/renderer/src/i18n/locales/${code}.json`), 'utf8')).trading;
    for (const [role, keys] of Object.entries(shared.TEAM_PERSONA_KEYS)) {
      for (const k of keys) assert.ok(l.personas?.[role]?.[k], `${code} trading.personas.${role}.${k}`);
    }
    for (const v of ['Bullish', 'Bearish', 'Neutral', 'LONG', 'SHORT', 'HOLD', 'CLOSE', 'LONG_ONLY', 'SHORT_ONLY', 'BOTH', 'NO_TRADE']) assert.ok(l.votes[v], `${code} votes.${v}`);
    for (const r of ['technical', 'derivatives', 'news', 'sentiment', 'trader', 'portfolioManager', 'biasDesk']) assert.ok(l.team.lead[r], `${code} team.lead.${r}`);
    for (const r of shared.CONSENSUS_RULES) assert.ok(l.consensus[r] && l.consensusHints[r], `${code} consensus.${r}`);
    for (const p of Object.keys(shared.TEAM_PRESETS)) assert.ok(l.teamPresets[p], `${code} teamPresets.${p}`);
  }
  // The Korean UI names a seat exactly as the agents are told who they are.
  const ko = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/i18n/locales/ko.json'), 'utf8')).trading;
  for (const [role, keys] of Object.entries(shared.TEAM_PERSONA_KEYS)) {
    for (const k of keys) assert.equal(ko.personas[role][k], teams.PERSONAS[role][k].name, `${role}.${k}`);
  }
});

test('the call estimate counts every seat and lead; solo is the original graph', () => {
  const solo = shared.normalizeTradingConfig({ teams: shared.TEAM_PRESETS.solo, symbols: ['BTCUSDT'] });
  assert.equal(shared.estimateLlmCalls(solo).pipeline, 4 + 2 + 1 + 1 + 3 + 1);
  const std = shared.normalizeTradingConfig({ symbols: ['BTCUSDT', 'ETHUSDT'] });
  const e = shared.estimateLlmCalls(std);
  assert.equal(e.pipeline, (4 * 2 + 4) + (2 * 2) + 1 + (3 + 1) + 3 + 3);
  assert.equal(e.pipelinePerHour, e.pipeline * 2);
  assert.equal(e.bias, 3);
  assert.equal(e.biasPerHour, 3 * 2 * 4);
  // The figures docs/TRADING.ko.md quotes.
  const per = (p) => shared.estimateLlmCalls(shared.normalizeTradingConfig({ teams: shared.TEAM_PRESETS[p] })).pipeline;
  assert.deepEqual([per('solo'), per('standard'), per('full')], [12, 27, 40]);
});

test('the step skeleton lists every seat in display order with stable ids', () => {
  const solo = shared.pipelineSkeleton(['technical', 'news'], shared.TEAM_PRESETS.solo);
  assert.deepEqual(solo.map((s) => s.id), ['technical', 'derivatives', 'news', 'sentiment', 'bull', 'bear', 'researchManager', 'trader',
    'aggressive', 'conservative', 'neutral', 'portfolioManager', 'riskEngine', 'execution']);
  assert.equal(solo.find((s) => s.id === 'derivatives').state, 'skipped');
  const std = shared.pipelineSkeleton(['technical'], { ...shared.TEAM_PRESETS.standard, riskPerStance: 2 });
  const ids = std.map((s) => s.id);
  assert.deepEqual(ids.slice(0, 3), ['technical', 'technical#1', 'technical#2']);
  assert.ok(std[0].lead && !std[1].lead && std[1].persona === 'trend' && std[2].persona === 'reversion');
  assert.deepEqual(ids.filter((i) => /^(bull|bear)/.test(i)), ['bull#1', 'bull#2', 'bear#1', 'bear#2']);
  assert.deepEqual(ids.filter((i) => i.startsWith('trader')), ['trader', 'trader#1', 'trader#2', 'trader#3']);
  assert.deepEqual(ids.filter((i) => i.startsWith('portfolioManager')), ['portfolioManager', 'portfolioManager#1', 'portfolioManager#2', 'portfolioManager#3']);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  assert.deepEqual(shared.biasSkeleton({ ...shared.TEAM_PRESETS.standard }).map((s) => s.id), ['biasDesk', 'biasDesk#1', 'biasDesk#2', 'biasDesk#3']);
});

// ─── tallies ─────────────────────────────────────────────────────────────────

test('stance lines parse in English or Korean, last one wins, percentages become fractions', () => {
  assert.deepEqual(teams.parseStance('...\n**Stance**: Bullish\n**Confidence**: 0.72'), { stance: 'Bullish', confidence: 0.72 });
  assert.deepEqual(teams.parseStance('Stance: 약세\nConfidence: 65%'), { stance: 'Bearish', confidence: 0.65 });
  assert.deepEqual(teams.parseStance('**Stance**: Mixed\n**Stance**: Neutral\n**Confidence**: 40'), { stance: 'Neutral', confidence: 0.4 });
  assert.deepEqual(teams.parseStance('no labels here'), { stance: null, confidence: null });
});

test('consensus rules: majority > 1/2, supermajority ≥ 2/3, unanimous = all who answered', () => {
  const m = teams.meetsConsensus;
  assert.equal(m('majority', 2, 3), true);
  assert.equal(m('majority', 2, 4), false);
  assert.equal(m('supermajority', 2, 3), true);
  assert.equal(m('supermajority', 3, 5), false);
  assert.equal(m('supermajority', 4, 5), true);
  assert.equal(m('unanimous', 3, 3), true);
  assert.equal(m('unanimous', 2, 3), false);
  assert.equal(m('majority', 0, 0), false);
  assert.equal(teams.quorumOf(3), 2);
  assert.equal(teams.quorumOf(4), 3);
  assert.equal(teams.quorumOf(1), 1);
});

const dec = (o) => ({ rating: 'Hold', action: 'HOLD', entryType: 'MARKET', entryPrice: null, stopLoss: null, takeProfit: null, leverage: null, riskPct: null, confidence: 0.5, horizonHours: null, summary: '요약', ...o });
const seat = (member, d) => ({ member, persona: shared.TEAM_PERSONA_KEYS.portfolioManager[member - 1], decision: d });

test('committee: 2 of 3 long under majority → long at median prices and two-thirds size', () => {
  const { decision, view } = teams.aggregateCommittee([
    seat(1, dec({ rating: 'Overweight', action: 'LONG', stopLoss: 63000, takeProfit: 66500, leverage: 4, riskPct: 0.8, confidence: 0.7, horizonHours: 24 })),
    seat(2, dec({ rating: 'Buy', action: 'LONG', stopLoss: 62800, takeProfit: 66800, leverage: 5, riskPct: 0.6, confidence: 0.8, horizonHours: 12 })),
    seat(3, dec({ rating: 'Hold', action: 'HOLD', confidence: 0.6 }))
  ], 'majority', 1);
  assert.equal(decision.action, 'LONG');
  assert.equal(decision.rating, 'Overweight', 'Buy + Overweight averages to the weak form');
  assert.equal(decision.stopLoss, 62900);
  assert.equal(decision.takeProfit, 66650);
  assert.equal(decision.leverage, 4, 'floor of the median leverage');
  assert.equal(decision.riskPct, 0.467, 'median risk × 2/3');
  assert.equal(decision.confidence, 0.75);
  assert.equal(decision.horizonHours, 18);
  assert.equal(decision.entryType, 'MARKET');
  assert.equal(view.outcome, 'LONG');
  assert.equal(view.agree, 2);
  assert.equal(view.reached, true);
  assert.ok(Math.abs(view.sizeScale - 2 / 3) < 1e-9);
  assert.match(decision.summary, /위원회 3명/);
  assert.equal(view.votes[2].vote, 'HOLD');
});

test('committee: the same votes fail unanimity and fall back to HOLD; a split is HOLD', () => {
  const votes = [
    seat(1, dec({ rating: 'Buy', action: 'LONG', stopLoss: 63000 })),
    seat(2, dec({ rating: 'Buy', action: 'LONG', stopLoss: 63100 })),
    seat(3, dec({ action: 'HOLD' }))
  ];
  const u = teams.aggregateCommittee(votes, 'unanimous', 1);
  assert.equal(u.decision.action, 'HOLD');
  assert.equal(u.view.reached, false);
  assert.match(u.view.note, /합의 기준\(만장일치\)에 못 미쳐/);
  assert.equal(teams.aggregateCommittee(votes, 'supermajority', 1).decision.action, 'LONG');
  const split = teams.aggregateCommittee([
    seat(1, dec({ action: 'LONG', rating: 'Buy', stopLoss: 63000 })),
    seat(2, dec({ action: 'SHORT', rating: 'Sell', stopLoss: 65000 })),
    seat(3, dec({ action: 'HOLD' }))
  ], 'majority', 1);
  assert.equal(split.decision.action, 'HOLD');
  assert.match(split.view.note, /동률/);
});

test('committee: shares count members who answered; below quorum is an error', () => {
  const r = teams.aggregateCommittee([
    seat(1, dec({ action: 'SHORT', rating: 'Sell', stopLoss: 65500, takeProfit: 61000, riskPct: 1 })),
    seat(2, dec({ action: 'SHORT', rating: 'Sell', stopLoss: 65300, takeProfit: 61500, riskPct: 1 })),
    seat(3, dec({ action: 'SHORT', rating: 'Underweight', stopLoss: 65400 })),
    seat(4, dec({ action: 'LONG', rating: 'Buy', stopLoss: 63000 })),
    seat(5, null)
  ], 'majority', 0.5);
  assert.equal(r.decision.action, 'SHORT');
  assert.equal(r.decision.rating, 'Sell', '(2+2+1)/3 > 1.5 → strong');
  assert.equal(r.decision.stopLoss, 65400);
  assert.equal(r.decision.takeProfit, 61250);
  assert.equal(r.view.responded, 4);
  assert.equal(r.decision.riskPct, 0.375, 'median 1, capped at 0.5, × 3/4');
  assert.throws(() => teams.aggregateCommittee([seat(1, dec({ action: 'LONG' })), seat(2, null), seat(3, null)], 'majority', 1), /정족수 미달/);
});

test('committee: LIMIT only when most agreeing planners ask for it; members without a stop do not set prices; CLOSE can win', () => {
  const lim = teams.aggregateCommittee([
    seat(1, dec({ action: 'LONG', rating: 'Overweight', entryType: 'LIMIT', entryPrice: 63500, stopLoss: 63000 })),
    seat(2, dec({ action: 'LONG', rating: 'Overweight', entryType: 'LIMIT', entryPrice: 63700, stopLoss: 63200 })),
    seat(3, dec({ action: 'LONG', rating: 'Overweight', entryType: 'MARKET', stopLoss: null }))
  ], 'majority', 1);
  assert.equal(lim.decision.entryType, 'LIMIT');
  assert.equal(lim.decision.entryPrice, 63600);
  assert.equal(lim.decision.stopLoss, 63100);
  assert.equal(lim.decision.riskPct, 1, 'unanimous → full size of the desk default');
  // Members asking for more than the cap: capped first, then scaled (else the cap would undo the scale).
  const over = teams.aggregateCommittee([
    seat(1, dec({ action: 'LONG', rating: 'Buy', stopLoss: 63000, riskPct: 3 })),
    seat(2, dec({ action: 'LONG', rating: 'Buy', stopLoss: 63000, riskPct: 4 })),
    seat(3, dec({ action: 'HOLD' }))
  ], 'majority', 1);
  assert.equal(over.decision.riskPct, 0.667);
  const close = teams.aggregateCommittee([
    seat(1, dec({ action: 'CLOSE', rating: 'Underweight' })),
    seat(2, dec({ action: 'CLOSE', rating: 'Hold' })),
    seat(3, dec({ action: 'LONG', rating: 'Buy', stopLoss: 63000 }))
  ], 'majority', 1);
  assert.equal(close.decision.action, 'CLOSE');
  assert.equal(close.decision.stopLoss, null);
});

const bseat = (member, bias, confidence = 0.6) => ({ member, persona: shared.TEAM_PERSONA_KEYS.biasDesk[member - 1], result: bias ? { bias, confidence, note: `${bias} 근거` } : null });

test('bias panel: approval voting per side', () => {
  const b = (votes, rule = 'majority') => teams.aggregateBias(votes.map((v, i) => bseat(i + 1, v)), rule).bias.bias;
  assert.equal(b(['LONG_ONLY', 'LONG_ONLY', 'BOTH']), 'LONG_ONLY');
  assert.equal(b(['LONG_ONLY', 'SHORT_ONLY', 'BOTH']), 'BOTH');
  assert.equal(b(['NO_TRADE', 'NO_TRADE', 'BOTH']), 'NO_TRADE');
  assert.equal(b(['LONG_ONLY', 'SHORT_ONLY', 'NO_TRADE']), 'NO_TRADE');
  assert.equal(b(['LONG_ONLY', 'LONG_ONLY', 'BOTH'], 'unanimous'), 'LONG_ONLY');
  assert.equal(b(['LONG_ONLY', 'LONG_ONLY', 'NO_TRADE'], 'unanimous'), 'NO_TRADE');
  const r = teams.aggregateBias([bseat(1, 'LONG_ONLY', 0.8), bseat(2, 'LONG_ONLY', 0.6), bseat(3, 'BOTH', 0.3)], 'majority');
  assert.equal(r.bias.confidence, 0.7, 'mean confidence of the members who voted the outcome');
  assert.equal(r.view.kind, 'bias');
  assert.match(r.view.note, /롱 허용 3 · 숏 허용 1/);
  const miss = teams.aggregateBias([bseat(1, 'LONG_ONLY'), bseat(2, 'SHORT_ONLY'), bseat(3, 'NO_TRADE')], 'majority');
  assert.equal(miss.view.reached, false);
  assert.throws(() => teams.aggregateBias([bseat(1, 'BOTH'), bseat(2, null), bseat(3, null)], 'majority'), /정족수 미달/);
});

// ─── staffed pipeline ────────────────────────────────────────────────────────

const PM = ({ action = 'LONG', rating = 'Overweight', sl = 63000, tp = 66500, lev = 4, risk = 0.8, conf = 0.7 } = {}) =>
  `**Rating**: ${rating}\n\n요약.\n\n\`\`\`json\n{"rating":"${rating}","action":"${action}","entryType":"MARKET","entryPrice":null,"stopLoss":${action === 'HOLD' ? null : sl},"takeProfit":${action === 'HOLD' ? null : tp},"leverage":${lev},"riskPct":${risk},"confidence":${conf},"horizonHours":24,"summary":"${action} 판단"}\n\`\`\``;

function staffedLlm(opts = {}) {
  const calls = [];
  return {
    calls,
    label: 'mock',
    async complete(call) {
      calls.push(call);
      const [base, seat = ''] = call.role.split('-')[0].split('_');
      if (opts.fail && opts.fail(base, seat, call)) throw new Error(`mock failure ${base}_${seat}`);
      if (['technical', 'derivatives', 'news', 'sentiment'].includes(base)) {
        if (seat === 'lead') return `${base} 팀 종합 보고서\n\n| 항목 | 값 |\n|---|---|\n\n**Stance**: Bullish\n**Confidence**: 0.65`;
        return `${base} 팀원 ${seat} 보고서\n\n**Stance**: ${seat === '1' ? 'Bullish' : 'Neutral'}\n**Confidence**: ${seat === '1' ? '0.7' : '0.5'}`;
      }
      switch (base) {
        case 'researchManager': return '**Rating**: Overweight\n\n**근거**: 강세 우세.';
        case 'trader':
          if (seat === 'lead') return '**Action**: LONG\n\n종합.\n\nFINAL TRANSACTION PROPOSAL: **LONG**';
          return `**Action**: ${seat === '3' ? 'HOLD' : 'LONG'}\n\n제안 ${seat}.\n\nFINAL TRANSACTION PROPOSAL: **${seat === '3' ? 'HOLD' : 'LONG'}**`;
        case 'portfolioManager':
          if (seat === '1') return PM();
          if (seat === '2') return PM({ rating: 'Buy', sl: 62800, tp: 66800, lev: 5, risk: 0.6, conf: 0.8 });
          return PM({ action: 'HOLD', rating: 'Hold', conf: 0.6 });
        case 'biasDesk': return '근거.\n```json\n{"bias":"LONG_ONLY","confidence":0.66,"note":"상승"}\n```';
        default: return `${base}${seat ? ` ${seat}` : ''} 발언`;
      }
    }
  };
}

async function snapshotFor(symbol = 'BTCUSDT') {
  return new MarketData(fixtureFetch()).analysisSnapshot(symbol, ['https://feeds.example.com/rss'], { news: true, sentiment: true });
}

const CTX = (snapshot) => ({ symbol: 'BTCUSDT', snapshot, portfolio: '- 현재 BTCUSDT 포지션: 없음', lessons: '', constraints: { maxLeverage: 10, riskPerTradePct: 1, minRewardRisk: 1.5, minConfidence: 0.55, defaultLeverage: 3, venueLabel: '모의투자' } });
const STAFFED = { analystsPerRole: 2, researchersPerSide: 2, traders: 3, riskPerStance: 2, portfolioCommittee: 3, consensus: 'majority' };

test('staffed pipeline: every seat speaks with its persona and its own session; leads merge; code tallies the committee', async () => {
  const llm = staffedLlm();
  const steps = [];
  const r = await runPipeline({ ctx: CTX(await snapshotFor()), analysts: ['technical', 'derivatives', 'news', 'sentiment'], debateRounds: 1, riskRounds: 1, teams: STAFFED },
    { llm, onStep: (s) => steps.push(s) });
  const keys = llm.calls.map((c) => c.role.split('-')[0]);
  assert.equal(llm.calls.length, (4 * 2 + 4) + (2 * 2) + 1 + (3 + 1) + (3 * 2) + 3, 'matches the estimate formula');
  // Analysts: 8 members first (any order), then the 4 leads.
  assert.deepEqual(new Set(keys.slice(0, 8)), new Set(['technical_1', 'technical_2', 'derivatives_1', 'derivatives_2', 'news_1', 'news_2', 'sentiment_1', 'sentiment_2']));
  assert.deepEqual(new Set(keys.slice(8, 12)), new Set(['technical_lead', 'derivatives_lead', 'news_lead', 'sentiment_lead']));
  // Debates interleave seats; the risk debate runs seat by seat across stances.
  assert.deepEqual(keys.slice(12, 17), ['bull_1', 'bear_1', 'bull_2', 'bear_2', 'researchManager']);
  assert.deepEqual(new Set(keys.slice(17, 20)), new Set(['trader_1', 'trader_2', 'trader_3']));
  assert.equal(keys[20], 'trader_lead');
  assert.deepEqual(keys.slice(21, 27), ['aggressive_1', 'conservative_1', 'neutral_1', 'aggressive_2', 'conservative_2', 'neutral_2']);
  assert.deepEqual(new Set(keys.slice(27)), new Set(['portfolioManager_1', 'portfolioManager_2', 'portfolioManager_3']));
  // Tiers: committee members are deep like the single PM.
  for (const c of llm.calls) assert.equal(c.tier, /^(researchManager|portfolioManager)/.test(c.role) ? 'deep' : 'quick', c.role);

  const byKey = (k) => llm.calls.find((c) => c.role.startsWith(`${k}-`));
  // Persona and team framing reach each seat.
  assert.match(byKey('technical_1').system, /\[팀 구성\] 기술적 분석 팀에는 2명이 있고, 너는 그중 1번 "추세추종 차티스트"/);
  assert.match(byKey('technical_2').system, /오실레이터·평균회귀 전문가/);
  assert.match(byKey('technical_1').system, /\*\*Stance\*\*/);
  assert.match(byKey('portfolioManager_2').system, /리스크 책임자/);
  assert.match(byKey('portfolioManager_2').system, /합의 규칙\(과반/);
  // The analyst lead sees both members and the code tally; the bull sees the team report.
  const lead = byKey('technical_lead').prompt;
  assert.match(lead, /technical 팀원 1 보고서/);
  assert.match(lead, /technical 팀원 2 보고서/);
  assert.match(lead, /팀 투표\(코드 집계\): 강세 1 · 약세 0 · 중립 1/);
  assert.match(byKey('bull_1').prompt, /technical 팀 종합 보고서/);
  assert.doesNotMatch(byKey('bull_1').prompt, /technical 팀원 1 보고서/);
  // Debaters see who spoke; the research manager gets named speakers.
  assert.match(byKey('bear_1').prompt, /강세 연구원 1\(모멘텀 강세론자\): bull 1 발언/);
  assert.match(byKey('researchManager').prompt, /약세 연구원 2\(레버리지·청산 약세론자\): bear 2 발언/);
  assert.match(byKey('trader_lead').prompt, /트레이더 투표\(코드 집계\): 롱 2 · 숏 0 · 관망 1 · 청산 0/);
  assert.match(byKey('neutral_2').prompt, /공격적 리스크 분석가 2\(추세 추격형\)/);

  // Code tallied the committee: 2 of 3 long.
  assert.equal(r.decision.action, 'LONG');
  assert.equal(r.decision.stopLoss, 62900);
  assert.equal(r.decision.riskPct, 0.467);
  assert.equal(r.committee.agree, 2);
  assert.equal(r.parsedJson, true);
  assert.equal(r.traderAction, 'LONG');
  assert.equal(r.analystMembers.technical.length, 2);
  assert.equal(r.traderMembers.length, 3);

  // Steps carry seat ids, personas and votes.
  const last = new Map();
  for (const s of steps) last.set(s.id, s);
  assert.equal(last.get('technical#1').persona, 'trend');
  assert.equal(last.get('technical#1').vote, 'Bullish');
  assert.equal(last.get('technical').lead, true);
  assert.equal(last.get('trader#3').vote, 'HOLD');
  assert.equal(last.get('portfolioManager').vote, 'LONG');
  assert.match(last.get('portfolioManager').content, /\| 2 \| 리스크 책임자 \| Buy \| 롱 \|/);

  const report = renderReport({ symbol: 'BTCUSDT', takenAt: Date.UTC(2026, 9, 13), llmLabel: 'mock', venueLabel: '모의투자', snapshotVerified: '스냅샷', result: r, verdictText: '승인', notes: [] });
  assert.match(report, /팀 구성: 분석가 역할당 2명 · 연구원 진영당 2명 · 트레이더 3명 · 리스크 성향당 2명 · 포트폴리오 위원회 3명\(과반/);
  assert.match(report, /#### 팀원 1 — 추세추종 차티스트 \(강세, 확신도 0\.70\)/);
  assert.match(report, /### 헤드 트레이더 종합/);
  assert.match(report, /## V\. 포트폴리오 위원회 결정/);
});

test('staffed pipeline fails open seat by seat', async () => {
  const llm = staffedLlm({
    fail: (base, seat) => (base === 'news' && seat === '2') || (base === 'bull' && seat === '2') || (base === 'trader' && seat === 'lead') || (base === 'portfolioManager' && seat === '3')
  });
  const steps = [];
  const r = await runPipeline({ ctx: CTX(await snapshotFor()), analysts: ['technical', 'news'], debateRounds: 1, riskRounds: 1, teams: STAFFED },
    { llm, onStep: (s) => steps.push(s) });
  const keys = llm.calls.map((c) => c.role.split('-')[0]);
  // news: one member left → its report is used as-is, no lead call.
  assert.ok(!keys.includes('news_lead'));
  assert.match(r.reports.news, /news 팀원 1 보고서/);
  // bull 2 failed: the debate went on without it.
  assert.ok(steps.some((s) => s.id === 'bull#2' && s.state === 'error'));
  assert.doesNotMatch(r.investmentHistory, /강세 연구원 2/);
  // Head trader failed: the plurality (LONG) proposal stands in.
  assert.match(r.traderPlan, /헤드 트레이더 종합 실패/);
  assert.equal(r.traderAction, 'LONG');
  // One committee seat failed: 2 of 3 answered (quorum met), both long → long.
  assert.equal(r.committee.responded, 2);
  assert.equal(r.decision.action, 'LONG');
});

test('a committee below quorum fails the run instead of trading', async () => {
  const llm = staffedLlm({ fail: (base, seat) => base === 'portfolioManager' && seat !== '1' });
  await assert.rejects(
    runPipeline({ ctx: CTX(await snapshotFor()), analysts: ['technical'], debateRounds: 1, riskRounds: 1, teams: { ...STAFFED, analystsPerRole: 1, researchersPerSide: 1, traders: 1, riskPerStance: 1 } }, { llm, onStep: () => {} }),
    /정족수 미달/
  );
});

// ─── concurrency & engine ────────────────────────────────────────────────────

test('limitConcurrency keeps at most N calls in flight, first come first served', async () => {
  let active = 0;
  let peak = 0;
  const order = [];
  const inner = {
    label: 'inner',
    async complete(call) {
      active++;
      peak = Math.max(peak, active);
      order.push(call.role);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      if (call.role === 'boom') throw new Error('boom');
      return call.role;
    }
  };
  const lim = limitConcurrency(inner, 2);
  const roles = ['a', 'b', 'boom', 'c', 'd', 'e'];
  const out = await Promise.allSettled(roles.map((role) => lim.complete({ role, tier: 'quick', system: '', prompt: '' })));
  assert.equal(peak, 2);
  assert.deepEqual(order, roles);
  assert.equal(out[2].status, 'rejected', 'a failing call still frees its slot');
  assert.deepEqual(out.filter((o) => o.status === 'fulfilled').map((o) => o.value), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(lim.label, 'inner');
});

async function waitFor(fn, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out');
}

test('engine (scalping): the bias panel votes seat by seat and code sets the direction', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-teams-'));
  const llm = staffedLlm();
  const cfg = shared.normalizeTradingConfig({ mode: 'scalping', venue: 'paper', symbols: ['BTCUSDT'], scalping: { pollSeconds: 60, agentBias: true }, teams: { biasPanel: 3, consensus: 'supermajority' } });
  const eng = new TradingEngine(cfg, { fetch: fixtureFetch(), dataDir: dir, getSecret: () => undefined, createLlm: () => llm, emit: () => {} });
  await eng.start();
  try {
    const b = await waitFor(() => eng.getSnapshot().biases.BTCUSDT);
    assert.equal(b.bias, 'LONG_ONLY');
    const run = await waitFor(() => eng.getSnapshot().runs.find((x) => x.kind === 'bias' && x.finishedAt));
    assert.equal(run.committee.kind, 'bias');
    assert.equal(run.committee.rule, 'supermajority');
    assert.equal(run.committee.agree, 3);
    assert.deepEqual(run.steps.map((s) => s.id), ['biasDesk', 'biasDesk#1', 'biasDesk#2', 'biasDesk#3']);
    assert.ok(run.steps.every((s) => s.state === 'done'));
    const roles = llm.calls.filter((c) => c.role.startsWith('biasDesk')).map((c) => c.role).sort();
    assert.deepEqual(roles, ['biasDesk_1-BTCUSDT', 'biasDesk_2-BTCUSDT', 'biasDesk_3-BTCUSDT']);
    assert.match(llm.calls.find((c) => c.role === 'biasDesk_3-BTCUSDT').system, /리스크 판정관/);
  } finally {
    await eng.stop();
    eng.dispose();
  }
});

test('engine (agents): the desk-wide cap holds across a staffed run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-teams-'));
  let active = 0;
  let peak = 0;
  const base = staffedLlm();
  const llm = {
    label: 'mock',
    calls: base.calls,
    async complete(call) {
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise((r) => setTimeout(r, 5));
        return await base.complete(call);
      } finally { active--; }
    }
  };
  const cfg = shared.normalizeTradingConfig({ mode: 'agents', venue: 'paper', symbols: ['BTCUSDT'], teams: { ...shared.TEAM_PRESETS.full, maxParallel: 3 } });
  const eng = new TradingEngine(cfg, { fetch: fixtureFetch(), dataDir: dir, getSecret: () => undefined, createLlm: () => llm, emit: () => {} });
  await eng.runNow('BTCUSDT');
  const run = eng.getSnapshot().runs[0];
  assert.equal(run.error, undefined, run.error);
  assert.ok(peak <= 3 && peak >= 2, `peak ${peak}`);
  assert.equal(run.committee.seats, 5);
  assert.ok(run.steps.some((s) => s.id === 'technical#3' && s.state === 'done'));
  assert.ok(run.steps.some((s) => s.id === 'neutral#2' && s.state === 'done'));
  eng.dispose();
});
