'use strict';

/**
 * claudeTrust.ts — the Claude Code first-run prompt pre-acceptance shared by
 * the office and the standalone trading desk. Loads without Electron, so it
 * runs where config.ts (which needs Electron) cannot.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const realHome = process.env.HOME;
const realUserProfile = process.env.USERPROFILE;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-claude-trust-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
assert.equal(os.homedir(), home, 'home redirect failed; refusing to run against the real home');
test.after(() => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realUserProfile;
  fs.rmSync(home, { recursive: true, force: true });
});

const { ensureClaudePermissionsAccepted } = loadTs('src/main/claudeTrust.ts');

test('pre-accepts bypass mode and trusts the folder, keeping unrelated settings', () => {
  const settingsPath = path.join(home, '.claude', 'settings.json');
  const projectConfigPath = path.join(home, '.claude.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ env: { KEEP: '1' } }));
  fs.writeFileSync(projectConfigPath, JSON.stringify({ numStartups: 3, projects: { '/x': { hasTrustDialogAccepted: false } } }));
  const cwd = path.join(home, 'desk', 'agents', 'researchManager', '.sessions', 'BTCUSDT');
  ensureClaudePermissionsAccepted(cwd);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), { env: { KEEP: '1' }, skipDangerousModePermissionPrompt: true, skipAutoPermissionPrompt: true });
  const c = JSON.parse(fs.readFileSync(projectConfigPath, 'utf8'));
  assert.equal(c.numStartups, 3);
  assert.equal(c.projects['/x'].hasTrustDialogAccepted, false);
  assert.equal(c.projects[cwd.replace(/\\/g, '/')].hasTrustDialogAccepted, true);
});

test('the office config still re-exports the same function', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'config.ts'), 'utf8');
  assert.match(src, /export \{ ensureClaudePermissionsAccepted \} from '\.\/claudeTrust';/);
});
