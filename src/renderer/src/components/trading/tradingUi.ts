/**
 * Small shared pieces for the trading desk UI: the live-snapshot hook,
 * number formatting and the few inline styles every trading view reuses.
 * Styling follows the WorkersTab conventions (tokens only, no new CSS file).
 */
import { useEffect, useState, type CSSProperties } from 'react';
import type { TradingSnapshot } from '@shared/trading';

/** The engine snapshot: fetched once, then kept current by main's push. */
export function useTradingSnapshot(): TradingSnapshot | null {
  const [snap, setSnap] = useState<TradingSnapshot | null>(null);
  useEffect(() => {
    let alive = true;
    window.cth.tradingSnapshot().then((s) => { if (alive) setSnap(s); }).catch(() => { /* main not ready */ });
    const off = window.cth.onTradingUpdate((s) => { if (alive) setSnap(s); });
    return () => { alive = false; off(); };
  }, []);
  return snap;
}

/** Re-render every `ms` (for "3분 전" style ages). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function fmtPx(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '-';
  const a = Math.abs(v);
  return v.toLocaleString(undefined, { minimumFractionDigits: a >= 1000 ? 1 : 2, maximumFractionDigits: a >= 1000 ? 1 : a >= 1 ? 3 : 5 });
}

export function fmtUsd(v: number | null | undefined, signed = false): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '-';
  const s = v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return signed && v > 0 ? `+${s}` : s;
}

export function fmtPct(v: number | null | undefined, dp = 2, signed = true): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '-';
  return `${signed && v > 0 ? '+' : ''}${v.toFixed(dp)}%`;
}

export function fmtTime(ts: number | undefined): string {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Compact duration: 45s · 12m · 3h · 2d. */
export function fmtAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

export const pnlColor = (v: number | null | undefined): string =>
  v === null || v === undefined || v === 0 ? 'var(--cth-ink-700)' : v > 0 ? 'var(--cth-status-success)' : 'var(--cth-status-blocked)';

export const card: CSSProperties = {
  background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0
};

export const sectionHead: CSSProperties = {
  fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: 0.5, color: 'var(--cth-ink-900)', margin: '2px 0'
};

export const mono: CSSProperties = { fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-700)' };

export const hint: CSSProperties = { fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-500)', margin: 0 };

export const metaRow: CSSProperties = {
  display: 'flex', flexWrap: 'wrap', gap: '4px 14px', fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-700)'
};

export const input: CSSProperties = {
  fontFamily: 'var(--cth-font-mono)', fontSize: 12, padding: '4px 6px', background: 'var(--cth-paper-100)',
  color: 'var(--cth-ink-900)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', minWidth: 0
};

export function chip(bg: string, fg = 'var(--cth-on-accent, #1A1320)'): CSSProperties {
  return {
    fontFamily: 'var(--cth-font-mono)', fontSize: 10, padding: '1px 6px', textTransform: 'uppercase',
    letterSpacing: 0.5, background: bg, color: fg, whiteSpace: 'nowrap'
  };
}
