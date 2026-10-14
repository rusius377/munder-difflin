/**
 * The trading desk's renderer API (window.cth.trading*), shared by the
 * Munder Difflin preload and the standalone desk's preload so both expose the
 * same functions to the same screens. Secrets are WRITE-ONLY: `tradingSecrets`
 * returns presence booleans, never a value. Orders only ever originate in main.
 */
import type {
  AgentProjectView, BacktestJobView, BacktestRequest, BacktestResultView, ExperienceView, NautilusStatusView,
  TradingConfig, TradingSecretKey, TradingSecretPresence, TradingSnapshot, TradingSymbol
} from '../shared/trading';

/** A saved backtest without its trade list (the results list). */
export type BacktestResultSummary = Omit<BacktestResultView, 'trades' | 'equity' | 'episodes'> & { tradeCount: number };

/** The part of Electron's ipcRenderer this API uses (kept structural: no electron import here). */
export interface IpcLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke(channel: string, ...args: unknown[]): Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(channel: string, listener: (event: unknown, ...args: any[]) => void): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeListener(channel: string, listener: (event: unknown, ...args: any[]) => void): unknown;
}
type IpcRendererEvent = unknown;

export function tradingApi(ipcRenderer: IpcLike) {
  return {
    tradingGetConfig: (): Promise<TradingConfig> => ipcRenderer.invoke('trading:getConfig'),
    tradingSaveConfig: (cfg: TradingConfig): Promise<{ ok: boolean; config?: TradingConfig; restartRequired?: boolean; error?: string }> =>
      ipcRenderer.invoke('trading:saveConfig', cfg),
    tradingSecrets: (): Promise<TradingSecretPresence> => ipcRenderer.invoke('trading:secrets'),
    tradingSetSecret: (key: TradingSecretKey, value: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('trading:setSecret', { key, value }),
    tradingDeleteSecret: (key: TradingSecretKey): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('trading:deleteSecret', { key }),
    tradingSnapshot: (): Promise<TradingSnapshot> => ipcRenderer.invoke('trading:snapshot'),
    tradingStart: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('trading:start'),
    tradingStop: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('trading:stop'),
    tradingRunNow: (symbol: TradingSymbol): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('trading:runNow', { symbol }),
    tradingClosePosition: (symbol: TradingSymbol): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('trading:closePosition', { symbol }),
    tradingResetPaper: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('trading:resetPaper'),
    tradingOpenReports: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('trading:openReports'),
    tradingGetLoginItem: (): Promise<boolean> => ipcRenderer.invoke('trading:getLoginItem'),
    tradingTest: (target: 'binance' | 'llm'): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke('trading:test', { target }),
    /** Every desk agent's project folder and track record. */
    tradingAgents: (): Promise<{ ok: boolean; root: string; agents: AgentProjectView[]; registered: boolean; canRegister?: boolean; error?: string }> =>
      ipcRenderer.invoke('trading:agents'),
    /** Open one agent's folder by id (main resolves the path), or the agents root without an id. */
    tradingOpenAgentFolder: (id?: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('trading:openAgentFolder', id === undefined ? {} : { id }),
    tradingRegisterAgentsProject: (): Promise<{ ok: boolean; path?: string; already?: boolean; error?: string }> =>
      ipcRenderer.invoke('trading:registerAgentsProject'),
    // Past-chart replays, the scalper's experience and the NautilusTrader engine.
    tradingBacktestStart: (req: Partial<BacktestRequest>): Promise<{ ok: boolean; job?: BacktestJobView; error?: string }> =>
      ipcRenderer.invoke('trading:backtestStart', req),
    tradingBacktestCancel: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('trading:backtestCancel', { id }),
    tradingBacktestJobs: (): Promise<BacktestJobView[]> => ipcRenderer.invoke('trading:backtestJobs'),
    tradingBacktestResults: (): Promise<BacktestResultSummary[]> => ipcRenderer.invoke('trading:backtestResults'),
    tradingBacktestResult: (id: string): Promise<BacktestResultView | null> => ipcRenderer.invoke('trading:backtestResult', { id }),
    tradingBacktestDelete: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('trading:backtestDelete', { id }),
    tradingExperience: (symbol: TradingSymbol): Promise<ExperienceView | null> => ipcRenderer.invoke('trading:experience', { symbol }),
    tradingExperienceClear: (symbol: TradingSymbol): Promise<{ ok: boolean }> => ipcRenderer.invoke('trading:experienceClear', { symbol }),
    tradingNautilusStatus: (): Promise<NautilusStatusView> => ipcRenderer.invoke('trading:nautilusStatus'),
    tradingNautilusInstall: (): Promise<NautilusStatusView> => ipcRenderer.invoke('trading:nautilusInstall'),
    onBacktestUpdate: (cb: (jobs: BacktestJobView[]) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, jobs: BacktestJobView[]) => cb(jobs);
      ipcRenderer.on('trading:backtest', listener);
      return () => ipcRenderer.removeListener('trading:backtest', listener);
    },
    onNautilusLog: (cb: (line: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, line: string) => cb(line);
      ipcRenderer.on('trading:nautilus', listener);
      return () => ipcRenderer.removeListener('trading:nautilus', listener);
    },
    /** Throttled snapshot push from the engine. Returns an unsubscribe. */
    onTradingUpdate: (cb: (snapshot: TradingSnapshot) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, snapshot: TradingSnapshot) => cb(snapshot);
      ipcRenderer.on('trading:update', listener);
      return () => ipcRenderer.removeListener('trading:update', listener);
    },
  };
}
