/**
 * Standalone desk preload: the same window.cth.trading* API the trading screens
 * use inside Munder Difflin (src/preload/tradingApi.ts), the two app helpers
 * those screens call (login item, external links), and window.desk for this
 * app's own settings.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { tradingApi } from '../../../src/preload/tradingApi';

const cth = {
  ...tradingApi(ipcRenderer),
  setLoginItem: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke('desk:setLoginItem', enabled),
  openExternal: (url: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('desk:openExternal', url),
  /** Workspace images in markdown: the desk has no workspace, so there is nothing to read. */
  readBinary: async (): Promise<{ ok: false; error: string }> => ({ ok: false, error: 'not available in the standalone desk' })
};

const desk = {
  info: (): Promise<{ version: string; dataDir: string; claudeCommand: string; platform: string }> => ipcRenderer.invoke('desk:info'),
  setClaudeCommand: (value: string): Promise<{ ok: boolean; claudeCommand?: string; error?: string }> =>
    ipcRenderer.invoke('desk:setClaudeCommand', value),
  openDataDir: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('desk:openDataDir')
};

export type DeskCth = typeof cth;
export type DeskApi = typeof desk;

contextBridge.exposeInMainWorld('cth', cth);
contextBridge.exposeInMainWorld('desk', desk);
