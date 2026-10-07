import { z } from 'zod';
import { animationCanvasSchema } from './project-schema/authoring-animations';
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

export const importedAnimationSchema = z
  .object({
    label: z.string().min(1),
    format: z.enum(['image-sequence', 'gif', 'apng']),
    canvas: animationCanvasSchema,
    frameDurationMs: z.number().int().positive(),
    frames: z
      .array(
        z
          .object({
            assetIndex: z.number().int().nonnegative(),
            durationMs: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1),
    sourceAssetIndices: z.array(z.number().int().nonnegative()).min(1),
  })
  .strict();
export type ImportedAnimation = z.infer<typeof importedAnimationSchema>;

export interface AssetImportOptions {
  allowMultiple?: boolean;
  animation?: { frameDurationMs: number };
}

export interface AssetImportResponse {
  ok: boolean;
  success: boolean;
  assets: ImportedAssetMetadata[];
  animation?: ImportedAnimation;
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
