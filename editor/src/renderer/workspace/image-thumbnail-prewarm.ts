import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import { parseAssetData } from '../../shared/project-schema/authoring-assets';
import {
  IMAGE_THUMBNAIL_MAX_PREWARM_BATCH_SIZE,
  isCanonicalImageThumbnailContentHash,
} from '../../shared/image-thumbnails';

export class ImageThumbnailPrewarmCoordinator {
  #generation: string | null = null;
  #projectFilePath: string | null = null;
  readonly #signatures = new Map<string, string>();

  publish(project: AuthoringProject | null, projectFilePath: string | null): void {
    if (!project || !projectFilePath) {
      this.cancel();
      return;
    }
    if (this.#projectFilePath !== projectFilePath) {
      this.cancel();
      this.#projectFilePath = projectFilePath;
      this.#generation = `${Date.now()}:${globalThis.crypto.randomUUID()}`;
    }

    const currentIds = new Set<string>();
    const sources = [];
    for (const [assetId, record] of Object.entries(project.assets)) {
      const data = parseAssetData(record.data);
      if (
        data?.kind !== 'image' ||
        !data.imageMetadata ||
        !isCanonicalImageThumbnailContentHash(data.contentHash)
      )
        continue;
      currentIds.add(assetId);
      const signature = [
        data.source.path,
        data.contentHash,
        data.imageMetadata.width,
        data.imageMetadata.height,
        data.imageMetadata.orientation,
        data.sampling ?? 'linear',
      ].join('\u0000');
      if (this.#signatures.get(assetId) === signature) continue;
      this.#signatures.set(assetId, signature);
      sources.push({
        projectFilePath,
        projectRelativePath: data.source.path,
        contentHash: data.contentHash,
        width: data.imageMetadata.width,
        height: data.imageMetadata.height,
        orientation: data.imageMetadata.orientation,
        sampling: data.sampling,
      });
    }
    for (const assetId of this.#signatures.keys()) {
      if (!currentIds.has(assetId)) this.#signatures.delete(assetId);
    }
    if (sources.length > 0 && this.#generation) {
      for (
        let offset = 0;
        offset < sources.length;
        offset += IMAGE_THUMBNAIL_MAX_PREWARM_BATCH_SIZE
      ) {
        void window.noveltea
          .prewarmImageThumbnails({
            projectGeneration: this.#generation,
            sources: sources.slice(offset, offset + IMAGE_THUMBNAIL_MAX_PREWARM_BATCH_SIZE),
          })
          .catch(() => undefined);
      }
    }
  }

  cancel(): void {
    if (this.#generation) {
      void window.noveltea
        .cancelImageThumbnailPrewarm({
          projectGeneration: this.#generation,
        })
        .catch(() => undefined);
    }
    this.#generation = null;
    this.#projectFilePath = null;
    this.#signatures.clear();
  }
}
