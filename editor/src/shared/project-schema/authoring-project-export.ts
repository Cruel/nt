import { z } from 'zod';
import { exportProfileSchema } from './authoring-export';
import {
  assetMemoryPolicyDefinitionSchema,
  platformExportProfileSchema,
  resolveAssetMemoryPolicy,
} from './platform-export-contracts';

export const projectExportSettingsSchema = z
  .object({
    runtime: exportProfileSchema,
    profiles: z.array(platformExportProfileSchema).default([]),
    assetMemoryPolicies: z.array(assetMemoryPolicyDefinitionSchema).default([]),
  })
  .strict();

export type ProjectExportSettings = z.infer<typeof projectExportSettingsSchema>;

export interface ProjectExportValidationFinding {
  readonly path: string;
  readonly message: string;
  readonly category: 'Asset memory policies';
  readonly code:
    | 'authoring.asset-memory-policy.id.duplicate'
    | 'authoring.asset-memory-policy.label.duplicate'
    | 'authoring.asset-memory-policy.warm.exceeds-total'
    | 'authoring.asset-memory-policy.reference.missing';
  readonly ownerPaths?: readonly string[];
}

export function validateProjectExportSettings(
  exportSettings: ProjectExportSettings,
): ProjectExportValidationFinding[] {
  const findings: ProjectExportValidationFinding[] = [];
  const ids = new Map<string, number>();
  const labels = new Map<string, number>();
  for (const [index, policy] of exportSettings.assetMemoryPolicies.entries()) {
    const base = `/export/assetMemoryPolicies/${index}`;
    const priorId = ids.get(policy.id);
    if (priorId !== undefined)
      findings.push({
        path: `${base}/id`,
        message: `Asset memory policy ID '${policy.id}' is already used by policy ${priorId + 1}.`,
        category: 'Asset memory policies',
        code: 'authoring.asset-memory-policy.id.duplicate',
      });
    else ids.set(policy.id, index);

    const normalizedLabel = policy.label.trim().toLocaleLowerCase('en-US');
    const priorLabel = labels.get(normalizedLabel);
    if (priorLabel !== undefined)
      findings.push({
        path: `${base}/label`,
        message: `Asset memory policy name '${policy.label}' duplicates policy ${priorLabel + 1}.`,
        category: 'Asset memory policies',
        code: 'authoring.asset-memory-policy.label.duplicate',
      });
    else labels.set(normalizedLabel, index);

    const warmFields = [
      ['warmPreparedCpuBytes', 'preparedCpuBytes', 'prepared CPU'],
      ['warmGpuBytes', 'gpuBytes', 'GPU'],
      ['warmAudioBytes', 'audioBytes', 'audio'],
    ] as const;
    const targetFamilies = [
      ['linux', 'Desktop'],
      ['android', 'Android'],
      ['web', 'Web'],
    ] as const;
    for (const [warmField, totalField, domainLabel] of warmFields) {
      const warmBytes = policy.overrides[warmField];
      if (warmBytes === undefined) continue;
      for (const [target, targetLabel] of targetFamilies) {
        const baseline = resolveAssetMemoryPolicy(target, {
          kind: 'builtin',
          preset: policy.basePreset,
        });
        const totalBytes = policy.overrides[totalField] ?? baseline[totalField];
        if (warmBytes <= totalBytes) continue;
        findings.push({
          path: `${base}/overrides/${warmField}`,
          message: `${targetLabel} Warm ${domainLabel} ceiling must not exceed its total residency ceiling.`,
          category: 'Asset memory policies',
          code: 'authoring.asset-memory-policy.warm.exceeds-total',
        });
        break;
      }
    }
  }

  const knownIds = new Set(exportSettings.assetMemoryPolicies.map((policy) => policy.id));
  for (const [index, profile] of exportSettings.profiles.entries()) {
    if (profile.assetMemory.kind !== 'policy' || knownIds.has(profile.assetMemory.policyId))
      continue;
    findings.push({
      path: `/export/profiles/${index}/assetMemory/policyId`,
      message: `Export profile '${profile.label}' references missing asset memory policy '${profile.assetMemory.policyId}'.`,
      category: 'Asset memory policies',
      code: 'authoring.asset-memory-policy.reference.missing',
      ownerPaths: [`/export/profiles/${index}/assetMemory`, '/export/assetMemoryPolicies'],
    });
  }
  return findings;
}
