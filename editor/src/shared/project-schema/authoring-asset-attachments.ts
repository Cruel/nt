import type { JsonPatchOperation } from '../../renderer/project/json-patch';
import { assetAttachmentSchema, parseAssetData, type AssetAttachment } from './authoring-assets';
import type { AuthoringProject } from './authoring-project';

export interface AttachmentUsage {
  assetId: string;
  label: string;
  attachment: AssetAttachment;
}

export function projectAttachmentPaths(project: AuthoringProject): string[] {
  return [
    ...new Set(
      Object.values(project.assets).flatMap(
        (record) =>
          parseAssetData(record.data)?.attachments.map((attachment) => attachment.path) ?? [],
      ),
    ),
  ].sort();
}

export function attachmentUsages(
  project: AuthoringProject,
  relativePath: string,
): AttachmentUsage[] {
  return Object.entries(project.assets).flatMap(([assetId, record]) => {
    const attachment = parseAssetData(record.data)?.attachments.find(
      (item) => item.path === relativePath,
    );
    return attachment ? [{ assetId, label: record.label, attachment }] : [];
  });
}

export function assetAttachmentPatches(
  project: AuthoringProject,
  assetIds: readonly string[],
  change: { kind: 'add' | 'remove' | 'replace'; attachment: AssetAttachment; priorPath?: string },
  assetRevisionsById: Readonly<Record<string, string>> = {},
): JsonPatchOperation[] {
  const parsed = Object.fromEntries(
    Object.entries(assetAttachmentSchema.parse(change.attachment)).filter(
      ([, value]) => value !== undefined,
    ),
  ) as AssetAttachment;
  const unique = [...new Set(assetIds)];
  // Preflight all targets so no partial association can be committed.
  const updates = unique.map((assetId) => {
    const record = project.assets[assetId];
    const data = record && parseAssetData(record.data);
    if (!data) throw new Error(`Asset '${assetId}' does not exist or has invalid data.`);
    const current = data.attachments;
    const key = change.priorPath ?? parsed.path;
    const index = current.findIndex((item) => item.path === key);
    if (change.kind === 'add' && index >= 0) return null;
    if (change.kind !== 'add' && index < 0)
      throw new Error(`Attachment '${key}' is not associated with '${assetId}'.`);
    if (current.some((item) => item.path === parsed.path && item.path !== key))
      throw new Error(`Asset '${assetId}' already references '${parsed.path}'.`);
    const next = [...current];
    const selectedAssetRevision = assetRevisionsById[assetId] ?? parsed.assetBaselineHash;
    const attachment =
      change.kind === 'add' && parsed.purpose === 'authoring-source'
        ? {
            ...parsed,
            ...(/^sha256:[0-9a-f]{64}$/u.test(selectedAssetRevision ?? '')
              ? { assetBaselineHash: selectedAssetRevision }
              : {}),
          }
        : parsed;
    if (change.kind === 'remove') next.splice(index, 1);
    else if (change.kind === 'replace') next[index] = attachment;
    else next.push(attachment);
    return {
      op: Object.hasOwn(record.data as object, 'attachments')
        ? ('replace' as const)
        : ('add' as const),
      path: `/assets/${assetId.replaceAll('~', '~0').replaceAll('/', '~1')}/data/attachments`,
      value: next,
    };
  });
  return updates.filter((patch): patch is NonNullable<typeof patch> => patch !== null);
}
