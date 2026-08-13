export interface NovelTeaVersionIdentity {
  readonly version: string;
  readonly coreVersion: string;
  readonly releaseTag: string;
}

export declare function parseNovelTeaVersion(value: string): NovelTeaVersionIdentity;
export declare function readNovelTeaVersion(root?: string): NovelTeaVersionIdentity;
export declare function novelTeaDevelopmentVersion(version: string, revision: string): string;
