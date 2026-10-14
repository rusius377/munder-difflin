import { useEffect, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { TradingTab } from '@/components/trading/TradingTab';
import { PixelButton } from '@/components/PixelButton';
import { LANGUAGES, setLanguage } from '@/i18n';
import { useDirectionSync } from '@/i18n/useDirection';
import { hint, input, mono } from '@/components/trading/tradingUi';

/**
 * The standalone desk: the trading tab fills the window; a thin bar at the
 * bottom holds what the office app's settings held for it (language, the
 * Claude Code command) and a shortcut to the data folder.
 */
const bar: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '6px 14px',
  borderTop: '1px solid var(--cth-ink-100)', background: 'var(--cth-cream-200)'
};

export function App() {
  const { t, i18n } = useTranslation();
  useDirectionSync();
  const [info, setInfo] = useState<{ version: string; claudeCommand: string } | null>(null);
  const [cmd, setCmd] = useState('');
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    window.desk.info().then((i) => { setInfo(i); setCmd(i.claudeCommand); }).catch(() => undefined);
  }, []);
  useEffect(() => { document.title = t('desk.appName'); }, [t, i18n.language]);

  const saveCmd = async () => {
    const r = await window.desk.setClaudeCommand(cmd).catch((e: unknown) => ({ ok: false, error: String(e) }) as { ok: boolean; error?: string });
    if (r.ok) setInfo((i) => (i ? { ...i, claudeCommand: cmd.trim() } : i));
    setNote(r.ok ? { text: t('desk.saved') } : { text: r.error ?? '', error: true });
    setTimeout(() => setNote(null), 3000);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <TradingTab />
      </div>
      <div style={bar}>
        <span style={{ ...mono, fontWeight: 700 }}>{t('desk.appName')} {info ? `v${info.version}` : ''}</span>
        <label style={{ ...hint, display: 'flex', alignItems: 'center', gap: 6 }}>
          {t('desk.language')}
          <select value={i18n.language} onChange={(e) => setLanguage(e.target.value)} style={{ ...input, padding: '2px 4px' }}>
            {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
        </label>
        <label style={{ ...hint, display: 'flex', alignItems: 'center', gap: 6 }} title={t('desk.claudeHint')}>
          {t('desk.claudeCommand')}
          <input value={cmd} onChange={(e) => setCmd(e.target.value)} style={{ ...input, width: 220 }} spellCheck={false} />
        </label>
        <PixelButton size="sm" variant="secondary" onClick={() => { void saveCmd(); }} disabled={!info || cmd.trim() === info.claudeCommand || !cmd.trim()}>
          {t('desk.save')}
        </PixelButton>
        {note && <span style={{ ...hint, color: note.error ? 'var(--cth-status-blocked)' : 'var(--cth-status-success)' }}>{note.text}</span>}
        <span style={{ flex: 1 }} />
        <PixelButton size="sm" variant="ghost" onClick={() => { void window.desk.openDataDir(); }}>{t('desk.openData')}</PixelButton>
      </div>
    </div>
  );
}
