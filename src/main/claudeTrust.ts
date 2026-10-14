/**
 * Pre-accept Claude Code's first-run prompts for a working folder, so a hidden
 * or spawned `claude` never stops at a dialog it cannot answer. Shared by the
 * office (config.ts re-exports it) and the standalone trading desk.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function ensureClaudeGlobalPermissions(home: string): void {
  const dir = join(home, '.claude');
  const p = join(dir, 'settings.json');
  try {
    let s: Record<string, unknown> = {};
    if (existsSync(p)) {
      const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      s = parsed as Record<string, unknown>;
    }
    if (s.skipDangerousModePermissionPrompt !== true || s.skipAutoPermissionPrompt !== true) {
      s.skipDangerousModePermissionPrompt = true;
      s.skipAutoPermissionPrompt = true;
      mkdirSync(dir, { recursive: true });
      writeFileSync(p, JSON.stringify(s, null, 2), 'utf8');
    }
  } catch (error) {
    console.warn(
      `[config] Could not safely update Claude config at ${p}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

type ClaudeProjectConfig = Record<string, unknown> & { hasTrustDialogAccepted?: boolean };
type ClaudeConfig = Record<string, unknown> & { projects?: Record<string, ClaudeProjectConfig> };

function ensureClaudeProjectTrust(home: string, cwd: string): void {
  const p = join(home, '.claude.json');
  try {
    let c: ClaudeConfig = {};
    if (existsSync(p)) {
      const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      c = parsed as ClaudeConfig;
    }
    // Claude Code looks this entry up under a path normalised to FORWARD
    // slashes — its own lookup walks parents with `o.startsWith(r + "/")`, and
    // the entries it writes on Windows are keyed "C:/Users/…". Writing only the
    // raw Windows path ("C:\Users\…") puts the flag somewhere Claude never
    // reads, so the agent still hits the interactive "Accessing workspace /
    // Quick safety check" dialog, which it cannot answer: god exits 1 and every
    // message to it sits at "waiting".
    //
    // Both spellings are written — the normalised one is what current Claude
    // reads, the raw one keeps older builds working. On macOS and Linux the two
    // are identical, the Set collapses to one key, and this is a no-op.
    const keys = Array.from(new Set([cwd.replace(/\\/g, '/'), cwd]));
    if (keys.some((k) => c.projects?.[k]?.hasTrustDialogAccepted !== true)) {
      c.projects = c.projects ?? {};
      for (const k of keys) {
        c.projects[k] = { ...(c.projects[k] ?? {}), hasTrustDialogAccepted: true };
      }
      writeFileSync(p, JSON.stringify(c, null, 2), 'utf8');
    }
  } catch (error) {
    console.warn(
      `[config] Could not safely update Claude config at ${p}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Idempotently pre-accept Claude Code's first-run prompts so agents spawned with
 *  `--permission-mode bypassPermissions` start cleanly. Without this, a fresh
 *  install shows an interactive "WARNING: Bypass Permissions mode … 1. No, exit /
 *  2. Yes, I accept" prompt that the PTY can't answer in time, so the agent exits
 *  code 1 on its own (reported by multiple users).
 *
 *  Two separate gates, written only when they aren't already satisfied (so we
 *  rarely touch files a running `claude` also writes):
 *   1. `~/.claude/settings.json` → `skipDangerousModePermissionPrompt` +
 *      `skipAutoPermissionPrompt` — these gate the bypass-mode warning (global).
 *   2. `~/.claude.json` → `projects[cwd].hasTrustDialogAccepted` — the per-folder
 *      "do you trust the files in this folder?" dialog.
 *
 *  Each file is an independent best-effort boundary: unsafe existing contents
 *  are preserved without preventing the other file from being handled safely. */
export function ensureClaudePermissionsAccepted(cwd?: string): void {
  let home: string;
  try { home = homedir(); } catch { return; }
  if (!home) return;

  ensureClaudeGlobalPermissions(home);
  if (cwd) {
    ensureClaudeProjectTrust(home, cwd);
  }
}
