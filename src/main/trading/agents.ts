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
 */
import type { LlmClient } from './llm';
import {
  aggressivePrompt, bearPrompt, bullPrompt, conservativePrompt, derivativesAnalystPrompt,
  neutralPrompt, newsAnalystPrompt, portfolioManagerPrompt, researchManagerPrompt,
  sentimentAnalystPrompt, technicalAnalystPrompt, traderPrompt, DECISION_JSON_SPEC,
  type AnalystReports, type DeskContext
} from './prompts';
import { parseFinalDecision, parseRating, parseTraderAction } from './decision';
import type {
  AgentRole, AgentStepView, AnalystKey, FinalDecision, Rating, TradeAction
} from '../../shared/trading';

export interface PipelineDeps {
  llm: LlmClient;
  /** Called whenever a step changes state (running/done/error/skipped). */
  onStep: (step: AgentStepView) => void;
  /** Checked between steps; return true to abort (engine stopping). */
  aborted?: () => boolean;
  now?: () => number;
}

export interface PipelineInput {
  ctx: DeskContext;
  analysts: readonly AnalystKey[];
  debateRounds: number;
  riskRounds: number;
}

export interface PipelineResult {
  reports: AnalystReports;
  investmentHistory: string;
  investmentPlan: string;
  researchRating: Rating | null;
  traderPlan: string;
  traderAction: TradeAction | null;
  riskHistory: string;
  finalText: string;
  decision: FinalDecision;
  parsedJson: boolean;
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

export async function runPipeline(input: PipelineInput, deps: PipelineDeps): Promise<PipelineResult> {
  const { ctx } = input;
  const now = deps.now ?? Date.now;
  const steps = new Map<AgentRole, AgentStepView>();
  const emit = (role: AgentRole, patch: Partial<AgentStepView>) => {
    const prev = steps.get(role) ?? { role, state: 'pending' as const };
    const next = { ...prev, ...patch, role };
    steps.set(role, next);
    deps.onStep(next);
  };
  const checkAbort = () => { if (deps.aborted?.()) throw new PipelineAborted(); };

  const call = async (role: AgentRole, tier: 'quick' | 'deep', p: { system: string; prompt: string }, maxTokens?: number) => {
    checkAbort();
    return deps.llm.complete({ role: `${role}-${ctx.symbol}`, tier, system: p.system, prompt: p.prompt, maxTokens });
  };

  // ── 1. analysts, in parallel ─────────────────────────────────────────────
  const reports: AnalystReports = { technical: '', derivatives: '', news: '', sentiment: '' };
  const selected = new Set(input.analysts);
  for (const key of ['technical', 'derivatives', 'news', 'sentiment'] as AnalystKey[]) {
    if (!selected.has(key)) emit(key, { state: 'skipped' });
  }
  await Promise.all([...selected].map(async (key) => {
    emit(key, { state: 'running', startedAt: now() });
    try {
      const text = await call(key, 'quick', ANALYST_PROMPTS[key](ctx));
      reports[key] = text.trim();
      emit(key, { state: 'done', finishedAt: now(), content: reports[key] });
    } catch (e) {
      if (e instanceof PipelineAborted) throw e;
      // Fail open like TradingAgents: the debate proceeds with the reports it has.
      emit(key, { state: 'error', finishedAt: now(), error: e instanceof Error ? e.message : String(e) });
    }
  }));
  if (![...selected].some((k) => reports[k])) {
    throw new Error('모든 분석가가 실패했습니다 — LLM 연결을 확인하세요');
  }

  // ── 2. bull ⇄ bear research debate ───────────────────────────────────────
  let history = '';
  let lastBull = '';
  let lastBear = '';
  const bullTurns: string[] = [];
  const bearTurns: string[] = [];
  emit('bull', { state: 'running', startedAt: now() });
  emit('bear', { state: 'pending' });
  for (let round = 0; round < input.debateRounds; round++) {
    emit('bull', { state: 'running' });
    const bull = (await call('bull', 'quick', bullPrompt(ctx, reports, history, lastBear))).trim();
    lastBull = `${SPEAKER.bull}: ${bull}`;
    history += `\n${lastBull}`;
    bullTurns.push(bull);
    emit('bull', { state: 'done', finishedAt: now(), content: joinRounds(bullTurns) });

    emit('bear', { state: 'running', startedAt: steps.get('bear')?.startedAt ?? now() });
    const bear = (await call('bear', 'quick', bearPrompt(ctx, reports, history, lastBull))).trim();
    lastBear = `${SPEAKER.bear}: ${bear}`;
    history += `\n${lastBear}`;
    bearTurns.push(bear);
    emit('bear', { state: 'done', finishedAt: now(), content: joinRounds(bearTurns) });
  }
  const investmentHistory = history.trim();

  // ── 3. research manager ──────────────────────────────────────────────────
  emit('researchManager', { state: 'running', startedAt: now() });
  const investmentPlan = (await call('researchManager', 'deep', researchManagerPrompt(ctx, investmentHistory))).trim();
  const researchRating = parseRating(investmentPlan);
  emit('researchManager', { state: 'done', finishedAt: now(), content: investmentPlan });

  // ── 4. trader ────────────────────────────────────────────────────────────
  emit('trader', { state: 'running', startedAt: now() });
  const traderPlan = (await call('trader', 'quick', traderPrompt(ctx, investmentPlan, reports.technical))).trim();
  const traderAction = parseTraderAction(traderPlan);
  emit('trader', { state: 'done', finishedAt: now(), content: traderPlan });

  // ── 5. risk debate: aggressive → conservative → neutral ──────────────────
  let riskHistory = '';
  let lastAggr = '';
  let lastCons = '';
  let lastNeut = '';
  const turns: Record<'aggressive' | 'conservative' | 'neutral', string[]> = { aggressive: [], conservative: [], neutral: [] };
  for (let round = 0; round < input.riskRounds; round++) {
    for (const role of ['aggressive', 'conservative', 'neutral'] as const) {
      emit(role, { state: 'running', startedAt: steps.get(role)?.startedAt ?? now() });
      const p = role === 'aggressive'
        ? aggressivePrompt(ctx, reports, traderPlan, riskHistory, lastCons, lastNeut)
        : role === 'conservative'
          ? conservativePrompt(ctx, reports, traderPlan, riskHistory, lastAggr, lastNeut)
          : neutralPrompt(ctx, reports, traderPlan, riskHistory, lastAggr, lastCons);
      const text = (await call(role, 'quick', p)).trim();
      const line = `${SPEAKER[role]}: ${text}`;
      riskHistory += `\n${line}`;
      if (role === 'aggressive') lastAggr = line;
      else if (role === 'conservative') lastCons = line;
      else lastNeut = line;
      turns[role].push(text);
      emit(role, { state: 'done', finishedAt: now(), content: joinRounds(turns[role]) });
    }
  }

  // ── 6. portfolio manager ─────────────────────────────────────────────────
  emit('portfolioManager', { state: 'running', startedAt: now() });
  let finalText = (await call('portfolioManager', 'deep', portfolioManagerPrompt(ctx, investmentPlan, traderPlan, riskHistory.trim()))).trim();
  let parsed = parseFinalDecision(finalText);
  if (!parsed.parsedJson) {
    // One cheap repair turn: ask for the JSON block only, from its own text.
    try {
      const repair = await call('portfolioManager', 'quick', {
        system: '너는 결정문을 기계가 읽을 JSON으로 옮기는 서기다. JSON 블록 하나만 출력하라.',
        prompt: `다음 포트폴리오 매니저의 결정문을 아래 형식의 JSON 블록 하나로만 옮겨라. 결정문에 없는 가격은 null로 둬라.\n\n${DECISION_JSON_SPEC}\n\n결정문:\n${finalText}`
      });
      const repaired = parseFinalDecision(`${finalText}\n\n${repair}`);
      if (repaired.parsedJson) {
        parsed = repaired;
        finalText = `${finalText}\n\n${repair.trim()}`;
      }
    } catch { /* keep the text-only parse (rating → action, no prices) */ }
  }
  emit('portfolioManager', { state: 'done', finishedAt: now(), content: finalText });

  return {
    reports,
    investmentHistory,
    investmentPlan,
    researchRating,
    traderPlan,
    traderAction,
    riskHistory: riskHistory.trim(),
    finalText,
    decision: parsed.decision,
    parsedJson: parsed.parsedJson
  };
}

function joinRounds(turns: string[]): string {
  return turns.length === 1 ? turns[0] : turns.map((t, i) => `**라운드 ${i + 1}**\n\n${t}`).join('\n\n---\n\n');
}

const ROLE_TITLE: Record<string, string> = {
  technical: '기술적 분석가', derivatives: '파생상품 분석가', news: '뉴스 분석가', sentiment: '심리 분석가'
};

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
    `- 최종 등급: **${d.rating}** · 행동: **${d.action}** · 확신도 ${(d.confidence * 100).toFixed(0)}%`,
    `- 리스크 엔진: ${opts.verdictText}`,
    ...(opts.notes.length ? [`- 데이터 참고: ${opts.notes.join('; ')}`] : []),
    '',
    opts.snapshotVerified,
    '',
    '## I. 분석가 팀'
  ];
  for (const k of ['technical', 'derivatives', 'news', 'sentiment'] as const) {
    if (r.reports[k]) sections.push(`### ${ROLE_TITLE[k]}`, r.reports[k], '');
  }
  sections.push(
    '## II. 리서치 팀 토론', r.investmentHistory, '',
    '### 리서치 매니저 결정', r.investmentPlan, '',
    '## III. 트레이더 제안', r.traderPlan, '',
    '## IV. 리스크 관리 토론', r.riskHistory, '',
    '## V. 포트폴리오 매니저 최종 결정', r.finalText, ''
  );
  return sections.join('\n');
}
