import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useMaterialPreviewGroupRenderer,
  useMaterialPreviewGroupStatus,
  useMaterialPreviewProjectResources,
} from './material-preview-provider';
import type { ShaderUniformValue } from '../../shared/project-schema/authoring-shaders';
import type { MaterialPreviewProjectResources } from './material-preview-resources';
import type { MaterialPreviewPointerState } from './material-preview-renderer';

const OUTSIDE_POINTER: MaterialPreviewPointerState = { x: -1, y: -1, pressed: false };

export function MaterialPreview({
  materialId,
  className,
  resources: explicitResources,
  parameterOverrides,
  compact = false,
}: {
  materialId: string;
  className?: string;
  resources?: MaterialPreviewProjectResources;
  parameterOverrides?: Readonly<Record<string, ShaderUniformValue>>;
  compact?: boolean;
}) {
  const { t } = useTranslation('workspace');
  const renderer = useMaterialPreviewGroupRenderer();
  const status = useMaterialPreviewGroupStatus();
  const projectResources = useMaterialPreviewProjectResources();
  const resources = explicitResources ?? projectResources;
  const [resourceStatus, setResourceStatus] = useState<{ stale: boolean } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const registrationRef = useRef<ReturnType<typeof renderer.registerSurface> | null>(null);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [visible, setVisible] = useState(true);
  const pointerRef = useRef<MaterialPreviewPointerState>(OUTSIDE_POINTER);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const updateSize = () => {
      const rect = canvas.getBoundingClientRect();
      setSize({ width: Math.max(1, rect.width), height: Math.max(1, rect.height) });
    };
    updateSize();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateSize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (entry) setVisible(entry.isIntersecting);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let active = true;
    void resources.getMaterial(materialId).then((resource) => {
      if (active) setResourceStatus(resource ? { stale: resource.stale } : null);
    });
    return () => {
      active = false;
    };
  }, [materialId, resources, resources.generation]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const state = {
      canvas,
      materialId,
      width: size.width,
      height: size.height,
      visible,
      pointer: pointerRef.current,
      resources,
      parameterOverrides,
    };
    if (!registrationRef.current) registrationRef.current = renderer.registerSurface(state);
    else registrationRef.current.update(state);
  }, [
    materialId,
    parameterOverrides,
    renderer,
    resources,
    resources.generation,
    size.height,
    size.width,
    visible,
  ]);

  useEffect(
    () => () => {
      registrationRef.current?.unregister();
      registrationRef.current = null;
    },
    [renderer],
  );

  function updatePointer(event: React.PointerEvent<HTMLCanvasElement>, pressed: boolean) {
    const rect = event.currentTarget.getBoundingClientRect();
    pointerRef.current = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      pressed,
    };
    registrationRef.current?.update({
      canvas: event.currentTarget,
      materialId,
      width: size.width,
      height: size.height,
      visible,
      pointer: pointerRef.current,
      resources,
      parameterOverrides,
    });
  }

  const diagnosticMessage =
    status.code === 'material-preview.webgl2-unavailable'
      ? t('materialEditor.preview.webgl2Unavailable')
      : status.code === 'material-preview.context-lost'
        ? t('materialEditor.preview.contextLost')
        : status.code === 'material-preview.render-failed'
          ? t('materialEditor.preview.renderFailed')
          : status.message;

  return (
    <div
      className={`relative h-full ${compact ? 'min-h-0' : 'min-h-[160px]'} w-full overflow-hidden ${className ?? ''}`}
    >
      <canvas
        ref={canvasRef}
        aria-label={t('materialEditor.preview.label')}
        className="h-full w-full touch-none"
        data-material-preview={materialId}
        data-material-preview-parameter-overrides={
          parameterOverrides && Object.keys(parameterOverrides).length > 0
            ? Object.keys(parameterOverrides).sort().join(',')
            : undefined
        }
        onPointerDown={(event) => updatePointer(event, true)}
        onPointerMove={(event) => updatePointer(event, pointerRef.current.pressed)}
        onPointerUp={(event) => updatePointer(event, false)}
        onPointerLeave={(event) => {
          pointerRef.current = OUTSIDE_POINTER;
          registrationRef.current?.update({
            canvas: event.currentTarget,
            materialId,
            width: size.width,
            height: size.height,
            visible,
            pointer: OUTSIDE_POINTER,
            resources,
            parameterOverrides,
          });
        }}
      />
      {resourceStatus?.stale ? (
        <div
          className="absolute right-2 top-2 rounded bg-amber-500/90 px-2 py-1 text-[10px] font-medium text-black"
          data-material-preview-stale
        >
          {t('materialEditor.preview.stale')}
        </div>
      ) : null}
      {!status.available ? (
        <div
          className="absolute inset-0 flex items-center justify-center bg-muted/80 p-4 text-center text-xs text-muted-foreground"
          data-material-preview-diagnostic={status.code ?? undefined}
        >
          {diagnosticMessage}
        </div>
      ) : null}
    </div>
  );
}
