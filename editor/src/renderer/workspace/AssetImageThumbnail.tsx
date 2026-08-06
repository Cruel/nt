import { Image as ImageIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useProjectStore } from '@/project/project-store';
import type {
  ImageThumbnailFit,
  ImageThumbnailProfile,
  ImageThumbnailSource,
} from '../../shared/image-thumbnails';
import { imageThumbnailPhysicalSlot } from '../../shared/image-thumbnails';
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
      request.kind === 'profile'
        ? { kind: 'profile' as const, profile: request.profile }
        : request.width > 0 && request.height > 0
          ? {
              kind: 'minimum-size' as const,
              ...imageThumbnailPhysicalSlot(request.width, request.height, window.devicePixelRatio),
              fit: request.fit ?? 'cover',
            }
          : null;
    return variant ? { source: { ...source, projectFilePath }, variant } : null;
  }, [intersecting, projectFilePath, request, source]);

  const thumbnail = useImageThumbnail(thumbnailRequest);
  const fit = request.fit ?? 'cover';
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
