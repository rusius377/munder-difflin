'use strict';

/**
 * Trading desk — one project folder per agent. Pins:
 *   - ids are stable per seat (role + specialty), parse back, and refuse paths;
 *   - the current team gets a folder + CLAUDE.md per LLM agent, user edits survive;
 *   - API providers get the user-written instructions, the Claude subscription
 *     runs its session inside the agent's folder (Claude Code reads CLAUDE.md);
 *   - every call is recorded, scored against the price after its horizon, and
 *     fed back to the same agent; trades it voted on land in its lessons.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { makeFetch } = require('./fixtures/trading-fixtures.cjs');

const shared = loadTs('src/shared/trading.ts');
const { AgentProjects, parseAgentId, agentTitle, userSection, OPINION_HORIZON_MS } = loadTs('src/main/trading/agentProjects.ts');
const { createLlmClient } = loadTs('src/main/trading/llm.ts');
const { TradingEngine } = loadTs('src/main/trading/engine.ts');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'md-agentproj-'));
const H = 3_600_000;

test('agent ids: one per seat, stable, parse back, and never a path', () => {
  assert.equal(shared.agentIdOf('technical'), 'technical');
  assert.equal(shared.agentIdOf('technical', { persona: 'trend' }), 'technical-trend');
  assert.equal(shared.agentIdOf('trader', { lead: true }), 'trader-lead');
  assert.deepEqual(parseAgentId('portfolioManager-cio'), { id: 'portfolioManager-cio', role: 'portfolioManager', persona: 'cio' });
  assert.deepEqual(parseAgentId('trader-lead'), { id: 'trader-lead', role: 'trader', lead: true });
  for (const bad of ['../etc', 'a/b', 'technical-Trend', 'x-y-z', '']) assert.equal(parseAgentId(bad), null, bad);
  const p = new AgentProjects(tmp());
  assert.throws(() => p.folder('../escape'), /잘못된 에이전트 id/);
  assert.equal(agentTitle({ role: 'technical', persona: 'trend' }), '기술적 분석가 — 추세추종 차티스트');
  assert.equal(agentTitle({ role: 'trader', lead: true }), '헤드 트레이더');
  assert.equal(agentTitle({ role: 'news', lead: true }), '뉴스 분석 팀 팀장');
  assert.equal(agentTitle({ role: 'researchManager' }), '리서치 매니저');
});

test('the team roster lists every LLM agent of the config, not the code steps', () => {
  const ids = (cfg) => shared.teamAgents(shared.normalizeTradingConfig(cfg)).map((a) => a.id);
  const solo = ids({ teams: shared.TEAM_PRESETS.solo });
  assert.deepEqual(solo, ['technical', 'derivatives', 'news', 'sentiment', 'bull', 'bear', 'researchManager', 'trader',
    'aggressive', 'conservative', 'neutral', 'portfolioManager', 'biasDesk', 'reflection']);
  const std = ids({});
  assert.equal(std.length, 4 * 3 + 4 + 1 + 4 + 3 + 3 + 3 + 1);
  assert.ok(std.includes('technical-lead') && std.includes('technical-trend') && std.includes('trader-lead') && std.includes('biasDesk-risk'));
  assert.ok(!std.includes('portfolioManager') && !std.includes('portfolioManager-lead'), 'the committee tally is code');
  assert.ok(!std.includes('riskEngine') && !std.includes('execution'));
  assert.ok(!ids({ agents: { analysts: ['technical'] } }).some((i) => i.startsWith('news')), 'unselected analysts get no folder');
});

test('a folder is created once; what the user writes in CLAUDE.md survives and reaches API providers', () => {
  const root = tmp();
  const p = new AgentProjects(root);
  const ref = shared.agentRef('derivatives', { persona: 'positioning' });
  const dir = p.ensure(ref);
  const md = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  assert.match(md, /^# 파생상품 분석가 — 포지셔닝·청산 분석가/);
  assert.match(md, /전문 관점: 미결제약정과 가격의 조합/);
  assert.match(md, /## 내 지침/);
  assert.match(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), /## 공통 지침/);
  // Only the template comment so far: nothing to inject, not customized.
  assert.equal(p.instructionsForApi(ref.id), '');
  assert.equal(p.customized(ref.id), false);
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `${md}\n펀딩비가 0.05%를 넘으면 롱 확신도를 낮춰라.\n`);
  fs.appendFileSync(path.join(root, 'CLAUDE.md'), '\nFOMC 전후 6시간은 보수적으로.\n');
  p.ensure(ref);
  assert.match(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), /펀딩비가 0\.05%/, 'ensure never overwrites');
  const ins = p.instructionsForApi(ref.id);
  assert.match(ins, /\[데스크 공통 지침 — 사용자 작성\]\nFOMC 전후 6시간은 보수적으로\./);
  assert.match(ins, /\[이 에이전트의 지침 — 사용자 작성\]\n펀딩비가 0\.05%를 넘으면/);
  assert.equal(p.customized(ref.id), true);
  assert.equal(userSection('a\n## 내 지침\n<!-- x -->\n', '## 내 지침'), '');
});

test('calls are recorded, scored by the price after the horizon, and summarised in scorecard.md', () => {
  const root = tmp();
  let now = Date.UTC(2026, 9, 13, 0, 0);
  const p = new AgentProjects(root, () => now);
  const ref = shared.agentRef('technical', { persona: 'trend' });
  const base = { symbol: 'BTCUSDT', runId: 'r1', kind: 'pipeline', price: 100, horizonMs: OPINION_HORIZON_MS.pipeline, summary: '…' };
  const up = p.recordOpinion(ref, { ...base, ts: now, vote: 'Bullish', confidence: 0.7 });
  const down = p.recordOpinion(ref, { ...base, ts: now, vote: 'Bearish', confidence: 0.6 });
  p.recordOpinion(ref, { ...base, ts: now, vote: 'Neutral', confidence: 0.5 });
  assert.equal(p.due(now + 3 * H).length, 0, 'not before the horizon');
  now += 4 * H;
  const due = p.due(now);
  assert.deepEqual(due.map((d) => d.opinion.vote), ['Bullish', 'Bearish'], 'neutral calls are not scored');
  assert.equal(p.score(ref.id, up.id, 101).hit, true);
  assert.equal(p.score(ref.id, down.id, 101).hit, false);
  const s = p.stats(ref.id);
  assert.deepEqual([s.opinions, s.scored, s.hits, s.pending], [3, 2, 1, 0]);
  assert.equal(s.hitRate, 0.5);
  assert.ok(Math.abs(s.avgEdgeBps) < 1e-9, '+100bp and −100bp average out');
  const card = fs.readFileSync(path.join(p.folder(ref.id), 'scorecard.md'), 'utf8');
  assert.match(card, /적중률: 50% \(1\/2\)/);
  assert.match(card, /\| 강세 \| 0\.70 \| 100 \| 4시간 뒤 \+1\.00% ✓ \|/);
  assert.match(card, /\| 중립 \| 0\.50 \| 100 \| 채점 안 함/);
  // A new instance (app restart) reads the same record.
  const again = new AgentProjects(root, () => now);
  assert.equal(again.stats(ref.id).hits, 1);
  const list = again.list(new Set([ref.id, 'news']));
  const row = list.find((r) => r.id === ref.id);
  assert.equal(row.active, true);
  assert.equal(row.persona, 'trend');
  assert.equal(row.lastVote, 'Neutral');
  assert.ok(list.find((r) => r.id === 'news'), 'active agents appear even before their first call');
});

test('memory: the agent is reminded of its own record on the same symbol and its trades', () => {
  let now = Date.UTC(2026, 9, 13, 0, 0);
  const p = new AgentProjects(tmp(), () => now);
  const ref = shared.agentRef('portfolioManager', { persona: 'risk' });
  assert.equal(p.memoryBlock(ref.id, 'BTCUSDT'), '', 'nothing to remind of yet');
  const o = p.recordOpinion(ref, { ts: now, symbol: 'BTCUSDT', runId: 'r', kind: 'pipeline', vote: 'LONG', confidence: 0.74, price: 64000, horizonMs: 4 * H, summary: '' });
  p.recordOpinion(ref, { ts: now, symbol: 'ETHUSDT', runId: 'r', kind: 'pipeline', vote: 'SHORT', confidence: 0.6, price: 2500, horizonMs: 4 * H, summary: '' });
  now += 5 * H;
  p.score(ref.id, o.id, 63000);
  p.addLesson(ref, '10/13 BTCUSDT 롱 거래 종료(손절) 손익 -23.10 USDT — 너의 판단 롱 0.74: 거래 방향과 같음, 판단이 틀렸음');
  const m = p.memoryBlock(ref.id, 'BTCUSDT');
  assert.match(m, /채점된 방향 판단 1건 중 0건 적중\(0%\)/);
  assert.match(m, /롱\(0\.74\) → 4시간 뒤 -1\.56% ✗/);
  assert.doesNotMatch(m, /숏/, 'only this symbol\'s calls');
  assert.match(m, /판단이 틀렸음/);
});

test('outputs keep the newest 30 per symbol', () => {
  let now = Date.UTC(2026, 9, 13, 0, 0);
  const p = new AgentProjects(tmp(), () => now);
  const ref = shared.agentRef('bull', { persona: 'momentum' });
  for (let i = 0; i < 35; i++) { p.writeOutput(ref, 'BTCUSDT', now, `r${i}`, `발언 ${i}`, null); now += 60_000; }
  const dir = path.join(p.folder(ref.id), 'outputs', 'BTCUSDT');
  const files = fs.readdirSync(dir).sort();
  assert.equal(files.length, 30);
  assert.match(fs.readFileSync(path.join(dir, files[29]), 'utf8'), /발언 34/);
});

test('Claude subscription runs in the agent folder; API providers get the instructions in the system prompt', async () => {
  const seen = [];
  const sub = createLlmClient({ provider: 'claude-subscription', quickModel: 'sonnet', deepModel: 'opus', baseUrl: 'http://x', timeoutSec: 30 }, {
    fetch: async () => { throw new Error('no network'); }, getSecret: () => undefined, sessionRoot: '/tmp/sessions', claudeCommand: 'claude',
    runHidden: async (prompt, opts) => { seen.push({ prompt, cwd: opts.cwd }); return { ok: true, text: 'ok' }; }
  });
  const workdir = path.join(tmp(), 'technical-trend');
  await sub.complete({ role: 'technical_1-BTCUSDT', tier: 'quick', system: 'SYS', prompt: 'P', workdir, sessionKey: 'BTCUSDT', instructions: '[이 에이전트의 지침 — 사용자 작성]\nX' });
  assert.equal(seen[0].cwd, path.join(workdir, '.sessions', 'BTCUSDT'));
  assert.doesNotMatch(seen[0].prompt, /사용자 작성/, 'Claude Code reads CLAUDE.md itself');
  await sub.complete({ role: 'connection-test', tier: 'quick', system: 'SYS', prompt: 'P', instructions: 'INS' });
  assert.equal(seen[1].cwd, path.join('/tmp/sessions', 'connection-test'));
  assert.match(seen[1].prompt, /SYS\n\nINS/);

  let body = null;
  const api = createLlmClient({ provider: 'anthropic', quickModel: 'q', deepModel: 'd', baseUrl: 'http://x', timeoutSec: 30 }, {
    fetch: async (_u, init) => { body = JSON.parse(init.body); return { ok: true, status: 200, text: async () => JSON.stringify({ content: [{ type: 'text', text: 'hi' }] }) }; },
    getSecret: () => 'k', sessionRoot: '/tmp', claudeCommand: 'claude'
  });
  await api.complete({ role: 'r', tier: 'quick', system: 'SYS', prompt: 'P', workdir, instructions: 'INS' });
  assert.equal(body.system, 'SYS\n\nINS');
});

// ─── engine ──────────────────────────────────────────────────────────────────

const FLAT = { start: 64000, drift: 0.00005, vol: 0.0008 };
function fetchWithPastPrice(price) {
  return makeFetch({
    klines: { '1m': FLAT, '3m': FLAT, '5m': FLAT, '15m': FLAT, '1h': FLAT, '4h': FLAT, '1d': FLAT },
    override: (u) => {
      if (u.pathname === '/fapi/v1/klines' && u.searchParams.get('startTime')) {
        const t = Number(u.searchParams.get('startTime'));
        const row = [t + 30_000, String(price), String(price), String(price), String(price), '1', t + 89_999, '1', 1, '0.5', '1', '0'];
        return { ok: true, status: 200, text: async () => JSON.stringify([row]) };
      }
      return null;
    }
  });
}

const PM = (action, sl, tp, conf) => `**Rating**: ${action === 'LONG' ? 'Overweight' : 'Hold'}\n\n요약.\n\n\`\`\`json\n{"rating":"${action === 'LONG' ? 'Overweight' : 'Hold'}","action":"${action}","entryType":"MARKET","entryPrice":null,"stopLoss":${sl},"takeProfit":${tp},"leverage":4,"riskPct":0.8,"confidence":${conf},"horizonHours":24,"summary":"${action}"}\n\`\`\``;

function mock() {
  const calls = [];
  return {
    calls, label: 'mock',
    async complete(call) {
      calls.push(call);
      const [base, seat = ''] = call.role.split('-')[0].split('_');
      if (['technical', 'derivatives', 'news', 'sentiment'].includes(base)) return `${base} ${seat}\n\n**Stance**: ${seat === '2' ? 'Bearish' : 'Bullish'}\n**Confidence**: 0.7`;
      if (base === 'researchManager') return '**Rating**: Overweight\n\n근거.';
      if (base === 'trader') return `**Action**: LONG\n\nFINAL TRANSACTION PROPOSAL: **LONG**`;
      if (base === 'portfolioManager') return seat === '3' ? PM('HOLD', null, null, 0.6) : PM('LONG', 63000, 66500, 0.7);
      if (base === 'biasDesk') return '```json\n{"bias":"LONG_ONLY","confidence":0.6,"note":"상승"}\n```';
      if (base === 'reflection') return '교훈: 손절 폭이 적절했다.';
      return `${base} 발언`;
    }
  };
}

test('engine: every agent of the team has its folder at once; a run records each call and runs each agent in its folder', async () => {
  const dir = tmp();
  let now = Date.UTC(2026, 9, 13, 9, 0);
  const llm = mock();
  const eng = new TradingEngine(shared.normalizeTradingConfig({ mode: 'agents', venue: 'paper', symbols: ['BTCUSDT'] }), {
    fetch: fetchWithPastPrice(70000), dataDir: dir, getSecret: () => undefined, createLlm: () => llm, emit: () => {}, now: () => now
  });
  const roster = eng.listAgents();
  assert.equal(roster.length, 31, 'standard team: 31 LLM agents');
  for (const a of roster) assert.ok(fs.existsSync(path.join(a.folder, 'CLAUDE.md')), a.id);

  await eng.runNow('BTCUSDT');
  assert.equal(eng.getSnapshot().runs[0].error, undefined);
  // Each call ran in its agent's folder, one session folder per symbol.
  const trend = llm.calls.find((c) => c.role.startsWith('technical_1-'));
  assert.equal(trend.workdir, path.join(dir, 'agents', 'technical-trend'));
  assert.equal(trend.sessionKey, 'BTCUSDT');
  assert.equal(llm.calls.find((c) => c.role.startsWith('portfolioManager_2-')).workdir, path.join(dir, 'agents', 'portfolioManager-risk'));
  assert.equal(llm.calls.find((c) => c.role.startsWith('trader_lead-')).workdir, path.join(dir, 'agents', 'trader-lead'));
  // First run: no record yet, so no memory block.
  assert.doesNotMatch(trend.system, /너의 지난 판단 기록/);
  const out = fs.readdirSync(path.join(dir, 'agents', 'technical-trend', 'outputs', 'BTCUSDT'));
  assert.equal(out.length, 1);
  const rec = JSON.parse(fs.readFileSync(path.join(dir, 'agents', 'technical-trend', 'record.json'), 'utf8'));
  assert.equal(rec.opinions[0].vote, 'Bullish');
  assert.equal(rec.opinions[0].price, 64000);
  // Debaters have no vote: their words are kept, no record.
  assert.ok(fs.readdirSync(path.join(dir, 'agents', 'bull-momentum', 'outputs', 'BTCUSDT')).length === 1);
  assert.ok(!fs.existsSync(path.join(dir, 'agents', 'bull-momentum', 'record.json')));
  const bull = eng.listAgents().find((r) => r.id === 'bull-momentum');
  assert.deepEqual([bull.opinions, bull.outputs, bull.active], [0, 1, true]);
  assert.ok(shared.UNSCORED_ROLES.includes('bull') && !shared.UNSCORED_ROLES.includes('trader'));

  // Four hours later the calls are checked against the price then (70000 > 64000).
  now += 4 * 3_600_000 + 60_000;
  const n = await eng.scoreAgents(true);
  assert.ok(n >= 10, `scored ${n}`);
  const rows = Object.fromEntries(eng.listAgents().map((r) => [r.id, r]));
  assert.equal(rows['technical-trend'].hitRate, 1, 'bullish, price rose');
  assert.equal(rows['technical-reversion'].hitRate, 0, 'bearish, price rose');
  assert.equal(rows['researchManager'].hits, 1, 'Overweight counts as bullish');
  assert.equal(rows['portfolioManager-quant'].scored, 0, 'HOLD is not scored');

  // The next run reminds each agent of its own record.
  const before = llm.calls.length;
  await eng.runNow('BTCUSDT');
  const trend2 = llm.calls.slice(before).find((c) => c.role.startsWith('technical_1-'));
  assert.match(trend2.system, /\[너의 지난 판단 기록 — 너의 프로젝트 폴더에서\]/);
  assert.match(trend2.system, /채점된 방향 판단 1건 중 1건 적중\(100%\)/);
  const rev2 = llm.calls.slice(before).find((c) => c.role.startsWith('technical_2-'));
  assert.match(rev2.system, /약세\(0\.70\) → 4시간 뒤 \+9\.38% ✗/);
  eng.dispose();
});

test('engine: a closed trade goes to the lessons of every agent that called a direction on it', async () => {
  const dir = tmp();
  const eng = new TradingEngine(shared.normalizeTradingConfig({ mode: 'agents', venue: 'paper', symbols: ['BTCUSDT'] }), {
    fetch: fetchWithPastPrice(64000), dataDir: dir, getSecret: () => undefined, createLlm: () => mock(), emit: () => {}
  });
  await eng.start();
  try {
    const t0 = Date.now();
    while (!(eng.getSnapshot().positions.length) && Date.now() - t0 < 8000) { await new Promise((r) => setTimeout(r, 25)); await eng.tick(); }
    assert.equal(eng.getSnapshot().positions.length, 1, 'committee opened a long');
    await eng.closePosition('BTCUSDT');
    const lesson = (id) => {
      const f = path.join(dir, 'agents', id, 'lessons.md');
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    };
    assert.match(lesson('portfolioManager-cio'), /BTCUSDT 롱 거래 종료\(수동 청산\).*너의 판단 롱 0\.70: 거래 방향과 같음/);
    assert.match(lesson('technical-reversion'), /너의 판단 약세 0\.70: 거래 방향과 반대/);
    assert.equal(lesson('portfolioManager-quant'), '', 'a HOLD vote is not a direction');
    assert.equal(lesson('bull-momentum'), '', 'debaters do not vote');
    // The reflection agent writes in its own folder too.
    const t1 = Date.now();
    while (!fs.existsSync(path.join(dir, 'agents', 'reflection', 'outputs', 'BTCUSDT')) && Date.now() - t1 < 4000) await new Promise((r) => setTimeout(r, 25));
    assert.ok(fs.existsSync(path.join(dir, 'agents', 'reflection', 'outputs', 'BTCUSDT')));
  } finally {
    await eng.stop();
    eng.dispose();
  }
});
