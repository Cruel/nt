import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vite-plus/test';
import { HotspotImageStage } from '@/components/image-stage/HotspotImageStage';
import {
  clampImageStageCamera,
  imageRectToStage,
  imagePixelToUv,
  imageStageRect,
  imageUvToStage,
  imageUvToPixel,
  normalizedRectFromPoints,
  referenceRectToStage,
  resizeNormalizedRect,
  roomBackgroundImageRect,
  roomBackgroundTransform,
  stageToImageUv,
} from '@/components/image-stage/image-stage-transforms';
import {
  defaultHotspotViewState,
  parseHotspotViewTabState,
  restoreHotspotViewState,
} from '@/components/image-stage/hotspot-view-state';

describe('hotspot image-stage transforms', () => {
  it('keeps image UV coordinates stable across viewport, zoom, pan, and DPR-independent CSS sizing', () => {
    const uv = { x: 0.25, y: 0.75 };
    for (const viewport of [
      { width: 800, height: 600 },
      { width: 1600, height: 900 },
    ]) {
      for (const camera of [
        { zoom: 1, pan: { x: 0, y: 0 } },
        { zoom: 2.5, pan: { x: 117, y: -43 } },
      ]) {
        const imageRect = imageStageRect(viewport, { width: 1920, height: 1080 }, camera);
        const stage = imageUvToStage(uv, imageRect);
        expect(stageToImageUv(stage, imageRect)).toEqual(uv);
      }
    }
  });

  it('projects normalized rectangles and Room reference bounds without mixing coordinate domains', () => {
    const bounds = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
    expect(imageRectToStage(bounds, { x: 100, y: 50, width: 1000, height: 500 })).toEqual({
      x: 200,
      y: 150,
      width: 300,
      height: 200,
    });
    expect(referenceRectToStage(bounds, { width: 1920, height: 1080 })).toEqual({
      x: 192,
      y: 216,
      width: 576,
      height: 432,
    });
  });

  it('matches cover, contain, stretch, and center Room background geometry', () => {
    const viewport = { width: 1920, height: 1080 };
    const portrait = { width: 1000, height: 2000 };
    expect(roomBackgroundImageRect(viewport, portrait, 'cover')).toEqual({
      x: 0,
      y: -1380,
      width: 1920,
      height: 3840,
    });
    expect(roomBackgroundImageRect(viewport, portrait, 'contain')).toEqual({
      x: 690,
      y: 0,
      width: 540,
      height: 1080,
    });
    expect(roomBackgroundImageRect(viewport, portrait, 'stretch')).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    });
    expect(roomBackgroundImageRect(viewport, portrait, 'center')).toEqual({
      x: 460,
      y: -460,
      width: 1000,
      height: 2000,
    });
    expect(roomBackgroundImageRect(viewport, { width: 640, height: 360 }, 'center')).toEqual({
      x: 640,
      y: 360,
      width: 640,
      height: 360,
    });
    expect(roomBackgroundTransform(viewport, portrait, 'cover').visibleImageUv).toEqual({
      x: 0,
      y: 0.359375,
      width: 1,
      height: 0.28125,
    });
  });

  it('round-trips source pixels and clamps pointer rectangles to image UV bounds', () => {
    const image = { width: 1920, height: 1080 };
    const pixels = { x: 480, y: 810 };
    expect(imageUvToPixel(imagePixelToUv(pixels, image), image)).toEqual(pixels);
    expect(normalizedRectFromPoints({ x: -0.5, y: 0.25 }, { x: 1.5, y: 2 })).toEqual({
      x: 0,
      y: 0.25,
      width: 1,
      height: 0.75,
    });
  });

  it('clamps resize handles inside image space and preserves the opposite edge', () => {
    expect(
      resizeNormalizedRect(
        { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
        'nw',
        { x: -1, y: 0.2 },
        { x: 0.05, y: 0.05 },
      ),
    ).toEqual({ x: 0, y: 0.45, width: 0.75, height: 0.3 });
  });

  it('clamps restored cameras while keeping at least 32 CSS pixels visible on each axis', () => {
    expect(
      clampImageStageCamera(
        { width: 400, height: 300 },
        { width: 100, height: 100 },
        { zoom: 1, pan: { x: 1000, y: -1000 } },
      ),
    ).toEqual({ zoom: 1, pan: { x: 318, y: -268 } });
  });
});

describe('hotspot view-state contract', () => {
  it('accepts only noveltea.editor.hotspot-view version 1 state', () => {
    const value = {
      ...defaultHotspotViewState(),
      tool: 'draw-rect' as const,
      panX: 12,
      panY: -8,
      zoom: 2,
      selectedHotspotId: 'door',
    };
    expect(parseHotspotViewTabState(value)).toEqual(value);
    expect(parseHotspotViewTabState({ ...value, schemaVersion: 2 })).toBeUndefined();
    expect(parseHotspotViewTabState({ ...value, schema: 'legacy.hotspot-view' })).toBeUndefined();
    expect(
      restoreHotspotViewState(
        { ...value, zoom: 99, panX: 10000, panY: -10000, selectedHotspotId: 'missing' },
        ['door'],
        {
          viewport: { width: 400, height: 300 },
          image: { width: 100, height: 100 },
        },
      ),
    ).toMatchObject({ zoom: 16, panX: 2568, panY: -2518, selectedHotspotId: null });
  });
});

describe('HotspotImageStage', () => {
  it('supports list selection, alpha visualization, and keyboard deletion without owner wrappers', () => {
    const onSelectionChange = vi.fn();
    const onDelete = vi.fn();
    render(
      <HotspotImageStage
        imageSize={{ width: 100, height: 100 }}
        hotspots={[
          { id: 'door', label: 'Door', bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } },
        ]}
        selectedHotspotId="door"
        tool="select"
        camera={{ zoom: 1, pan: { x: 0, y: 0 } }}
        alphaVisualization
        onSelectionChange={onSelectionChange}
        onCameraChange={vi.fn()}
        onCreate={vi.fn()}
        onCommitBounds={vi.fn()}
        onDelete={onDelete}
      />,
    );
    expect(document.querySelector('[data-alpha-visualization]')).not.toBeNull();
    expect(document.querySelector('[data-geometry-layer]')).not.toBeNull();
    expect(document.querySelector('[data-handles-feedback-layer]')).not.toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Door' })[1]!);
    expect(onSelectionChange).toHaveBeenCalledWith('door');
    const stage = document.querySelector<HTMLElement>(
      '[data-hotspot-image-stage] > div[tabindex]',
    )!;
    fireEvent.keyDown(stage, { key: 'Delete' });
    expect(onDelete).toHaveBeenCalledWith('door');
  });

  it('renders the Room runtime-visible image guide without changing editable UV geometry', () => {
    Object.defineProperties(HTMLElement.prototype, {
      clientWidth: { configurable: true, get: () => 400 },
      clientHeight: { configurable: true, get: () => 300 },
    });
    render(
      <HotspotImageStage
        imageSize={{ width: 1000, height: 2000 }}
        hotspots={[
          { id: 'door', label: 'Door', bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } },
        ]}
        visibleImageGuide={{ x: 0, y: 0.359375, width: 1, height: 0.28125 }}
        selectedHotspotId="door"
        tool="select"
        camera={{ zoom: 1, pan: { x: 0, y: 0 } }}
        onSelectionChange={vi.fn()}
        onCameraChange={vi.fn()}
        onCreate={vi.fn()}
        onCommitBounds={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(document.querySelector('[data-runtime-visible-area-guide]')).not.toBeNull();
    expect(document.querySelector('[data-hotspot-id="door"]')).not.toBeNull();
  });

  it('exposes polygon-ready display and selection without enabling polygon editing', () => {
    const onSelectionChange = vi.fn();
    render(
      <HotspotImageStage
        imageSize={{ width: 100, height: 100 }}
        hotspots={[
          {
            id: 'triangle',
            label: 'Triangle',
            inputOrder: 7,
            geometry: {
              kind: 'polygon',
              vertices: [
                { x: 0.1, y: 0.1 },
                { x: 0.9, y: 0.1 },
                { x: 0.5, y: 0.9 },
              ],
            },
          },
        ]}
        selectedHotspotId="triangle"
        tool="select"
        camera={{ zoom: 1, pan: { x: 0, y: 0 } }}
        onSelectionChange={onSelectionChange}
        onCameraChange={vi.fn()}
        onCreate={vi.fn()}
        onCommitBounds={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const polygon = document.querySelector<SVGGElement>(
      '[data-hotspot-id="triangle"][data-hotspot-geometry="polygon"]',
    )!;
    expect(polygon).not.toBeNull();
    expect(document.querySelector('[data-resize-handle]')).toBeNull();
    expect(screen.getByText('Order 7')).toBeInTheDocument();
    fireEvent.pointerDown(polygon, { pointerId: 9, button: 0 });
    expect(onSelectionChange).toHaveBeenCalledWith('triangle');
  });

  it('normalizes restored pan after stage dimensions become available', async () => {
    Object.defineProperties(HTMLElement.prototype, {
      clientWidth: { configurable: true, get: () => 400 },
      clientHeight: { configurable: true, get: () => 300 },
    });
    const onCameraChange = vi.fn();
    render(
      <HotspotImageStage
        imageSize={{ width: 100, height: 100 }}
        hotspots={[]}
        selectedHotspotId={null}
        tool="pan"
        camera={{ zoom: 1, pan: { x: 1000, y: -1000 } }}
        onSelectionChange={vi.fn()}
        onCameraChange={onCameraChange}
        onCreate={vi.fn()}
        onCommitBounds={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(onCameraChange).toHaveBeenCalledWith({ zoom: 1, pan: { x: 318, y: -268 } }),
    );
  });

  it('commits a move exactly once when the pointer gesture ends', () => {
    Object.defineProperties(HTMLElement.prototype, {
      clientWidth: { configurable: true, get: () => 400 },
      clientHeight: { configurable: true, get: () => 400 },
      setPointerCapture: { configurable: true, value: vi.fn() },
    });
    const onCommitBounds = vi.fn();
    render(
      <HotspotImageStage
        imageSize={{ width: 100, height: 100 }}
        hotspots={[
          { id: 'door', label: 'Door', bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
        ]}
        selectedHotspotId="door"
        tool="select"
        camera={{ zoom: 1, pan: { x: 0, y: 0 } }}
        onSelectionChange={vi.fn()}
        onCameraChange={vi.fn()}
        onCreate={vi.fn()}
        onCommitBounds={onCommitBounds}
        onDelete={vi.fn()}
      />,
    );
    const hotspot = document.querySelector<HTMLElement>('[data-hotspot-id="door"]')!;
    fireEvent.pointerDown(hotspot, { pointerId: 1, button: 0, clientX: 40, clientY: 40 });
    fireEvent.pointerMove(hotspot, { pointerId: 1, clientX: 80, clientY: 80 });
    expect(onCommitBounds).not.toHaveBeenCalled();
    fireEvent.pointerUp(hotspot, { pointerId: 1, clientX: 80, clientY: 80 });
    expect(onCommitBounds).toHaveBeenCalledTimes(1);
    expect(onCommitBounds).toHaveBeenCalledWith('door', {
      x: 0.2,
      y: 0.2,
      width: 0.2,
      height: 0.2,
    });
  });

  it('draws and resizes with one callback per completed gesture and cancels drafts with Escape', () => {
    Object.defineProperties(HTMLElement.prototype, {
      clientWidth: { configurable: true, get: () => 400 },
      clientHeight: { configurable: true, get: () => 400 },
      setPointerCapture: { configurable: true, value: vi.fn() },
    });
    const onCreate = vi.fn();
    const onCommitBounds = vi.fn();
    const view = render(
      <HotspotImageStage
        imageSize={{ width: 100, height: 100 }}
        hotspots={[]}
        selectedHotspotId={null}
        tool="draw-rect"
        camera={{ zoom: 1, pan: { x: 0, y: 0 } }}
        onSelectionChange={vi.fn()}
        onCameraChange={vi.fn()}
        onCreate={onCreate}
        onCommitBounds={onCommitBounds}
        onDelete={vi.fn()}
      />,
    );
    const stage = document.querySelector<HTMLElement>(
      '[data-hotspot-image-stage] > div[tabindex]',
    )!;
    fireEvent.pointerDown(stage, { pointerId: 2, button: 0, clientX: 40, clientY: 40 });
    fireEvent.pointerMove(stage, { pointerId: 2, clientX: 120, clientY: 120 });
    fireEvent.keyDown(stage, { key: 'Escape' });
    fireEvent.pointerUp(stage, { pointerId: 2, clientX: 120, clientY: 120 });
    expect(onCreate).not.toHaveBeenCalled();

    fireEvent.pointerDown(stage, { pointerId: 3, button: 0, clientX: 40, clientY: 40 });
    fireEvent.pointerMove(stage, { pointerId: 3, clientX: 120, clientY: 120 });
    fireEvent.pointerUp(stage, { pointerId: 3, clientX: 120, clientY: 120 });
    expect(onCreate).toHaveBeenCalledTimes(1);

    view.rerender(
      <HotspotImageStage
        imageSize={{ width: 100, height: 100 }}
        hotspots={[
          { id: 'door', label: 'Door', bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
        ]}
        selectedHotspotId="door"
        tool="select"
        camera={{ zoom: 1, pan: { x: 0, y: 0 } }}
        onSelectionChange={vi.fn()}
        onCameraChange={vi.fn()}
        onCreate={onCreate}
        onCommitBounds={onCommitBounds}
        onDelete={vi.fn()}
      />,
    );
    const handle = document.querySelector<SVGRectElement>('[data-resize-handle="se"]')!;
    fireEvent.pointerDown(handle, { pointerId: 4, button: 0, clientX: 120, clientY: 120 });
    fireEvent.pointerMove(handle, { pointerId: 4, clientX: 160, clientY: 160 });
    expect(onCommitBounds).not.toHaveBeenCalled();
    fireEvent.pointerUp(handle, { pointerId: 4, clientX: 160, clientY: 160 });
    expect(onCommitBounds).toHaveBeenCalledTimes(1);
  });

  it('publishes pan and zoom only through camera callbacks', () => {
    Object.defineProperties(HTMLElement.prototype, {
      clientWidth: { configurable: true, get: () => 400 },
      clientHeight: { configurable: true, get: () => 400 },
      setPointerCapture: { configurable: true, value: vi.fn() },
    });
    const onCameraChange = vi.fn();
    render(
      <HotspotImageStage
        imageSize={{ width: 100, height: 100 }}
        hotspots={[]}
        selectedHotspotId={null}
        tool="pan"
        camera={{ zoom: 1, pan: { x: 0, y: 0 } }}
        onSelectionChange={vi.fn()}
        onCameraChange={onCameraChange}
        onCreate={vi.fn()}
        onCommitBounds={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const stage = document.querySelector<HTMLElement>(
      '[data-hotspot-image-stage] > div[tabindex]',
    )!;
    fireEvent.pointerDown(stage, { pointerId: 5, button: 0, clientX: 50, clientY: 60 });
    fireEvent.pointerMove(stage, { pointerId: 5, clientX: 80, clientY: 90 });
    fireEvent.pointerUp(stage, { pointerId: 5, clientX: 80, clientY: 90 });
    expect(onCameraChange).toHaveBeenCalledWith({ zoom: 1, pan: { x: 30, y: 30 } });
    fireEvent.wheel(stage, { deltaY: -100 });
    expect(onCameraChange).toHaveBeenCalledTimes(2);
    expect(onCameraChange.mock.calls[1]?.[0].zoom).toBeGreaterThan(1);
  });
});
