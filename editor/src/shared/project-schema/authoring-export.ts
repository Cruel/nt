import { z } from 'zod';
import { shaderVariantValues, type ShaderVariant } from '../shader-variants';
import type { AuthoringProject } from './authoring-project';

export const exportPackageKindValues = ['runtime', 'editable'] as const;
export const exportShaderVariantValues = shaderVariantValues;

export type ExportPackageKind = (typeof exportPackageKindValues)[number];
export type ExportShaderVariant = ShaderVariant;

export const exportProfileSchema = z
  .object({
    id: z.string().min(1).default('runtime-default'),
    label: z.string().min(1).default('Runtime Package'),
    kind: z.enum(exportPackageKindValues).default('runtime'),
    outputPath: z.string().default(''),
    includeChecksums: z.boolean().default(true),
    stripEditorData: z.boolean().default(true),
    stripShaderSources: z.boolean().default(true),
    compileShadersBeforeExport: z.boolean().default(true),
    shaderVariants: z
      .array(z.enum(exportShaderVariantValues))
      .default(['glsl-120', 'essl-100', 'essl-300', 'metal']),
    excludeUnusedAssets: z.boolean().default(true),
    includeShaderSources: z.boolean().default(false),
    includeTests: z.boolean().default(false),
    previewAfterExport: z.boolean().default(false),
  })
  .strict();

export interface ExportProfileData {
  id: string;
  label: string;
  kind: ExportPackageKind;
  outputPath: string;
  includeChecksums: boolean;
  stripEditorData: boolean;
  stripShaderSources: boolean;
  compileShadersBeforeExport: boolean;
  shaderVariants: ExportShaderVariant[];
  excludeUnusedAssets: boolean;
  includeShaderSources: boolean;
  includeTests: boolean;
  previewAfterExport: boolean;
}

export function defaultExportProfile(
  _project?: Pick<AuthoringProject, 'project'> | null,
): ExportProfileData {
  return exportProfileSchema.parse({
    id: 'runtime-default',
    label: 'Runtime Package',
    kind: 'runtime',
    outputPath: '',
    includeChecksums: true,
    stripEditorData: true,
    stripShaderSources: true,
    compileShadersBeforeExport: true,
    shaderVariants: ['glsl-120', 'essl-100', 'essl-300', 'metal'],
    excludeUnusedAssets: true,
    includeShaderSources: false,
    includeTests: false,
    previewAfterExport: false,
  });
}

export function exportSettingsFromProject(project: AuthoringProject) {
  return project.export;
}

export function selectedExportProfile(project: AuthoringProject): ExportProfileData {
  return exportSettingsFromProject(project).runtime;
}

export function runtimeExportProfileForPlatform(
  project: AuthoringProject,
  target: 'windows' | 'linux' | 'macos' | 'web' | 'android',
): ExportProfileData {
  const profile = selectedExportProfile(project);
  const requiredVariant =
    target === 'web'
      ? 'essl-100'
      : target === 'android'
        ? 'essl-300'
        : target === 'macos'
          ? 'metal'
          : 'glsl-120';
  const shaderVariants = profile.shaderVariants.filter((variant) => variant === requiredVariant);
  return {
    ...profile,
    shaderVariants: shaderVariants.length > 0 ? shaderVariants : [requiredVariant],
  };
}

export function normalizeExportProfile(
  value: unknown,
  project?: Pick<AuthoringProject, 'project'> | null,
): ExportProfileData {
  const parsed = exportProfileSchema.safeParse(value);
  const profile = parsed.success ? parsed.data : defaultExportProfile(project);
  const variants =
    profile.shaderVariants.length > 0
      ? profile.shaderVariants
      : defaultExportProfile(project).shaderVariants;
  return {
    ...profile,
    id: profile.id.trim() || 'runtime-default',
    label: profile.label.trim() || 'Runtime Package',
    outputPath: profile.outputPath.trim(),
    shaderVariants: Array.from(new Set(variants)),
  };
}

export function defaultPackageOutputFileName(project: AuthoringProject): string {
  const slug =
    project.project.name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-') ||
    project.project.id ||
    'noveltea-project';
  return `${slug}.ntpkg`;
}
