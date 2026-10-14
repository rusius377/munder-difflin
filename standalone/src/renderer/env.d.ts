/// <reference types="vite/client" />
import type { DeskApi } from '../preload/index';

declare global {
  interface Window {
    desk: DeskApi;
  }
}

export {};
