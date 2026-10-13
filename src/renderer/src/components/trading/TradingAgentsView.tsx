import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from '../PixelButton';
import { MarkdownPreview } from '@/markdown/MarkdownPreview';
import { card, chip, fmtAge, fmtPx, fmtTime, hint, metaRow, mono, sectionHead, useNow } from './tradingUi';
import type { AgentRole, AgentRunView, AgentStepView, TradingSnapshot } from '@shared/trading';

/**
 * The TradingAgents pipeline as it runs: one row per agent, in graph order
 * (analysts → research debate → research manager → trader → risk debate →
 * portfolio manager → risk engine → execution). Click an agent to read what it
 * wrote. Reports are model output: rendered through MarkdownPreview, which has
 * no raw-HTML sink.
 */

const STATE_BG: Record<AgentStepView['state'], string> = {
  pending: 'var(--cth-cream-300)',
  running: 'var(--cth-status-thinking)',
  done: 'var(--cth-status-success)',
  error: 'var(--cth-status-blocked)',
  skipped: 'var(--cth-status-idle)'
};

/** Visual grouping of the pipeline, TradingAgents' four teams + the desk's own two steps. */
const GROUPS: Array<{ key: string; roles: AgentRole[] }> = [
  { key: 'analysts', roles: ['technical', 'derivatives', 'news', 'sentiment'] },
  { key: 'research', roles: ['bull', 'bear', 'researchManager'] },
  { key: 'trader', roles: ['trader'] },
  { key: 'risk', roles: ['aggressive', 'conservative', 'neutral', 'portfolioManager'] },
  { key: 'desk', roles: ['riskEngine', 'execution'] },
  { key: 'bias', roles: ['biasDesk'] }
];

function StepRow({ step, selected, onClick, now }: { step: AgentStepView; selected: boolean; onClick: () => void; now: number }) {
  const { t } = useTranslation();
  const dur = step.startedAt ? (step.finishedAt ?? now) - step.startedAt : null;
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'start', cursor: 'pointer',
      border: 'none', padding: '4px 6px', background: selected ? 'var(--cth-cream-300)' : 'transparent', color: 'var(--cth-ink-900)'
    }}>
      <span style={{ width: 8, height: 8, flex: '0 0 auto', background: STATE_BG[step.state] }} />
      <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {t(`trading.roles.${step.role}`)}
      </span>
      <span style={{ ...mono, fontSize: 10 }}>{t(`trading.steps.${step.state}`)}{dur !== null ? ` · ${fmtAge(dur)}` : ''}</span>
    </button>
  );
}

export function TradingAgentsView({ snap }: { snap: TradingSnapshot | null }) {
  const { t } = useTranslation();
  const now = useNow(1000);
  const runs = snap?.runs ?? [];
  const [runId, setRunId] = useState<string | null>(null);
  const [role, setRole] = useState<AgentRole | null>(null);

  // Follow the newest run unless the user picked one (clicking the newest
  // again goes back to following).
  const run: AgentRunView | undefined = runs.find((r) => r.id === runId) ?? runs[0];

  if (!runs.length) {
    return <div style={{ ...card, ...hint }}>{t('trading.agentsView.noRuns')}</div>;
  }

  const steps = run?.steps ?? [];
  // Default selection: the running step, else the last step that has content.
  const autoRole = steps.find((s) => s.state === 'running')?.role
    ?? [...steps].reverse().find((s) => s.content || s.error)?.role
    ?? null;
  const shown = steps.find((s) => s.role === (role ?? autoRole));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Run picker */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {runs.map((r) => (
          <button key={r.id} onClick={() => { setRunId(r.id === runs[0]?.id ? null : r.id); setRole(null); }} style={{
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
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(170px, 220px) 1fr', gap: 10, alignItems: 'start' }}>
          {/* Pipeline */}
          <div style={{ ...card, padding: 6, gap: 2 }}>
            {GROUPS.map((g) => {
              const gs = g.roles.map((r) => steps.find((s) => s.role === r)).filter((s): s is AgentStepView => !!s);
              if (!gs.length) return null;
              return (
                <div key={g.key} style={{ display: 'flex', flexDirection: 'column', gap: 1, marginBottom: 4 }}>
                  <span style={{ ...hint, fontWeight: 700, padding: '2px 6px' }}>{t(`trading.agentsView.groups.${g.key}`)}</span>
                  {gs.map((s) => (
                    <StepRow key={s.role} step={s} now={now} selected={shown?.role === s.role} onClick={() => setRole(s.role)} />
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
            {run.error && <div style={{ ...card, ...hint, color: 'var(--cth-status-blocked)' }}>{run.error}</div>}

            <div style={{ ...card, minHeight: 120 }}>
              {shown ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={sectionHead}>{t(`trading.roles.${shown.role}`)}</span>
                    <span style={chip(STATE_BG[shown.state], 'var(--cth-ink-900)')}>{t(`trading.steps.${shown.state}`)}</span>
                    <span style={hint}>{t(`trading.roleHints.${shown.role}`)}</span>
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
