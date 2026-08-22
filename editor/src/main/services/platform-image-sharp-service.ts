import sharp from 'sharp';
import { configureImageInspectionService } from './image-inspection-service';
import { configurePlatformImageService } from './platform-host-service';

export function configureSharpPlatformImageService(): void {
  const inspectImage = async (sourcePath: string) => {
    const metadata = await sharp(sourcePath, { failOn: 'error' }).metadata();
    if (!metadata.width || !metadata.height)
      throw new Error('Image dimensions could not be determined.');
    const { data, info } = await sharp(sourcePath)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let left = info.width;
    let top = info.height;
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < info.height; y += 1)
      for (let x = 0; x < info.width; x += 1)
        if (data[(y * info.width + x) * info.channels + 3] > 8) {
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
    return {
      width: metadata.width,
      height: metadata.height,
      hasAlpha: metadata.hasAlpha ?? false,
      space: metadata.space,
      ...(right >= 0 ? { alphaBounds: { left, top, right, bottom } } : {}),
    };
  };
  configureImageInspectionService(inspectImage);
  configurePlatformImageService({
    inspectImage,
    async resizeImageToPng(request) {
      await sharp(request.sourcePath, { failOn: 'error' })
        .resize(request.size, request.size, { fit: 'contain' })
        .png()
        .toFile(request.outputPath);
    },
  });
}
