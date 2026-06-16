export interface AppInfo {
  version: string;
  electronVersion: string;
  platform: string;
  arch: string;
  packaged: boolean;
}

export interface NovelTeaElectronApi {
  getAppInfo(): Promise<AppInfo>;
  selectProjectDirectory(): Promise<string | null>;
  openExternal(url: string): Promise<void>;
}
