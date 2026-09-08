export interface ImageInspectionMetadata {
  width: number;
  height: number;
  hasAlpha: boolean;
  orientation?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
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
