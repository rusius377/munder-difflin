import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from '../PixelButton';
import {
  card, chip, fmtAge, fmtPct, fmtPx, fmtTime, fmtUsd, hint, metaRow, mono, pnlColor, sectionHead, useNow
} from './tradingUi';
import type { TradingConfig, TradingSnapshot, TradingSymbol, BiasDirection, ScalpPlanView } from '@shared/trading';

const BIAS_BG: Record<BiasDirection, string> = {
  LONG_ONLY: 'var(--cth-mint-light)',
  SHORT_ONLY: 'var(--cth-coral-light)',
  BOTH: 'var(--cth-sky-light)',
  NO_TRADE: 'var(--cth-cream-300)'
};

function ScoreBar({ label, value, min, color }: { label: string; value: number; min: number; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ ...mono, width: 34 }}>{label}</span>
      <div style={{ position: 'relative', flex: 1, height: 8, background: 'var(--cth-cream-200)' }}>
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.max(0, Math.min(100, value))}%`, background: color }} />
        <div style={{ position: 'absolute', left: `${min}%`, top: -2, bottom: -2, width: 1, background: 'var(--cth-ink-700)' }} />
      </div>
      <span style={{ ...mono, width: 24, textAlign: 'right' }}>{value}</span>
    </div>
  );
}

const signedPct = (v: number, dp = 3) => `${v >= 0 ? '+' : ''}${v.toFixed(dp)}%`;

/** The scalper's trade card at its leverage (75x by default): entry, stop, target, R:R, liquidation, margin, ROE. */
function PlanCard({ plan, symbol }: { plan: ScalpPlanView; symbol: TradingSymbol }) {
  const { t } = useTranslation();
  const dir = plan.side === 'LONG' ? 1 : -1;
  const base = symbol.replace('USDT', '');
  const cell = (label: string, value: string, sub?: string, color?: string) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
      <span style={hint}>{label}</span>
      <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 12, color: color ?? 'var(--cth-ink-900)' }}>{value}</span>
      {sub && <span style={{ ...mono, fontSize: 10 }}>{sub}</span>}
    </div>
  );
  const netWeak = plan.rewardRiskNet < 1;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '6px 8px', border: '1px dashed var(--cth-ink-300)', background: 'var(--cth-cream-50)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ ...hint, fontWeight: 700, color: 'var(--cth-ink-900)' }}>{t('trading.plan.title', { lev: plan.requestedLeverage })}</span>
        <span style={chip(plan.ready ? 'var(--cth-status-success)' : 'var(--cth-cream-300)', plan.ready ? 'var(--cth-cream-50)' : 'var(--cth-ink-900)')}>
          {plan.ready ? t('trading.plan.ready') : t('trading.plan.waiting')}
        </span>
        <span style={chip(plan.side === 'LONG' ? 'var(--cth-mint-light)' : 'var(--cth-coral-light)', 'var(--cth-ink-900)')}>{t(`trading.side.${plan.side}`)} · {plan.score}</span>
        {plan.leverage !== plan.requestedLeverage && <span style={mono}>{t('trading.plan.levAdjusted', { req: plan.requestedLeverage, lev: plan.leverage })}</span>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(118px, 1fr))', gap: 6 }}>
        {cell(t('trading.plan.entry'), fmtPx(plan.entryPrice))}
        {cell(t('trading.plan.stop'), fmtPx(plan.stopLoss), signedPct(-dir * plan.stopPct), 'var(--cth-status-blocked)')}
        {cell(t('trading.plan.target'), fmtPx(plan.takeProfit), signedPct(dir * plan.targetPct), 'var(--cth-status-success)')}
        {cell(t('trading.plan.rr'), `${plan.rewardRisk.toFixed(2)} : 1`, t('trading.plan.rrNet', { v: plan.rewardRiskNet.toFixed(2) }), netWeak ? 'var(--cth-status-blocked)' : undefined)}
        {cell(t('trading.plan.leverage'), `${plan.leverage}x`, `MMR ${(plan.maintMarginRate * 100).toFixed(2)}%`)}
        {cell(t('trading.plan.liq'), fmtPx(plan.liquidationPrice), signedPct(-dir * plan.liquidationPct, 2))}
        {cell(t('trading.plan.qty'), `${plan.quantity.toFixed(3)} ${base}`, `${t('trading.plan.notional')} ${fmtUsd(plan.notional)}`)}
        {cell(t('trading.plan.margin'), `${fmtUsd(plan.margin)} USDT`)}
        {cell(t('trading.plan.atStop'), `${fmtUsd(-plan.riskUsdt, true)} USDT`, `ROE ${signedPct(plan.roeAtStop, 1)}`, 'var(--cth-status-blocked)')}
        {cell(t('trading.plan.atTarget'), `${fmtUsd(plan.rewardUsdt, true)} USDT`, `ROE ${signedPct(plan.roeAtTarget, 1)}`, pnlColor(plan.rewardUsdt))}
        {cell(t('trading.plan.fees'), `${fmtUsd(plan.feesUsdt)} USDT`, `${t('trading.plan.breakEven')} ${plan.breakEvenPct.toFixed(3)}%`)}
      </div>
      {netWeak && <div style={{ ...hint, color: 'var(--cth-status-blocked)' }}>{t('trading.plan.feeWarning')}</div>}
      {plan.notes.length > 0 && <div style={hint}>{plan.notes.join(' · ')}</div>}
      {plan.bracketsEstimated && <div style={{ ...hint, fontSize: 10 }}>{t('trading.plan.estimated')}</div>}
    </div>
  );
}

export function TradingOverview({ snap, cfg }: { snap: TradingSnapshot | null; cfg: TradingConfig | null }) {
  const { t } = useTranslation();
  const now = useNow(1000);
  const [closing, setClosing] = useState<Record<string, boolean>>({});
  const [confirm, setConfirm] = useState<TradingSymbol | null>(null);

  const symbols: TradingSymbol[] = snap?.symbols?.length ? snap.symbols : cfg?.symbols ?? ['BTCUSDT', 'ETHUSDT'];
  const a = snap?.account ?? null;
  const mode = snap?.mode ?? cfg?.mode ?? 'agents';

  const close = async (s: TradingSymbol) => {
    setConfirm(null);
    setClosing((c) => ({ ...c, [s]: true }));
    await window.cth.tradingClosePosition(s).catch(() => undefined);
    setClosing((c) => ({ ...c, [s]: false }));
  };

  const dayPnl = a ? a.equity - a.dayStartEquity : null;
  const dayPct = a && a.dayStartEquity > 0 ? ((a.equity - a.dayStartEquity) / a.dayStartEquity) * 100 : null;
  const limit = cfg?.risk.dailyLossLimitPct ?? 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Account */}
      <div>
        <span style={sectionHead}>{t('trading.overview.account')}</span>
        {!a ? (
          <div style={{ ...card, ...hint }}>{t('trading.overview.noAccount')}</div>
        ) : (
          <div style={{ ...card }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 8 }}>
              {[
                [t('trading.overview.equity'), `${fmtUsd(a.equity)} USDT`, undefined],
                [t('trading.overview.available'), `${fmtUsd(a.available)} USDT`, undefined],
                [t('trading.overview.unrealized'), fmtUsd(a.unrealizedPnl, true), pnlColor(a.unrealizedPnl)],
                [t('trading.overview.realizedToday'), fmtUsd(a.realizedPnlToday, true), pnlColor(a.realizedPnlToday)],
                [t('trading.overview.dayChange'), `${fmtUsd(dayPnl, true)} (${fmtPct(dayPct)})`, pnlColor(dayPnl)],
                [t('trading.overview.tradesToday'), t('trading.overview.tradesTodayValue', { count: a.tradesToday, wins: a.winsToday, losses: a.lossesToday }), undefined]
              ].map(([label, value, color]) => (
                <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={hint}>{label}</span>
                  <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 13, color: color ?? 'var(--cth-ink-900)' }}>{value}</span>
                </div>
              ))}
            </div>
            {/* Daily loss limit gauge */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <span style={hint}>{t('trading.overview.dailyLimit', { pct: limit })}</span>
              <div style={{ flex: 1, height: 6, background: 'var(--cth-cream-200)', position: 'relative' }}>
                <div style={{
                  position: 'absolute', left: 0, top: 0, bottom: 0,
                  width: `${dayPct !== null && dayPct < 0 && limit > 0 ? Math.min(100, (-dayPct / limit) * 100) : 0}%`,
                  background: 'var(--cth-status-blocked)'
                }} />
              </div>
              <span style={mono}>{t('trading.overview.lossStreak', { count: a.consecutiveLosses })}</span>
            </div>
          </div>
        )}
      </div>

      {/* Per-symbol */}
      {symbols.map((s) => {
        const m = snap?.markets?.[s];
        const pos = snap?.positions?.find((p) => p.symbol === s);
        const sc = snap?.scalp?.[s];
        const bias = snap?.biases?.[s];
        const pending = snap?.pendingEntries?.find((p) => p.symbol === s);
        const lastRun = snap?.runs?.find((r) => r.symbol === s && r.kind === 'pipeline' && r.decision);
        const next = snap?.nextRunAt?.[s];
        return (
          <div key={s} style={card}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 14, fontWeight: 700, color: 'var(--cth-ink-900)' }}>{s}</span>
              <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 14, color: 'var(--cth-ink-900)' }}>{fmtPx(m?.price)}</span>
              <span style={{ ...mono, color: pnlColor(m?.change24hPct ?? null) }}>{fmtPct(m?.change24hPct ?? null)}</span>
              <span style={mono}>{t('trading.overview.mark')} {fmtPx(m?.markPrice)}</span>
              <span style={mono}>{t('trading.overview.funding')} {m ? fmtPct(m.fundingRate * 100, 4) : '-'}</span>
              {m && <span style={{ ...hint }}>{fmtAge(now - m.updatedAt)}</span>}
            </div>

            {/* Position */}
            {pos ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 8px', background: pos.side === 'LONG' ? 'var(--cth-mint-light)' : 'var(--cth-coral-light)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={chip(pos.side === 'LONG' ? 'var(--cth-status-success)' : 'var(--cth-status-blocked)', 'var(--cth-cream-50)')}>
                    {t(`trading.side.${pos.side}`)} {pos.leverage}x
                  </span>
                  <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 12, color: 'var(--cth-ink-900)' }}>
                    {pos.quantity} @ {fmtPx(pos.entryPrice)}
                  </span>
                  <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 12, color: pnlColor(pos.unrealizedPnl) }}>{fmtUsd(pos.unrealizedPnl, true)} USDT</span>
                  <span style={{ flex: 1 }} />
                  {confirm === s ? (
                    <>
                      <span style={hint}>{t('trading.overview.closeConfirm')}</span>
                      <PixelButton size="sm" variant="destructive" onClick={() => close(s)}>{t('trading.actions.closeYes')}</PixelButton>
                      <PixelButton size="sm" variant="ghost" onClick={() => setConfirm(null)}>{t('common.cancel')}</PixelButton>
                    </>
                  ) : (
                    <PixelButton size="sm" variant="secondary" disabled={!!closing[s]} onClick={() => setConfirm(s)}>
                      {closing[s] ? t('trading.actions.closing') : t('trading.actions.close')}
                    </PixelButton>
                  )}
                </div>
                <div style={metaRow}>
                  <span>{t('trading.overview.sl')} {fmtPx(pos.stopLoss)}</span>
                  <span>{t('trading.overview.tp')} {fmtPx(pos.takeProfit)}</span>
                  {pos.liquidationPrice ? <span>{t('trading.plan.liq')} {fmtPx(pos.liquidationPrice)}</span> : null}
                  {pos.margin ? <span style={{ color: pnlColor(pos.unrealizedPnl) }}>ROE {signedPct((pos.unrealizedPnl / pos.margin) * 100, 1)}</span> : null}
                  <span>{t('trading.overview.held')} {fmtAge(now - pos.openedAt)}</span>
                  <span>{t(`trading.source.${pos.source}`)}</span>
                </div>
              </div>
            ) : (
              <div style={hint}>{t('trading.overview.noPosition')}</div>
            )}

            {pending && (
              <div style={{ ...hint, color: 'var(--cth-ink-700)' }}>
                {t('trading.overview.pending', { side: t(`trading.side.${pending.side}`), price: fmtPx(pending.limitPrice), time: fmtTime(pending.expiresAt) })}
              </div>
            )}

            {/* Mode-specific */}
            {mode === 'agents' ? (
              <div style={metaRow}>
                {lastRun?.decision ? (
                  <>
                    <span>{t('trading.overview.lastDecision')}: <b>{lastRun.decision.rating}</b> / {t(`trading.actionNames.${lastRun.decision.action}`)}</span>
                    <span>{t('trading.overview.confidence')} {(lastRun.decision.confidence * 100).toFixed(0)}%</span>
                    {lastRun.committee && (
                      <span>{lastRun.committee.reached
                        ? t('trading.overview.committeeAgree', { agree: lastRun.committee.agree, responded: lastRun.committee.responded })
                        : t('trading.overview.committeeMissed')}</span>
                    )}
                    <span>{fmtTime(lastRun.finishedAt)}</span>
                  </>
                ) : (
                  <span>{t('trading.overview.noDecision')}</span>
                )}
                {next ? <span>{t('trading.overview.nextRun')} {next > now ? fmtAge(next - now) : t('trading.overview.soon')}</span> : null}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {sc ? (
                  <>
                    <ScoreBar label={t('trading.side.LONG')} value={sc.longScore} min={cfg?.scalping.minScore ?? 65} color="var(--cth-status-success)" />
                    <ScoreBar label={t('trading.side.SHORT')} value={sc.shortScore} min={cfg?.scalping.minScore ?? 65} color="var(--cth-status-blocked)" />
                    <div style={metaRow}>
                      <span>{t('trading.overview.trend')}: {t(`trading.trend.${sc.trend}`)}</span>
                      <span>ATR {sc.atrPct.toFixed(3)}%</span>
                      <span>{t('trading.overview.spread')} {sc.spreadBps.toFixed(2)}bp</span>
                      <span>{fmtAge(now - sc.evaluatedAt)}</span>
                    </div>
                    {sc.reasons.length > 0 && <div style={hint}>{sc.reasons.join(' · ')}</div>}
                    {sc.blocked && <div style={{ ...hint, color: 'var(--cth-ink-700)' }}>{t('trading.overview.blocked')}: {sc.blocked}</div>}
                    {sc.plan && !pos && <PlanCard plan={sc.plan} symbol={s} />}
                  </>
                ) : (
                  <div style={hint}>{t('trading.overview.noSignal')}</div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={hint}>{t('trading.overview.bias')}</span>
                  {bias ? (
                    <>
                      <span style={chip(BIAS_BG[bias.bias], 'var(--cth-ink-900)')}>{t(`trading.bias.${bias.bias}`)}</span>
                      <span style={mono}>{(bias.confidence * 100).toFixed(0)}% · {fmtAge(now - bias.updatedAt)}</span>
                      <span style={hint}>{bias.note}</span>
                    </>
                  ) : (
                    <span style={mono}>{cfg?.scalping.agentBias ? t('trading.overview.biasPending') : t('trading.overview.biasOff')}</span>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
