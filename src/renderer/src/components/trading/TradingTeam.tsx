import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from '../PixelButton';
import { card, chip, fmtAge, hint, mono, sectionHead, useNow } from './tradingUi';
import { TEAM_PERSONA_KEYS, UNSCORED_ROLES, type AgentProjectView, type AgentRole, type TeamRole, type TradingSnapshot } from '@shared/trading';

/**
 * Every desk agent's project folder (main/trading/agentProjects.ts): who it
 * is, how its directional calls scored against the market, and a button to
 * open its folder — where its CLAUDE.md instructions, scorecard, lessons and
 * outputs live. Paths never come from here: main resolves an agent id.
 */

const ROLE_ORDER: AgentRole[] = ['technical', 'derivatives', 'news', 'sentiment', 'bull', 'bear', 'researchManager', 'trader',
  'aggressive', 'conservative', 'neutral', 'portfolioManager', 'biasDesk', 'reflection'];

const GROUPS: Array<{ key: string; roles: AgentRole[] }> = [
  { key: 'analysts', roles: ['technical', 'derivatives', 'news', 'sentiment'] },
  { key: 'research', roles: ['bull', 'bear', 'researchManager'] },
  { key: 'trader', roles: ['trader'] },
  { key: 'risk', roles: ['aggressive', 'conservative', 'neutral'] },
  { key: 'portfolio', roles: ['portfolioManager'] },
  { key: 'bias', roles: ['biasDesk'] },
  { key: 'other', roles: ['reflection'] }
];

function order(a: AgentProjectView): number {
  const r = ROLE_ORDER.indexOf(a.role) * 100;
  if (a.lead) return r;
  if (!a.persona) return r + 1;
  const keys = (TEAM_PERSONA_KEYS as Record<string, readonly string[]>)[a.role] ?? [];
  return r + 2 + Math.max(0, keys.indexOf(a.persona));
}

const th: CSSProperties = {
  fontFamily: 'var(--cth-font-ui)', fontSize: 11, fontWeight: 700, color: 'var(--cth-ink-700)',
  textAlign: 'start', padding: '4px 6px', borderBottom: '1px solid var(--cth-ink-100)', whiteSpace: 'nowrap'
};
const td: CSSProperties = { ...mono, padding: '3px 6px', borderBottom: '1px solid var(--cth-ink-100)', whiteSpace: 'nowrap' };

type Roster = { root: string; agents: AgentProjectView[]; registered: boolean; canRegister: boolean };

export function TradingTeam({ snap }: { snap: TradingSnapshot | null }) {
  const { t } = useTranslation();
  const now = useNow(30_000);
  const [data, setData] = useState<Roster | null>(null);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [showFormer, setShowFormer] = useState(false);

  const load = useCallback(() => {
    window.cth.tradingAgents()
      .then((r) => { setData({ root: r.root, agents: r.agents, registered: r.registered, canRegister: r.canRegister !== false }); if (!r.ok && r.error) setMsg({ text: r.error, error: true }); })
      .catch((e: unknown) => setMsg({ text: String(e), error: true }));
  }, []);
  useEffect(() => { load(); }, [load]);
  // A finished run adds calls and outputs: refresh shortly after it lands.
  const lastFinished = snap?.runs?.[0]?.finishedAt;
  useEffect(() => {
    if (!lastFinished) return;
    const id = setTimeout(load, 1500);
    return () => clearTimeout(id);
  }, [lastFinished, load]);

  const open = async (id?: string) => {
    const r = await window.cth.tradingOpenAgentFolder(id).catch((e: unknown) => ({ ok: false, error: String(e) }));
    if (!r.ok) setMsg({ text: r.error ?? '', error: true });
  };
  const register = async () => {
    const r = await window.cth.tradingRegisterAgentsProject().catch((e: unknown) => ({ ok: false, error: String(e) } as { ok: boolean; error?: string }));
    if (!r.ok) { setMsg({ text: r.error ?? '', error: true }); return; }
    setMsg({ text: t('trading.roster.registerDone') });
    load();
  };

  const label = (a: AgentProjectView): string => {
    const role = t(`trading.roles.${a.role}`);
    if (a.lead) return `${role} · ${t(`trading.team.lead.${a.role}`)}`;
    if (a.persona) return `${role} · ${t(`trading.personas.${a.role as TeamRole}.${a.persona}`)}`;
    return role;
  };

  if (!data) return <div style={{ ...card, ...hint }}>{t('trading.roster.loading')}</div>;
  const active = data.agents.filter((a) => a.active).sort((a, b) => order(a) - order(b));
  const former = data.agents.filter((a) => !a.active).sort((a, b) => order(a) - order(b));

  const table = (rows: AgentProjectView[]) => (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr>
            {(['agent', 'opinions', 'hitRate', 'edge', 'pending', 'last', 'instructions', 'folder'] as const).map((c) => (
              <th key={c} style={th}>{t(`trading.roster.cols.${c}`)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {GROUPS.flatMap((g) => {
            const gs = rows.filter((a) => g.roles.includes(a.role));
            if (!gs.length) return [];
            return [
              <tr key={`g-${g.key}`}>
                <td colSpan={8} style={{ ...td, fontFamily: 'var(--cth-font-ui)', fontWeight: 700, color: 'var(--cth-ink-700)', paddingTop: 8 }}>
                  {t(g.key === 'other' ? 'trading.roster.groups.other' : `trading.agentsView.groups.${g.key}`)}
                </td>
              </tr>,
              ...gs.map((a) => (
                <tr key={a.id}>
                  <td style={{ ...td, fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)', fontWeight: a.lead ? 700 : 400, paddingInlineStart: a.persona ? 16 : 6 }} title={a.folder}>
                    {label(a)}
                  </td>
                  <td style={td}>
                    {UNSCORED_ROLES.includes(a.role)
                      ? (a.outputs ? t('trading.roster.speeches', { count: a.outputs }) : t('trading.roster.none'))
                      : a.opinions || t('trading.roster.none')}
                  </td>
                  <td style={td} title={a.scored ? `${a.hits}/${a.scored}` : undefined}>
                    {UNSCORED_ROLES.includes(a.role)
                      ? t('trading.roster.unscored')
                      : a.hitRate !== null ? `${Math.round(a.hitRate * 100)}% (${a.hits}/${a.scored})` : a.pending ? t('trading.roster.noScore') : t('trading.roster.none')}
                  </td>
                  <td style={{ ...td, color: a.avgEdgeBps === null ? undefined : a.avgEdgeBps >= 0 ? 'var(--cth-status-success)' : 'var(--cth-status-blocked)' }}>
                    {a.avgEdgeBps !== null ? `${a.avgEdgeBps >= 0 ? '+' : ''}${(a.avgEdgeBps / 100).toFixed(2)}%` : t('trading.roster.none')}
                  </td>
                  <td style={td}>{a.pending || t('trading.roster.none')}</td>
                  <td style={td}>
                    {a.lastAt ? (
                      <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                        {a.lastVote && <span style={{ ...chip('var(--cth-cream-300)', 'var(--cth-ink-900)'), fontSize: 10, padding: '0 4px' }}>{t(`trading.votes.${a.lastVote}`, { defaultValue: a.lastVote })}</span>}
                        {a.lastSymbol?.replace('USDT', '')} · {fmtAge(Math.max(0, now - a.lastAt))}
                      </span>
                    ) : t('trading.roster.none')}
                  </td>
                  <td style={td}>{a.customized ? <span style={{ ...chip('var(--cth-lemon-light)', 'var(--cth-ink-900)'), fontSize: 10, padding: '0 4px' }}>{t('trading.roster.customized')}</span> : t('trading.roster.default')}</td>
                  <td style={td}><PixelButton size="sm" variant="ghost" onClick={() => { void open(a.id); }}>{t('trading.roster.open')}</PixelButton></td>
                </tr>
              ))
            ];
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ ...card, gap: 6 }}>
        <span style={sectionHead}>{t('trading.roster.title')}</span>
        <p style={hint}>{t('trading.roster.intro')}</p>
        <p style={hint}>{t('trading.roster.scoring')}</p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <PixelButton size="sm" variant="secondary" onClick={() => { void open(); }}>{t('trading.roster.openRoot')}</PixelButton>
          {data.canRegister && (data.registered
            ? <span style={{ ...hint, color: 'var(--cth-status-success)' }}>✓ {t('trading.roster.registered')}</span>
            : <PixelButton size="sm" variant="ghost" onClick={() => { void register(); }} title={t('trading.roster.registerHint')}>{t('trading.roster.register')}</PixelButton>)}
          <span style={{ ...mono, wordBreak: 'break-all' }}>{data.root}</span>
        </div>
        {msg && <div style={{ ...hint, color: msg.error ? 'var(--cth-status-blocked)' : 'var(--cth-ink-700)' }}>{msg.text}</div>}
      </div>

      <div style={{ ...card, padding: 6 }}>{table(active)}</div>

      {former.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <PixelButton size="sm" variant="ghost" onClick={() => setShowFormer(!showFormer)}>
              {showFormer ? t('trading.roster.hideFormer') : t('trading.roster.showFormer', { count: former.length })}
            </PixelButton>
          </div>
          {showFormer && (
            <>
              <p style={hint}>{t('trading.roster.formerNote')}</p>
              <div style={{ ...card, padding: 6 }}>{table(former)}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
