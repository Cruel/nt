import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import { parseAssetData } from '../../shared/project-schema/authoring-assets';
import { isCanonicalImageThumbnailContentHash } from '../../shared/image-thumbnails';

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
      const signature = `${data.source.path}\u0000${data.contentHash}`;
      if (this.#signatures.get(assetId) === signature) continue;
      this.#signatures.set(assetId, signature);
      sources.push({
        projectFilePath,
        projectRelativePath: data.source.path,
        contentHash: data.contentHash,
        width: data.imageMetadata.width,
        height: data.imageMetadata.height,
        orientation: data.imageMetadata.orientation,
      });
    }
    for (const assetId of this.#signatures.keys()) {
      if (!currentIds.has(assetId)) this.#signatures.delete(assetId);
    }
    if (sources.length > 0 && this.#generation) {
      void window.noveltea.prewarmImageThumbnails({
        projectGeneration: this.#generation,
        sources,
      });
    }
  }

  cancel(): void {
    if (this.#generation) {
      void window.noveltea.cancelImageThumbnailPrewarm({
        projectGeneration: this.#generation,
      });
    }
    this.#generation = null;
    this.#projectFilePath = null;
    this.#signatures.clear();
  }
}
