export interface ScriptcInvocationContext {
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly cancellationProbe?: () => boolean;
  readonly residentProjectSessions?: boolean;
}

export declare function runNovelTeaScriptcIsland(
  argvText: string,
  invokeHost: (operation: string, requestText: string) => string,
  forceRuntimeCacheRebuild?: boolean,
  authoringCacheInventoryText?: string,
  invocationContext?: ScriptcInvocationContext,
): Promise<string>;
