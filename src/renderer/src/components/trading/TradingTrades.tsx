import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { card, fmtPx, fmtTime, fmtUsd, hint, mono, pnlColor } from './tradingUi';
import type { LogLine, TradingSnapshot } from '@shared/trading';

const th: CSSProperties = {
  fontFamily: 'var(--cth-font-ui)', fontSize: 11, fontWeight: 700, color: 'var(--cth-ink-700)',
  textAlign: 'start', padding: '4px 6px', borderBottom: '1px solid var(--cth-ink-100)', whiteSpace: 'nowrap'
};
const td: CSSProperties = { ...mono, padding: '3px 6px', borderBottom: '1px solid var(--cth-ink-100)', whiteSpace: 'nowrap' };

export function TradingTrades({ snap }: { snap: TradingSnapshot | null }) {
  const { t } = useTranslation();
  const trades = snap?.trades ?? [];
  if (!trades.length) return <div style={{ ...card, ...hint }}>{t('trading.trades.none')}</div>;
  const total = trades.reduce((a, x) => a + x.pnl, 0);
  const wins = trades.filter((x) => x.pnl > 0).length;
  const fees = trades.reduce((a, x) => a + x.fees, 0);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ ...mono, fontSize: 12 }}>
        {t('trading.trades.summary', { count: trades.length, pnl: fmtUsd(total, true), rate: ((wins / trades.length) * 100).toFixed(0), fees: fmtUsd(fees) })}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              {['closedAt', 'symbol', 'side', 'source', 'qty', 'entry', 'exit', 'pnl', 'reason'].map((k) => (
                <th key={k} style={th}>{t(`trading.trades.cols.${k}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {trades.map((x) => (
              <tr key={x.id}>
                <td style={td}>{fmtTime(x.closedAt)}</td>
                <td style={td}>{x.symbol}</td>
                <td style={{ ...td, color: x.side === 'LONG' ? 'var(--cth-status-success)' : 'var(--cth-status-blocked)' }}>{t(`trading.side.${x.side}`)}</td>
                <td style={td}>{t(`trading.source.${x.source}`)}</td>
                <td style={td}>{x.quantity}</td>
                <td style={td}>{fmtPx(x.entryPrice)}</td>
                <td style={td}>{fmtPx(x.exitPrice)}</td>
                <td style={{ ...td, color: pnlColor(x.pnl) }}>{fmtUsd(x.pnl, true)}</td>
                <td style={td}>{x.exitReason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const LEVEL_COLOR: Record<LogLine['level'], string> = {
  info: 'var(--cth-ink-700)',
  warn: 'var(--cth-status-looping)',
  error: 'var(--cth-status-blocked)',
  trade: 'var(--cth-status-success)'
};

export function TradingLog({ snap }: { snap: TradingSnapshot | null }) {
  const { t } = useTranslation();
  const logs = snap?.logs ?? [];
  const endRef = useRef<HTMLDivElement | null>(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => {
    if (follow) endRef.current?.scrollIntoView({ block: 'end' });
  }, [logs.length, follow]);
  if (!logs.length) return <div style={{ ...card, ...hint }}>{t('trading.log.none')}</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label style={{ ...hint, display: 'flex', alignItems: 'center', gap: 6 }}>
        <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
        {t('trading.log.follow')}
      </label>
      <div style={{ ...card, gap: 2 }}>
        {logs.map((l, i) => (
          <div key={`${l.ts}-${i}`} style={{ display: 'flex', gap: 8, ...mono, color: LEVEL_COLOR[l.level], whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            <span style={{ color: 'var(--cth-ink-500)', flex: '0 0 auto' }}>{fmtTime(l.ts)}</span>
            <span>{l.message}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}
