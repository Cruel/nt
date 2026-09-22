export interface ScriptcInvocationContext {
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly terminal?: Readonly<{
    stdin: boolean;
    stdout: boolean;
    stderr: boolean;
    columns: number | null;
    rows: number | null;
  }>;
  readonly cancellationProbe?: () => boolean;
  readonly residentProjectSessions?: boolean;
  readonly projectSessionIdleMs?: number;
  readonly residentProjectSessionEpoch?: number;
  readonly residentProjectSnapshot?: Readonly<{
    projectRoot: string;
    snapshotText: string;
    ownerMetadataText: string;
  }>;
  readonly pinnedProjectSnapshot?: Readonly<{
    projectRoot: string;
    snapshotText: string;
    ownerMetadataText: string;
  }>;
  readonly prepareResidentSnapshotOnly?: boolean;
}

export declare function runNovelTeaScriptcIsland(
  argvText: string,
  invokeHost: (operation: string, requestText: string) => string,
  forceRuntimeCacheRebuild?: boolean,
  authoringCacheInventoryText?: string,
  invocationContext?: ScriptcInvocationContext,
): Promise<string>;

export declare function reconcileNovelTeaResidentProjects(): Promise<number>;
export declare function prepareNovelTeaResidentProjectSnapshots(): Promise<number>;
export declare function novelTeaResidentProjectSessionCount(): number;
