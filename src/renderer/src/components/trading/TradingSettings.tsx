import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from '../PixelButton';
import { card, hint, input, mono, sectionHead } from './tradingUi';
import {
  ANALYST_KEYS, CONSENSUS_RULES, DEFAULT_LLM_MODELS, EXECUTION_VENUES, LLM_PROVIDERS, TEAM_LIMITS, TEAM_PRESETS, TRADING_MODES, TRADING_SYMBOLS,
  estimateLlmCalls, normalizeTradingConfig, teamPresetOf,
  type AgentModeSettings, type AutomationSettings, type LlmProvider, type RiskSettings, type ScalpingSettings,
  type TeamPreset, type TeamSettings, type TradingConfig, type TradingSecretKey, type TradingSecretPresence
} from '@shared/trading';

/**
 * Desk settings. The renderer only drafts: main normalises (clamps every
 * number, refuses live without the acknowledgement) and the saved, normalised
 * config comes back and replaces the draft — what you see after "save" is
 * exactly what the engine will use.
 */

const row: CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(150px, 220px) 1fr', gap: 8, alignItems: 'center' };
const grid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: '8px 16px' };

function Section({ title, children, intro }: { title: string; intro?: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={sectionHead}>{title}</span>
      {intro && <p style={hint}>{intro}</p>}
      <div style={{ ...card, gap: 8 }}>{children}</div>
    </div>
  );
}

function Num({ label, value, step, onChange, suffix }: { label: string; value: number; step?: number; suffix?: string; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  // Re-sync only when the value moved for another reason (save, revert) —
  // not on every keystroke, or "0." would snap back to "0" mid-typing.
  useEffect(() => { setText((cur) => (Number(cur) === value && cur !== '' ? cur : String(value))); }, [value]);
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={hint}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <input
          type="number" step={step ?? 1} value={text} style={{ ...input, width: 110 }}
          onChange={(e) => { setText(e.target.value); const n = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(n)) onChange(n); }}
        />
        {suffix && <span style={mono}>{suffix}</span>}
      </span>
    </label>
  );
}

function Seg<T extends string>({ value, options, label, onChange }: { value: T; options: readonly T[]; label: (v: T) => string; onChange: (v: T) => void }) {
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {options.map((o) => (
        <button key={o} onClick={() => onChange(o)} style={{
          fontFamily: 'var(--cth-font-ui)', fontSize: 12, padding: '4px 10px', border: 'none', cursor: 'pointer',
          background: value === o ? 'var(--cth-ink-900)' : 'var(--cth-cream-200)',
          color: value === o ? 'var(--cth-cream-50)' : 'var(--cth-ink-900)'
        }}>{label(o)}</button>
      ))}
    </div>
  );
}

function SecretField({ k, label, present, onChanged }: { k: TradingSecretKey; label: string; present: boolean; onChanged: () => void }) {
  const { t } = useTranslation();
  const [val, setVal] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setErr(null);
    const r = await window.cth.tradingSetSecret(k, val);
    if (!r.ok) setErr(r.error ?? t('trading.messages.saveFailed'));
    else { setVal(''); onChanged(); }
  };
  const del = async () => { await window.cth.tradingDeleteSecret(k); onChanged(); };
  return (
    <div style={row}>
      <span style={hint}>{label}</span>
      <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="password" autoComplete="off" spellCheck={false} value={val} placeholder={present ? t('trading.settings.secretStored') : t('trading.settings.secretPlaceholder')}
          onChange={(e) => setVal(e.target.value)} style={{ ...input, flex: 1, minWidth: 160 }} />
        <PixelButton size="sm" variant="secondary" disabled={!val.trim()} onClick={save}>{t('common.save')}</PixelButton>
        {present && <PixelButton size="sm" variant="ghost" onClick={del}>{t('common.delete')}</PixelButton>}
        {err && <span style={{ ...hint, color: 'var(--cth-status-blocked)' }}>{err}</span>}
      </span>
    </div>
  );
}

export function TradingSettings({ cfg, running, onSaved }: { cfg: TradingConfig | null; running: boolean; onSaved: (cfg: TradingConfig, restartRequired: boolean) => void }) {
  const { t } = useTranslation();
  const [d, setD] = useState<TradingConfig | null>(cfg);
  const [secrets, setSecrets] = useState<TradingSecretPresence | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [test, setTest] = useState<{ target: string; ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [resetMsg, setResetMsg] = useState<string | null>(null);
  const [loginItem, setLoginItem] = useState<boolean | null>(null);
  useEffect(() => { window.cth.tradingGetLoginItem().then(setLoginItem).catch(() => setLoginItem(null)); }, []);
  const toggleLoginItem = async (v: boolean) => {
    setLoginItem(v);
    try { setLoginItem(await window.cth.setLoginItem(v)); } catch { setLoginItem(!v); }
  };

  useEffect(() => { if (cfg) setD(structuredClone(cfg)); }, [cfg]);
  const loadSecrets = useCallback(() => { window.cth.tradingSecrets().then(setSecrets).catch(() => undefined); }, []);
  useEffect(() => { loadSecrets(); }, [loadSecrets]);

  if (!d) return <div style={hint}>…</div>;

  const set = (patch: Partial<TradingConfig>) => setD({ ...d, ...patch });
  const setRisk = (patch: Partial<RiskSettings>) => setD({ ...d, risk: { ...d.risk, ...patch } });
  const setAgents = (patch: Partial<AgentModeSettings>) => setD({ ...d, agents: { ...d.agents, ...patch } });
  const setScalp = (patch: Partial<ScalpingSettings>) => setD({ ...d, scalping: { ...d.scalping, ...patch } });
  const setAuto = (patch: Partial<AutomationSettings>) => setD({ ...d, automation: { ...d.automation, ...patch } });
  const setTeams = (patch: Partial<TeamSettings>) => setD({ ...d, teams: { ...d.teams, ...patch } });
  const f = (k: string) => t(`trading.settings.fields.${k}`);

  const save = async () => {
    // Main would silently fall back to paper; say so here instead.
    if (d.venue === 'live' && !d.liveAcknowledged) { setErr(t('trading.live.needAck')); return; }
    setSaving(true);
    setErr(null);
    const r = await window.cth.tradingSaveConfig(d).catch((e: unknown) => ({ ok: false, error: String(e) } as { ok: boolean; error?: string; config?: TradingConfig; restartRequired?: boolean }));
    setSaving(false);
    if (!r.ok || !r.config) { setErr(r.error ?? t('trading.messages.saveFailed')); return; }
    setD(structuredClone(r.config));
    onSaved(r.config, !!r.restartRequired);
  };

  const runTest = async (target: 'binance' | 'llm') => {
    setTesting(target);
    setTest(null);
    const r = await window.cth.tradingTest(target).catch((e: unknown) => ({ ok: false, message: String(e) }));
    setTest({ target, ...r });
    setTesting(null);
  };

  const resetPaper = async () => {
    const r = await window.cth.tradingResetPaper();
    setResetMsg(r.ok ? t('trading.messages.paperReset') : r.error ?? '');
  };

  const setProvider = (p: LlmProvider) => setD({ ...d, llm: { ...d.llm, provider: p, quickModel: DEFAULT_LLM_MODELS[p].quick, deepModel: DEFAULT_LLM_MODELS[p].deep } });
  const toggle = <T extends string>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const dirty = JSON.stringify(d) !== JSON.stringify(cfg);
  // Shown on the clamped values, exactly what saving would keep.
  const est = estimateLlmCalls(normalizeTradingConfig(d));
  const preset = teamPresetOf(d.teams);
  const TEAM_FIELDS = ['analystsPerRole', 'researchersPerSide', 'traders', 'riskPerStance', 'portfolioCommittee', 'biasPanel'] as const;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {running && <div style={{ ...hint, color: 'var(--cth-ink-700)' }}>{t('trading.settings.runningNote')}</div>}

      <Section title={t('trading.settings.sections.general')}>
        <div style={row}>
          <span style={hint}>{f('mode')}</span>
          <Seg value={d.mode} options={TRADING_MODES} label={(m) => t(`trading.modes.${m}`)} onChange={(mode) => set({ mode })} />
        </div>
        <p style={hint}>{t(`trading.modeHints.${d.mode}`)}</p>
        <div style={row}>
          <span style={hint}>{f('symbols')}</span>
          <span style={{ display: 'flex', gap: 12 }}>
            {TRADING_SYMBOLS.map((s) => (
              <label key={s} style={{ ...mono, display: 'flex', gap: 4, alignItems: 'center' }}>
                <input type="checkbox" checked={d.symbols.includes(s)} onChange={() => { const next = toggle(d.symbols, s); if (next.length) set({ symbols: next }); }} />
                {s}
              </label>
            ))}
          </span>
        </div>
        <div style={row}>
          <span style={hint}>{f('venue')}</span>
          <Seg value={d.venue} options={EXECUTION_VENUES} label={(v) => t(`trading.venues.${v}`)}
            onChange={(venue) => set({ venue })} />
        </div>
        <p style={hint}>{t(`trading.venueHints.${d.venue}`)}</p>
        {d.venue === 'live' && (
          <div style={{ padding: 8, background: 'var(--cth-coral-light)', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <b style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)' }}>{t('trading.live.warnTitle')}</b>
            <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)' }}>{t('trading.live.warnBody')}</span>
            <label style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)', display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={d.liveAcknowledged} onChange={(e) => set({ liveAcknowledged: e.target.checked })} />
              {t('trading.live.ack')}
            </label>
          </div>
        )}
      </Section>

      <Section title={t('trading.settings.sections.automation')} intro={t('trading.settings.automationIntro')}>
        {(['autoStart', 'keepAwake', 'notify'] as const).map((k) => (
          <label key={k} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <input type="checkbox" checked={d.automation[k]} onChange={(e) => setAuto({ [k]: e.target.checked })} style={{ marginTop: 2 }} />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)' }}>{f(k)}</span>
              <span style={hint}>{t(`trading.settings.automationHints.${k}`)}</span>
            </span>
          </label>
        ))}
        {loginItem !== null && (
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <input type="checkbox" checked={loginItem} onChange={(e) => { void toggleLoginItem(e.target.checked); }} style={{ marginTop: 2 }} />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)' }}>{f('openAtLogin')}</span>
              <span style={hint}>{t('trading.settings.automationHints.openAtLogin')}</span>
            </span>
          </label>
        )}
        {d.automation.autoStart && d.venue === 'live' && (
          <div style={{ ...hint, color: 'var(--cth-status-blocked)', fontWeight: 700 }}>{t('trading.settings.autoStartLive')}</div>
        )}
      </Section>

      <Section title={t('trading.settings.sections.binance')} intro={t('trading.settings.binanceIntro')}>
        {secrets && (
          <>
            <SecretField k="binance.demo.key" label={f('demoKey')} present={secrets['binance.demo.key']} onChanged={loadSecrets} />
            <SecretField k="binance.demo.secret" label={f('demoSecret')} present={secrets['binance.demo.secret']} onChanged={loadSecrets} />
            <SecretField k="binance.live.key" label={f('liveKey')} present={secrets['binance.live.key']} onChanged={loadSecrets} />
            <SecretField k="binance.live.secret" label={f('liveSecret')} present={secrets['binance.live.secret']} onChanged={loadSecrets} />
          </>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <PixelButton size="sm" variant="secondary" disabled={testing !== null} onClick={() => runTest('binance')}>
            {testing === 'binance' ? t('trading.actions.testing') : t('trading.actions.testBinance')}
          </PixelButton>
          {test?.target === 'binance' && <span style={{ ...hint, color: test.ok ? 'var(--cth-status-success)' : 'var(--cth-status-blocked)' }}>{test.message}</span>}
        </div>
      </Section>

      <Section title={t('trading.settings.sections.llm')} intro={t('trading.settings.llmIntro')}>
        <div style={row}>
          <span style={hint}>{f('provider')}</span>
          <Seg value={d.llm.provider} options={LLM_PROVIDERS} label={(p) => t(`trading.providers.${p}`)} onChange={setProvider} />
        </div>
        <p style={hint}>{t(`trading.providerHints.${d.llm.provider}`)}</p>
        <div style={grid}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={hint}>{f('quickModel')}</span>
            <input value={d.llm.quickModel} onChange={(e) => setD({ ...d, llm: { ...d.llm, quickModel: e.target.value } })} style={input} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={hint}>{f('deepModel')}</span>
            <input value={d.llm.deepModel} onChange={(e) => setD({ ...d, llm: { ...d.llm, deepModel: e.target.value } })} style={input} />
          </label>
          {d.llm.provider === 'openai-compatible' && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={hint}>{f('baseUrl')}</span>
              <input value={d.llm.baseUrl} onChange={(e) => setD({ ...d, llm: { ...d.llm, baseUrl: e.target.value } })} style={input} />
            </label>
          )}
          <Num label={f('timeoutSec')} value={d.llm.timeoutSec} suffix={t('trading.units.sec')} onChange={(v) => setD({ ...d, llm: { ...d.llm, timeoutSec: v } })} />
        </div>
        {secrets && d.llm.provider === 'anthropic' && <SecretField k="anthropic.key" label={f('anthropicKey')} present={secrets['anthropic.key']} onChanged={loadSecrets} />}
        {secrets && d.llm.provider === 'openai' && <SecretField k="openai.key" label={f('openaiKey')} present={secrets['openai.key']} onChanged={loadSecrets} />}
        {secrets && d.llm.provider === 'openai-compatible' && <SecretField k="compat.key" label={f('compatKey')} present={secrets['compat.key']} onChanged={loadSecrets} />}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <PixelButton size="sm" variant="secondary" disabled={testing !== null || dirty} onClick={() => runTest('llm')} title={dirty ? t('trading.settings.saveFirst') : undefined}>
            {testing === 'llm' ? t('trading.actions.testing') : t('trading.actions.testLlm')}
          </PixelButton>
          {test?.target === 'llm' && <span style={{ ...hint, color: test.ok ? 'var(--cth-status-success)' : 'var(--cth-status-blocked)' }}>{test.message}</span>}
        </div>
      </Section>

      <Section title={t('trading.settings.sections.risk')} intro={t('trading.settings.riskIntro')}>
        <div style={grid}>
          <Num label={f('paperBalanceUsdt')} value={d.risk.paperBalanceUsdt} step={100} suffix="USDT" onChange={(v) => setRisk({ paperBalanceUsdt: v })} />
          <Num label={f('riskPerTradePct')} value={d.risk.riskPerTradePct} step={0.1} suffix="%" onChange={(v) => setRisk({ riskPerTradePct: v })} />
          <Num label={f('maxLeverage')} value={d.risk.maxLeverage} suffix="x" onChange={(v) => setRisk({ maxLeverage: v })} />
          <Num label={f('maxNotionalPct')} value={d.risk.maxNotionalPct} step={10} suffix="%" onChange={(v) => setRisk({ maxNotionalPct: v })} />
          <Num label={f('dailyLossLimitPct')} value={d.risk.dailyLossLimitPct} step={0.5} suffix="%" onChange={(v) => setRisk({ dailyLossLimitPct: v })} />
          <Num label={f('maxConsecutiveLosses')} value={d.risk.maxConsecutiveLosses} onChange={(v) => setRisk({ maxConsecutiveLosses: v })} />
          <Num label={f('takerFeePct')} value={d.risk.takerFeePct} step={0.01} suffix="%" onChange={(v) => setRisk({ takerFeePct: v })} />
          <Num label={f('slippageBps')} value={d.risk.slippageBps} step={0.5} suffix="bp" onChange={(v) => setRisk({ slippageBps: v })} />
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={hint}>{f('marginType')}</span>
            <Seg value={d.risk.marginType} options={['ISOLATED', 'CROSSED'] as const} label={(m) => t(`trading.marginTypes.${m}`)} onChange={(marginType) => setRisk({ marginType })} />
          </label>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <PixelButton size="sm" variant="ghost" disabled={running && d.venue === 'paper'} onClick={resetPaper}>{t('trading.actions.resetPaper')}</PixelButton>
          {resetMsg && <span style={hint}>{resetMsg}</span>}
        </div>
      </Section>

      <Section title={t('trading.settings.sections.agents')} intro={t('trading.settings.agentsIntro')}>
        <div style={row}>
          <span style={hint}>{f('analysts')}</span>
          <span style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {ANALYST_KEYS.map((k) => (
              <label key={k} style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, display: 'flex', gap: 4, alignItems: 'center', color: 'var(--cth-ink-900)' }}>
                <input type="checkbox" checked={d.agents.analysts.includes(k)} onChange={() => { const next = toggle(d.agents.analysts, k); if (next.length) setAgents({ analysts: next }); }} />
                {t(`trading.roles.${k}`)}
              </label>
            ))}
          </span>
        </div>
        <div style={grid}>
          <Num label={f('intervalMinutes')} value={d.agents.intervalMinutes} step={15} suffix={t('trading.units.min')} onChange={(v) => setAgents({ intervalMinutes: v })} />
          <Num label={f('debateRounds')} value={d.agents.debateRounds} onChange={(v) => setAgents({ debateRounds: v })} />
          <Num label={f('riskRounds')} value={d.agents.riskRounds} onChange={(v) => setAgents({ riskRounds: v })} />
          <Num label={f('minConfidence')} value={d.agents.minConfidence} step={0.05} onChange={(v) => setAgents({ minConfidence: v })} />
          <Num label={f('minRewardRisk')} value={d.agents.minRewardRisk} step={0.1} suffix=": 1" onChange={(v) => setAgents({ minRewardRisk: v })} />
          <Num label={f('agentMaxLeverage')} value={d.agents.maxLeverage} suffix="x" onChange={(v) => setAgents({ maxLeverage: v })} />
          <Num label={f('defaultLeverage')} value={d.agents.defaultLeverage} suffix="x" onChange={(v) => setAgents({ defaultLeverage: v })} />
          <Num label={f('limitEntryTtlMinutes')} value={d.agents.limitEntryTtlMinutes} step={15} suffix={t('trading.units.min')} onChange={(v) => setAgents({ limitEntryTtlMinutes: v })} />
          <label style={{ ...hint, display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={d.agents.reflect} onChange={(e) => setAgents({ reflect: e.target.checked })} />
            {f('reflect')}
          </label>
        </div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={hint}>{f('newsFeeds')}</span>
          <textarea rows={4} value={d.agents.newsFeeds.join('\n')} spellCheck={false}
            onChange={(e) => setAgents({ newsFeeds: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })}
            style={{ ...input, resize: 'vertical' }} />
        </label>
      </Section>

      <Section title={t('trading.settings.sections.teams')} intro={t('trading.settings.teamsIntro')}>
        <div style={row}>
          <span style={hint}>{f('teamPreset')}</span>
          <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Seg value={(preset ?? '') as TeamPreset} options={Object.keys(TEAM_PRESETS) as TeamPreset[]} label={(p) => t(`trading.teamPresets.${p}`)}
              onChange={(p) => setTeams({ ...TEAM_PRESETS[p] })} />
            {!preset && <span style={mono}>{t('trading.teamPresets.custom')}</span>}
          </span>
        </div>
        <div style={grid}>
          {TEAM_FIELDS.map((k) => (
            <Num key={k} label={`${f(k)} (1–${TEAM_LIMITS[k]})`} value={d.teams[k]} suffix={t('trading.units.people')} onChange={(v) => setTeams({ [k]: v })} />
          ))}
          <Num label={`${f('maxParallel')} (1–${TEAM_LIMITS.maxParallel})`} value={d.teams.maxParallel} onChange={(v) => setTeams({ maxParallel: v })} />
        </div>
        <div style={row}>
          <span style={hint}>{f('consensus')}</span>
          <Seg value={d.teams.consensus} options={CONSENSUS_RULES} label={(r) => t(`trading.consensus.${r}`)} onChange={(consensus) => setTeams({ consensus })} />
        </div>
        <p style={hint}>{t(`trading.consensusHints.${d.teams.consensus}`)}</p>
        <p style={hint}>{t('trading.settings.teamsHow')}</p>
        <div style={{ ...mono, color: 'var(--cth-ink-900)' }}>
          {t('trading.settings.teamEstimate', { pipeline: est.pipeline, pipelinePerHour: est.pipelinePerHour, bias: est.bias, biasPerHour: est.biasPerHour })}
        </div>
        {d.llm.provider === 'claude-subscription' && <p style={hint}>{t('trading.settings.teamSubscriptionNote')}</p>}
      </Section>

      <Section title={t('trading.settings.sections.scalping')} intro={t('trading.settings.scalpingIntro')}>
        <div style={row}>
          <span style={hint}>{f('timeframe')}</span>
          <Seg value={d.scalping.timeframe} options={['1m', '3m', '5m'] as const} label={(x) => x} onChange={(timeframe) => setScalp({ timeframe })} />
        </div>
        <div style={row}>
          <span style={hint}>{f('trendTimeframe')}</span>
          <Seg value={d.scalping.trendTimeframe} options={['5m', '15m', '1h'] as const} label={(x) => x} onChange={(trendTimeframe) => setScalp({ trendTimeframe })} />
        </div>
        <div style={grid}>
          <Num label={f('pollSeconds')} value={d.scalping.pollSeconds} suffix={t('trading.units.sec')} onChange={(v) => setScalp({ pollSeconds: v })} />
          <Num label={f('scalpLeverage')} value={d.scalping.leverage} suffix="x" onChange={(v) => setScalp({ leverage: v })} />
          <Num label={f('minScore')} value={d.scalping.minScore} onChange={(v) => setScalp({ minScore: v })} />
          <Num label={f('slAtr')} value={d.scalping.slAtr} step={0.1} suffix="ATR" onChange={(v) => setScalp({ slAtr: v })} />
          <Num label={f('tpAtr')} value={d.scalping.tpAtr} step={0.1} suffix="ATR" onChange={(v) => setScalp({ tpAtr: v })} />
          <Num label={f('breakevenAtR')} value={d.scalping.breakevenAtR} step={0.1} suffix="R" onChange={(v) => setScalp({ breakevenAtR: v })} />
          <Num label={f('maxHoldMinutes')} value={d.scalping.maxHoldMinutes} suffix={t('trading.units.min')} onChange={(v) => setScalp({ maxHoldMinutes: v })} />
          <Num label={f('cooldownMinutes')} value={d.scalping.cooldownMinutes} suffix={t('trading.units.min')} onChange={(v) => setScalp({ cooldownMinutes: v })} />
          <Num label={f('maxTradesPerHour')} value={d.scalping.maxTradesPerHour} onChange={(v) => setScalp({ maxTradesPerHour: v })} />
          <Num label={f('emaFast')} value={d.scalping.emaFast} onChange={(v) => setScalp({ emaFast: v })} />
          <Num label={f('emaSlow')} value={d.scalping.emaSlow} onChange={(v) => setScalp({ emaSlow: v })} />
          <Num label={f('trendEma')} value={d.scalping.trendEma} onChange={(v) => setScalp({ trendEma: v })} />
          <Num label={f('rsiPeriod')} value={d.scalping.rsiPeriod} onChange={(v) => setScalp({ rsiPeriod: v })} />
          <Num label={f('atrPeriod')} value={d.scalping.atrPeriod} onChange={(v) => setScalp({ atrPeriod: v })} />
          <Num label={f('maxSpreadBps')} value={d.scalping.maxSpreadBps} step={0.5} suffix="bp" onChange={(v) => setScalp({ maxSpreadBps: v })} />
          <Num label={f('minAtrPct')} value={d.scalping.minAtrPct} step={0.01} suffix="%" onChange={(v) => setScalp({ minAtrPct: v })} />
          <Num label={f('maxAtrPct')} value={d.scalping.maxAtrPct} step={0.1} suffix="%" onChange={(v) => setScalp({ maxAtrPct: v })} />
          <Num label={f('biasRefreshMinutes')} value={d.scalping.biasRefreshMinutes} suffix={t('trading.units.min')} onChange={(v) => setScalp({ biasRefreshMinutes: v })} />
          <label style={{ ...hint, display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={d.scalping.agentBias} onChange={(e) => setScalp({ agentBias: e.target.checked })} />
            {f('agentBias')}
          </label>
        </div>
      </Section>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', position: 'sticky', bottom: 0, background: 'var(--cth-cream-100)', padding: '8px 0' }}>
        <PixelButton variant="primary" onClick={save} disabled={saving || !dirty}>{saving ? t('trading.actions.saving') : t('trading.actions.save')}</PixelButton>
        {dirty && <PixelButton variant="ghost" onClick={() => cfg && setD(structuredClone(cfg))}>{t('trading.actions.revert')}</PixelButton>}
        {err && <span style={{ ...hint, color: 'var(--cth-status-blocked)' }}>{err}</span>}
      </div>
    </div>
  );
}
