import type { ImportedAssetMetadata } from './asset-import';

export interface ProjectAssetAuditFile {
  projectRelativePath: string;
  absolutePath: string;
  kind: ImportedAssetMetadata['kind'];
  extension: string;
  mimeType?: string;
  byteSize: number;
  modifiedAt: string;
  previewUrl?: string;
}

export interface ProjectAssetAuditResponse {
  ok: boolean;
  success: boolean;
  projectFilePath?: string;
  untrackedFiles: ProjectAssetAuditFile[];
  skippedUnstableFiles: string[];
  diagnostics: Array<{ severity: 'error' | 'warning' | 'info'; path?: string; message: string }>;
  error?: string;
}

export interface ProjectAssetTrashMove {
  projectRelativePath: string;
  trashRelativePath: string;
}

export interface ProjectAssetFileOperationResponse {
  ok: boolean;
  success: boolean;
  assets?: ImportedAssetMetadata[];
  moved?: ProjectAssetTrashMove[];
  restored?: ProjectAssetTrashMove[];
  diagnostics: Array<{ severity: 'error' | 'warning' | 'info'; path?: string; message: string }>;
  error?: string;
}

export interface ProjectAssetAuditChangeEvent {
  projectFilePath: string;
  reason: 'watcher';
}
