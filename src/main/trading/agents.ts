/**
 * The TradingAgents pipeline ("에이전트 알고리즘 모드").
 *
 * Same graph as TradingAgents' GraphSetup, written as plain async code:
 *
 *   analysts (parallel) ─▶ Bull ⇄ Bear (N rounds) ─▶ Research Manager
 *     ─▶ Trader ─▶ Aggressive → Conservative → Neutral (N rounds)
 *     ─▶ Portfolio Manager ─▶ (risk engine & execution, in engine.ts)
 *
 * Debate turn order and termination follow TradingAgents' ConditionalLogic:
 * the research debate ends after 2×rounds turns, the risk debate after
 * 3×rounds. The quick tier serves analysts, researchers, debaters and the
 * trader; the deep tier serves the two managers.
 *
 * Every team can be staffed by several agents (see teams.ts and
 * TeamSettings). With one agent per role this is exactly the graph above;
 * with more:
 *   - each analyst role runs N specialists in parallel and its team lead merges
 *     them into the one report the researchers read;
 *   - N bulls and N bears speak in turn (bull 1, bear 1, bull 2, bear 2 …) each
 *     round, every speaker seeing the whole transcript;
 *   - N traders propose independently and the head trader merges them;
 *   - N debaters per risk stance speak in turn (aggressive 1, conservative 1,
 *     neutral 1, aggressive 2 …);
 *   - N portfolio committee members decide independently and code tallies
 *     their votes under the consensus rule.
 */
import type { LlmClient } from './llm';
import {
  aggressivePrompt, bearPrompt, bullPrompt, conservativePrompt, derivativesAnalystPrompt,
  neutralPrompt, newsAnalystPrompt, portfolioManagerPrompt, researchManagerPrompt,
  sentimentAnalystPrompt, technicalAnalystPrompt, traderPrompt, DECISION_JSON_SPEC,
  type AnalystReports, type DeskContext
} from './prompts';
import { parseFinalDecision, parseRating, parseTraderAction } from './decision';
import {
  ANALYST_MEMBER_CLOSING, CONSENSUS_KO, DEBATE_MEMBER_CLOSING, TRADER_MEMBER_CLOSING,
  actionTally, aggregateCommittee, analystLeadPrompt, committeeClosing, committeeMinutes,
  fallbackAnalystMerge, fallbackTraderMerge, headTraderPrompt, memberRule, parseStance,
  personaKey, personaOf, speakerName, stanceLabel, stanceTally, withMember, type MemberOutput
} from './teams';
import {
  ANALYST_KEYS, TEAM_LIMITS, stepId,
  type AgentRole, type AgentStepView, type AnalystKey, type CommitteeView, type ConsensusRule,
  type FinalDecision, type Rating, type TeamRole, type TeamSettings, type TradeAction
} from '../../shared/trading';

export interface PipelineDeps {
  llm: LlmClient;
  /** Called whenever a step changes state (running/done/error/skipped). */
  onStep: (step: AgentStepView) => void;
  /** Checked between steps; return true to abort (engine stopping). */
  aborted?: () => boolean;
  now?: () => number;
}

/** Headcounts the pipeline uses (maxParallel is the LLM client's business). */
export type PipelineTeams = Omit<TeamSettings, 'biasPanel' | 'maxParallel'>;

export interface PipelineInput {
  ctx: DeskContext;
  analysts: readonly AnalystKey[];
  debateRounds: number;
  riskRounds: number;
  /** Headcount per team. Omitted fields = one agent per role (the original graph). */
  teams?: Partial<PipelineTeams>;
}

export interface PipelineResult {
  teams: PipelineTeams;
  reports: AnalystReports;
  /** Per analyst role, when it was staffed by more than one agent. */
  analystMembers: Partial<Record<AnalystKey, MemberOutput[]>>;
  investmentHistory: string;
  investmentPlan: string;
  researchRating: Rating | null;
  traderPlan: string;
  traderAction: TradeAction | null;
  /** Individual proposals when the trading team had more than one trader. */
  traderMembers: MemberOutput[];
  riskHistory: string;
  finalText: string;
  decision: FinalDecision;
  parsedJson: boolean;
  /** Present when a portfolio committee voted. */
  committee?: CommitteeView;
}

export class PipelineAborted extends Error {
  constructor() { super('파이프라인이 중단되었습니다'); this.name = 'PipelineAborted'; }
}

const ANALYST_PROMPTS: Record<AnalystKey, (ctx: DeskContext) => { system: string; prompt: string }> = {
  technical: technicalAnalystPrompt,
  derivatives: derivativesAnalystPrompt,
  news: newsAnalystPrompt,
  sentiment: sentimentAnalystPrompt
};

const SPEAKER: Partial<Record<AgentRole, string>> = {
  bull: '강세 연구원',
  bear: '약세 연구원',
  aggressive: '공격적 리스크 분석가',
  conservative: '보수적 리스크 분석가',
  neutral: '중립 리스크 분석가'
};

export function resolveTeams(t: Partial<PipelineTeams> | undefined): PipelineTeams {
  const n = (v: number | undefined, max: number) => Math.min(max, Math.max(1, Math.round(v ?? 1)));
  return {
    analystsPerRole: n(t?.analystsPerRole, TEAM_LIMITS.analystsPerRole),
    researchersPerSide: n(t?.researchersPerSide, TEAM_LIMITS.researchersPerSide),
    traders: n(t?.traders, TEAM_LIMITS.traders),
    riskPerStance: n(t?.riskPerStance, TEAM_LIMITS.riskPerStance),
    portfolioCommittee: n(t?.portfolioCommittee, TEAM_LIMITS.portfolioCommittee),
    consensus: (t?.consensus ?? 'majority') as ConsensusRule
  };
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runPipeline(input: PipelineInput, deps: PipelineDeps): Promise<PipelineResult> {
  const { ctx } = input;
  const teams = resolveTeams(input.teams);
  const now = deps.now ?? Date.now;
  const steps = new Map<string, AgentStepView>();
  /** member: seat number for a staffed team; 'lead' for its merge step; undefined for a solo role. */
  const emit = (role: AgentRole, member: number | 'lead' | undefined, patch: Partial<AgentStepView>) => {
    const id = typeof member === 'number' ? stepId(role, member) : role;
    const base: AgentStepView = typeof member === 'number'
      ? { role, id, member, persona: personaKey(role as TeamRole, member), state: 'pending' }
      : member === 'lead' ? { role, id, lead: true, state: 'pending' } : { role, id, state: 'pending' };
    const next: AgentStepView = { ...(steps.get(id) ?? base), ...patch, role, id };
    steps.set(id, next);
    deps.onStep(next);
  };
  const startedAt = (role: AgentRole, member?: number) => steps.get(member ? stepId(role, member) : role)?.startedAt ?? now();
  const checkAbort = () => { if (deps.aborted?.()) throw new PipelineAborted(); };

  /** LLM role key — also the hidden session's folder, so every seat gets its own. */
  const llmKey = (role: string, member?: number | 'lead') =>
    member === undefined ? role : member === 'lead' ? `${role}_lead` : `${role}_${member}`;
  const call = async (key: string, tier: 'quick' | 'deep', p: { system: string; prompt: string }, maxTokens?: number) => {
    checkAbort();
    try {
      return await deps.llm.complete({ role: `${key}-${ctx.symbol}`, tier, system: p.system, prompt: p.prompt, maxTokens });
    } catch (e) {
      if (deps.aborted?.()) throw new PipelineAborted();
      throw e;
    }
  };

  // ── 1. analysts, in parallel ─────────────────────────────────────────────
  const reports: AnalystReports = { technical: '', derivatives: '', news: '', sentiment: '' };
  const analystMembers: Partial<Record<AnalystKey, MemberOutput[]>> = {};
  const selected = ANALYST_KEYS.filter((k) => input.analysts.includes(k));
  for (const key of ANALYST_KEYS) if (!selected.includes(key)) emit(key, undefined, { state: 'skipped' });
  const nA = teams.analystsPerRole;

  await Promise.all(selected.map(async (key) => {
    if (nA === 1) {
      emit(key, undefined, { state: 'running', startedAt: now() });
      try {
        const text = await call(key, 'quick', ANALYST_PROMPTS[key](ctx));
        reports[key] = text.trim();
        emit(key, undefined, { state: 'done', finishedAt: now(), content: reports[key] });
      } catch (e) {
        if (e instanceof PipelineAborted) throw e;
        // Fail open like TradingAgents: the debate proceeds with the reports it has.
        emit(key, undefined, { state: 'error', finishedAt: now(), error: errText(e) });
      }
      return;
    }

    const members = await Promise.all(range(nA).map(async (member): Promise<MemberOutput> => {
      const persona = personaKey(key, member);
      const name = personaOf(key, member).name;
      emit(key, member, { state: 'running', startedAt: now() });
      try {
        const p = withMember(ANALYST_PROMPTS[key](ctx), memberRule(key, member, nA, ANALYST_MEMBER_CLOSING));
        const text = (await call(llmKey(key, member), 'quick', p)).trim();
        const st = parseStance(text);
        emit(key, member, { state: 'done', finishedAt: now(), content: text, vote: st.stance ?? undefined, confidence: st.confidence ?? undefined });
        return { member, persona, name, text, vote: st.stance, confidence: st.confidence };
      } catch (e) {
        if (e instanceof PipelineAborted) throw e;
        emit(key, member, { state: 'error', finishedAt: now(), error: errText(e) });
        return { member, persona, name, text: '', vote: null, confidence: null, error: errText(e) };
      }
    }));
    analystMembers[key] = members;
    const ok = members.filter((m) => !m.error && m.text);
    if (!ok.length) {
      emit(key, 'lead', { state: 'error', finishedAt: now(), error: '팀원 전원이 실패했습니다' });
      return;
    }
    emit(key, 'lead', { state: 'running', startedAt: now() });
    let merged: string;
    let note: string | undefined;
    if (ok.length === 1) {
      merged = ok[0].text;
      note = `팀원 ${nA}명 중 ${ok[0].member}번만 응답해 그 보고서를 그대로 사용`;
    } else {
      try {
        merged = (await call(llmKey(key, 'lead'), 'quick', analystLeadPrompt(ctx, key, members))).trim();
      } catch (e) {
        if (e instanceof PipelineAborted) throw e;
        merged = fallbackAnalystMerge(key, members);
        note = `팀장 종합 실패(${errText(e)}) — 팀원 보고서를 이어 붙임`;
      }
    }
    reports[key] = merged;
    const st = parseStance(merged);
    emit(key, 'lead', {
      state: 'done', finishedAt: now(), content: merged, error: note,
      vote: st.stance ?? undefined, confidence: st.confidence ?? undefined
    });
  }));
  if (!selected.some((k) => reports[k])) {
    throw new Error('모든 분석가가 실패했습니다 — LLM 연결을 확인하세요');
  }

  // ── 2. bull ⇄ bear research debate ───────────────────────────────────────
  const nR = teams.researchersPerSide;
  let history = '';
  let lastBull = '';
  let lastBear = '';
  const turns = new Map<string, string[]>();
  const pushTurn = (id: string, text: string) => {
    const list = turns.get(id) ?? [];
    list.push(text);
    turns.set(id, list);
    return list;
  };
  if (nR === 1) {
    emit('bull', undefined, { state: 'running', startedAt: now() });
    emit('bear', undefined, { state: 'pending' });
  }
  let spoke = 0;
  for (let round = 0; round < input.debateRounds; round++) {
    for (const seat of range(nR)) {
      for (const side of ['bull', 'bear'] as const) {
        const member = nR > 1 ? seat : undefined;
        emit(side, member, { state: 'running', startedAt: startedAt(side, member) });
        const base = side === 'bull' ? bullPrompt(ctx, reports, history, lastBear) : bearPrompt(ctx, reports, history, lastBull);
        let text: string;
        try {
          const p = member ? withMember(base, memberRule(side, member, nR, DEBATE_MEMBER_CLOSING)) : base;
          text = (await call(llmKey(side, member), 'quick', p)).trim();
        } catch (e) {
          // A solo debate cannot go on without one side; a staffed one can.
          if (e instanceof PipelineAborted || !member) throw e;
          emit(side, member, { state: 'error', finishedAt: now(), error: errText(e) });
          continue;
        }
        const line = `${member ? speakerName(side, member) : SPEAKER[side]}: ${text}`;
        history += `\n${line}`;
        if (side === 'bull') lastBull = line; else lastBear = line;
        spoke++;
        emit(side, member, { state: 'done', finishedAt: now(), content: joinRounds(pushTurn(stepId(side, member), text)), error: undefined });
      }
    }
  }
  if (!spoke) throw new Error('리서치 토론에서 발언한 연구원이 없습니다');
  const investmentHistory = history.trim();

  // ── 3. research manager ──────────────────────────────────────────────────
  emit('researchManager', undefined, { state: 'running', startedAt: now() });
  const investmentPlan = (await call('researchManager', 'deep', researchManagerPrompt(ctx, investmentHistory))).trim();
  const researchRating = parseRating(investmentPlan);
  emit('researchManager', undefined, { state: 'done', finishedAt: now(), content: investmentPlan });

  // ── 4. trader(s) ─────────────────────────────────────────────────────────
  const nT = teams.traders;
  let traderPlan: string;
  let traderMembers: MemberOutput[] = [];
  if (nT === 1) {
    emit('trader', undefined, { state: 'running', startedAt: now() });
    traderPlan = (await call('trader', 'quick', traderPrompt(ctx, investmentPlan, reports.technical))).trim();
    emit('trader', undefined, { state: 'done', finishedAt: now(), content: traderPlan, vote: parseTraderAction(traderPlan) ?? undefined });
  } else {
    traderMembers = await Promise.all(range(nT).map(async (member): Promise<MemberOutput> => {
      const persona = personaKey('trader', member);
      const name = personaOf('trader', member).name;
      emit('trader', member, { state: 'running', startedAt: now() });
      try {
        const p = withMember(traderPrompt(ctx, investmentPlan, reports.technical), memberRule('trader', member, nT, TRADER_MEMBER_CLOSING));
        const text = (await call(llmKey('trader', member), 'quick', p)).trim();
        const action = parseTraderAction(text);
        emit('trader', member, { state: 'done', finishedAt: now(), content: text, vote: action ?? undefined });
        return { member, persona, name, text, vote: action, confidence: null };
      } catch (e) {
        if (e instanceof PipelineAborted) throw e;
        emit('trader', member, { state: 'error', finishedAt: now(), error: errText(e) });
        return { member, persona, name, text: '', vote: null, confidence: null, error: errText(e) };
      }
    }));
    const ok = traderMembers.filter((m) => !m.error && m.text);
    if (!ok.length) throw new Error('트레이더 전원이 실패했습니다');
    emit('trader', 'lead', { state: 'running', startedAt: now() });
    let note: string | undefined;
    if (ok.length === 1) {
      traderPlan = ok[0].text;
      note = `트레이더 ${nT}명 중 ${ok[0].member}번만 응답해 그 제안을 그대로 사용`;
    } else {
      try {
        traderPlan = (await call(llmKey('trader', 'lead'), 'quick', headTraderPrompt(ctx, investmentPlan, reports.technical, traderMembers))).trim();
      } catch (e) {
        if (e instanceof PipelineAborted) throw e;
        traderPlan = fallbackTraderMerge(traderMembers);
        note = `헤드 트레이더 종합 실패(${errText(e)}) — 다수 의견 사용`;
      }
    }
    emit('trader', 'lead', { state: 'done', finishedAt: now(), content: traderPlan, error: note, vote: parseTraderAction(traderPlan) ?? undefined });
  }
  const traderAction = parseTraderAction(traderPlan);

  // ── 5. risk debate: aggressive → conservative → neutral ──────────────────
  const nK = teams.riskPerStance;
  let riskHistory = '';
  let lastAggr = '';
  let lastCons = '';
  let lastNeut = '';
  let riskSpoke = 0;
  for (let round = 0; round < input.riskRounds; round++) {
    for (const seat of range(nK)) {
      for (const role of ['aggressive', 'conservative', 'neutral'] as const) {
        const member = nK > 1 ? seat : undefined;
        emit(role, member, { state: 'running', startedAt: startedAt(role, member) });
        const base = role === 'aggressive'
          ? aggressivePrompt(ctx, reports, traderPlan, riskHistory, lastCons, lastNeut)
          : role === 'conservative'
            ? conservativePrompt(ctx, reports, traderPlan, riskHistory, lastAggr, lastNeut)
            : neutralPrompt(ctx, reports, traderPlan, riskHistory, lastAggr, lastCons);
        let text: string;
        try {
          const p = member ? withMember(base, memberRule(role, member, nK, DEBATE_MEMBER_CLOSING)) : base;
          text = (await call(llmKey(role, member), 'quick', p)).trim();
        } catch (e) {
          if (e instanceof PipelineAborted || !member) throw e;
          emit(role, member, { state: 'error', finishedAt: now(), error: errText(e) });
          continue;
        }
        const line = `${member ? speakerName(role, member) : SPEAKER[role]}: ${text}`;
        riskHistory += `\n${line}`;
        if (role === 'aggressive') lastAggr = line;
        else if (role === 'conservative') lastCons = line;
        else lastNeut = line;
        riskSpoke++;
        emit(role, member, { state: 'done', finishedAt: now(), content: joinRounds(pushTurn(stepId(role, member), text)), error: undefined });
      }
    }
  }
  if (!riskSpoke) throw new Error('리스크 토론에서 발언한 분석가가 없습니다');

  // ── 6. portfolio manager / committee ─────────────────────────────────────
  const pmPrompt = portfolioManagerPrompt(ctx, investmentPlan, traderPlan, riskHistory.trim());
  /** One PM's decision, with one cheap repair turn if the JSON block is missing. */
  const decide = async (key: string, p: { system: string; prompt: string }) => {
    let text = (await call(key, 'deep', p)).trim();
    let parsed = parseFinalDecision(text);
    if (!parsed.parsedJson) {
      try {
        const repair = await call(key, 'quick', {
          system: '너는 결정문을 기계가 읽을 JSON으로 옮기는 서기다. JSON 블록 하나만 출력하라.',
          prompt: `다음 포트폴리오 매니저의 결정문을 아래 형식의 JSON 블록 하나로만 옮겨라. 결정문에 없는 가격은 null로 둬라.\n\n${DECISION_JSON_SPEC}\n\n결정문:\n${text}`
        });
        const repaired = parseFinalDecision(`${text}\n\n${repair}`);
        if (repaired.parsedJson) {
          parsed = repaired;
          text = `${text}\n\n${repair.trim()}`;
        }
      } catch (e) {
        if (e instanceof PipelineAborted) throw e;
        /* keep the text-only parse (rating → action, no prices) */
      }
    }
    return { text, ...parsed };
  };

  const nP = teams.portfolioCommittee;
  let finalText: string;
  let decision: FinalDecision;
  let parsedJson: boolean;
  let committee: CommitteeView | undefined;
  if (nP === 1) {
    emit('portfolioManager', undefined, { state: 'running', startedAt: now() });
    const r = await decide('portfolioManager', pmPrompt);
    finalText = r.text;
    decision = r.decision;
    parsedJson = r.parsedJson;
    emit('portfolioManager', undefined, { state: 'done', finishedAt: now(), content: finalText, vote: decision.action, confidence: decision.confidence });
  } else {
    const seats = await Promise.all(range(nP).map(async (member) => {
      const persona = personaKey('portfolioManager', member);
      emit('portfolioManager', member, { state: 'running', startedAt: now() });
      try {
        const r = await decide(llmKey('portfolioManager', member), withMember(pmPrompt, memberRule('portfolioManager', member, nP, committeeClosing(teams.consensus))));
        emit('portfolioManager', member, {
          state: 'done', finishedAt: now(), content: r.text, vote: r.decision.action, confidence: r.decision.confidence,
          error: r.parsedJson ? undefined : 'JSON 없음 — 등급만 반영'
        });
        return { member, persona, decision: r.decision as FinalDecision | null, parsedJson: r.parsedJson, text: r.text, error: undefined as string | undefined };
      } catch (e) {
        if (e instanceof PipelineAborted) throw e;
        emit('portfolioManager', member, { state: 'error', finishedAt: now(), error: errText(e) });
        return { member, persona, decision: null, parsedJson: false, text: '', error: errText(e) };
      }
    }));
    emit('portfolioManager', 'lead', { state: 'running', startedAt: now() });
    let agg: ReturnType<typeof aggregateCommittee>;
    try {
      agg = aggregateCommittee(seats.map((s) => ({ member: s.member, persona: s.persona, decision: s.decision })), teams.consensus, ctx.constraints.riskPerTradePct);
    } catch (e) {
      emit('portfolioManager', 'lead', { state: 'error', finishedAt: now(), error: errText(e) });
      throw e;
    }
    committee = agg.view;
    decision = agg.decision;
    parsedJson = seats.filter((s) => s.decision).every((s) => s.parsedJson);
    finalText = committeeMinutes(agg.view, seats);
    emit('portfolioManager', 'lead', { state: 'done', finishedAt: now(), content: finalText, vote: decision.action, confidence: decision.confidence });
  }

  return {
    teams,
    reports,
    analystMembers,
    investmentHistory,
    investmentPlan,
    researchRating,
    traderPlan,
    traderAction,
    traderMembers,
    riskHistory: riskHistory.trim(),
    finalText,
    decision,
    parsedJson,
    committee
  };
}

function joinRounds(turns: string[]): string {
  return turns.length === 1 ? turns[0] : turns.map((t, i) => `**라운드 ${i + 1}**\n\n${t}`).join('\n\n---\n\n');
}

const ROLE_TITLE: Record<AnalystKey, string> = {
  technical: '기술적 분석가', derivatives: '파생상품 분석가', news: '뉴스 분석가', sentiment: '심리 분석가'
};

/** "분석가 역할당 2명 · 연구원 진영당 2명 · …" */
export function teamsLabel(t: PipelineTeams): string {
  return [
    `분석가 역할당 ${t.analystsPerRole}명`,
    `연구원 진영당 ${t.researchersPerSide}명`,
    `트레이더 ${t.traders}명`,
    `리스크 성향당 ${t.riskPerStance}명`,
    `포트폴리오 위원회 ${t.portfolioCommittee}명${t.portfolioCommittee > 1 ? `(${CONSENSUS_KO[t.consensus]})` : ''}`
  ].join(' · ');
}

/** The whole run as one Korean markdown report (saved next to the journal). */
export function renderReport(opts: {
  symbol: string;
  takenAt: number;
  llmLabel: string;
  venueLabel: string;
  snapshotVerified: string;
  result: PipelineResult;
  verdictText: string;
  notes: string[];
}): string {
  const r = opts.result;
  const kst = new Date(opts.takenAt + 9 * 3_600_000).toISOString().replace('T', ' ').slice(0, 16);
  const d = r.decision;
  const sections: string[] = [
    `# ${opts.symbol} 트레이딩 에이전트 보고서 — ${kst} KST`,
    `- LLM: ${opts.llmLabel} · 실행 환경: ${opts.venueLabel}`,
    `- 팀 구성: ${teamsLabel(r.teams)}`,
    `- 최종 등급: **${d.rating}** · 행동: **${d.action}** · 확신도 ${(d.confidence * 100).toFixed(0)}%`,
    ...(r.committee ? [`- 위원회: ${r.committee.note}`] : []),
    `- 리스크 엔진: ${opts.verdictText}`,
    ...(opts.notes.length ? [`- 데이터 참고: ${opts.notes.join('; ')}`] : []),
    '',
    opts.snapshotVerified,
    '',
    '## I. 분석가 팀'
  ];
  for (const k of ANALYST_KEYS) {
    const members = r.analystMembers[k];
    if (!r.reports[k] && !members) continue;
    if (!members) {
      sections.push(`### ${ROLE_TITLE[k]}`, r.reports[k], '');
      continue;
    }
    sections.push(`### ${ROLE_TITLE[k]} 팀 — 팀장 종합 (팀 투표: ${stanceTally(members)})`, r.reports[k] || '(종합 없음)', '');
    for (const m of members) {
      sections.push(`#### 팀원 ${m.member} — ${m.name} (${stanceLabel(m)})`, m.error ? `(응답 실패: ${m.error})` : m.text, '');
    }
  }
  sections.push(
    '## II. 리서치 팀 토론', r.investmentHistory, '',
    '### 리서치 매니저 결정', r.investmentPlan, ''
  );
  if (r.traderMembers.length) {
    sections.push(`## III. 트레이딩 팀 (투표: ${actionTally(r.traderMembers)})`);
    for (const m of r.traderMembers) sections.push(`### 트레이더 ${m.member} — ${m.name}`, m.error ? `(응답 실패: ${m.error})` : m.text, '');
    sections.push('### 헤드 트레이더 종합', r.traderPlan, '');
  } else {
    sections.push('## III. 트레이더 제안', r.traderPlan, '');
  }
  sections.push(
    '## IV. 리스크 관리 토론', r.riskHistory, '',
    r.committee ? '## V. 포트폴리오 위원회 결정' : '## V. 포트폴리오 매니저 최종 결정', r.finalText, ''
  );
  return sections.join('\n');
}
