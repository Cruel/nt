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

export type AssetImageThumbnailRequest =
  | { kind: 'profile'; profile: ImageThumbnailProfile; fit?: ImageThumbnailFit }
  | { kind: 'slot'; fit: ImageThumbnailFit };

export type AssetImageThumbnailSource = Omit<ImageThumbnailSource, 'projectFilePath'>;

interface AssetImageThumbnailProps {
  label: string;
  source: AssetImageThumbnailSource;
  request: AssetImageThumbnailRequest;
  className?: string;
  visible?: boolean;
}

export function AssetImageThumbnail({
  label,
  source,
  request,
  className = 'h-9 w-12',
  visible = true,
}: AssetImageThumbnailProps) {
  const projectFilePath = useProjectStore((state) => state.projectFilePath);
  const containerRef = useRef<HTMLSpanElement>(null);
  const [intersecting, setIntersecting] = useState(false);
  const [slot, setSlot] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = containerRef.current;
    if (!element || !visible) {
      setIntersecting(false);
      return;
    }
    if (typeof IntersectionObserver === 'undefined') {
      setIntersecting(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) =>
      setIntersecting(entry?.isIntersecting ?? false),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || request.kind !== 'slot') return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      setSlot({ width: Math.max(0, rect.width), height: Math.max(0, rect.height) });
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [request.kind]);

  const thumbnailRequest = useMemo(() => {
    if (!projectFilePath || !visible || !intersecting) return null;
    const variant =
      request.kind === 'profile'
        ? { kind: 'profile' as const, profile: request.profile }
        : slot.width > 0 && slot.height > 0
          ? {
              kind: 'minimum-size' as const,
              ...imageThumbnailPhysicalSlot(slot.width, slot.height, window.devicePixelRatio),
              fit: request.fit,
            }
          : null;
    return variant ? { source: { ...source, projectFilePath }, variant } : null;
  }, [intersecting, projectFilePath, request, slot.height, slot.width, source, visible]);

  const thumbnail = useImageThumbnail(thumbnailRequest);
  const fit = request.fit ?? 'cover';
  const url = thumbnail.status === 'ready' && thumbnail.result?.ok ? thumbnail.result.url : null;

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
      {url ? (
        <img
          src={url}
          alt={label}
          className={`relative h-full w-full ${fit === 'contain' ? 'object-contain' : 'object-cover'}`}
        />
      ) : (
        <ImageIcon className="relative h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
      )}
    </span>
  );
}
