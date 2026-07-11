import { z } from 'zod';
import { exportPlatformValues, templateDescriptorSchema, type TemplateDescriptor } from './platform-export-contracts';

export const PLATFORM_CERTIFICATION_FORMAT = 'noveltea-platform-certification' as const;
export const PLATFORM_CERTIFICATION_FORMAT_VERSION = 1 as const;

const checkStatusSchema = z.enum(['passed', 'failed', 'skipped']);
const evidenceSchema = z.object({
  check: z.string().trim().min(1),
  status: checkStatusSchema,
  detail: z.string().trim().min(1),
  artifact: z.string().trim().min(1).optional(),
}).strict();

export const platformCertificationReportSchema = z.object({
  format: z.literal(PLATFORM_CERTIFICATION_FORMAT),
  formatVersion: z.literal(PLATFORM_CERTIFICATION_FORMAT_VERSION),
  generatedAt: z.string().datetime(),
  template: z.object({
    templateId: z.string().min(1), buildId: z.string().min(1), target: z.enum(exportPlatformValues),
    architecture: z.string().min(1), buildFlavor: z.enum(['debug', 'release']),
  }).strict(),
  fixture: z.object({ id: z.string().min(1), revision: z.string().min(1) }).strict(),
  exercised: z.object({
    packageApis: z.array(z.number().int().nonnegative()), capabilities: z.array(z.string()),
    artifactFormats: z.array(z.string()),
  }).strict(),
  evidence: z.array(evidenceSchema),
  hostGaps: z.array(z.object({ check: z.string().min(1), reason: z.string().min(1) }).strict()).default([]),
}).strict();

export type PlatformCertificationReport = z.infer<typeof platformCertificationReportSchema>;
export interface CertificationDiagnostic { code: string; path: string; message: string }
export interface CertificationResult { certified: boolean; diagnostics: CertificationDiagnostic[] }

const universalChecks = [
  'artifact-claims', 'descriptor-file-roles', 'runtime-closure', 'grouped-transaction-rollback',
  'fixture-launch', 'input', 'rendering', 'rmlui', 'lua', 'fonts', 'images', 'audio', 'navigation',
  'save-reload', 'clean-shutdown', 'fatal-startup-diagnostics', 'compatible-update',
  'incompatible-api-rejected', 'debug-release-separation', 'development-surfaces-absent',
  'symbols-build-id', 'third-party-notices', 'sbom', 'reproducibility',
] as const;

const targetChecks: Record<(typeof exportPlatformValues)[number], readonly string[]> = {
  web: ['web-root-path', 'web-subdirectory-path', 'web-persistence', 'web-two-games-one-origin', 'web-service-worker-update'],
  windows: [], linux: [], macos: [], android: ['android-system-assets', 'android-install-launch'],
};

function descriptorArtifactFormats(descriptor: TemplateDescriptor): string[] {
  if (descriptor.platform === 'android') return descriptor.android?.artifactKinds ?? [];
  if (descriptor.platform === 'web') return ['directory', 'zip'];
  if (descriptor.platform === 'macos') return ['app-bundle', 'zip'];
  if (descriptor.platform === 'linux') return ['directory', 'tar.gz'];
  return ['directory', 'zip'];
}

export function certifyTemplateDescriptor(descriptorValue: unknown, reportValue: unknown): CertificationResult {
  const descriptor = templateDescriptorSchema.parse(descriptorValue);
  const parsed = platformCertificationReportSchema.safeParse(reportValue);
  if (!parsed.success) return { certified: false, diagnostics: [{ code: 'certification-report-invalid', path: '/', message: z.prettifyError(parsed.error) }] };
  const report = parsed.data;
  const diagnostics: CertificationDiagnostic[] = [];
  const mismatch = (field: string, actual: unknown, expected: unknown) => {
    if (actual !== expected) diagnostics.push({ code: 'certification-template-mismatch', path: `/template/${field}`, message: `Certification ${field} '${String(actual)}' does not match descriptor '${String(expected)}'.` });
  };
  mismatch('templateId', report.template.templateId, descriptor.templateId);
  mismatch('buildId', report.template.buildId, descriptor.buildId);
  mismatch('target', report.template.target, descriptor.platform);
  mismatch('architecture', report.template.architecture, descriptor.architecture);
  mismatch('buildFlavor', report.template.buildFlavor, descriptor.buildFlavor);

  for (let api = descriptor.runtimePackageApi.minimum; api <= descriptor.runtimePackageApi.maximum; api += 1) if (!report.exercised.packageApis.includes(api)) diagnostics.push({ code: 'certification-package-api-unexercised', path: '/exercised/packageApis', message: `Descriptor package API ${api} was not exercised.` });
  for (const capability of descriptor.capabilities) if (!report.exercised.capabilities.includes(capability)) diagnostics.push({ code: 'certification-capability-unexercised', path: '/exercised/capabilities', message: `Descriptor capability '${capability}' was not exercised.` });
  for (const format of descriptorArtifactFormats(descriptor)) if (!report.exercised.artifactFormats.includes(format)) diagnostics.push({ code: 'certification-artifact-unexercised', path: '/exercised/artifactFormats', message: `Claimed artifact format '${format}' was not exercised.` });

  const evidence = new Map(report.evidence.map((item) => [item.check, item]));
  const required = [...universalChecks, ...targetChecks[descriptor.platform], `${descriptor.platform}-system-assets`];
  for (const check of new Set(required)) {
    const item = evidence.get(check);
    if (!item) diagnostics.push({ code: 'certification-evidence-missing', path: '/evidence', message: `Required certification check '${check}' has no evidence.` });
    else if (item.status !== 'passed') diagnostics.push({ code: 'certification-check-not-passed', path: `/evidence/${check}`, message: `Required certification check '${check}' is ${item.status}: ${item.detail}` });
  }
  for (const gap of report.hostGaps) diagnostics.push({ code: 'certification-host-gap', path: `/hostGaps/${gap.check}`, message: `${gap.check}: ${gap.reason}` });
  return { certified: diagnostics.length === 0, diagnostics };
}
