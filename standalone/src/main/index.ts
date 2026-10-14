/**
 * 트레이딩 데스크 — standalone app (main process).
 *
 * The same engine, agents, scalper, backtests and screens as the trading tab in
 * Munder Difflin (they are imported from ../src, not copied), in a window of
 * its own: no office, no orchestrator. This file only provides what the office
 * app provided — a secret store, the Claude Code command, the window — and the
 * app's own small settings.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { registerTradingIpc } from '../../../src/main/trading/ipc';
import { runHiddenClaude } from '../../../src/main/hiddenClaude';
import { ensureClaudePermissionsAccepted } from '../../../src/main/claudeTrust';
import { projectDir } from '../../../src/main/transcript';
import type { EngineStatus } from '../../../src/shared/trading';
import { createSecretStore } from './secrets';
import { DeskSettings, normalizeClaudeCommand } from './settings';
import { findLegacyTradingDir, importLegacyTradingDir } from './importLegacy';

const APP_TITLE = '트레이딩 데스크';
const APP_ID = 'io.github.rusius377.tradingdesk';
const GUIDE_URL = 'https://github.com/rusius377/munder-difflin/blob/feat/trading-desk-ko/standalone/README.ko.md';

let win: BrowserWindow | null = null;
let deskStatus: EngineStatus = 'stopped';
let quitConfirmed = false;

const tradingDir = () => path.join(app.getPath('userData'), 'trading');
const isRunning = () => deskStatus === 'running' || deskStatus === 'halted' || deskStatus === 'starting';

function createWindow(): void {
  win = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 920,
    minHeight: 640,
    title: APP_TITLE,
    backgroundColor: '#FFF8E7',
    show: false,
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.once('ready-to-show', () => win?.show());
  // Links open in the browser; the window itself never navigates away.
  win.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e: { preventDefault(): void }, url: string) => {
    if (url !== win?.webContents.getURL()) e.preventDefault();
  });
  // Closing the window stops automated trading: say so while the desk runs.
  win.on('close', (e: { preventDefault(): void }) => {
    if (quitConfirmed || !isRunning()) return;
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(win!, {
      type: 'warning',
      buttons: ['종료', '취소'],
      defaultId: 1,
      cancelId: 1,
      title: APP_TITLE,
      message: '트레이딩 데스크가 실행 중입니다',
      detail: '앱을 닫으면 자동매매가 멈춥니다. 열린 포지션은 그대로 남습니다 (데모·실거래는 거래소에 걸린 손절·익절이 유지되지만, 모의투자 포지션은 다음 시작까지 감시되지 않습니다).'
    });
    if (choice === 0) {
      quitConfirmed = true;
      win?.close();
    }
  });
  win.on('closed', () => { win = null; });
  if (process.env.TRADING_DESK_SMOKE) runSmoke(win, process.env.TRADING_DESK_SMOKE);
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

/**
 * CI smoke test of the PACKAGED app (TRADING_DESK_SMOKE=<file>): once the page
 * has loaded, check the screens rendered and the trading IPC answers, write the
 * verdict to <file> and exit. Proves the asar paths, preload, renderer bundle
 * and native node-pty all load in the real build.
 */
function runSmoke(w: BrowserWindow, out: string): void {
  const report = (r: Record<string, unknown>) => {
    try { writeFileSync(out, JSON.stringify({ version: app.getVersion(), ...r })); } catch { /* nowhere to report */ }
    quitConfirmed = true;
    app.exit(r.ok ? 0 : 1);
  };
  w.webContents.on('did-fail-load', (_e: unknown, code: number, desc: string) => report({ ok: false, stage: 'load', code, desc }));
  w.webContents.on('render-process-gone', (_e: unknown, d: { reason: string }) => report({ ok: false, stage: 'renderer', reason: d.reason }));
  w.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      w.webContents.executeJavaScript(`(async () => {
        const snap = await window.cth.tradingSnapshot();
        const cfg = await window.cth.tradingGetConfig();
        const info = await window.desk.info();
        return { api: typeof window.cth.tradingStart === 'function', status: snap.status, mode: cfg.mode,
          claude: info.claudeCommand, lang: document.documentElement.lang, text: document.body.innerText.slice(0, 160) };
      })()`).then((r: { api: boolean; status: string; text: string }) => {
        report({ ok: r.api && r.status === 'stopped' && /트레이딩 데스크/.test(r.text), ...r });
      }).catch((e: unknown) => report({ ok: false, stage: 'ipc', error: String(e) }));
    }, 3000);
  });
  setTimeout(() => report({ ok: false, stage: 'timeout' }), 60_000);
}

function openDataDir(): void {
  const dir = tradingDir();
  mkdirSync(dir, { recursive: true });
  void shell.openPath(dir);
}

/** Bring over the trading data built up in Munder Difflin (asked once, or from the menu). */
async function offerLegacyImport(settings: DeskSettings, fromMenu: boolean): Promise<boolean> {
  const legacy = findLegacyTradingDir(app.getPath('appData'));
  const hasOwn = existsSync(path.join(tradingDir(), 'config.json'));
  if (!legacy) {
    if (fromMenu) {
      await dialog.showMessageBox({ type: 'info', title: APP_TITLE, message: 'Munder Difflin의 트레이딩 데이터를 찾지 못했습니다.' });
    }
    return false;
  }
  if (!fromMenu && (hasOwn || settings.get().legacyImportAsked)) return false;
  const r = await dialog.showMessageBox({
    type: 'question',
    buttons: ['가져오기', '새로 시작'],
    defaultId: 0,
    cancelId: 1,
    title: APP_TITLE,
    message: 'Munder Difflin에서 쓰던 트레이딩 데이터를 가져올까요?',
    detail: `${legacy}\n\n설정, 에이전트 폴더와 성적표, 교훈, 거래 기록, 보고서, 백테스트, 스캘퍼 경험, 내려받은 과거 데이터를 복사합니다.` +
      ' 이미 있는 파일은 덮어쓰지 않습니다. API 키는 보안상 옮길 수 없으니 설정에서 다시 입력하세요.' +
      (fromMenu ? '\n\n가져온 설정은 앱을 다시 시작하면 적용됩니다.' : '')
  });
  settings.update({ legacyImportAsked: true });
  if (r.response !== 0) return false;
  try {
    importLegacyTradingDir(legacy, tradingDir());
    return true;
  } catch (e) {
    await dialog.showMessageBox({ type: 'error', title: APP_TITLE, message: '가져오기 실패', detail: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

function buildMenu(settings: DeskSettings): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: '파일',
      submenu: [
        { label: '데이터 폴더 열기', click: openDataDir },
        {
          label: 'Munder Difflin 데이터 가져오기…',
          click: async () => {
            if (await offerLegacyImport(settings, true)) {
              const r = await dialog.showMessageBox({ type: 'info', buttons: ['지금 다시 시작', '나중에'], defaultId: 0, title: APP_TITLE, message: '가져왔습니다. 다시 시작하면 적용됩니다.' });
              if (r.response === 0) { quitConfirmed = true; app.relaunch(); app.quit(); }
            }
          }
        },
        { type: 'separator' },
        { role: 'quit', label: '종료' }
      ]
    },
    {
      label: '편집',
      submenu: [
        { role: 'undo', label: '실행 취소' }, { role: 'redo', label: '다시 실행' }, { type: 'separator' },
        { role: 'cut', label: '잘라내기' }, { role: 'copy', label: '복사' }, { role: 'paste', label: '붙여넣기' },
        { role: 'selectAll', label: '모두 선택' }
      ]
    },
    {
      label: '보기',
      submenu: [
        { role: 'reload', label: '새로 고침' }, { role: 'toggleDevTools', label: '개발자 도구' }, { type: 'separator' },
        { role: 'resetZoom', label: '실제 크기' }, { role: 'zoomIn', label: '확대' }, { role: 'zoomOut', label: '축소' },
        { type: 'separator' }, { role: 'togglefullscreen', label: '전체 화면' }
      ]
    },
    {
      label: '도움말',
      submenu: [
        { label: '사용 설명서', click: () => { void shell.openExternal(GUIDE_URL); } },
        {
          label: '정보',
          click: () => {
            void dialog.showMessageBox({
              type: 'info', title: APP_TITLE, message: `${APP_TITLE} ${app.getVersion()}`,
              detail: 'TradingAgents × 바이낸스 USDⓈ-M 선물. 연구용 도구이며 투자 조언이 아닙니다.\n' +
                `데이터: ${tradingDir()}`
            });
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

  void app.whenReady().then(async () => {
    const userData = app.getPath('userData');
    const settings = new DeskSettings(path.join(userData, 'desk.json'));
    await offerLegacyImport(settings, false);

    const secrets = createSecretStore(path.join(userData, 'secrets.json'));
    const desk = registerTradingIpc({
      host: {
        secrets,
        claudeCommand: () => settings.get().claudeCommand || 'claude',
        runHidden: runHiddenClaude,
        prepareCwd: (cwd) => ensureClaudePermissionsAccepted(cwd),
        transcriptDirFor: (cwd) => projectDir(cwd),
        nautilusScriptDir: app.isPackaged
          ? path.join(process.resourcesPath, 'nautilus')
          : path.resolve(app.getAppPath(), '..', 'resources', 'nautilus')
      },
      broadcast: (channel, payload) => {
        if (channel === 'trading:update') deskStatus = (payload as { status: EngineStatus }).status;
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send(channel, payload);
        }
      }
    });
    app.on('will-quit', () => { try { desk.dispose(); } catch { /* quitting */ } });

    // The app's own settings and helpers (the trading ones live in trading/ipc.ts).
    ipcMain.handle('desk:info', () => ({
      version: app.getVersion(),
      dataDir: tradingDir(),
      claudeCommand: settings.get().claudeCommand,
      platform: process.platform
    }));
    ipcMain.handle('desk:setClaudeCommand', (_e: unknown, value: unknown) => {
      const cmd = normalizeClaudeCommand(value);
      if (!cmd) return { ok: false, error: '명령이 비어 있거나 너무 깁니다' };
      settings.update({ claudeCommand: cmd });
      return { ok: true, claudeCommand: cmd };
    });
    ipcMain.handle('desk:openDataDir', () => { openDataDir(); return { ok: true }; });
    ipcMain.handle('desk:setLoginItem', (_e: unknown, open: unknown) => {
      try {
        app.setLoginItemSettings({ openAtLogin: open === true });
        return app.getLoginItemSettings().openAtLogin;
      } catch {
        return false;
      }
    });
    ipcMain.handle('desk:openExternal', (_e: unknown, url: unknown) => {
      if (typeof url === 'string' && /^https:\/\//i.test(url)) void shell.openExternal(url);
      return { ok: true };
    });

    buildMenu(settings);
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (e: { preventDefault(): void }) => {
    // Menu → 종료 / Cmd+Q while trading: confirm through the window's close handler.
    if (quitConfirmed || !isRunning() || !win) return;
    e.preventDefault();
    win.close();
  });
}
