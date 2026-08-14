import { Image as ImageIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useProjectStore } from '@/project/project-store';
import type { ImageThumbnailProfile, ImageThumbnailSource } from '../../shared/image-thumbnails';
import { isCanonicalImageThumbnailContentHash } from '../../shared/image-thumbnails';
import { useImageThumbnail } from './image-thumbnail-client';
import { observeThumbnailVisibility } from './thumbnail-visibility-service';

export interface AssetImageThumbnailRequest {
  profile: ImageThumbnailProfile;
}

export type AssetImageThumbnailSource = Omit<ImageThumbnailSource, 'projectSessionId'>;

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
  const projectSessionId = useProjectStore((state) => state.projectSessionId);
  const containerRef = useRef<HTMLSpanElement>(null);
  const [intersecting, setIntersecting] = useState(requestMode === 'eager');
  const [imageLoadFailed, setImageLoadFailed] = useState(false);
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
    if (!projectSessionId || !intersecting) return null;
    return {
      source: {
        projectSessionId,
        assetId: source.assetId,
        projectRelativePath: source.projectRelativePath,
        ...(contentHash ? { contentHash } : {}),
        width: source.width,
        height: source.height,
        orientation: source.orientation,
        ...(source.sampling ? { sampling: source.sampling } : {}),
      },
      variant: { kind: 'profile' as const, profile: request.profile },
    };
  }, [
    contentHash,
    intersecting,
    projectSessionId,
    request.profile,
    source.assetId,
    source.height,
    source.orientation,
    source.projectRelativePath,
    source.sampling,
    source.width,
  ]);

  const thumbnail = useImageThumbnail(thumbnailRequest, requestMode === 'visible' && !intersecting);
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
          className="relative h-full w-full object-cover"
        />
      ) : (
        <ImageIcon className="relative h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
      )}
    </span>
  );
}
