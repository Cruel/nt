import type { AssetKind, ImageAssetMetadata } from './project-schema/authoring-assets';

interface ImportedAssetMetadataBase {
  originalPath: string;
  originalName: string;
  projectRelativePath: string;
  extension: string;
  mimeType?: string;
  byteSize: number;
  contentHash: string;
  importedAt: string;
}

export type ImportedAssetMetadata =
  | (ImportedAssetMetadataBase & {
      kind: 'image';
      imageMetadata: ImageAssetMetadata;
    })
  | (ImportedAssetMetadataBase & {
      kind: Exclude<AssetKind, 'image'>;
      imageMetadata: null;
    });

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
