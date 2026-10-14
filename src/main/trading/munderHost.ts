/**
 * The trading desk hosted inside Munder Difflin: the office's encrypted secret
 * store (keys prefixed "trading:"), its Claude Code command and trust handling,
 * and its project rooms for the agents folder.
 */
import { app } from 'electron';
import path from 'node:path';
import { runHiddenClaude } from '../hiddenClaude';
import { ensureClaudePermissionsAccepted, readConfig, writeConfig } from '../config';
import { projectDir } from '../transcript';
import { deleteSecret, getSecret, hasSecret, setSecret } from '../integrations';
import type { TradingHost } from './ipc';

const SECRET_PREFIX = 'trading:';

export function munderDifflinHost(): TradingHost {
  return {
    secrets: {
      get: (k) => getSecret(SECRET_PREFIX + k),
      set: (k, v) => setSecret(SECRET_PREFIX + k, v),
      has: (k) => hasSecret(SECRET_PREFIX + k),
      remove: (k) => deleteSecret(SECRET_PREFIX + k)
    },
    claudeCommand: () => readConfig().defaultCommand ?? 'claude',
    runHidden: runHiddenClaude,
    prepareCwd: (cwd) => ensureClaudePermissionsAccepted(cwd),
    transcriptDirFor: (cwd) => projectDir(cwd),
    nautilusScriptDir: app.isPackaged ? path.join(process.resourcesPath, 'nautilus') : path.join(app.getAppPath(), 'resources', 'nautilus'),
    projects: {
      isRegistered: (root) => (readConfig().registeredRepos ?? []).includes(root),
      register: (root) => {
        const repos = readConfig().registeredRepos ?? [];
        if (!repos.includes(root)) writeConfig({ registeredRepos: [...repos, root] });
      }
    }
  };
}
