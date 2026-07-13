import { z } from 'zod';
import type { AuthoringProject } from './authoring-project';

export const exportPackageKindValues = ['runtime', 'editable'] as const;
export const exportShaderVariantValues = ['glsl-120', 'essl-100', 'essl-300'] as const;

export type ExportPackageKind = (typeof exportPackageKindValues)[number];
export type ExportShaderVariant = (typeof exportShaderVariantValues)[number];

export const exportProfileSchema = z.object({
  id: z.string().min(1).default('runtime-default'),
  label: z.string().min(1).default('Runtime Package'),
  kind: z.enum(exportPackageKindValues).default('runtime'),
  outputPath: z.string().default(''),
  includeChecksums: z.boolean().default(true),
  stripEditorData: z.boolean().default(true),
  stripShaderSources: z.boolean().default(true),
  compileShadersBeforeExport: z.boolean().default(true),
  shaderVariants: z.array(z.enum(exportShaderVariantValues)).default(['glsl-120', 'essl-100', 'essl-300']),
  includeAllProjectAssets: z.boolean().default(false),
  includeOnlyReferencedAssets: z.boolean().default(true),
  includeTests: z.boolean().default(false),
  previewAfterExport: z.boolean().default(false),
}).strict();

export const exportSettingsSchema = z.object({
  selectedProfileId: z.string().default('runtime-default'),
  profiles: z.array(exportProfileSchema).default([]),
}).strict();

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
  includeAllProjectAssets: boolean;
  includeOnlyReferencedAssets: boolean;
  includeTests: boolean;
  previewAfterExport: boolean;
}

export interface ExportSettingsData {
  selectedProfileId: string;
  profiles: ExportProfileData[];
}

export function defaultExportProfile(_project?: Pick<AuthoringProject, 'project'> | null): ExportProfileData {
  return exportProfileSchema.parse({
    id: 'runtime-default',
    label: 'Runtime Package',
    kind: 'runtime',
    outputPath: '',
    includeChecksums: true,
    stripEditorData: true,
    stripShaderSources: true,
    compileShadersBeforeExport: true,
    shaderVariants: ['glsl-120', 'essl-100', 'essl-300'],
    includeAllProjectAssets: false,
    includeOnlyReferencedAssets: true,
    includeTests: false,
    previewAfterExport: false,
  });
}

export function defaultExportSettings(project?: Pick<AuthoringProject, 'project'> | null): ExportSettingsData {
  const profile = defaultExportProfile(project);
  return exportSettingsSchema.parse({ selectedProfileId: profile.id, profiles: [profile] });
}

export function parseExportSettings(value: unknown, project?: Pick<AuthoringProject, 'project'> | null): ExportSettingsData {
  const parsed = exportSettingsSchema.safeParse(value);
  if (!parsed.success || parsed.data.profiles.length === 0) return defaultExportSettings(project);

  const normalizedProfiles = parsed.data.profiles.map((profile) => normalizeExportProfile(profile, project));
  const selectedExists = normalizedProfiles.some((profile) => profile.id === parsed.data.selectedProfileId);
  return {
    selectedProfileId: selectedExists ? parsed.data.selectedProfileId : normalizedProfiles[0]!.id,
    profiles: normalizedProfiles,
  };
}

export function exportSettingsFromProject(project: AuthoringProject): ExportSettingsData {
  const settings = project.settings.export;
  return parseExportSettings(settings, project);
}

export function selectedExportProfile(project: AuthoringProject): ExportProfileData {
  const settings = exportSettingsFromProject(project);
  return settings.profiles.find((profile) => profile.id === settings.selectedProfileId) ?? settings.profiles[0] ?? defaultExportProfile(project);
}

export function normalizeExportProfile(value: unknown, project?: Pick<AuthoringProject, 'project'> | null): ExportProfileData {
  const parsed = exportProfileSchema.safeParse(value);
  const profile = parsed.success ? parsed.data : defaultExportProfile(project);
  const variants = profile.shaderVariants.length > 0 ? profile.shaderVariants : defaultExportProfile(project).shaderVariants;
  return {
    ...profile,
    id: profile.id.trim() || 'runtime-default',
    label: profile.label.trim() || 'Runtime Package',
    outputPath: profile.outputPath.trim(),
    shaderVariants: Array.from(new Set(variants)),
    includeOnlyReferencedAssets: profile.includeAllProjectAssets ? false : profile.includeOnlyReferencedAssets,
  };
}

export function defaultPackageOutputFileName(project: AuthoringProject): string {
  const slug = project.project.name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-') || project.project.id || 'noveltea-project';
  return `${slug}.ntpkg`;
}
