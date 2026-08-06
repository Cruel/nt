import { Image as ImageIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useProjectStore } from '@/project/project-store';
import type {
  ImageThumbnailFit,
  ImageThumbnailProfile,
  ImageThumbnailSource,
} from '../../shared/image-thumbnails';
import {
  imageThumbnailPhysicalSlot,
  isCanonicalImageThumbnailContentHash,
} from '../../shared/image-thumbnails';
import { useImageThumbnail } from './image-thumbnail-client';
import { observeThumbnailVisibility } from './thumbnail-visibility-service';

export type AssetImageThumbnailRequest =
  | { kind: 'profile'; profile: ImageThumbnailProfile; fit?: ImageThumbnailFit }
  | { kind: 'slot'; width: number; height: number; fit?: ImageThumbnailFit };

export type AssetImageThumbnailSource = Omit<ImageThumbnailSource, 'projectFilePath'>;

interface AssetImageThumbnailProps {
  label: string;
  source: AssetImageThumbnailSource;
  request: AssetImageThumbnailRequest;
  requestMode?: 'eager' | 'visible';
  className?: string;
}

export function AssetImageThumbnail({
  label,
  source,
  request,
  requestMode = 'eager',
  className = 'h-9 w-12',
}: AssetImageThumbnailProps) {
  const projectFilePath = useProjectStore((state) => state.projectFilePath);
  const containerRef = useRef<HTMLSpanElement>(null);
  const [intersecting, setIntersecting] = useState(requestMode === 'eager');
  const [imageLoadFailed, setImageLoadFailed] = useState(false);
  const requestKind = request.kind;
  const requestProfile = request.kind === 'profile' ? request.profile : null;
  const requestWidth = request.kind === 'slot' ? request.width : null;
  const requestHeight = request.kind === 'slot' ? request.height : null;
  const fit = request.fit ?? 'cover';
  const contentHash = isCanonicalImageThumbnailContentHash(source.contentHash)
    ? source.contentHash
    : undefined;

  useEffect(() => {
    const element = containerRef.current;
    if (requestMode === 'eager') {
      setIntersecting(true);
      return;
    }
    if (!element) return;
    setIntersecting(false);
    return observeThumbnailVisibility(element, setIntersecting);
  }, [requestMode]);

  const thumbnailRequest = useMemo(() => {
    if (!projectFilePath || !intersecting) return null;
    const variant =
      requestKind === 'profile' && requestProfile
        ? { kind: 'profile' as const, profile: requestProfile }
        : requestWidth && requestHeight && requestWidth > 0 && requestHeight > 0
          ? {
              kind: 'minimum-size' as const,
              ...imageThumbnailPhysicalSlot(requestWidth, requestHeight, window.devicePixelRatio),
              fit,
            }
          : null;
    return variant
      ? {
          source: {
            projectFilePath,
            projectRelativePath: source.projectRelativePath,
            ...(contentHash ? { contentHash } : {}),
            width: source.width,
            height: source.height,
            orientation: source.orientation,
          },
          variant,
        }
      : null;
  }, [
    contentHash,
    fit,
    intersecting,
    projectFilePath,
    requestHeight,
    requestKind,
    requestProfile,
    requestWidth,
    source.height,
    source.orientation,
    source.projectRelativePath,
    source.width,
  ]);

  const thumbnail = useImageThumbnail(thumbnailRequest);
  const url = thumbnail.status === 'ready' && thumbnail.result?.ok ? thumbnail.result.url : null;

  useEffect(() => setImageLoadFailed(false), [url]);

  return (
    <span
      ref={containerRef}
      className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded border bg-muted/20 ${className}`}
    >
      <span
        className="absolute inset-0 opacity-35"
        aria-hidden="true"
        style={{
          backgroundImage:
            'linear-gradient(45deg, currentColor 25%, transparent 25%), linear-gradient(-45deg, currentColor 25%, transparent 25%), linear-gradient(45deg, transparent 75%, currentColor 75%), linear-gradient(-45deg, transparent 75%, currentColor 75%)',
          backgroundPosition: '0 0, 0 4px, 4px -4px, -4px 0px',
          backgroundSize: '8px 8px',
        }}
      />
      {url && !imageLoadFailed ? (
        <img
          src={url}
          alt={label}
          loading="lazy"
          onError={() => setImageLoadFailed(true)}
          className={`relative h-full w-full ${fit === 'contain' ? 'object-contain' : 'object-cover'}`}
        />
      ) : (
        <ImageIcon className="relative h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
      )}
    </span>
  );
}
