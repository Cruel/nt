import type { AssetKind } from './project-schema/authoring-assets';

export interface ImportedAssetMetadata {
  originalPath: string;
  originalName: string;
  projectRelativePath: string;
  kind: AssetKind;
  extension: string;
  mimeType?: string;
  byteSize: number;
  contentHash: string;
  importedAt: string;
}

export interface AssetImportDiagnostic {
  severity: 'info' | 'warning' | 'error';
  message: string;
  path?: string;
}

export interface AssetImportOptions {
  allowMultiple?: boolean;
}

export interface AssetImportResponse {
  ok: boolean;
  success: boolean;
  assets: ImportedAssetMetadata[];
  diagnostics: AssetImportDiagnostic[];
  error?: string;
}

export interface AssetReimportResponse {
  ok: boolean;
  success: boolean;
  asset?: ImportedAssetMetadata;
  diagnostics: AssetImportDiagnostic[];
  error?: string;
}
