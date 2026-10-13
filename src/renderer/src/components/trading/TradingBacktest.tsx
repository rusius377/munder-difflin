import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from '../PixelButton';
import { Num, Seg } from './TradingSettings';
import { card, chip, fmtPct, fmtPx, fmtTime, fmtUsd, hint, input, metaRow, mono, pnlColor, sectionHead } from './tradingUi';
import {
  TRADING_SYMBOLS, defaultBacktestRequest,
  type BacktestJobView, type BacktestRequest, type BacktestResultView, type ExperienceView, type NautilusStatusView,
  type TradingConfig, type TradingSymbol
} from '@shared/trading';

/**
 * 백테스트 — replay past charts through the desk (main/trading/backtest.ts).
 *
 *   scalping · builtin   the live scalper, second by second on Binance's tape
 *   scalping · nautilus  the same signals executed by NautilusTrader's simulated exchange
 *   agents               the whole agent team at past moments, dates and prices masked
 *
 * With "learn" on, results feed the scalper's experience and the agents' records.
 * Nothing here places an order.
 */

type Summary = Awaited<ReturnType<typeof window.cth.tradingBacktestResults>>[number];

const th: CSSProperties = {
  fontFamily: 'var(--cth-font-ui)', fontSize: 11, fontWeight: 700, color: 'var(--cth-ink-700)',
  textAlign: 'start', padding: '4px 6px', borderBottom: '1px solid var(--cth-ink-100)', whiteSpace: 'nowrap'
};
const td: CSSProperties = { ...mono, padding: '3px 6px', borderBottom: '1px solid var(--cth-ink-100)', whiteSpace: 'nowrap' };
const grid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: '8px 14px' };

const JOB_BG: Record<BacktestJobView['state'], string> = {
  queued: 'var(--cth-cream-300)', loading: 'var(--cth-status-thinking)', running: 'var(--cth-status-thinking)',
  done: 'var(--cth-status-success)', error: 'var(--cth-status-blocked)', cancelled: 'var(--cth-status-idle)'
};
const NT_BG: Record<NautilusStatusView['state'], string> = {
  ready: 'var(--cth-status-success)', installing: 'var(--cth-status-thinking)', 'not-installed': 'var(--cth-cream-300)',
  'missing-python': 'var(--cth-status-looping)', error: 'var(--cth-status-blocked)'
};

const fmtR = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '-' : `${v > 0 ? '+' : ''}${v.toFixed(2)}R`);
const fmtDay = (ts: number) => new Date(ts).toISOString().slice(0, 10);

function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label style={{ ...hint, display: 'flex', gap: 6, alignItems: 'center' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

function Tile({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
      <span style={hint}>{label}</span>
      <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 14, fontWeight: 700, color: color ?? 'var(--cth-ink-900)' }}>{value}</span>
      {sub && <span style={{ ...mono, fontSize: 10 }}>{sub}</span>}
    </div>
  );
}

/** Equity over time as a plain SVG line. */
function EquityCurve({ points, start }: { points: Array<[number, number]>; start: number }) {
  if (points.length < 2) return null;
  const W = 600;
  const H = 120;
  const t0 = points[0][0];
  const t1 = points[points.length - 1][0];
  const vs = points.map((p) => p[1]).concat(start);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const x = (t: number) => (t1 > t0 ? ((t - t0) / (t1 - t0)) * W : 0);
  const y = (v: number) => (hi > lo ? H - ((v - lo) / (hi - lo)) * (H - 8) - 4 : H / 2);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ');
  const end = points[points.length - 1][1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: 120, display: 'block', background: 'var(--cth-cream-100)' }}>
      <line x1={0} x2={W} y1={y(start)} y2={y(start)} stroke="var(--cth-ink-300)" strokeDasharray="4 4" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      <path d={d} fill="none" stroke={end >= start ? 'var(--cth-status-success)' : 'var(--cth-status-blocked)'} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function TradingBacktest({ cfg }: { cfg: TradingConfig | null }) {
  const { t } = useTranslation();
  const b = (k: string, o?: Record<string, unknown>) => t(`trading.backtest.${k}`, o);
  const [req, setReq] = useState<BacktestRequest | null>(null);
  const [jobs, setJobs] = useState<BacktestJobView[]>([]);
  const [results, setResults] = useState<Summary[]>([]);
  const [detail, setDetail] = useState<BacktestResultView | null>(null);
  const [nt, setNt] = useState<NautilusStatusView | null>(null);
  const [ntLog, setNtLog] = useState<string[]>([]);
  const [expSym, setExpSym] = useState<TradingSymbol>('BTCUSDT');
  const [exp, setExp] = useState<ExperienceView | null>(null);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [showAllTrades, setShowAllTrades] = useState(false);
  const detailRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (detail) detailRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, [detail]);

  useEffect(() => {
    if (cfg && !req) {
      const d = defaultBacktestRequest(cfg);
      setReq(d);
      setExpSym(d.symbol);
    }
  }, [cfg, req]);
  const patch = (p: Partial<BacktestRequest>) => setReq((r) => (r ? { ...r, ...p } : r));

  const loadResults = useCallback(() => {
    window.cth.tradingBacktestResults().then(setResults).catch(() => undefined);
  }, []);
  const loadExp = useCallback((s: TradingSymbol) => {
    window.cth.tradingExperience(s).then(setExp).catch(() => setExp(null));
  }, []);
  const loadNt = useCallback(() => {
    window.cth.tradingNautilusStatus().then(setNt).catch(() => undefined);
  }, []);

  useEffect(() => {
    window.cth.tradingBacktestJobs().then(setJobs).catch(() => undefined);
    loadResults();
    loadNt();
    const offJobs = window.cth.onBacktestUpdate(setJobs);
    const offLog = window.cth.onNautilusLog((line) => setNtLog((l) => [...l.slice(-11), line]));
    return () => { offJobs(); offLog(); };
  }, [loadResults, loadNt]);
  useEffect(() => { loadExp(expSym); }, [expSym, loadExp]);

  // A job that just finished adds a result and (with learn) experience.
  const finished = jobs.filter((j) => j.finishedAt).map((j) => j.id).join(',');
  const prevFinished = useRef(finished);
  useEffect(() => {
    if (finished === prevFinished.current) return;
    prevFinished.current = finished;
    loadResults();
    loadExp(expSym);
  }, [finished, loadResults, loadExp, expSym]);

  const start = async () => {
    if (!req) return;
    setMsg(null);
    const r = await window.cth.tradingBacktestStart(req).catch((e: unknown) => ({ ok: false, error: String(e) }));
    if (!r.ok) setMsg({ text: r.error ?? '', error: true });
  };
  const open = async (id: string) => {
    const r = await window.cth.tradingBacktestResult(id).catch(() => null);
    setShowAllTrades(false);
    if (r) setDetail(r);
    else setMsg({ text: b('missing'), error: true });
  };
  const remove = async (id: string) => {
    await window.cth.tradingBacktestDelete(id).catch(() => undefined);
    if (detail?.id === id) setDetail(null);
    loadResults();
    loadExp(expSym);
  };
  const install = async () => {
    setNtLog([]);
    setNt({ state: 'installing' });
    const s = await window.cth.tradingNautilusInstall().catch((e: unknown) => ({ state: 'error', message: String(e) } as NautilusStatusView));
    setNt(s);
  };
  const clearExp = async () => {
    await window.cth.tradingExperienceClear(expSym).catch(() => undefined);
    loadExp(expSym);
  };

  const active = jobs.some((j) => j.state === 'queued' || j.state === 'loading' || j.state === 'running');
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  if (!req) return <p style={hint}>{b('loading')}</p>;
  const agents = req.mode === 'agents';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={hint}>{b('intro')}</p>

      {/* ── request ─────────────────────────────────────────────────────── */}
      <div style={card}>
        <div style={sectionHead}>{b('newRun')}</div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <Seg value={req.mode} options={['scalping', 'agents'] as const} label={(m) => b(`modes.${m}`)} onChange={(mode) => patch({ mode })} />
          {!agents && (
            <Seg value={req.engine} options={['builtin', 'nautilus'] as const} label={(e) => b(`engines.${e}`)} onChange={(engine) => patch({ engine })} />
          )}
          <Seg value={req.symbol} options={TRADING_SYMBOLS} label={(s) => s} onChange={(symbol) => patch({ symbol })} />
        </div>
        <p style={hint}>{agents ? b('modeHint.agents') : req.engine === 'nautilus' ? b('modeHint.nautilus') : b('modeHint.builtin')}</p>
        <div style={grid}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={hint}>{b('fromDay')}</span>
            <input type="date" value={req.fromDay} max={today} style={input} onChange={(e) => e.target.value && patch({ fromDay: e.target.value })} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={hint}>{b('toDay')}</span>
            <input type="date" value={req.toDay} max={today} style={input} onChange={(e) => e.target.value && patch({ toDay: e.target.value })} />
          </label>
          <Num label={b('startEquity')} value={req.startEquity} step={100} suffix="USDT" onChange={(v) => patch({ startEquity: v })} />
          {!agents && <Num label={b('leverage')} value={req.leverage} suffix="x" onChange={(v) => patch({ leverage: v })} />}
          {!agents && <Num label={b('evalEverySec')} value={req.evalEverySec} suffix={t('trading.units.sec')} onChange={(v) => patch({ evalEverySec: v })} />}
          {agents && <Num label={b('episodeCount')} value={req.episodes} onChange={(v) => patch({ episodes: v })} />}
          {agents && <Num label={b('horizonHours')} value={req.horizonHours} suffix="h" onChange={(v) => patch({ horizonHours: v })} />}
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {!agents && req.engine === 'builtin' && <Check checked={req.useTape} onChange={(useTape) => patch({ useTape })}>{b('useTape')}</Check>}
          {agents && <Check checked={req.maskHistory} onChange={(maskHistory) => patch({ maskHistory })}>{b('maskHistory')}</Check>}
          <Check checked={req.learn} onChange={(learn) => patch({ learn })}>{agents ? b('learnAgents') : b('learnScalp')}</Check>
        </div>
        {agents && <p style={{ ...hint, color: 'var(--cth-ink-700)' }}>{b('agentsCost', { n: req.episodes })}</p>}
        {!agents && req.engine === 'nautilus' && nt?.state !== 'ready' && (
          <p style={{ ...hint, color: 'var(--cth-status-blocked)' }}>{b('nautilus.needInstall')}</p>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <PixelButton variant="primary" size="sm" onClick={start}>{active ? b('queue') : b('start')}</PixelButton>
          {msg && <span style={{ ...hint, color: msg.error ? 'var(--cth-status-blocked)' : 'var(--cth-ink-700)' }}>{msg.text}</span>}
        </div>
      </div>

      {/* ── jobs ────────────────────────────────────────────────────────── */}
      {jobs.length > 0 && (
        <div style={card}>
          <div style={sectionHead}>{b('jobs')}</div>
          {jobs.slice(0, 6).map((j) => {
            const live = j.state === 'queued' || j.state === 'loading' || j.state === 'running';
            return (
              <div key={j.id} style={{ display: 'flex', flexDirection: 'column', gap: 3, paddingBottom: 6, borderBottom: '1px solid var(--cth-ink-100)' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={chip(JOB_BG[j.state], 'var(--cth-ink-900)')}>{b(`states.${j.state}`)}</span>
                  <span style={mono}>{j.request.symbol} · {b(`modes.${j.request.mode}`)}{j.request.mode === 'scalping' ? ` · ${b(`engines.${j.request.engine}`)}` : ''} · {j.request.fromDay} → {j.request.toDay}</span>
                  <span style={{ flex: 1 }} />
                  {live && <PixelButton variant="ghost" size="sm" onClick={() => window.cth.tradingBacktestCancel(j.id)}>{b('cancel')}</PixelButton>}
                  {!live && j.state !== 'error' && j.finishedAt && (
                    <PixelButton variant="secondary" size="sm" onClick={() => open(j.id)}>{b('view')}</PixelButton>
                  )}
                </div>
                {live && (
                  <div style={{ height: 6, background: 'var(--cth-cream-200)' }}>
                    <div style={{ height: '100%', width: `${Math.round(j.pct * 100)}%`, background: 'var(--cth-status-thinking)' }} />
                  </div>
                )}
                <span style={hint}>{j.phase}</span>
                {j.error && <span style={{ ...hint, color: 'var(--cth-status-blocked)' }}>{j.error}</span>}
                {j.summary && (
                  <span style={metaRow}>
                    <span>{b('stats.trades')} {j.summary.trades}</span>
                    <span>{b('stats.winRate')} {j.summary.winRate === null ? '-' : fmtPct(j.summary.winRate * 100, 0, false)}</span>
                    <span style={{ color: pnlColor(j.summary.returnPct) }}>{fmtPct(j.summary.returnPct)}</span>
                    <span>{fmtR(j.summary.avgR)}</span>
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── detail ──────────────────────────────────────────────────────── */}
      <div ref={detailRef} />
      {detail && <ResultDetail r={detail} showAll={showAllTrades} onShowAll={() => setShowAllTrades(true)} onClose={() => setDetail(null)} />}

      {/* ── saved results ───────────────────────────────────────────────── */}
      <div style={card}>
        <div style={sectionHead}>{b('results')}</div>
        {results.length === 0 ? <p style={hint}>{b('noResults')}</p> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  <th style={th} /><th style={th}>{b('cols.when')}</th><th style={th}>{b('cols.run')}</th><th style={th}>{b('cols.period')}</th>
                  <th style={th}>{b('stats.trades')}</th><th style={th}>{b('stats.winRate')}</th><th style={th}>{b('stats.return')}</th>
                  <th style={th}>{b('stats.avgR')}</th><th style={th}>{b('stats.maxDd')}</th><th style={th}>{b('cols.data')}</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.id} style={{ background: detail?.id === r.id ? 'var(--cth-cream-200)' : undefined }}>
                    <td style={td}>
                      <span style={{ display: 'flex', gap: 4 }}>
                        <PixelButton variant="secondary" size="sm" onClick={() => open(r.id)}>{b('view')}</PixelButton>
                        <PixelButton variant="ghost" size="sm" onClick={() => remove(r.id)} title={r.learned ? b('deleteHint') : undefined}>{b('delete')}</PixelButton>
                      </span>
                    </td>
                    <td style={td}>{fmtTime(r.createdAt)}</td>
                    <td style={{ ...td, whiteSpace: 'normal', minWidth: 160 }}>{r.request.symbol} · {b(`modes.${r.request.mode}`)}{r.request.mode === 'scalping' ? ` · ${b(`engines.${r.engine}`)}` : ''} · {r.request.leverage}x</td>
                    <td style={td}>{r.request.fromDay.slice(5)} → {r.request.toDay.slice(5)}</td>
                    <td style={td}>{r.stats.trades}</td>
                    <td style={td}>{r.stats.winRate === null ? '-' : fmtPct(r.stats.winRate * 100, 0, false)}</td>
                    <td style={{ ...td, color: pnlColor(r.stats.returnPct) }}>{fmtPct(r.stats.returnPct)}</td>
                    <td style={td}>{fmtR(r.stats.avgR)}</td>
                    <td style={td}>{fmtPct(-r.stats.maxDrawdownPct, 1)}</td>
                    <td style={td}>
                      {b(`dataLevels.${r.dataLevel}`)}
                      {r.learned && <span style={{ ...chip('var(--cth-lilac-light)', 'var(--cth-ink-900)'), marginInlineStart: 6 }}>{b('learned')}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── experience ──────────────────────────────────────────────────── */}
      <div style={card}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={sectionHead}>{b('experience.title')}</div>
          <Seg value={expSym} options={TRADING_SYMBOLS} label={(s) => s} onChange={setExpSym} />
          <span style={{ flex: 1 }} />
          {exp && exp.trades > 0 && <PixelButton variant="ghost" size="sm" onClick={clearExp}>{b('experience.clear')}</PixelButton>}
        </div>
        <p style={hint}>{b('experience.intro', { n: cfg?.scalping.experienceMinSamples ?? 20 })}</p>
        {cfg?.scalping.experienceFilter === false && <p style={{ ...hint, color: 'var(--cth-ink-700)' }}>{b('experience.off')}</p>}
        {!exp || exp.trades === 0 ? <p style={hint}>{b('experience.empty')}</p> : (
          <>
            <div style={metaRow}>
              <span>{b('experience.trades', { n: exp.trades })}</span>
              <span>{b('experience.runs', { n: exp.runs.length })}</span>
              {exp.runs.length > 0 && <span>{fmtDay(Math.min(...exp.runs.map((r) => r.from)))} → {fmtDay(Math.max(...exp.runs.map((r) => r.to)) - 1)}</span>}
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead>
                  <tr>
                    <th style={th}>{b('experience.setup')}</th><th style={th}>{b('experience.n')}</th>
                    <th style={th}>{b('stats.winRate')}</th><th style={th}>{b('stats.avgR')}</th><th style={th} />
                  </tr>
                </thead>
                <tbody>
                  {exp.buckets.slice(0, 24).map((k) => {
                    const min = (cfg?.scalping.experienceMinSamples ?? 20) * (k.key.includes('|*|') ? 2 : 1);
                    const veto = k.n >= min && k.avgR < 0;
                    return (
                      <tr key={k.key}>
                        <td style={{ ...td, whiteSpace: 'normal' }}>{k.label}</td>
                        <td style={td}>{k.n}</td>
                        <td style={td}>{fmtPct(k.winRate * 100, 0, false)}</td>
                        <td style={{ ...td, color: pnlColor(k.avgR) }}>{fmtR(k.avgR)}</td>
                        <td style={td}>{veto && <span style={chip('var(--cth-status-blocked)', 'var(--cth-cream-50)')}>{b('experience.veto')}</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* ── NautilusTrader ──────────────────────────────────────────────── */}
      <div style={card}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={sectionHead}>{b('nautilus.title')}</div>
          {nt && <span style={chip(NT_BG[nt.state], 'var(--cth-ink-900)')}>{b(`nautilus.states.${nt.state}`)}</span>}
          {nt?.version && <span style={mono}>nautilus_trader {nt.version}</span>}
          {nt?.python && <span style={mono}>Python {nt.python}</span>}
          <span style={{ flex: 1 }} />
          <PixelButton variant="ghost" size="sm" onClick={loadNt}>{b('nautilus.check')}</PixelButton>
          {nt && nt.state !== 'ready' && nt.state !== 'missing-python' && (
            <PixelButton variant="secondary" size="sm" onClick={install} disabled={nt.state === 'installing'}>{b('nautilus.install')}</PixelButton>
          )}
        </div>
        <p style={hint}>{b('nautilus.intro')}</p>
        {nt?.state === 'missing-python' && <p style={{ ...hint, color: 'var(--cth-status-blocked)' }}>{b('nautilus.missingPython')}</p>}
        {nt?.message && <p style={{ ...hint, color: nt.state === 'error' ? 'var(--cth-status-blocked)' : 'var(--cth-ink-700)' }}>{nt.message}</p>}
        {ntLog.length > 0 && (
          <pre style={{ ...mono, margin: 0, padding: 6, background: 'var(--cth-cream-100)', whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto' }}>{ntLog.join('\n')}</pre>
        )}
      </div>
    </div>
  );
}

function ResultDetail({ r, showAll, onShowAll, onClose }: { r: BacktestResultView; showAll: boolean; onShowAll: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const b = (k: string, o?: Record<string, unknown>) => t(`trading.backtest.${k}`, o);
  const s = r.stats;
  const trades = showAll ? r.trades : r.trades.slice(-100);
  const exits = Object.entries(s.byExit).sort((a, c) => c[1] - a[1]);
  return (
    <div style={card}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={sectionHead}>{b('detail')}</div>
        <span style={mono}>
          {r.request.symbol} · {b(`modes.${r.request.mode}`)}{r.request.mode === 'scalping' ? ` · ${b(`engines.${r.engine}`)} · ${r.request.leverage}x` : ''} · {r.request.fromDay} → {r.request.toDay} · {b(`dataLevels.${r.dataLevel}`)}
        </span>
        <span style={{ flex: 1 }} />
        <PixelButton variant="ghost" size="sm" onClick={onClose}>{b('close')}</PixelButton>
      </div>
      <div style={grid}>
        <Tile label={b('stats.trades')} value={String(s.trades)} sub={`${t('trading.side.LONG')} ${s.longs} · ${t('trading.side.SHORT')} ${s.shorts}`} />
        <Tile label={b('stats.winRate')} value={s.winRate === null ? '-' : fmtPct(s.winRate * 100, 1, false)} sub={`${s.wins} / ${s.losses}`} />
        <Tile label={b('stats.netPnl')} value={`${fmtUsd(s.netPnl, true)} USDT`} sub={fmtPct(s.returnPct)} color={pnlColor(s.netPnl)} />
        <Tile label={b('stats.avgR')} value={fmtR(s.avgR)} color={pnlColor(s.avgR)} />
        <Tile label={b('stats.profitFactor')} value={s.profitFactor === null ? '-' : s.profitFactor.toFixed(2)} />
        <Tile label={b('stats.maxDd')} value={fmtPct(-s.maxDrawdownPct, 1)} color="var(--cth-status-blocked)" />
        <Tile label={b('stats.fees')} value={`${fmtUsd(s.fees)} USDT`} sub={s.trades ? b('stats.beforeFees', { v: fmtUsd(s.netPnl + s.fees, true) }) : undefined} />
        <Tile label={b('stats.avgHold')} value={s.avgHoldMin === null ? '-' : `${s.avgHoldMin.toFixed(1)}${t('trading.units.min')}`} />
        <Tile label={b('stats.liquidations')} value={String(s.liquidations)} color={s.liquidations ? 'var(--cth-status-blocked)' : undefined} />
        <Tile label={b('stats.endEquity')} value={`${fmtUsd(s.endEquity)} USDT`} sub={`${b('startEquity')} ${fmtUsd(r.request.startEquity)}`} />
      </div>
      <EquityCurve points={r.equity} start={r.request.startEquity} />
      {exits.length > 0 && (
        <div style={metaRow}>
          <span style={hint}>{b('byExit')}</span>
          {exits.map(([k, n]) => <span key={k}>{k} {n}</span>)}
        </div>
      )}
      {r.notes.length > 0 && (
        <ul style={{ margin: 0, paddingInlineStart: 18 }}>
          {r.notes.map((n, i) => <li key={i} style={hint}>{n}</li>)}
        </ul>
      )}

      {r.episodes && r.episodes.length > 0 && (
        <>
          <div style={sectionHead}>{b('episodes')}</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  <th style={th}>{b('cols.time')}</th><th style={th}>{b('cols.decision')}</th><th style={th}>{b('cols.entry')}</th>
                  <th style={th}>{b('cols.stop')}</th><th style={th}>{b('cols.target')}</th><th style={th}>{b('cols.outcome')}</th>
                  <th style={th}>{b('cols.horizon')}</th><th style={th}>{b('cols.calls')}</th>
                </tr>
              </thead>
              <tbody>
                {r.episodes.map((e) => (
                  <tr key={e.t}>
                    <td style={td}>{fmtTime(e.t)}</td>
                    <td style={td}>{e.error ? <span style={{ color: 'var(--cth-status-blocked)' }}>{e.error.slice(0, 60)}</span> : `${e.rating} · ${t(`trading.actionNames.${e.action}`)} · ${Math.round(e.confidence * 100)}%`}</td>
                    <td style={td}>{fmtPx(e.entryPrice)}</td>
                    <td style={td}>{fmtPx(e.stopLoss)}</td>
                    <td style={td}>{fmtPx(e.takeProfit)}</td>
                    <td style={{ ...td, color: pnlColor(e.outcome?.r ?? null) }}>{e.outcome ? `${e.outcome.reason} ${fmtPct(e.outcome.movePct)} ${fmtR(e.outcome.r)}` : '-'}</td>
                    <td style={{ ...td, color: pnlColor(e.horizonMovePct) }}>{fmtPct(e.horizonMovePct)}</td>
                    <td style={td}>{e.calls ? `${e.hits}/${e.calls}` : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {r.trades.length > 0 && (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={sectionHead}>{b('trades')}</div>
            {!showAll && r.trades.length > 100 && (
              <PixelButton variant="ghost" size="sm" onClick={onShowAll}>{b('showAll', { n: r.trades.length })}</PixelButton>
            )}
          </div>
          <div style={{ overflowX: 'auto', maxHeight: 420, overflowY: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  <th style={th}>{b('cols.time')}</th><th style={th}>{b('cols.side')}</th><th style={th}>{b('cols.entry')}</th>
                  <th style={th}>{b('cols.stop')}</th><th style={th}>{b('cols.target')}</th><th style={th}>{b('cols.exit')}</th>
                  <th style={th}>{b('cols.lev')}</th><th style={th}>{b('cols.liq')}</th><th style={th}>R</th><th style={th}>ROE</th>
                  <th style={th}>{b('cols.pnl')}</th><th style={th}>{b('cols.reason')}</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((x) => (
                  <tr key={`${x.entryTime}-${x.side}`}>
                    <td style={td}>{fmtTime(x.entryTime)}</td>
                    <td style={{ ...td, color: x.side === 'LONG' ? 'var(--cth-status-success)' : 'var(--cth-status-blocked)' }}>{t(`trading.side.${x.side}`)}</td>
                    <td style={td}>{fmtPx(x.entryPrice)}</td>
                    <td style={td}>{fmtPx(x.stopLoss)}</td>
                    <td style={td}>{fmtPx(x.takeProfit)}</td>
                    <td style={td}>{fmtPx(x.exitPrice)}</td>
                    <td style={td}>{x.leverage}x</td>
                    <td style={td}>{fmtPx(x.liquidationPrice)}</td>
                    <td style={{ ...td, color: pnlColor(x.pnlR) }}>{fmtR(x.pnlR)}</td>
                    <td style={{ ...td, color: pnlColor(x.roe) }}>{fmtPct(x.roe, 1)}</td>
                    <td style={{ ...td, color: pnlColor(x.pnl) }}>{fmtUsd(x.pnl, true)}</td>
                    <td style={td}>{x.exitReason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
