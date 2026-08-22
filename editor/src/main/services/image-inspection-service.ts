export interface ImageInspectionMetadata {
  width: number;
  height: number;
  hasAlpha: boolean;
}

export type ImageInspectionImplementation = (
  sourcePath: string,
) => Promise<ImageInspectionMetadata>;

let configuredInspection: ImageInspectionImplementation | null = null;

export function configureImageInspectionService(
  implementation: ImageInspectionImplementation,
): void {
  configuredInspection = implementation;
}

export function resetImageInspectionService(): void {
  configuredInspection = null;
}

export function inspectImage(sourcePath: string): Promise<ImageInspectionMetadata> | null {
  return configuredInspection?.(sourcePath) ?? null;
}
