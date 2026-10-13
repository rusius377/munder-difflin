/**
 * The desk's on-disk record, under <userData>/trading/:
 *
 *   journal.jsonl            every decision, trade and bias call (append-only)
 *   reports/*.md             full Korean report of each agent pipeline run
 *   lessons/<SYMBOL>.jsonl   reflections fed back to the portfolio manager
 *   day-<venue>.json         today's risk counters, so a restart cannot reset
 *                            the daily loss limit
 *   paper.json / meta-<venue>.json   broker state
 *
 * Everything is best-effort: a failed write is logged by the caller and never
 * stops trading logic.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ExecutionVenue, TradeView, TradingSymbol } from '../../shared/trading';
import type { Persist } from './broker';

export interface DayState {
  dayKey: string;
  startEquity: number;
  realized: number;
  trades: number;
  wins: number;
  losses: number;
  consecutiveLosses: number;
}

export interface Lesson { ts: number; lesson: string }

export class Journal {
  constructor(readonly dir: string) {
    for (const sub of ['', 'reports', 'lessons', 'sessions']) mkdirSync(path.join(dir, sub), { recursive: true });
  }

  get sessionRoot(): string {
    return path.join(this.dir, 'sessions');
  }

  append(entry: Record<string, unknown>): void {
    appendFileSync(path.join(this.dir, 'journal.jsonl'), `${JSON.stringify({ ts: Date.now(), ...entry })}\n`, 'utf8');
  }

  /** Last `n` journal entries of a type (reads the tail of the file). */
  recent(type: string, n: number, venue?: ExecutionVenue): Record<string, unknown>[] {
    const p = path.join(this.dir, 'journal.jsonl');
    if (!existsSync(p)) return [];
    const lines = readFileSync(p, 'utf8').trim().split('\n');
    const out: Record<string, unknown>[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
      try {
        const e = JSON.parse(lines[i]) as Record<string, unknown>;
        if (e.type === type && (!venue || e.venue === venue)) out.push(e);
      } catch { /* torn line */ }
    }
    return out.reverse();
  }

  recentTrades(n: number, venue: ExecutionVenue): TradeView[] {
    return this.recent('trade', n, venue).map((e) => e.trade as TradeView).filter(Boolean);
  }

  writeReport(symbol: TradingSymbol, runId: string, takenAt: number, markdown: string): string {
    const stamp = new Date(takenAt + 9 * 3_600_000).toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 13);
    const file = path.join(this.dir, 'reports', `${symbol}_${stamp}_${runId}.md`);
    writeFileSync(file, markdown, 'utf8');
    return file;
  }

  addLesson(symbol: TradingSymbol, lesson: string): void {
    appendFileSync(path.join(this.dir, 'lessons', `${symbol}.jsonl`), `${JSON.stringify({ ts: Date.now(), lesson })}\n`, 'utf8');
  }

  lessons(symbol: TradingSymbol, n = 5): Lesson[] {
    const p = path.join(this.dir, 'lessons', `${symbol}.jsonl`);
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8').trim().split('\n').slice(-n).map((l) => {
      try { return JSON.parse(l) as Lesson; } catch { return null; }
    }).filter((x): x is Lesson => !!x && typeof x.lesson === 'string');
  }

  /** A JSON file store for broker state (atomic write). */
  store(name: string): Persist {
    const file = path.join(this.dir, name);
    return {
      load: () => {
        try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined; } catch { return undefined; }
      },
      save: (value: unknown) => {
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8');
        renameSync(tmp, file);
      }
    };
  }
}
