/**
 * App-level settings of the standalone desk (<userData>/desk.json). The trading
 * settings themselves live in <userData>/trading/config.json, as in the office.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface DeskSettingsData {
  /** The Claude Code command for the Claude-subscription provider ("claude", or a full path). */
  claudeCommand: string;
  /** The Munder Difflin import question was answered (asked once). */
  legacyImportAsked: boolean;
}

const DEFAULTS: DeskSettingsData = { claudeCommand: 'claude', legacyImportAsked: false };

export function normalizeClaudeCommand(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > 300 || /[\r\n\0]/.test(s)) return null;
  return s;
}

export class DeskSettings {
  private data: DeskSettingsData;

  constructor(private readonly file: string) {
    this.data = { ...DEFAULTS };
    try {
      if (existsSync(file)) {
        const j = JSON.parse(readFileSync(file, 'utf8')) as Partial<DeskSettingsData>;
        this.data = {
          claudeCommand: normalizeClaudeCommand(j.claudeCommand) ?? DEFAULTS.claudeCommand,
          legacyImportAsked: j.legacyImportAsked === true
        };
      }
    } catch { /* defaults */ }
  }

  get(): DeskSettingsData { return { ...this.data }; }

  update(patch: Partial<DeskSettingsData>): DeskSettingsData {
    this.data = { ...this.data, ...patch };
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    return this.get();
  }
}
