import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from '../PixelButton';
import { MarkdownPreview } from '@/markdown/MarkdownPreview';
import { card, chip, fmtAge, fmtPx, fmtTime, hint, metaRow, mono, sectionHead, useNow } from './tradingUi';
import { agentIdOf, isAgentStep, stepKey, type AgentRole, type AgentRunView, type AgentStepView, type CommitteeView, type TradingSnapshot } from '@shared/trading';

/**
 * The TradingAgents pipeline as it runs: one row per agent, in graph order
 * (analysts → research debate → research manager → trader → risk debate →
 * portfolio manager → risk engine → execution). A staffed team shows its
 * merge step (team lead / head trader / committee tally) with its members
 * indented below it, each with its specialty and vote. Click a row to read
 * what that agent wrote. Reports are model output: rendered through
 * MarkdownPreview, which has no raw-HTML sink.
 */

const STATE_BG: Record<AgentStepView['state'], string> = {
  pending: 'var(--cth-cream-300)',
  running: 'var(--cth-status-thinking)',
  done: 'var(--cth-status-success)',
  error: 'var(--cth-status-blocked)',
  skipped: 'var(--cth-status-idle)'
};

/** Visual grouping of the pipeline, TradingAgents' teams + the desk's own two steps. */
const GROUPS: Array<{ key: string; roles: AgentRole[] }> = [
  { key: 'analysts', roles: ['technical', 'derivatives', 'news', 'sentiment'] },
  { key: 'research', roles: ['bull', 'bear', 'researchManager'] },
  { key: 'trader', roles: ['trader'] },
  { key: 'risk', roles: ['aggressive', 'conservative', 'neutral'] },
  { key: 'portfolio', roles: ['portfolioManager'] },
  { key: 'desk', roles: ['riskEngine', 'execution'] },
  { key: 'bias', roles: ['biasDesk'] }
];

const KNOWN_VOTES = new Set(['Bullish', 'Bearish', 'Neutral', 'LONG', 'SHORT', 'HOLD', 'CLOSE', 'LONG_ONLY', 'SHORT_ONLY', 'BOTH', 'NO_TRADE']);

function voteBg(v: string): string {
  if (v === 'Bullish' || v === 'LONG' || v === 'LONG_ONLY') return 'var(--cth-mint-light)';
  if (v === 'Bearish' || v === 'SHORT' || v === 'SHORT_ONLY' || v === 'CLOSE') return 'var(--cth-coral-light)';
  if (v === 'NO_TRADE') return 'var(--cth-cream-300)';
  return 'var(--cth-lemon-light)';
}

function VoteChip({ vote, confidence }: { vote?: string; confidence?: number }) {
  const { t } = useTranslation();
  if (!vote || !KNOWN_VOTES.has(vote)) return null;
  return (
    <span style={{ ...chip(voteBg(vote), 'var(--cth-ink-900)'), fontSize: 10, padding: '0 4px' }}>
      {t(`trading.votes.${vote}`)}{confidence !== undefined ? ` ${(confidence * 100).toFixed(0)}%` : ''}
    </span>
  );
}

/**
 * "2. 오실레이터·평균회귀 전문가" for a seat; "기술적 분석가 · 팀장 종합" for a
 * team's merge step (in the list, `short` drops the suffix: the bold row with
 * its members indented below already reads as the team).
 */
function useStepLabel() {
  const { t } = useTranslation();
  return (s: AgentStepView, short = false): string => {
    if (s.member && s.persona) return `${s.member}. ${t(`trading.personas.${s.role}.${s.persona}`)}`;
    if (s.lead && !short) return `${t(`trading.roles.${s.role}`)} · ${t(`trading.team.lead.${s.role}`)}`;
    return t(`trading.roles.${s.role}`);
  };
}

function StepRow({ step, selected, onClick, now }: { step: AgentStepView; selected: boolean; onClick: () => void; now: number }) {
  const { t } = useTranslation();
  const label = useStepLabel();
  const dur = step.startedAt ? (step.finishedAt ?? now) - step.startedAt : null;
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'start', cursor: 'pointer',
      border: 'none', padding: '4px 6px', paddingInlineStart: step.member ? 20 : 6,
      background: selected ? 'var(--cth-cream-300)' : 'transparent', color: 'var(--cth-ink-900)'
    }}>
      <span style={{ width: step.member ? 6 : 8, height: step.member ? 6 : 8, flex: '0 0 auto', background: STATE_BG[step.state] }} />
      <span title={label(step)} style={{
        fontFamily: 'var(--cth-font-ui)', fontSize: step.member ? 11 : 12, fontWeight: step.lead ? 700 : 400,
        flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
      }}>
        {label(step, true)}
      </span>
      <VoteChip vote={step.vote} />
      <span style={{ ...mono, fontSize: 10 }}>{t(`trading.steps.${step.state}`)}{dur !== null ? ` · ${fmtAge(dur)}` : ''}</span>
    </button>
  );
}

function CommitteeBox({ c }: { c: CommitteeView }) {
  const { t } = useTranslation();
  const role = c.kind === 'portfolio' ? 'portfolioManager' : 'biasDesk';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ ...hint, fontWeight: 700 }}>{t(c.kind === 'portfolio' ? 'trading.agentsView.committee' : 'trading.agentsView.panel')}</span>
        <span style={mono}>{t(`trading.consensus.${c.rule}`)}</span>
        <span style={chip(c.reached ? 'var(--cth-mint-light)' : 'var(--cth-cream-300)', 'var(--cth-ink-900)')}>
          {c.reached
            ? t('trading.agentsView.consensusReached', { agree: c.agree, responded: c.responded })
            : t('trading.agentsView.consensusMissed')}
        </span>
        {c.sizeScale !== undefined && c.sizeScale < 1 && (
          <span style={mono}>{t('trading.agentsView.sizeScale', { pct: Math.round(c.sizeScale * 100) })}</span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {c.votes.map((v) => (
          <span key={v.member} title={t(`trading.personas.${role}.${v.persona}`)} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, ...mono }}>
            {v.member}.
            {v.vote ? <VoteChip vote={v.vote} confidence={v.confidence ?? undefined} /> : <span>{t('trading.agentsView.noVote')}</span>}
          </span>
        ))}
      </div>
    </div>
  );
}

export function TradingAgentsView({ snap }: { snap: TradingSnapshot | null }) {
  const { t } = useTranslation();
  const label = useStepLabel();
  const now = useNow(1000);
  const runs = snap?.runs ?? [];
  const [runId, setRunId] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  // Follow the newest run unless the user picked one (clicking the newest
  // again goes back to following).
  const run: AgentRunView | undefined = runs.find((r) => r.id === runId) ?? runs[0];

  if (!runs.length) {
    return <div style={{ ...card, ...hint }}>{t('trading.agentsView.noRuns')}</div>;
  }

  const steps = run?.steps ?? [];
  // Default selection: the running step, else the last step that has content.
  const running = steps.find((s) => s.state === 'running');
  const lastWithContent = [...steps].reverse().find((s) => s.content || s.error);
  const autoKey = running ? stepKey(running) : lastWithContent ? stepKey(lastWithContent) : null;
  const shown = steps.find((s) => stepKey(s) === (picked ?? autoKey));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Run picker */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {runs.map((r) => (
          <button key={r.id} onClick={() => { setRunId(r.id === runs[0]?.id ? null : r.id); setPicked(null); }} style={{
            fontFamily: 'var(--cth-font-mono)', fontSize: 11, padding: '3px 8px', border: 'none', cursor: 'pointer',
            background: run?.id === r.id ? 'var(--cth-ink-900)' : 'var(--cth-cream-200)',
            color: run?.id === r.id ? 'var(--cth-cream-50)' : 'var(--cth-ink-900)'
          }}>
            {r.symbol.replace('USDT', '')} · {r.kind === 'bias' ? t('trading.agentsView.biasRun') : t('trading.agentsView.pipelineRun')} · {fmtTime(r.startedAt)}
            {!r.finishedAt ? ' …' : r.error ? ' ✕' : ''}
          </button>
        ))}
      </div>

      {run && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(190px, 250px) 1fr', gap: 10, alignItems: 'start' }}>
          {/* Pipeline */}
          <div style={{ ...card, padding: 6, gap: 2 }}>
            {GROUPS.map((g) => {
              const gs = steps.filter((s) => g.roles.includes(s.role));
              if (!gs.length) return null;
              const seats = gs.filter((s) => s.member).length;
              return (
                <div key={g.key} style={{ display: 'flex', flexDirection: 'column', gap: 1, marginBottom: 4 }}>
                  <span style={{ ...hint, fontWeight: 700, padding: '2px 6px' }}>
                    {t(`trading.agentsView.groups.${g.key}`)}
                    {seats > 0 && <span style={{ fontWeight: 400 }}> · {t('trading.agentsView.seats', { count: seats })}</span>}
                  </span>
                  {gs.map((s) => (
                    <StepRow key={stepKey(s)} step={s} now={now} selected={!!shown && stepKey(shown) === stepKey(s)} onClick={() => setPicked(stepKey(s))} />
                  ))}
                </div>
              );
            })}
          </div>

          {/* Selected agent output + the decision */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
            {run.decision && (
              <div style={{ ...card, background: 'var(--cth-cream-100)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={sectionHead}>{t('trading.agentsView.decision')}</span>
                  <span style={chip('var(--cth-lemon-light)', 'var(--cth-ink-900)')}>{run.decision.rating}</span>
                  <span style={chip(run.decision.action === 'LONG' ? 'var(--cth-mint-light)' : run.decision.action === 'SHORT' ? 'var(--cth-coral-light)' : 'var(--cth-cream-300)', 'var(--cth-ink-900)')}>
                    {t(`trading.actionNames.${run.decision.action}`)}
                  </span>
                  <span style={mono}>{t('trading.overview.confidence')} {(run.decision.confidence * 100).toFixed(0)}%</span>
                </div>
                <div style={metaRow}>
                  <span>{t('trading.agentsView.entry')} {run.decision.entryType === 'LIMIT' ? `${t('trading.agentsView.limit')} ${fmtPx(run.decision.entryPrice)}` : t('trading.agentsView.market')}</span>
                  <span>{t('trading.overview.sl')} {fmtPx(run.decision.stopLoss)}</span>
                  <span>{t('trading.overview.tp')} {fmtPx(run.decision.takeProfit)}</span>
                  <span>{t('trading.agentsView.leverage')} {run.decision.leverage ?? '-'}x</span>
                  <span>{t('trading.agentsView.risk')} {run.decision.riskPct ?? '-'}%</span>
                  {run.decision.horizonHours ? <span>{t('trading.agentsView.horizon', { hours: run.decision.horizonHours })}</span> : null}
                </div>
                {run.committee && <CommitteeBox c={run.committee} />}
                {run.decision.summary && <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)' }}>{run.decision.summary}</div>}
                {run.verdict && (
                  <div style={{ ...hint, color: run.verdict.approved ? 'var(--cth-status-success)' : 'var(--cth-ink-700)' }}>
                    {t('trading.agentsView.verdict')}: {run.verdict.approved ? t('trading.agentsView.approved') : t('trading.agentsView.notExecuted')} — {run.verdict.reason}
                    {run.verdict.adjustments.length > 0 && ` (${run.verdict.adjustments.join('; ')})`}
                  </div>
                )}
                {run.reportPath && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ ...mono, wordBreak: 'break-all' }}>{run.reportPath}</span>
                    <PixelButton size="sm" variant="ghost" onClick={() => { void window.cth.tradingOpenReports(); }}>{t('trading.actions.openReports')}</PixelButton>
                  </div>
                )}
              </div>
            )}
            {!run.decision && run.committee && <div style={{ ...card, background: 'var(--cth-cream-100)' }}><CommitteeBox c={run.committee} /></div>}
            {run.error && <div style={{ ...card, ...hint, color: 'var(--cth-status-blocked)' }}>{run.error}</div>}

            <div style={{ ...card, minHeight: 120 }}>
              {shown ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={sectionHead}>{shown.member ? `${t(`trading.roles.${shown.role}`)} ${label(shown)}` : label(shown)}</span>
                    <span style={chip(STATE_BG[shown.state], 'var(--cth-ink-900)')}>{t(`trading.steps.${shown.state}`)}</span>
                    <VoteChip vote={shown.vote} confidence={shown.confidence} />
                    <span style={hint}>{t(`trading.roleHints.${shown.role}`)}</span>
                    {isAgentStep(shown) && (
                      <PixelButton size="sm" variant="ghost" title={t('trading.agentsView.openFolderHint')}
                        onClick={() => { void window.cth.tradingOpenAgentFolder(agentIdOf(shown.role, { persona: shown.persona, lead: shown.lead })); }}>
                        {t('trading.agentsView.openFolder')}
                      </PixelButton>
                    )}
                  </div>
                  {shown.error && <div style={{ ...hint, color: 'var(--cth-status-blocked)' }}>{shown.error}</div>}
                  {shown.content ? (
                    <div style={{ fontSize: 12 }}><MarkdownPreview source={shown.content} variant="card" /></div>
                  ) : (
                    <div style={hint}>{shown.state === 'running' ? t('trading.agentsView.working') : t('trading.agentsView.noContent')}</div>
                  )}
                </>
              ) : (
                <div style={hint}>{t('trading.agentsView.selectStep')}</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
