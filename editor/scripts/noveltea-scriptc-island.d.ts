export declare function runNovelTeaScriptcIsland(
  argvText: string,
  invokeHost: (operation: string, requestText: string) => string,
  forceRuntimeCacheRebuild?: boolean,
  authoringCacheInventoryText?: string,
): Promise<string>;
