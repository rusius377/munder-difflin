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
 *   'trading:update' (event)           throttled TradingSnapshot push
 */
import { app, ipcMain, shell } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runHiddenClaude } from '../hiddenClaude';
import { ensureClaudePermissionsAccepted, readConfig } from '../config';
import { projectDir } from '../transcript';
import { deleteSecret, getSecret, hasSecret, setSecret } from '../integrations';
import { TradingEngine } from './engine';
import { createLlmClient } from './llm';
import { BinanceFuturesClient, BINANCE_REST, type FetchLike } from './binance';
import {
  normalizeTradingConfig, TRADING_SECRET_KEYS, TRADING_SYMBOLS,
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
  const engine = new TradingEngine(loadConfig(), {
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
    emit: (snapshot) => opts.broadcast('trading:update', snapshot)
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
      }
      return { ok: true, message: lines.join(' · ') };
    } catch (e) {
      return { ok: false, message: errMsg(e) };
    }
  });

  return { dispose: () => engine.dispose() };
}
