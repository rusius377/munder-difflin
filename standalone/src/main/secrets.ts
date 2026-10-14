/**
 * The desk's secret store: Binance and LLM keys, encrypted with the OS key
 * store (Electron safeStorage — DPAPI on Windows, Keychain on macOS, libsecret
 * on Linux) in <userData>/secrets.json. Plaintext never touches disk; if the OS
 * cannot encrypt, saving is refused. Values never go back to the renderer.
 */
import { safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TradingSecretKey } from '../../../src/shared/trading';

export interface SecretStore {
  get(key: TradingSecretKey): string | undefined;
  set(key: TradingSecretKey, value: string): { ok: boolean; error?: string };
  has(key: TradingSecretKey): boolean;
  remove(key: TradingSecretKey): void;
}

export function createSecretStore(file: string): SecretStore {
  const read = (): Record<string, string> => {
    try {
      if (!existsSync(file)) return {};
      const j: unknown = JSON.parse(readFileSync(file, 'utf8'));
      return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, string>) : {};
    } catch {
      return {};
    }
  };
  const write = (blob: Record<string, string>) => {
    mkdirSync(path.dirname(file), { recursive: true });
    if (!Object.keys(blob).length) { rmSync(file, { force: true }); return; }
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(blob, null, 1), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
  };
  return {
    get(key) {
      const cipher = read()[key];
      if (!cipher) return undefined;
      try {
        if (!safeStorage.isEncryptionAvailable()) return undefined;
        return safeStorage.decryptString(Buffer.from(cipher, 'base64'));
      } catch {
        return undefined;
      }
    },
    set(key, value) {
      try {
        if (!safeStorage.isEncryptionAvailable()) {
          return { ok: false, error: '운영체제 암호화를 사용할 수 없어 키를 평문으로 저장하지 않습니다' };
        }
        const blob = read();
        blob[key] = safeStorage.encryptString(value).toString('base64');
        write(blob);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    has(key) {
      return !!read()[key];
    },
    remove(key) {
      const blob = read();
      if (key in blob) { delete blob[key]; write(blob); }
    }
  };
}
