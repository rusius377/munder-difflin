/**
 * Trading desk ⇄ renderer bridge (main process).
 *
 *   trading:getConfig / saveConfig     config at <userData>/trading/config.json
 *   trading:secrets / setSecret / deleteSecret
 *                                      Binance + LLM keys, encrypted at rest with
 *                                      the app's existing safeStorage secret store
 *                                      (src/main/integrations.ts). Values are
 *                                      write-only: only presence booleans come back.
 *   trading:start / stop / runNow / closePosition / resetPaper / snapshot / test
 *   trading:openReports                opens the reports folder
 *   trading:agents                     every agent's project folder + track record
 *   trading:openAgentFolder            opens one agent's folder (or the agents root)
 *   trading:registerAgentsProject      adds the agents root to the office's projects
 *   trading:backtest*                  past-chart replays (start / cancel / jobs / results / result / delete)
 *   trading:experience / experienceClear   what replays taught the scalper, per symbol
 *   trading:nautilusStatus / nautilusInstall   the NautilusTrader engine (own Python venv)
 *   'trading:backtest' (event)         job list push · 'trading:nautilus' (event) install log lines
 *   'trading:update' (event)           throttled TradingSnapshot push
 *
 * Automation (config.automation): auto-start on launch, a power-save blocker
 * while the desk runs, and desktop notifications for entries/exits/halts/errors.
 */
import { app, ipcMain, Notification, powerSaveBlocker, shell } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runHiddenClaude } from '../hiddenClaude';
import { ensureClaudePermissionsAccepted, readConfig, writeConfig } from '../config';
import { projectDir } from '../transcript';
import { deleteSecret, getSecret, hasSecret, setSecret } from '../integrations';
import { TradingEngine } from './engine';
import { createLlmClient } from './llm';
import { parseAgentId } from './agentProjects';
import { BinanceFuturesClient, BINANCE_REST, liveKeyPermissions, type FetchLike } from './binance';
import { connectWebSocket } from './wsClient';
import { BacktestRunner } from './backtest';
import { NautilusEnv } from './nautilus';
import {
  assessLiveKey, normalizeTradingConfig, TRADING_SECRET_KEYS, TRADING_SYMBOLS, type EngineStatus,
  type TradingConfig, type TradingSecretKey, type TradingSecretPresence, type TradingSymbol
} from '../../shared/trading';

const SECRET_PREFIX = 'trading:';

function dataDir(): string {
  const d = path.join(app.getPath('userData'), 'trading');
  mkdirSync(d, { recursive: true });
  return d;
}

function configPath(): string {
  return path.join(dataDir(), 'config.json');
}

function loadConfig(): TradingConfig {
  try {
    if (existsSync(configPath())) return normalizeTradingConfig(JSON.parse(readFileSync(configPath(), 'utf8')));
  } catch { /* fall through to defaults */ }
  return normalizeTradingConfig({});
}

function saveConfigFile(cfg: TradingConfig): void {
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8');
}

const isSecretKey = (k: unknown): k is TradingSecretKey =>
  typeof k === 'string' && (TRADING_SECRET_KEYS as readonly string[]).includes(k);
const isSymbol = (s: unknown): s is TradingSymbol =>
  typeof s === 'string' && (TRADING_SYMBOLS as readonly string[]).includes(s);

const readSecret = (k: TradingSecretKey) => getSecret(SECRET_PREFIX + k);

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function registerTradingIpc(opts: { broadcast: (channel: string, payload: unknown) => void }): { dispose: () => void } {
  const fetchImpl = (globalThis as unknown as { fetch: FetchLike }).fetch;

  // Keep the machine from suspending the app while the desk trades: a sleeping
  // laptop misses exits the exchange cannot handle for it (time stops, the
  // scalper's break-even move, the next agent run).
  let blockerId: number | null = null;
  const syncKeepAwake = (status: EngineStatus) => {
    const want = engine.config.automation.keepAwake && (status === 'running' || status === 'halted' || status === 'starting');
    try {
      if (want && blockerId === null) blockerId = powerSaveBlocker.start('prevent-app-suspension');
      if (!want && blockerId !== null) {
        if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
        blockerId = null;
      }
    } catch { /* best-effort */ }
  };

  const engine: TradingEngine = new TradingEngine(loadConfig(), {
    fetch: fetchImpl,
    dataDir: dataDir(),
    getSecret: readSecret,
    createLlm: (cfg, sessionRoot) => createLlmClient(cfg.llm, {
      fetch: fetchImpl,
      getSecret: readSecret,
      sessionRoot,
      claudeCommand: readConfig().defaultCommand ?? 'claude',
      runHidden: runHiddenClaude,
      prepareCwd: (cwd) => ensureClaudePermissionsAccepted(cwd),
      transcriptDirFor: (cwd) => projectDir(cwd)
    }),
    emit: (snapshot) => {
      syncKeepAwake(snapshot.status);
      opts.broadcast('trading:update', snapshot);
    },
    wsFactory: connectWebSocket,
    notify: (title, body) => {
      try { if (Notification.isSupported()) new Notification({ title, body, silent: false }).show(); } catch { /* best-effort */ }
    }
  });

  // Auto-start: once the app is up (and the user's shell PATH / Claude login are
  // resolvable), start the desk with the saved settings. Live needs the saved
  // acknowledgement, which normalizeTradingConfig already enforces.
  void app.whenReady().then(() => {
    setTimeout(() => {
      if (!engine.config.automation.autoStart || engine.running) return;
      engine.log('앱 시작 시 자동 실행 설정에 따라 트레이딩 데스크를 시작합니다');
      engine.start().catch(() => { /* logged + notified by the engine */ });
    }, 8000);
  });

  ipcMain.handle('trading:getConfig', () => engine.config);

  ipcMain.handle('trading:saveConfig', (_e: unknown, input: unknown) => {
    try {
      const cfg = normalizeTradingConfig(input);
      saveConfigFile(cfg);
      const { restartRequired } = engine.updateConfig(cfg);
      return { ok: true, config: cfg, restartRequired };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  });

  ipcMain.handle('trading:secrets', (): TradingSecretPresence => {
    const out = {} as TradingSecretPresence;
    for (const k of TRADING_SECRET_KEYS) out[k] = hasSecret(SECRET_PREFIX + k);
    return out;
  });

  ipcMain.handle('trading:setSecret', (_e: unknown, payload: unknown) => {
    const p = payload as { key?: unknown; value?: unknown } | null;
    if (!p || !isSecretKey(p.key) || typeof p.value !== 'string' || !p.value.trim()) return { ok: false, error: '잘못된 요청' };
    if (p.value.length > 512) return { ok: false, error: '값이 너무 깁니다' };
    return setSecret(SECRET_PREFIX + p.key, p.value.trim());
  });

  ipcMain.handle('trading:deleteSecret', (_e: unknown, payload: unknown) => {
    const p = payload as { key?: unknown } | null;
    if (!p || !isSecretKey(p.key)) return { ok: false, error: '잘못된 요청' };
    deleteSecret(SECRET_PREFIX + p.key);
    return { ok: true };
  });

  ipcMain.handle('trading:snapshot', () => engine.getSnapshot());

  ipcMain.handle('trading:start', async () => {
    try { await engine.start(); return { ok: true }; } catch (e) { return { ok: false, error: errMsg(e) }; }
  });

  ipcMain.handle('trading:stop', async () => {
    await engine.stop();
    return { ok: true };
  });

  ipcMain.handle('trading:runNow', async (_e: unknown, payload: unknown) => {
    const s = (payload as { symbol?: unknown } | null)?.symbol;
    if (!isSymbol(s)) return { ok: false, error: '잘못된 종목' };
    // Fire and forget: the run streams its progress through snapshots.
    engine.runNow(s).catch((err) => engine.log(`${s} 분석 실행 실패: ${errMsg(err)}`, 'error', s));
    return { ok: true };
  });

  ipcMain.handle('trading:closePosition', async (_e: unknown, payload: unknown) => {
    const s = (payload as { symbol?: unknown } | null)?.symbol;
    if (!isSymbol(s)) return { ok: false, error: '잘못된 종목' };
    try { await engine.closePosition(s); return { ok: true }; } catch (e) { return { ok: false, error: errMsg(e) }; }
  });

  ipcMain.handle('trading:resetPaper', () => {
    try { engine.resetPaper(); return { ok: true }; } catch (e) { return { ok: false, error: errMsg(e) }; }
  });

  /** Whether the OS launches the app at login (the onboarding sets it; the desk's automation section shows it again). */
  ipcMain.handle('trading:getLoginItem', () => {
    try { return app.getLoginItemSettings().openAtLogin; } catch { return false; }
  });

  // ── backtests ("과거 차트 리테스트") ─────────────────────────────────────
  const nautilus = new NautilusEnv(
    path.join(dataDir(), 'nautilus'),
    app.isPackaged ? path.join(process.resourcesPath, 'nautilus') : path.join(app.getAppPath(), 'resources', 'nautilus')
  );
  const backtests = new BacktestRunner({
    dataDir: dataDir(),
    history: engine.history,
    experience: engine.experience,
    nautilus,
    getConfig: () => engine.config,
    agentReplay: (req, ctl) => engine.runAgentReplay(req, ctl),
    emit: (jobs) => opts.broadcast('trading:backtest', jobs)
  });
  const isSym = (s: unknown) => isSymbol(s) ? s : null;

  ipcMain.handle('trading:backtestStart', (_e: unknown, req: unknown) => {
    try { return { ok: true, job: backtests.start(req) }; } catch (e) { return { ok: false, error: errMsg(e) }; }
  });
  ipcMain.handle('trading:backtestCancel', (_e: unknown, p: unknown) => {
    const id = (p as { id?: unknown } | null)?.id;
    if (typeof id === 'string') backtests.cancel(id);
    return { ok: true };
  });
  ipcMain.handle('trading:backtestJobs', () => backtests.list());
  ipcMain.handle('trading:backtestResults', () => backtests.results());
  ipcMain.handle('trading:backtestResult', (_e: unknown, p: unknown) => {
    const id = (p as { id?: unknown } | null)?.id;
    return typeof id === 'string' ? backtests.result(id) : null;
  });
  ipcMain.handle('trading:backtestDelete', (_e: unknown, p: unknown) => {
    const id = (p as { id?: unknown } | null)?.id;
    if (typeof id === 'string') backtests.remove(id);
    return { ok: true };
  });
  ipcMain.handle('trading:experience', (_e: unknown, p: unknown) => {
    const s = isSym((p as { symbol?: unknown } | null)?.symbol);
    return s ? engine.experience.view(s) : null;
  });
  ipcMain.handle('trading:experienceClear', (_e: unknown, p: unknown) => {
    const s = isSym((p as { symbol?: unknown } | null)?.symbol);
    if (s) engine.experience.clear(s);
    return { ok: true };
  });
  ipcMain.handle('trading:nautilusStatus', async () => {
    try { return await nautilus.status(); } catch (e) { return { state: 'error', message: errMsg(e) }; }
  });
  ipcMain.handle('trading:nautilusInstall', async () => {
    try {
      return await nautilus.install((line) => opts.broadcast('trading:nautilus', line.slice(0, 400)));
    } catch (e) {
      return { state: 'error', message: errMsg(e) };
    }
  });

  ipcMain.handle('trading:agents', () => {
    try {
      return { ok: true, root: engine.projects.root, agents: engine.listAgents(), registered: (readConfig().registeredRepos ?? []).includes(engine.projects.root) };
    } catch (e) {
      return { ok: false, error: errMsg(e), root: engine.projects.root, agents: [], registered: false };
    }
  });

  ipcMain.handle('trading:openAgentFolder', async (_e: unknown, payload: unknown) => {
    const id = (payload as { id?: unknown } | null)?.id;
    let dir = engine.projects.root;
    if (id !== undefined) {
      // Only a known agent id resolves to a folder: no path ever comes from the renderer.
      const ref = typeof id === 'string' ? parseAgentId(id) : null;
      if (!ref) return { ok: false, error: '잘못된 에이전트' };
      dir = engine.projects.ensure(ref);
    }
    const err = await shell.openPath(dir);
    return err ? { ok: false, error: err } : { ok: true };
  });

  /** The agents root becomes an office project (a room), so an office agent can be pointed at the desk's agents. */
  ipcMain.handle('trading:registerAgentsProject', () => {
    try {
      const root = engine.projects.root;
      const repos = readConfig().registeredRepos ?? [];
      if (repos.includes(root)) return { ok: true, path: root, already: true };
      writeConfig({ registeredRepos: [...repos, root] });
      engine.log(`에이전트 폴더를 사무실 프로젝트로 등록했습니다: ${root}`);
      return { ok: true, path: root, already: false };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  });

  ipcMain.handle('trading:openReports', async () => {
    const dir = path.join(dataDir(), 'reports');
    mkdirSync(dir, { recursive: true });
    const err = await shell.openPath(dir);
    return err ? { ok: false, error: err } : { ok: true };
  });

  /** Connectivity checks: Binance public + (if keys) private for the chosen venue, or one tiny LLM call. */
  ipcMain.handle('trading:test', async (_e: unknown, payload: unknown) => {
    const target = (payload as { target?: unknown } | null)?.target;
    const cfg = engine.config;
    try {
      if (target === 'llm') {
        const llm = createLlmClient(cfg.llm, {
          fetch: fetchImpl, getSecret: readSecret, sessionRoot: path.join(dataDir(), 'sessions'),
          claudeCommand: readConfig().defaultCommand ?? 'claude', runHidden: runHiddenClaude,
          prepareCwd: (cwd) => ensureClaudePermissionsAccepted(cwd), transcriptDirFor: (cwd) => projectDir(cwd)
        });
        const t0 = Date.now();
        const text = await llm.complete({ role: 'connection-test', tier: 'quick', system: '짧게 답하라.', prompt: '"연결 성공" 이라고만 답하라.', maxTokens: 50 });
        return { ok: true, message: `${llm.label} — ${((Date.now() - t0) / 1000).toFixed(1)}초, 응답: ${text.slice(0, 60)}` };
      }
      const pub = new BinanceFuturesClient({ baseUrl: BINANCE_REST.live, fetch: fetchImpl });
      const prem = await pub.premiumIndex('BTCUSDT');
      const lines = [`시세 연결 OK — BTCUSDT 마크가격 ${prem.markPrice.toFixed(1)}`];
      if (cfg.venue !== 'paper') {
        const key = readSecret(cfg.venue === 'live' ? 'binance.live.key' : 'binance.demo.key');
        const secret = readSecret(cfg.venue === 'live' ? 'binance.live.secret' : 'binance.demo.secret');
        if (!key || !secret) return { ok: false, message: `${lines[0]} · ${cfg.venue === 'live' ? '실거래' : '데모'} API 키가 없습니다` };
        const priv = new BinanceFuturesClient({ baseUrl: cfg.venue === 'live' ? BINANCE_REST.live : BINANCE_REST.demo, apiKey: key, apiSecret: secret, fetch: fetchImpl });
        const acct = await priv.account();
        const hedge = await priv.isHedgeMode();
        lines.push(`${cfg.venue === 'live' ? '실거래' : '데모'} 계좌 OK — 지갑 ${acct.totalWalletBalance.toFixed(2)} USDT, 가용 ${acct.availableBalance.toFixed(2)} USDT, ${hedge ? '헤지 모드' : '단방향 모드'}`);
        if (cfg.venue === 'live') {
          try {
            const verdict = assessLiveKey(await liveKeyPermissions(key, secret, fetchImpl));
            if (!verdict.ok) return { ok: false, message: [...lines, ...verdict.problems].join(' · ') };
            lines.push('키 권한 OK (선물 거래 가능 · 출금 불가)', ...verdict.warnings);
          } catch (e) {
            lines.push(`키 권한 확인 실패: ${errMsg(e)}`);
          }
        }
      }
      return { ok: true, message: lines.join(' · ') };
    } catch (e) {
      return { ok: false, message: errMsg(e) };
    }
  });

  return {
    dispose: () => {
      engine.dispose();
      syncKeepAwake('stopped');
    }
  };
}
