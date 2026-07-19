export {};

declare global {
  interface Window {
    noveltea: import('./shared/electron-api').NovelTeaElectronApi;
  }
}
