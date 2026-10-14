/**
 * One-time import of the trading desk data a user already built up inside
 * Munder Difflin: settings, agent folders and track records, lessons, journal,
 * reports, backtests, experience and the downloaded market history.
 *
 * Not copied: API keys (encrypted for the other app; re-enter them), Claude
 * session folders (throwaway), and the NautilusTrader venv (its paths are
 * absolute; the desk reinstalls it with one button).
 */
import { cpSync, existsSync } from 'node:fs';
import path from 'node:path';

/** Munder Difflin's trading folder, if this user has one. */
export function findLegacyTradingDir(appData: string): string | null {
  for (const name of ['Munder Difflin', 'munder-difflin']) {
    const dir = path.join(appData, name, 'trading');
    if (existsSync(path.join(dir, 'config.json'))) return dir;
  }
  return null;
}

/** Copy everything worth keeping from `from` into `to` (existing files win). */
export function importLegacyTradingDir(from: string, to: string): void {
  cpSync(from, to, {
    recursive: true,
    force: false,
    errorOnExist: false,
    filter: (src) => {
      const rel = path.relative(from, src);
      if (!rel) return true;
      const parts = rel.split(path.sep);
      if (parts[0] === 'nautilus' || parts[0] === 'sessions') return false;
      if (parts.includes('.sessions')) return false;
      if (parts[0] === 'backtests' && parts[1] === 'tmp') return false;
      return true;
    }
  });
}
