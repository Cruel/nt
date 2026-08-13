import { z } from 'zod';
import certificationContract from './platform-certification-contract.json';
import {
  exportPlatformValues,
  templateDescriptorSchema,
  type TemplateDescriptor,
} from './platform-export-contracts';

export const PLATFORM_CERTIFICATION_FORMAT = 'noveltea-platform-certification' as const;
export const PLATFORM_CERTIFICATION_FORMAT_VERSION = 1 as const;
export const PLATFORM_CERTIFICATION_FIXTURE_ID = 'platform-export-acceptance' as const;

const checkStatusSchema = z.enum(['passed', 'failed', 'skipped']);
const trimmedNonEmptyStringSchema = z.string().check(z.trim(), z.minLength(1));
const evidenceSchema = z
  .object({
    check: trimmedNonEmptyStringSchema,
    status: checkStatusSchema,
    detail: trimmedNonEmptyStringSchema,
    test: trimmedNonEmptyStringSchema,
    target: z.enum(exportPlatformValues),
    artifact: trimmedNonEmptyStringSchema,
    artifactSha256: z.string().regex(/^[0-9a-f]{64}$/),
    producer: trimmedNonEmptyStringSchema,
    command: trimmedNonEmptyStringSchema,
    environment: z
      .object({
        workflow: trimmedNonEmptyStringSchema,
        runId: trimmedNonEmptyStringSchema,
        job: trimmedNonEmptyStringSchema,
        runnerOs: trimmedNonEmptyStringSchema,
        runnerArch: trimmedNonEmptyStringSchema,
        target: z.enum(exportPlatformValues),
      })
      .strict(),
  })
  .strict();

export const platformCertificationReportSchema = z
  .object({
    format: z.literal(PLATFORM_CERTIFICATION_FORMAT),
    formatVersion: z.literal(PLATFORM_CERTIFICATION_FORMAT_VERSION),
    generatedAt: z.string().datetime(),
    template: z
      .object({
        templateId: z.string().min(1),
        buildId: z.string().min(1),
        target: z.enum(exportPlatformValues),
        architecture: z.string().min(1),
        buildFlavor: z.enum(['debug', 'release']),
        descriptorSha256: z.string().regex(/^[0-9a-f]{64}$/),
        archiveSha256: z.string().regex(/^[0-9a-f]{64}$/),
        sourceRevision: z.string().min(1),
      })
      .strict(),
    fixture: z
      .object({
        id: z.literal(PLATFORM_CERTIFICATION_FIXTURE_ID),
        revision: z.string().min(1),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        runtimePackageSha256: z.string().regex(/^[0-9a-f]{64}$/),
        profileSha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
    environment: z
      .object({
        workflow: trimmedNonEmptyStringSchema,
        runId: trimmedNonEmptyStringSchema,
        job: trimmedNonEmptyStringSchema,
        runnerOs: trimmedNonEmptyStringSchema,
        runnerArch: trimmedNonEmptyStringSchema,
        target: z.enum(exportPlatformValues),
      })
      .strict(),
    exercised: z
      .object({
        packageApis: z.array(z.number().int().nonnegative()),
        playerConfigApis: z.array(z.number().int().nonnegative()),
        packageAccessModes: z.array(z.string()).min(1),
      })
      .strict(),
    evidence: z.array(evidenceSchema),
    hostGaps: z
      .array(z.object({ check: z.string().min(1), reason: z.string().min(1) }).strict())
      .default([]),
  })
  .strict();

export type PlatformCertificationReport = z.infer<typeof platformCertificationReportSchema>;
export interface CertificationDiagnostic {
  code: string;
  path: string;
  message: string;
}
export interface CertificationResult {
  certified: boolean;
  diagnostics: CertificationDiagnostic[];
}

type CertificationContract = {
  formatVersion: number;
  universalChecks: string[];
  targetChecks: Record<(typeof exportPlatformValues)[number], string[]>;
  conditionalChecks: Array<{
    platform: (typeof exportPlatformValues)[number];
    artifactKind: string;
    check: string;
  }>;
};

const contract = certificationContract as CertificationContract;

export function requiredPlatformCertificationChecks(descriptor: TemplateDescriptor): string[] {
  const checks = [...contract.universalChecks, ...contract.targetChecks[descriptor.platform]];
  if (descriptor.platform === 'android') {
    const artifactKinds = descriptor.android?.artifactKinds ?? [];
    for (const conditional of contract.conditionalChecks) {
      if (
        conditional.platform === 'android' &&
        artifactKinds.includes(conditional.artifactKind as (typeof artifactKinds)[number])
      )
        checks.push(conditional.check);
    }
  }
  return [...new Set(checks)];
}

export function certifyTemplateDescriptor(
  descriptorValue: unknown,
  reportValue: unknown,
): CertificationResult {
  const descriptor = templateDescriptorSchema.parse(descriptorValue);
  const parsed = platformCertificationReportSchema.safeParse(reportValue);
  if (!parsed.success)
    return {
      certified: false,
      diagnostics: [
        { code: 'certification-report-invalid', path: '/', message: z.prettifyError(parsed.error) },
      ],
    };
  const report = parsed.data;
  const diagnostics: CertificationDiagnostic[] = [];
  const mismatch = (field: string, actual: unknown, expected: unknown) => {
    if (actual !== expected)
      diagnostics.push({
        code: 'certification-template-mismatch',
        path: `/template/${field}`,
        message: `Certification ${field} '${String(actual)}' does not match descriptor '${String(expected)}'.`,
      });
  };
  mismatch('templateId', report.template.templateId, descriptor.templateId);
  mismatch('buildId', report.template.buildId, descriptor.buildId);
  mismatch('target', report.template.target, descriptor.platform);
  mismatch('architecture', report.template.architecture, descriptor.architecture);
  mismatch('buildFlavor', report.template.buildFlavor, descriptor.buildFlavor);

  for (
    let api = descriptor.runtimePackageApi.minimum;
    api <= descriptor.runtimePackageApi.maximum;
    api += 1
  )
    if (!report.exercised.packageApis.includes(api))
      diagnostics.push({
        code: 'certification-package-api-unexercised',
        path: '/exercised/packageApis',
        message: `Descriptor package API ${api} was not exercised.`,
      });
  for (
    let api = descriptor.playerConfigApi.minimum;
    api <= descriptor.playerConfigApi.maximum;
    api += 1
  )
    if (!report.exercised.playerConfigApis.includes(api))
      diagnostics.push({
        code: 'certification-player-config-api-unexercised',
        path: '/exercised/playerConfigApis',
        message: `Descriptor player config API ${api} was not exercised.`,
      });
  for (const mode of report.exercised.packageAccessModes)
    if (!descriptor.packageAccessModes.some((declaredMode) => declaredMode === mode))
      diagnostics.push({
        code: 'certification-report-invalid',
        path: '/exercised/packageAccessModes',
        message: `Exercised package access mode '${mode}' is not declared by the template.`,
      });
  const evidence = new Map<string, (typeof report.evidence)[number]>();
  const artifactOwners = new Map<string, string>();
  for (const item of report.evidence) {
    if (evidence.has(item.check))
      diagnostics.push({
        code: 'certification-evidence-duplicate',
        path: '/evidence',
        message: `Certification check '${item.check}' has duplicate evidence.`,
      });
    evidence.set(item.check, item);
    const owner = artifactOwners.get(item.artifact);
    if (owner && owner !== item.check)
      diagnostics.push({
        code: 'certification-evidence-artifact-reused',
        path: '/evidence',
        message: `Evidence artifact '${item.artifact}' is reused by unrelated checks '${owner}' and '${item.check}'.`,
      });
    artifactOwners.set(item.artifact, item.check);
    if (item.target !== descriptor.platform || item.environment.target !== descriptor.platform)
      diagnostics.push({
        code: 'certification-evidence-target-mismatch',
        path: `/evidence/${item.check}`,
        message: `Evidence '${item.check}' does not match target '${descriptor.platform}'.`,
      });
  }
  for (const check of requiredPlatformCertificationChecks(descriptor)) {
    const item = evidence.get(check);
    if (!item)
      diagnostics.push({
        code: 'certification-evidence-missing',
        path: '/evidence',
        message: `Required certification check '${check}' has no evidence.`,
      });
    else if (item.status !== 'passed')
      diagnostics.push({
        code: 'certification-check-not-passed',
        path: `/evidence/${check}`,
        message: `Required certification check '${check}' is ${item.status}: ${item.detail}`,
      });
  }
  for (const gap of report.hostGaps)
    diagnostics.push({
      code: 'certification-host-gap',
      path: `/hostGaps/${gap.check}`,
      message: `${gap.check}: ${gap.reason}`,
    });
  return { certified: diagnostics.length === 0, diagnostics };
}
