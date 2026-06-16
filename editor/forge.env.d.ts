/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

interface Window {
  noveltea: import('./src/shared/electron-api').NovelTeaElectronApi;
}
