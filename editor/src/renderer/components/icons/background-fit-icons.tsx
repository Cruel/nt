import { useId, type ComponentType, type SVGProps } from 'react';
import { cn } from '@/lib/utils';

export type BackgroundFitMode = 'cover' | 'contain' | 'stretch' | 'center';

type BackgroundFitIconProps = SVGProps<SVGSVGElement>;

type ImageBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function BackgroundFitIcon({
  fit,
  imageBounds,
  clipImage = true,
  className,
  ...props
}: BackgroundFitIconProps & {
  fit: BackgroundFitMode;
  imageBounds: ImageBounds;
  clipImage?: boolean;
}) {
  const clipId = `background-fit-${fit}-${useId().replaceAll(':', '')}`;

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
      data-background-fit-icon={fit}
      className={cn('shrink-0', className)}
      {...props}
    >
      <defs>
        <clipPath id={clipId}>
          <rect x="2" y="4" width="20" height="16" />
        </clipPath>
      </defs>
      <g clipPath={clipImage ? `url(#${clipId})` : undefined}>
        <svg
          {...imageBounds}
          viewBox="0 0 16 9"
          preserveAspectRatio="none"
          data-background-fit-image={fit}
        >
          <rect width="16" height="9" rx="0.75" className="fill-chart-2" />
          <circle cx="12.6" cy="2.25" r="1.15" className="fill-background/90" />
          <path d="M0 8.25 4.5 3.75 7.4 6.35 9.5 4.25 16 8.6V9H0Z" className="fill-background/80" />
          <path
            d="m0 8.25 4.5-4.5 2.9 2.6 2.1-2.1L16 8.6"
            className="fill-none stroke-background/95"
            strokeWidth="0.7"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </g>
      <rect
        x="2"
        y="4"
        width="20"
        height="16"
        data-background-fit-frame=""
        className="fill-none stroke-muted-foreground"
        strokeWidth="1.5"
        shapeRendering="crispEdges"
      />
    </svg>
  );
}

export function BackgroundFitCoverIcon(props: BackgroundFitIconProps) {
  return (
    <BackgroundFitIcon
      fit="cover"
      imageBounds={{ x: -2.22, y: 4, width: 28.44, height: 16 }}
      clipImage={false}
      {...props}
    />
  );
}

export function BackgroundFitContainIcon(props: BackgroundFitIconProps) {
  return (
    <BackgroundFitIcon
      fit="contain"
      imageBounds={{ x: 2, y: 6.38, width: 20, height: 11.25 }}
      {...props}
    />
  );
}

export function BackgroundFitStretchIcon(props: BackgroundFitIconProps) {
  return (
    <BackgroundFitIcon
      fit="stretch"
      imageBounds={{ x: 2, y: 4, width: 20, height: 16 }}
      {...props}
    />
  );
}

export function BackgroundFitCenterIcon(props: BackgroundFitIconProps) {
  return (
    <BackgroundFitIcon
      fit="center"
      imageBounds={{ x: 7, y: 9.19, width: 10, height: 5.62 }}
      {...props}
    />
  );
}

export const backgroundFitIconByMode = {
  cover: BackgroundFitCoverIcon,
  contain: BackgroundFitContainIcon,
  stretch: BackgroundFitStretchIcon,
  center: BackgroundFitCenterIcon,
} satisfies Record<BackgroundFitMode, ComponentType<BackgroundFitIconProps>>;
