import { Image as ImageIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useProjectStore } from '@/project/project-store';

interface AssetImageThumbnailProps {
  label: string;
  sourcePath: string;
  className?: string;
}

export function AssetImageThumbnail({ label, sourcePath, className = 'h-9 w-12' }: AssetImageThumbnailProps) {
  const projectFilePath = useProjectStore((state) => state.projectFilePath);
  const [assetUrl, setAssetUrl] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;
    setAssetUrl(null);
    if (!projectFilePath) return;
    void window.noveltea.resolveProjectAssetUrl(projectFilePath, sourcePath)
      .then((result) => {
        if (!canceled) setAssetUrl(result?.url ?? null);
      })
      .catch(() => {
        if (!canceled) setAssetUrl(null);
      });
    return () => { canceled = true; };
  }, [projectFilePath, sourcePath]);

  return (
    <span className={`flex shrink-0 items-center justify-center overflow-hidden rounded border bg-muted/20 ${className}`}>
      {assetUrl ? (
        <img src={assetUrl} alt={label} className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <ImageIcon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
      )}
    </span>
  );
}
