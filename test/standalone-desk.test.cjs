'use strict';

/**
 * Standalone trading desk (standalone/). Pins:
 *   - every window.cth function the trading screens call is provided by the
 *     standalone preload (shared tradingApi + its own helpers), and the office
 *     preload still spreads the same tradingApi;
 *   - the trading IPC no longer imports anything from the office app;
 *   - Munder Difflin data import copies records but never the Python venv or
 *     Claude session folders, and never overwrites;
 *   - the Claude command setting is validated; secrets are stored encrypted.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const loadTs = require('./load-ts.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('the standalone preload provides every window.cth call the trading screens make', () => {
  const dir = path.join(ROOT, 'src/renderer/src/components/trading');
  const used = new Set();
  for (const f of fs.readdirSync(dir)) {
    for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/window\.cth\.([A-Za-z]+)/g)) used.add(m[1]);
  }
  const api = read('src/preload/tradingApi.ts');
  const provided = new Set([...api.matchAll(/^\s{4}([A-Za-z]+): /gm)].map((m) => m[1]));
  const desk = read('standalone/src/preload/index.ts');
  for (const m of desk.matchAll(/^\s{2}([A-Za-z]+): /gm)) provided.add(m[1]);
  assert.ok(used.size > 25, `found ${used.size} calls`);
  const missing = [...used].filter((k) => !provided.has(k));
  assert.deepEqual(missing, [], 'trading screens call functions the standalone preload lacks');
  assert.match(read('src/preload/index.ts'), /\.\.\.tradingApi\(ipcRenderer\),/, 'the office preload spreads the same API');
  assert.match(desk, /\.\.\.tradingApi\(ipcRenderer\),/);
});

test('the trading IPC is host-agnostic; the office wires its own host', () => {
  const ipc = read('src/main/trading/ipc.ts');
  for (const office of ["'../config'", "'../integrations'", "'../hiddenClaude'", "'../transcript'"]) {
    assert.ok(!ipc.includes(`from ${office}`), `trading/ipc.ts imports ${office}`);
  }
  assert.match(read('src/main/index.ts'), /registerTradingIpc\(\{\s*host: munderDifflinHost\(\),/);
  const main = read('standalone/src/main/index.ts');
  assert.match(main, /registerTradingIpc\(\{\s*host: \{/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /contextIsolation: true/);
});

test('Munder Difflin data import keeps records, skips the venv and session folders, never overwrites', () => {
  const { findLegacyTradingDir, importLegacyTradingDir } = loadTs('standalone/src/main/importLegacy.ts');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-import-'));
  const appData = path.join(tmp, 'AppData');
  assert.equal(findLegacyTradingDir(appData), null);
  const from = path.join(appData, 'Munder Difflin', 'trading');
  const w = (rel, body) => { fs.mkdirSync(path.dirname(path.join(from, rel)), { recursive: true }); fs.writeFileSync(path.join(from, rel), body); };
  w('config.json', '{"mode":"agents"}');
  w('agents/trader/record.json', '{}');
  w('agents/trader/.sessions/BTCUSDT/t.jsonl', 'x');
  w('experience/scalp-BTCUSDT.json', '{}');
  w('backtests/abc.json', '{}');
  w('backtests/tmp/job/signals.json', '[]');
  w('history/BTCUSDT/klines/2026-10-01.zip', 'zip');
  w('nautilus/venv/pyvenv.cfg', 'x');
  w('sessions/connection-test/x', 'x');
  assert.equal(findLegacyTradingDir(appData), from);
  const to = path.join(tmp, 'TradingDesk', 'trading');
  fs.mkdirSync(to, { recursive: true });
  fs.writeFileSync(path.join(to, 'config.json'), '{"mode":"scalping"}');
  importLegacyTradingDir(from, to);
  const has = (rel) => fs.existsSync(path.join(to, rel));
  for (const rel of ['agents/trader/record.json', 'experience/scalp-BTCUSDT.json', 'backtests/abc.json', 'history/BTCUSDT/klines/2026-10-01.zip']) assert.ok(has(rel), rel);
  for (const rel of ['agents/trader/.sessions', 'backtests/tmp', 'nautilus', 'sessions']) assert.ok(!has(rel), rel);
  assert.equal(fs.readFileSync(path.join(to, 'config.json'), 'utf8'), '{"mode":"scalping"}', 'existing files win');
});

test('desk settings: the Claude command is validated and persisted', () => {
  const { DeskSettings, normalizeClaudeCommand } = loadTs('standalone/src/main/settings.ts');
  assert.equal(normalizeClaudeCommand('  claude '), 'claude');
  assert.equal(normalizeClaudeCommand(''), null);
  assert.equal(normalizeClaudeCommand('claude\nrm -rf /'), null);
  assert.equal(normalizeClaudeCommand('x'.repeat(301)), null);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'desk-set-')), 'desk.json');
  const s = new DeskSettings(file);
  assert.deepEqual(s.get(), { claudeCommand: 'claude', legacyImportAsked: false });
  s.update({ claudeCommand: 'C:\\npm\\claude.cmd' });
  assert.equal(new DeskSettings(file).get().claudeCommand, 'C:\\npm\\claude.cmd');
  fs.writeFileSync(file, '{"claudeCommand":"","legacyImportAsked":"yes"}');
  assert.deepEqual(new DeskSettings(file).get(), { claudeCommand: 'claude', legacyImportAsked: false });
});

test('desk secrets: encrypted at rest, refused when the OS cannot encrypt', () => {
  let available = true;
  const safeStorage = {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(`E:${Buffer.from(s).toString('hex')}`),
    decryptString: (b) => Buffer.from(b.toString().slice(2), 'hex').toString()
  };
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (req, ...rest) { return req === 'electron' ? 'electron' : orig.call(this, req, ...rest); };
  require.cache.electron = { id: 'electron', filename: 'electron', loaded: true, exports: { safeStorage } };
  try {
    const { createSecretStore } = loadTs('standalone/src/main/secrets.ts');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'desk-sec-')), 'secrets.json');
    const st = createSecretStore(file);
    assert.equal(st.has('binance.live.key'), false);
    assert.deepEqual(st.set('binance.live.key', 'K-123'), { ok: true });
    assert.ok(!fs.readFileSync(file, 'utf8').includes('K-123'));
    assert.equal(st.get('binance.live.key'), 'K-123');
    assert.equal(st.has('binance.live.key'), true);
    st.remove('binance.live.key');
    assert.equal(fs.existsSync(file), false, 'an empty store leaves no file');
    available = false;
    assert.equal(st.set('binance.live.key', 'K').ok, false);
  } finally {
    Module._resolveFilename = orig;
    delete require.cache.electron;
  }
});

test('standalone packaging: lockfile matches package.json; Nautilus runner and icon ship', () => {
  const pkg = JSON.parse(read('standalone/package.json'));
  const lock = JSON.parse(read('standalone/package-lock.json'));
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
  assert.deepEqual(lock.packages[''].devDependencies, pkg.devDependencies);
  for (const d of [...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)]) assert.ok(lock.packages[`node_modules/${d}`], `lock lacks ${d}`);
  assert.equal(lock.packages['node_modules/node-pty'].dev, undefined, 'node-pty is a runtime dependency');
  assert.equal(lock.packages['node_modules/electron'].dev, true);
  const builder = read('standalone/electron-builder.yml');
  assert.match(builder, /from: \.\.\/resources\/nautilus/);
  assert.ok(fs.existsSync(path.join(ROOT, 'standalone/build/icon.ico')));
  assert.ok(fs.existsSync(path.join(ROOT, 'resources/nautilus/desk_backtest.py')));
});
