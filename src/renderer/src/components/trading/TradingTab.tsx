import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from '../PixelButton';
import { TradingOverview } from './TradingOverview';
import { TradingAgentsView } from './TradingAgentsView';
import { TradingTrades, TradingLog } from './TradingTrades';
import { TradingSettings } from './TradingSettings';
import { TradingTeam } from './TradingTeam';
import { chip, hint, useTradingSnapshot } from './tradingUi';
import type { EngineStatus, TradingConfig, TradingSymbol } from '@shared/trading';

/**
 * TRADING DESK — the TradingAgents multi-agent algorithm on Binance USDⓈ-M
 * perpetuals (BTCUSDT / ETHUSDT), plus a scalping mode. The engine runs in the
 * main process (src/main/trading/); this tab only shows its snapshot and sends
 * commands. Orders never originate here.
 */

type SubTab = 'overview' | 'agents' | 'team' | 'trades' | 'log' | 'settings';
const SUBTABS: SubTab[] = ['overview', 'agents', 'team', 'trades', 'log', 'settings'];

const STATUS_BG: Record<EngineStatus, string> = {
  stopped: 'var(--cth-status-idle)',
  starting: 'var(--cth-status-thinking)',
  running: 'var(--cth-status-success)',
  stopping: 'var(--cth-status-thinking)',
  halted: 'var(--cth-status-looping)',
  error: 'var(--cth-status-blocked)'
};

export function TradingTab() {
  const { t } = useTranslation();
  const snap = useTradingSnapshot();
  const [cfg, setCfg] = useState<TradingConfig | null>(null);
  const [sub, setSub] = useState<SubTab>('overview');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);

  const reloadConfig = useCallback(() => {
    window.cth.tradingGetConfig().then(setCfg).catch(() => { /* main not ready */ });
  }, []);
  useEffect(() => { reloadConfig(); }, [reloadConfig]);

  const status: EngineStatus = snap?.status ?? 'stopped';
  const running = status === 'running' || status === 'halted' || status === 'starting';

  const start = async () => {
    setBusy(true);
    setNotice(null);
    const r = await window.cth.tradingStart().catch((e: unknown) => ({ ok: false, error: String(e) }));
    if (!r.ok) setNotice({ text: t('trading.messages.startFailed', { error: r.error ?? '' }), error: true });
    setBusy(false);
  };
  const stop = async () => {
    setBusy(true);
    await window.cth.tradingStop().catch(() => undefined);
    setBusy(false);
  };
  const runNow = async (symbol: TradingSymbol) => {
    const r = await window.cth.tradingRunNow(symbol).catch((e: unknown) => ({ ok: false, error: String(e) }));
    if (!r.ok) setNotice({ text: r.error ?? '', error: true });
    else setNotice({ text: running ? t('trading.messages.queued', { symbol }) : t('trading.messages.analysisOnly', { symbol }) });
    if (cfg?.mode === 'agents') setSub('agents');
  };

  const mode = snap && running ? snap.mode : cfg?.mode ?? 'agents';
  const venue = snap && running ? snap.venue : cfg?.venue ?? 'paper';
  const symbols = cfg?.symbols ?? ['BTCUSDT', 'ETHUSDT'];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      {/* Header: identity, status, the three things a user does most. */}
      <div style={{ padding: '10px 14px 8px', display: 'flex', flexDirection: 'column', gap: 6, borderBottom: '1px solid var(--cth-ink-100)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 14, fontWeight: 700, color: 'var(--cth-ink-900)' }}>{t('trading.title')}</span>
          <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-500)' }}>{t('trading.subtitle')}</span>
          <span style={{ flex: 1 }} />
          <span style={chip(STATUS_BG[status])} title={snap?.statusMessage}>{t(`trading.status.${status}`)}</span>
          <span style={chip(venue === 'live' ? 'var(--cth-status-blocked)' : venue === 'demo' ? 'var(--cth-sky-light)' : 'var(--cth-cream-300)', 'var(--cth-ink-900)')}>
            {t(`trading.venues.${venue}`)}
          </span>
          <span style={chip('var(--cth-lilac-light)', 'var(--cth-ink-900)')}>{t(`trading.modes.${mode}`)}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {running ? (
            <PixelButton variant="destructive" size="sm" onClick={stop} disabled={busy}>{t('trading.actions.stop')}</PixelButton>
          ) : (
            <PixelButton variant="primary" size="sm" onClick={start} disabled={busy || !cfg}>{t('trading.actions.start')}</PixelButton>
          )}
          {symbols.map((s) => (
            <PixelButton key={s} variant="secondary" size="sm" onClick={() => runNow(s)}
              title={mode === 'agents' ? t('trading.actions.runNowHint') : t('trading.actions.biasNowHint')}>
              {mode === 'agents' ? t('trading.actions.runNow', { symbol: s.replace('USDT', '') }) : t('trading.actions.biasNow', { symbol: s.replace('USDT', '') })}
            </PixelButton>
          ))}
          {snap?.statusMessage && (status === 'error' || status === 'halted') && (
            <span style={{ ...hint, color: 'var(--cth-status-blocked)' }}>{snap.statusMessage}</span>
          )}
        </div>
        {notice && (
          <div style={{ ...hint, color: notice.error ? 'var(--cth-status-blocked)' : 'var(--cth-ink-700)' }}>{notice.text}</div>
        )}
        {venue === 'live' && (
          <div style={{ ...hint, color: 'var(--cth-status-blocked)', fontWeight: 700 }}>{t('trading.live.banner')}</div>
        )}
      </div>

      {/* Sub-tabs */}
      <div className="cth-tabbar" style={{ display: 'flex', gap: 4, padding: '6px 14px 0', overflowX: 'auto' }}>
        {SUBTABS.map((k) => (
          <button key={k} onClick={() => setSub(k)} style={{
            fontFamily: 'var(--cth-font-ui)', fontSize: 12, padding: '4px 10px', border: 'none', cursor: 'pointer',
            background: sub === k ? 'var(--cth-ink-900)' : 'var(--cth-cream-200)',
            color: sub === k ? 'var(--cth-cream-50)' : 'var(--cth-ink-900)', whiteSpace: 'nowrap'
          }}>
            {t(`trading.tabs.${k}`)}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 14px 16px' }}>
        {sub === 'overview' && <TradingOverview snap={snap} cfg={cfg} />}
        {sub === 'agents' && <TradingAgentsView snap={snap} />}
        {sub === 'team' && <TradingTeam snap={snap} />}
        {sub === 'trades' && <TradingTrades snap={snap} />}
        {sub === 'log' && <TradingLog snap={snap} />}
        {sub === 'settings' && (
          <TradingSettings
            cfg={cfg}
            running={running}
            onSaved={(next, restartRequired) => {
              setCfg(next);
              setNotice({ text: restartRequired ? t('trading.messages.restartRequired') : t('trading.messages.saved') });
            }}
          />
        )}
        <p style={{ ...hint, marginTop: 14 }}>{t('trading.disclaimer')}</p>
      </div>
    </div>
  );
}
